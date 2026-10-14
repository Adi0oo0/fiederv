/**
 * Drop Multithreaded Processing Pipeline
 * Offloads compute-heavy Deflate compression, decompression, AES-256-GCM encryption,
 * decryption, and SHA-256 leaf hashing to dedicated background Web Workers (browser)
 * or asynchronous pipeline workers (Node.js).
 * 
 * Uses zero-copy Transferable ArrayBuffers (O(1) memory transfer) to prevent
 * GC pauses and ensure network I/O loops (WebRTC / HTTP relay) run at maximum throughput.
 */

export interface ProcessedOutgoingChunk {
  chunkIndex: number;
  ciphertextBuffer: ArrayBuffer;
  leafHash: Uint8Array;
  originalBytes: number;
  wireBytes: number;
  isCompressed: boolean;
}

export interface ProcessedIncomingChunk {
  chunkIndex: number;
  plaintextBuffer: ArrayBuffer;
  leafHash: Uint8Array;
  originalBytes: number;
  isCompressed: boolean;
}

// Inline Worker Script for zero-config browser bundling & Vite compatibility
const WORKER_SCRIPT = `
let chunkKey = null;
let salt = new Uint8Array(4);

function constructNonce(saltBytes, chunkIdx) {
  const nonce = new Uint8Array(12);
  nonce.set(saltBytes, 0);
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setBigUint64(4, BigInt(chunkIdx), false);
  return nonce;
}

function calculateShannonEntropy(data) {
  if (!data || data.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) freq[data[i]]++;
  let entropy = 0;
  const len = data.length;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / len;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

async function compressBlock(data) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      const promise = new Response(cs.readable).arrayBuffer();
      await writer.write(data);
      await writer.close();
      const res = new Uint8Array(await promise);
      if (res.byteLength < data.byteLength * 0.97) {
        return res;
      }
    } catch (e) {}
  }
  return null;
}

async function decompressBlock(data) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const promise = new Response(ds.readable).arrayBuffer();
      await writer.write(data);
      await writer.close();
      return new Uint8Array(await promise);
    } catch (e) {
      throw e;
    }
  }
  return data;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'INIT_KEYS') {
    try {
      salt = new Uint8Array(msg.salt);
      const rawKey = new Uint8Array(msg.rawKey);
      const enc = new TextEncoder();
      const hkdfKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'HKDF' },
        false,
        ['deriveKey']
      );
      chunkKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: salt,
          info: enc.encode('drop-chunk-aes-256-gcm'),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      self.postMessage({ type: 'INIT_KEYS_OK' });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: String(err) });
    }
    return;
  }

  if (msg.type === 'PROCESS_OUTGOING') {
    try {
      if (!chunkKey) throw new Error('Worker chunkKey not initialized');
      const plaintext = new Uint8Array(msg.buffer);
      const origLen = plaintext.byteLength;

      // 1. SHA-256 leaf hash of raw plaintext for Merkle root
      const leafHashBuf = await crypto.subtle.digest('SHA-256', plaintext);

      // 2. Multithreaded compression if candidate
      let isCompressed = false;
      let toEncrypt = plaintext;

      if (msg.isCompressible && origLen >= 512) {
        const sampleSize = Math.min(16384, origLen);
        const entropy = calculateShannonEntropy(plaintext.subarray(0, sampleSize));
        if (entropy <= 7.35) {
          const comp = await compressBlock(plaintext);
          if (comp) {
            toEncrypt = comp;
            isCompressed = true;
          }
        }
      }

      // 3. Prepend 1-byte compression header (0x01 if compressed, 0x00 if raw)
      const payload = new Uint8Array(1 + toEncrypt.byteLength);
      payload[0] = isCompressed ? 0x01 : 0x00;
      payload.set(toEncrypt, 1);

      // 4. Encrypt with AES-256-GCM using deterministic nonce
      const nonce = constructNonce(salt, msg.chunkIndex);
      const ciphertextBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        chunkKey,
        payload
      );

      // Zero-copy transfer back to main thread
      self.postMessage(
        {
          type: 'OUTGOING_PROCESSED',
          id: msg.id,
          chunkIndex: msg.chunkIndex,
          ciphertextBuffer: ciphertextBuf,
          leafHashBuffer: leafHashBuf,
          originalBytes: origLen,
          wireBytes: ciphertextBuf.byteLength,
          isCompressed,
        },
        [ciphertextBuf, leafHashBuf]
      );
    } catch (err) {
      self.postMessage({ type: 'OUTGOING_ERROR', id: msg.id, error: String(err) });
    }
    return;
  }

  if (msg.type === 'PROCESS_INCOMING') {
    try {
      if (!chunkKey) throw new Error('Worker chunkKey not initialized');
      const ciphertext = new Uint8Array(msg.buffer);
      const nonce = constructNonce(salt, msg.chunkIndex);

      // 1. Decrypt AES-256-GCM
      const decryptedBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        chunkKey,
        ciphertext
      );
      const decrypted = new Uint8Array(decryptedBuf);

      // 2. Parse 1-byte header: 0x01 = compressed, 0x00 = raw
      const isCompressed = decrypted[0] === 0x01;
      const body = decrypted.subarray(1);

      let plaintext;
      if (isCompressed) {
        plaintext = await decompressBlock(body);
      } else {
        plaintext = body;
      }

      // 3. SHA-256 leaf hash of decompressed plaintext
      const leafHashBuf = await crypto.subtle.digest('SHA-256', plaintext);

      // Copy to standalone buffer for clean transfer
      const plaintextBuf = plaintext.buffer.slice(
        plaintext.byteOffset,
        plaintext.byteOffset + plaintext.byteLength
      );

      self.postMessage(
        {
          type: 'INCOMING_PROCESSED',
          id: msg.id,
          chunkIndex: msg.chunkIndex,
          plaintextBuffer: plaintextBuf,
          leafHashBuffer: leafHashBuf,
          originalBytes: plaintextBuf.byteLength,
          isCompressed,
        },
        [plaintextBuf, leafHashBuf]
      );
    } catch (err) {
      self.postMessage({ type: 'INCOMING_ERROR', id: msg.id, error: String(err) });
    }
    return;
  }
};
`;

