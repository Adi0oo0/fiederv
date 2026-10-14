/**
 * Drop Core Transfer Engine
 * Standalone, zero-UI, zero-memory-buffering transfer engine for 50-100+ GB transfers.
 */

import {
  TransferManifest,
  TransferState,
  TransferProgress,
  EngineConfig,
  IDiskWriter,
} from './types.js';
import { TransferCrypto } from './crypto.js';
import { Hasher } from './hasher.js';
import { MerkleTree } from './merkle.js';
import { FileChunker, ChunkSource, BlobChunkSource } from './chunker.js';
import { ChunkBitmap, SessionPersistence } from './bitmap.js';
import { WorkStealingScheduler } from './scheduler.js';
import { FrameCodec, FrameType } from './transports/types.js';
import { MultipathController } from './transports/multipath.js';
import { WebRTCPeerManager } from './transports/webrtc.js';
import { HttpRelayTransport } from './transports/http-relay.js';

export interface TransferEngineEvents {
  onStateChange?: (state: TransferState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onSignal?: (signal: any) => void;
  onManifestReady?: (manifest: TransferManifest, shareUrl: string, keyFragment: string) => void;
  onComplete?: (merkleRoot: string) => void;
  onError?: (err: Error) => void;
}

export class TransferEngine {
  private config: EngineConfig;
  private events: TransferEngineEvents;
  private state: TransferState = 'idle';

  // Subsystems
  private crypto: TransferCrypto = new TransferCrypto();
  private chunker: FileChunker | null = null;
  private diskWriter: IDiskWriter | null = null;
  private scheduler: WorkStealingScheduler | null = null;
  private multipath: MultipathController | null = null;
  private webrtc: WebRTCPeerManager | null = null;
  private httpRelay: HttpRelayTransport | null = null;

  // Active session data
  private manifest: TransferManifest | null = null;
  private verifiedLeaves: Uint8Array[] = [];
  private wakeLock: any = null;

  // Speed and ETA calculation
  private bytesTransferred = 0;
  private totalBytes = 0;
  private lastProgressTime = 0;
  private lastProgressBytes = 0;
  private currentSpeedBps = 0;
  private progressInterval: any = null;

  constructor(config: EngineConfig = {}, events: TransferEngineEvents = {}) {
    this.config = {
      defaultChunkSize: 8 * 1024 * 1024, // 8 MB
      parallelChannels: 8,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      ...config,
    };
    this.events = events;
  }

  public getState(): TransferState {
    return this.state;
  }

  private setState(newState: TransferState): void {
    if (this.state === newState) return;
    this.state = newState;
    if (this.events.onStateChange) {
      this.events.onStateChange(newState);
    }
    this.emitProgress();
  }

  /**
   * SENDER: Prepares file for transfer, generates key, computes Merkle tree, and starts listening.
   */
  public async prepareSender(
    sourceOrBlob: ChunkSource | Blob,
    sessionId: string,
    originUrl: string = ''
  ): Promise<{ manifest: TransferManifest; shareUrl: string; keyFragment: string }> {
    this.setState('waiting_peer');

    // 1. Generate E2E encryption key and salt
    const { saltHex, fragment } = await this.crypto.generateKey();

    // 2. Initialize chunker
    const source: ChunkSource =
      'readSlice' in sourceOrBlob ? sourceOrBlob : new BlobChunkSource(sourceOrBlob);
    this.chunker = new FileChunker(source, this.config.defaultChunkSize);
    this.totalBytes = source.size;

    // 3. Generate Merkle tree root and manifest
    const { manifest, leafHashes } = await this.chunker.generateManifest(
      sessionId,
      saltHex,
      (processed, total) => {
        if (this.events.onProgress) {
          this.events.onProgress({
            state: 'waiting_peer',
            bytesTransferred: processed,
            totalBytes: total,
            chunksCompleted: 0,
            totalChunks: this.chunker?.totalChunks || 1,
            speedBps: 0,
            etaSeconds: 0,
            merkleRoot: 'computing...',
            activeTransports: [],
          });
        }
      }
    );

    this.manifest = manifest;
    this.verifiedLeaves = leafHashes;

    // 4. Initialize Scheduler & Multipath
    this.scheduler = new WorkStealingScheduler(manifest.totalChunks);
    this.multipath = new MultipathController(this.scheduler);
    this.setupMultipathSenderPump();

    // 5. Initialize WebRTC Manager
    this.setupWebRTC(true);

    // 6. Initialize HTTP Relay if URL provided
    if (this.config.relayUrl) {
      this.httpRelay = new HttpRelayTransport('relay-0', this.config.relayUrl, sessionId);
      this.multipath.registerTransport(this.httpRelay, 4, 16);
    }

    const shareUrl = `${originUrl}/?code=${sessionId}#key=${fragment}`;
    if (this.events.onManifestReady) {
      this.events.onManifestReady(manifest, shareUrl, fragment);
    }

    this.startProgressTicker();
    return { manifest, shareUrl, keyFragment: fragment };
  }