interface WorkerTask {
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

export class TransferPipeline {
  private workers: Worker[] = [];
  private workerBlobUrl: string | null = null;
  private pendingTasks = new Map<number, WorkerTask>();
  private nextTaskId = 1;
  private workerIndex = 0;
  private isCompressible = false;
  private isInitialized = false;

  // Key storage for inline fallback when Workers are unsupported
  private rawKey: Uint8Array | null = null;
  private salt: Uint8Array = new Uint8Array(4);
  private fallbackCryptoKey: CryptoKey | null = null;

  constructor(maxWorkers: number = 3) {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
        this.workerBlobUrl = URL.createObjectURL(blob);
        const count = Math.min(
          maxWorkers,
          Math.max(2, (navigator.hardwareConcurrency || 2) - 1)
        );
        for (let i = 0; i < count; i++) {
          const w = new Worker(this.workerBlobUrl);
          w.onmessage = (e) => this.handleWorkerMessage(e.data);
          w.onerror = (err) => console.warn('Pipeline Worker error:', err);
          this.workers.push(w);
        }
      } catch (e) {
        console.warn('Web Worker initialization fallback to async inline processing:', e);
      }
    }
  }

  public async initKeys(
    rawKey: Uint8Array,
    salt: Uint8Array,
    isCompressible: boolean = false
  ): Promise<void> {
    this.rawKey = rawKey;
    this.salt = salt;
    this.isCompressible = isCompressible;

    // Send INIT_KEYS to all workers in the pool
    if (this.workers.length > 0) {
      for (const w of this.workers) {
        w.postMessage({
          type: 'INIT_KEYS',
          rawKey: rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength),
          salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength),
        });
      }
    }

    // Also prepare fallback crypto key for environments without Web Workers
    const enc = new TextEncoder();
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      rawKey as any,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );
    this.fallbackCryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as any,
        info: enc.encode('drop-chunk-aes-256-gcm'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.isInitialized = true;
  }

  private handleWorkerMessage(data: any): void {
    if (!data || !data.id) return;
    const task = this.pendingTasks.get(data.id);
    if (!task) return;
    this.pendingTasks.delete(data.id);

    if (data.type === 'OUTGOING_PROCESSED') {
      task.resolve({
        chunkIndex: data.chunkIndex,
        ciphertextBuffer: data.ciphertextBuffer,
        leafHash: new Uint8Array(data.leafHashBuffer),
        originalBytes: data.originalBytes,
        wireBytes: data.wireBytes,
        isCompressed: data.isCompressed,
      });
    } else if (data.type === 'INCOMING_PROCESSED') {
      task.resolve({
        chunkIndex: data.chunkIndex,
        plaintextBuffer: data.plaintextBuffer,
        leafHash: new Uint8Array(data.leafHashBuffer),
        originalBytes: data.originalBytes,
        isCompressed: data.isCompressed,
      });
    } else if (data.type === 'OUTGOING_ERROR' || data.type === 'INCOMING_ERROR') {
      task.reject(new Error(data.error || 'Worker task failed'));
    }
  }

  /**
   * Dispatches outgoing chunk to background worker thread for compression + encryption.
   * Transferred using zero-copy postMessage([buffer]).
   */
  public async processOutgoingChunk(
    chunkIndex: number,
    chunkBytes: Uint8Array
  ): Promise<ProcessedOutgoingChunk> {
    if (this.workers.length > 0 && this.isInitialized) {
      const id = this.nextTaskId++;
      const worker = this.workers[this.workerIndex % this.workers.length];
      this.workerIndex++;

      const buf = chunkBytes.buffer.slice(
        chunkBytes.byteOffset,
        chunkBytes.byteOffset + chunkBytes.byteLength
      );

      return new Promise<ProcessedOutgoingChunk>((resolve, reject) => {
        this.pendingTasks.set(id, { resolve, reject });
        worker.postMessage(
          {
            type: 'PROCESS_OUTGOING',
            id,
            chunkIndex,
            buffer: buf,
            isCompressible: this.isCompressible,
          },
          [buf]
        );
      });
    }

    // Fallback: Inline execution (e.g. in Node.js test runner)
    return this.fallbackProcessOutgoing(chunkIndex, chunkBytes);
  }

  /**
   * Dispatches incoming ciphertext chunk to background worker thread for decryption + decompression.
   */
  public async processIncomingChunk(
    chunkIndex: number,
    ciphertextBytes: Uint8Array
  ): Promise<ProcessedIncomingChunk> {
    if (this.workers.length > 0 && this.isInitialized) {
      const id = this.nextTaskId++;
      const worker = this.workers[this.workerIndex % this.workers.length];
      this.workerIndex++;

      const buf = ciphertextBytes.buffer.slice(
        ciphertextBytes.byteOffset,
        ciphertextBytes.byteOffset + ciphertextBytes.byteLength
      );

      return new Promise<ProcessedIncomingChunk>((resolve, reject) => {
        this.pendingTasks.set(id, { resolve, reject });
        worker.postMessage(
          {
            type: 'PROCESS_INCOMING',
            id,
            chunkIndex,
            buffer: buf,
          },
          [buf]
        );
      });
    }

    // Fallback: Inline execution
    return this.fallbackProcessIncoming(chunkIndex, ciphertextBytes);
  }

  private constructNonce(chunkIndex: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(this.salt, 0);
    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setBigUint64(4, BigInt(chunkIndex), false);
    return nonce;
  }

  private async fallbackProcessOutgoing(
    chunkIndex: number,
    chunkBytes: Uint8Array
  ): Promise<ProcessedOutgoingChunk> {
    if (!this.fallbackCryptoKey) throw new Error('Pipeline keys not initialized');

    // SHA-256 leaf hash of raw plaintext
    const leafHashBuf = await crypto.subtle.digest('SHA-256', chunkBytes as any);
    const leafHash = new Uint8Array(leafHashBuf);

    // Multithreaded compression fallback
    let isCompressed = false;
    let toEncrypt = chunkBytes;

    if (this.isCompressible && chunkBytes.byteLength >= 512) {
      if (typeof CompressionStream !== 'undefined') {
        try {
          const cs = new CompressionStream('deflate-raw');
          const writer = cs.writable.getWriter();
          const p = new Response(cs.readable).arrayBuffer();
          await writer.write(chunkBytes as any);
          await writer.close();
          const comp = new Uint8Array(await p);
          if (comp.byteLength < chunkBytes.byteLength * 0.97) {
            toEncrypt = comp;
            isCompressed = true;
          }
        } catch {}
      } else if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          const zlib = await import(/* @vite-ignore */ 'node:zlib');
          const comp = zlib.deflateRawSync(chunkBytes);
          if (comp.byteLength < chunkBytes.byteLength * 0.97) {
            toEncrypt = new Uint8Array(comp.buffer, comp.byteOffset, comp.byteLength);
            isCompressed = true;
          }
        } catch {}
      }
    }

    // 1-byte compression header
    const payload = new Uint8Array(1 + toEncrypt.byteLength);
    payload[0] = isCompressed ? 0x01 : 0x00;
    payload.set(toEncrypt, 1);

    const nonce = this.constructNonce(chunkIndex);
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as any },
      this.fallbackCryptoKey,
      payload as any
    );

    return {
      chunkIndex,
      ciphertextBuffer: ciphertextBuf,
      leafHash,
      originalBytes: chunkBytes.byteLength,
      wireBytes: ciphertextBuf.byteLength,
      isCompressed,
    };
  }

  private async fallbackProcessIncoming(
    chunkIndex: number,
    ciphertextBytes: Uint8Array
  ): Promise<ProcessedIncomingChunk> {
    if (!this.fallbackCryptoKey) throw new Error('Pipeline keys not initialized');

    const nonce = this.constructNonce(chunkIndex);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as any },
      this.fallbackCryptoKey,
      ciphertextBytes as any
    );
    const decrypted = new Uint8Array(decryptedBuf);

    const isCompressed = decrypted[0] === 0x01;
    const body = decrypted.subarray(1);

    let plaintext: Uint8Array = body;
    if (isCompressed) {
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const p = new Response(ds.readable).arrayBuffer();
        await writer.write(body as any);
        await writer.close();
        plaintext = new Uint8Array(await p);
      } else if (typeof process !== 'undefined' && process.versions?.node) {
        const zlib = await import(/* @vite-ignore */ 'node:zlib');
        const decomp = zlib.inflateRawSync(body);
        plaintext = new Uint8Array(decomp.buffer, decomp.byteOffset, decomp.byteLength);
      }
    }

    const leafHashBuf = await crypto.subtle.digest('SHA-256', plaintext as any);
    const leafHash = new Uint8Array(leafHashBuf);
    const plaintextBuffer = (plaintext.buffer as ArrayBuffer).slice(
      plaintext.byteOffset,
      plaintext.byteOffset + plaintext.byteLength
    );

    return {
      chunkIndex,
      plaintextBuffer,
      leafHash,
      originalBytes: plaintextBuffer.byteLength,
      isCompressed,
    };
  }

  public destroy(): void {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {}
    }
    this.workers = [];
    if (this.workerBlobUrl) {
      try {
        URL.revokeObjectURL(this.workerBlobUrl);
      } catch {}
      this.workerBlobUrl = null;
    }
    this.pendingTasks.clear();
  }
}