  /**
   * RECEIVER: Initializes reception with manifest, key fragment, and disk writer.
   */
  public async prepareReceiver(
    manifest: TransferManifest,
    keyFragment: string,
    writer: IDiskWriter
  ): Promise<void> {
    this.manifest = manifest;
    this.diskWriter = writer;
    this.totalBytes = manifest.size;
    this.verifiedLeaves = new Array(manifest.totalChunks);

    // 1. Initialize Crypto from key fragment
    await this.crypto.initFromFragment(keyFragment);

    // 2. Open Disk Writer (preallocates space directly on disk)
    await this.diskWriter.open(manifest.name, manifest.size);

    // 3. Load or initialize ChunkBitmap for session resumption
    let existingBitmap: ChunkBitmap | undefined;
    const stored = await SessionPersistence.loadSession(manifest.sessionId);
    if (stored && stored.merkleRoot === manifest.merkleRoot) {
      existingBitmap = ChunkBitmap.fromBase64(stored.bitmapBase64, manifest.totalChunks);
    }

    this.scheduler = new WorkStealingScheduler(manifest.totalChunks, existingBitmap);
    this.bytesTransferred = (this.scheduler.getCompletedCount() * manifest.chunkSize);
    this.bytesTransferred = Math.min(this.bytesTransferred, manifest.size);

    // 4. Multipath & WebRTC
    this.multipath = new MultipathController(this.scheduler);
    this.setupWebRTC(false);

    // 5. Initialize HTTP Relay if enabled
    if (this.config.relayUrl) {
      this.httpRelay = new HttpRelayTransport('relay-0', this.config.relayUrl, manifest.sessionId);
      this.httpRelay.onFrame = (frame) => this.handleIncomingFrame(frame);
    }

    await this.acquireWakeLock();
    this.setState('transferring');
    this.startProgressTicker();

    // If relay enabled, start background pull of any chunks already uploaded to relay
    if (this.httpRelay) {
      this.startRelayPullWorker();
    }
  }

  private setupMultipathSenderPump(): void {
    if (!this.multipath || !this.chunker || !this.crypto) return;

    this.multipath.onChunkReadyToSend = async (chunkIndex, transport) => {
      try {
        const plaintext = await this.chunker!.readChunk(chunkIndex);
        const hash = await Hasher.hashChunk(plaintext);
        const ciphertext = await this.crypto.encryptChunk(chunkIndex, plaintext);
        const nonce = this.crypto.constructNonce(chunkIndex);

        const frame = FrameCodec.encodeDataFrame(chunkIndex, hash, nonce, ciphertext);
        const sent = await transport.sendFrame(frame);
        return sent;
      } catch (err: any) {
        console.error(`Failed to send chunk ${chunkIndex}:`, err);
        return false;
      }
    };
  }

  private setupWebRTC(isInitiator: boolean): void {
    this.webrtc = new WebRTCPeerManager({
      channelCount: this.config.parallelChannels || 8,
      iceServers: this.config.iceServers,
      onSignal: (signal) => {
        if (this.events.onSignal) {
          this.events.onSignal(signal);
        }
      },
      onConnectionChange: (state) => {
        if (state === 'connected') {
          if (this.state === 'waiting_peer') {
            this.acquireWakeLock();
            this.setState('transferring');
            this.multipath?.start();
          }
        } else if (state === 'failed' || state === 'disconnected') {
          // Fall back gracefully to relay if active
          if (this.multipath && this.httpRelay) {
            this.multipath.triggerSchedulePump();
          }
        }
      },
    });

    this.webrtc.onChannelReady = (channelTransport) => {
      channelTransport.onFrame = (frame) => this.handleIncomingFrame(frame);
      this.multipath?.registerTransport(channelTransport, 2, 8);
      if (this.state === 'waiting_peer') {
        this.acquireWakeLock();
        this.setState('transferring');
        this.multipath?.start();
      }
    };

    this.webrtc.initialize(isInitiator);
  }

  public async handleSignal(signal: any): Promise<void> {
    if (this.webrtc) {
      await this.webrtc.handleSignal(signal);
    }
  }

  /**
   * Processes incoming binary frames (Data Chunks, ACKs, NACKs).
   */
  public async handleIncomingFrame(frameData: Uint8Array): Promise<void> {
    const frame = FrameCodec.decodeFrame(frameData);
    if (!frame) return;

    if (frame.type === FrameType.CHUNK_ACK) {
      // SENDER received ACK from receiver
      if (this.scheduler && this.manifest) {
        const chunkLen = Math.min(
          this.manifest.chunkSize,
          this.manifest.size - frame.chunkIndex * this.manifest.chunkSize
        );
        this.bytesTransferred += chunkLen;
        this.scheduler.onChunkAck(frame.chunkIndex, chunkLen);
        this.saveCurrentSession();

        if (this.scheduler.isComplete()) {
          this.finalizeTransfer();
        } else {
          this.multipath?.triggerSchedulePump();
        }
      }
    } else if (frame.type === FrameType.CHUNK_NACK) {
      // SENDER received NACK: re-queue chunk
      this.scheduler?.onChunkNack(frame.chunkIndex);
      this.multipath?.triggerSchedulePump();
    } else if (frame.type === FrameType.DATA_CHUNK) {
      // RECEIVER received chunk payload: decrypt, hash, verify, write to disk
      await this.processReceivedChunk(frame);
    }
  }

  private async processReceivedChunk(frame: any): Promise<void> {
    if (!this.manifest || !this.diskWriter || !this.scheduler) return;
    const chunkIdx = frame.chunkIndex;

    // Skip if already stored
    if (this.scheduler.completedBitmap.has(chunkIdx)) return;

    try {
      // 1. Decrypt chunk
      const plaintext = await this.crypto.decryptChunk(chunkIdx, frame.payload);

      // 2. Verify per-chunk hash
      const computedHash = await Hasher.hashChunk(plaintext);
      const computedHex = Hasher.toHex(computedHash);
      const expectedHex = Hasher.toHex(frame.hash);

      if (computedHex !== expectedHex) {
        console.warn(`Hash mismatch on chunk ${chunkIdx}. Sending NACK.`);
        this.scheduler.onChunkNack(chunkIdx);
        return;
      }

      // 3. Write chunk directly to disk at byte offset
      const offset = chunkIdx * this.manifest.chunkSize;
      await this.diskWriter.writeChunk(offset, plaintext);

      // 4. Record leaf hash for whole-file Merkle tree
      this.verifiedLeaves[chunkIdx] = computedHash;
      this.bytesTransferred += plaintext.length;
      this.scheduler.onChunkAck(chunkIdx, plaintext.length);

      // Save resume checkpoint
      this.saveCurrentSession();

      // 5. Send ACK frame back across any active channel
      const ackFrame = FrameCodec.encodeControlFrame(FrameType.CHUNK_ACK, chunkIdx);
      const activeChannels = this.webrtc?.getActiveChannels() || [];
      if (activeChannels.length > 0) {
        activeChannels[0].sendFrame(ackFrame);
      }

      // Check for completion
      if (this.scheduler.isComplete()) {
        await this.verifyAndFinalizeReceiver();
      }
    } catch (e: any) {
      console.error(`Decryption/storage error on chunk ${chunkIdx}:`, e);
      this.scheduler.onChunkNack(chunkIdx);
    }
  }

  private async verifyAndFinalizeReceiver(): Promise<void> {
    if (!this.manifest || !this.diskWriter) return;

    this.setState('verifying');

    // Compute whole-file Merkle root
    const tree = new MerkleTree(this.verifiedLeaves);
    const computedRoot = await tree.computeRoot();

    if (computedRoot.toLowerCase() !== this.manifest.merkleRoot.toLowerCase()) {
      const err = new Error(
        `Merkle root mismatch! Expected ${this.manifest.merkleRoot}, got ${computedRoot}`
      );
      this.setState('error');
      if (this.events.onError) this.events.onError(err);
      return;
    }

    // Atomic finalize: rename .part to final file
    await this.diskWriter.finalize(this.manifest.name);
    await SessionPersistence.deleteSession(this.manifest.sessionId);

    this.finalizeTransfer();
  }

  private finalizeTransfer(): void {
    this.releaseWakeLock();
    this.stopProgressTicker();
    this.setState('complete');
    if (this.events.onComplete && this.manifest) {
      this.events.onComplete(this.manifest.merkleRoot);
    }
  }

  private async startRelayPullWorker(): Promise<void> {
    if (!this.httpRelay || !this.scheduler) return;

    while (this.state === 'transferring' && !this.scheduler.isComplete()) {
      const missing = this.scheduler.completedBitmap.getMissingIndices();
      if (missing.length === 0) break;

      const nextIdx = missing[0];
      const frameData = await this.httpRelay.fetchChunk(nextIdx);
      if (frameData) {
        await this.handleIncomingFrame(frameData);
      } else {
        // Yield briefly before checking relay again
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private async saveCurrentSession(): Promise<void> {
    if (!this.manifest || !this.scheduler) return;
    try {
      await SessionPersistence.saveSession({
        sessionId: this.manifest.sessionId,
        name: this.manifest.name,
        size: this.manifest.size,
        chunkSize: this.manifest.chunkSize,
        totalChunks: this.manifest.totalChunks,
        merkleRoot: this.manifest.merkleRoot,
        bitmapBase64: this.scheduler.completedBitmap.toBase64(),
        updatedAt: Date.now(),
      });
    } catch {}
  }

  public pause(): void {
    this.setState('paused');
    this.multipath?.pause();
    this.releaseWakeLock();
  }

  public resume(): void {
    if (this.state === 'paused') {
      this.acquireWakeLock();
      this.setState('transferring');
      this.multipath?.resume();
    }
  }

  public async cancel(): Promise<void> {
    this.releaseWakeLock();
    this.stopProgressTicker();
    this.multipath?.pause();
    if (this.webrtc) await this.webrtc.close();
    if (this.httpRelay) await this.httpRelay.close();
    if (this.diskWriter) await this.diskWriter.abort();
    this.setState('idle');
  }

  private startProgressTicker(): void {
    this.lastProgressTime = Date.now();
    this.lastProgressBytes = this.bytesTransferred;

    this.progressInterval = setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - this.lastProgressTime) / 1000;
      if (elapsedSec >= 0.5) {
        const deltaBytes = this.bytesTransferred - this.lastProgressBytes;
        const instantBps = deltaBytes / elapsedSec;
        this.currentSpeedBps = this.currentSpeedBps === 0
          ? instantBps
          : this.currentSpeedBps * 0.7 + instantBps * 0.3;

        this.lastProgressTime = now;
        this.lastProgressBytes = this.bytesTransferred;
      }

      this.emitProgress();
    }, 500);
  }

  private stopProgressTicker(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private emitProgress(): void {
    if (!this.events.onProgress) return;

    const remainingBytes = Math.max(0, this.totalBytes - this.bytesTransferred);
    const etaSeconds = this.currentSpeedBps > 0
      ? Math.ceil(remainingBytes / this.currentSpeedBps)
      : 0;

    const completedChunks = this.scheduler ? this.scheduler.getCompletedCount() : 0;
    const totalChunks = this.manifest ? this.manifest.totalChunks : 1;

    this.events.onProgress({
      state: this.state,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      chunksCompleted: completedChunks,
      totalChunks,
      speedBps: this.currentSpeedBps,
      etaSeconds,
      merkleRoot: this.manifest?.merkleRoot || '',
      activeTransports: this.multipath?.getTransportNames() || [],
    });
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      } catch {}
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch {}
      this.wakeLock = null;
    }
  }
}
