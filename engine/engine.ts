/**
 * Drop Core Transfer Engine
 * Standalone, zero-UI, zero-memory-buffering transfer engine for 50-100+ GB transfers.
 * Implements instant streaming without upfront 100 GB pre-hashing, multi-association WebRTC,
 * authenticated E2EE with HKDF, leaf hash persistence, and zero whole-file memory usage.
 */

import {
  TransferManifest,
  TransferState,
  TransferProgress,
  EngineConfig,
  IDiskWriter,
} from './types.js';
import { TransferCrypto, DerivedKeys } from './crypto.js';
import { Hasher } from './hasher.js';
import { MerkleTree } from './merkle.js';
import { FileChunker, ChunkSource, BlobChunkSource } from './chunker.js';
import { ChunkBitmap, SessionPersistence, StoredSession } from './bitmap.js';
import { WorkStealingScheduler } from './scheduler.js';
import { FrameCodec, FrameType } from './transports/types.js';
import { MultipathController } from './transports/multipath.js';
import { WebRTCPeerManager } from './transports/webrtc.js';
import { HttpRelayTransport } from './transports/http-relay.js';

export interface TransferEngineEvents {
  onStateChange?: (state: TransferState) => void;
  onConnectionChange?: (state: string) => void;
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
  private pendingEngineSignals: any[] = [];

  // Subsystems
  public crypto: TransferCrypto = new TransferCrypto();
  private chunker: FileChunker | null = null;
  private diskWriter: IDiskWriter | null = null;
  private scheduler: WorkStealingScheduler | null = null;
  private multipath: MultipathController | null = null;
  private webrtc: WebRTCPeerManager | null = null;
  private httpRelay: HttpRelayTransport | null = null;

  // Active session data
  private manifest: TransferManifest | null = null;
  private verifiedLeaves: (Uint8Array | undefined)[] = [];
  private wakeLock: any = null;
  private finalizedMerkleRoot: string | null = null;

  // Speed and throughput calculation
  private bytesTransferred = 0;
  private totalBytes = 0;
  private lastProgressTime = 0;
  private lastProgressBytes = 0;
  private currentSpeedBps = 0;
  private progressInterval: any = null;

  constructor(config: EngineConfig = {}, events: TransferEngineEvents = {}) {
    this.config = {
      defaultChunkSize: 4 * 1024 * 1024, // 4 MB chunks default
      parallelChannels: 6,
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
   * SENDER: Prepares file for transfer, derives keys, generates instant manifest,
   * and begins streaming immediately with 0 delay.
   */
  public async prepareSender(
    sourceOrBlob: ChunkSource | Blob,
    sessionId: string,
    originUrl: string = ''
  ): Promise<{ manifest: TransferManifest; shareUrl: string; keyFragment: string; authSecret: string }> {
    this.setState('waiting_peer');

    // 1. Generate master key and derive subkeys (or reuse upfront key)
    let saltHex: string;
    let fragment: string;
    let authSecret: string;
    if (this.crypto.isReady() && this.crypto.getAuthSecret()) {
      saltHex = this.crypto.getSaltHex();
      fragment = this.crypto.getFragment();
      authSecret = this.crypto.getAuthSecret();
    } else {
      const gen = await this.crypto.generateKey();
      saltHex = gen.saltHex;
      fragment = gen.fragment;
      authSecret = gen.authSecret;
    }

    // 2. Initialize chunker
    const source: ChunkSource =
      'readSlice' in sourceOrBlob ? sourceOrBlob : new BlobChunkSource(sourceOrBlob);
    this.chunker = new FileChunker(source, this.config.defaultChunkSize);
    this.totalBytes = source.size;
    this.verifiedLeaves = new Array(this.chunker.totalChunks);

    // 3. Create instant manifest without 100 GB pre-read delay
    this.manifest = this.chunker.createInstantManifest(sessionId, saltHex);

    // 4. Initialize Scheduler & Multipath
    this.scheduler = new WorkStealingScheduler(this.manifest.totalChunks);
    if (!this.multipath) {
      this.multipath = new MultipathController(this.scheduler);
    } else {
      this.multipath.setScheduler(this.scheduler);
    }
    this.setupMultipathSenderPump();

    // 5. Initialize or reuse WebRTC Multi-Association Peer Manager
    if (!this.webrtc || this.webrtc.getActiveChannels().length === 0) {
      this.setupWebRTC(true);
    } else {
      for (const ch of this.webrtc.getActiveChannels()) {
        ch.onFrame = (frame) => this.handleIncomingFrame(frame);
        this.multipath.registerTransport(ch, 2, 8);
      }
    }

    // 6. Initialize HTTP Relay if enabled
    if (this.config.relayUrl) {
      this.httpRelay = new HttpRelayTransport('relay-0', this.config.relayUrl, sessionId, authSecret);
      this.multipath.registerTransport(this.httpRelay, 4, 16);
    }

    const shareUrl = `${originUrl}/?code=${sessionId}#key=${fragment}`;
    if (this.events.onManifestReady) {
      this.events.onManifestReady(this.manifest, shareUrl, fragment);
    }

    this.startProgressTicker();
    return { manifest: this.manifest, shareUrl, keyFragment: fragment, authSecret };
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

    // 2. Open Disk Writer (preallocates space directly on disk, no RAM buffering)
    await this.diskWriter.open(manifest.name, manifest.size);

    // 3. Load ChunkBitmap & persisted leaf hashes for session resumption
    let existingBitmap: ChunkBitmap | undefined;
    const stored = await SessionPersistence.loadSession(manifest.sessionId);
    if (stored) {
      existingBitmap = ChunkBitmap.fromBase64(stored.bitmapBase64, manifest.totalChunks);
      if (stored.leafHashes && Array.isArray(stored.leafHashes)) {
        for (let i = 0; i < stored.leafHashes.length; i++) {
          const hex = stored.leafHashes[i];
          if (hex && hex.length === 64) {
            this.verifiedLeaves[i] = Hasher.fromHex(hex);
          }
        }
      }
    }

    this.scheduler = new WorkStealingScheduler(manifest.totalChunks, existingBitmap);
    this.bytesTransferred = Math.min(
      this.scheduler.getCompletedCount() * manifest.chunkSize,
      manifest.size
    );

    // 4. Multipath & WebRTC
    if (!this.multipath) {
      this.multipath = new MultipathController(this.scheduler);
    } else {
      this.multipath.setScheduler(this.scheduler);
    }

    if (!this.webrtc || this.webrtc.getActiveChannels().length === 0) {
      this.setupWebRTC(false);
    } else {
      for (const ch of this.webrtc.getActiveChannels()) {
        ch.onFrame = (frame) => this.handleIncomingFrame(frame);
        this.multipath.registerTransport(ch, 2, 8);
      }
    }

    // 5. Initialize HTTP Relay if enabled
    if (this.config.relayUrl) {
      this.httpRelay = new HttpRelayTransport('relay-0', this.config.relayUrl, manifest.sessionId, this.crypto.getAuthSecret());
      this.httpRelay.onFrame = (frame) => this.handleIncomingFrame(frame);
    }

    await this.acquireWakeLock();
    this.setState('transferring');
    this.startProgressTicker();

    // Parallel relay pull worker
    if (this.httpRelay) {
      this.startRelayPullWorker();
    }
  }

  private setupMultipathSenderPump(): void {
    if (!this.multipath || !this.chunker || !this.crypto) return;

    this.multipath.onChunkReadyToSend = async (chunkIndex, transport) => {
      try {
        const plaintext = await this.chunker!.readChunk(chunkIndex);
        // Compute leaf hash on the fly during transmission
        const leafHash = await Hasher.hashChunk(plaintext);
        this.verifiedLeaves[chunkIndex] = leafHash;

        // Authenticated AES-256-GCM encryption
        const ciphertext = await this.crypto.encryptChunk(chunkIndex, plaintext);
        const nonce = this.crypto.constructNonce(chunkIndex);

        // Frame without plaintext hash
        const frame = FrameCodec.encodeDataFrame(chunkIndex, nonce, ciphertext);
        const sent = await transport.sendFrame(frame);
        return sent;
      } catch (err: any) {
        console.error(`Failed to send chunk ${chunkIndex}:`, err);
        return false;
      }
    };
  }

  public async initializeWebRTC(isInitiator: boolean, iceServers?: RTCIceServer[]): Promise<void> {
    if (iceServers && iceServers.length > 0) {
      this.config.iceServers = iceServers;
    }

    if (this.webrtc && this.webrtc.getActiveChannels().length > 0) {
      if (this.events.onConnectionChange) {
        this.events.onConnectionChange('connected');
      }
      return;
    }

    if (!this.scheduler) {
      this.scheduler = new WorkStealingScheduler(1);
    }
    if (!this.multipath) {
      this.multipath = new MultipathController(this.scheduler);
    }

    this.setupWebRTC(isInitiator);
  }

  private setupWebRTC(isInitiator: boolean): void {
    if (this.webrtc) {
      try { this.webrtc.close(); } catch {}
    }

    this.webrtc = new WebRTCPeerManager({
      peerConnectionCount: 1, // 1 reliable SCTP peer connection with multi-streams
      channelsPerPeer: 4,     // 4 parallel data channels
      iceServers: this.config.iceServers,
      onSignal: (signal) => {
        if (this.events.onSignal) {
          this.events.onSignal(signal);
        }
      },
      onConnectionChange: (state) => {
        if (this.events.onConnectionChange) {
          this.events.onConnectionChange(state);
        }
        if (state === 'connected') {
          if (this.state === 'waiting_peer') {
            this.acquireWakeLock();
            this.setState('transferring');
            this.multipath?.start();
          }
        } else if (state === 'failed' || state === 'disconnected') {
          if (this.multipath && this.httpRelay) {
            this.multipath.triggerSchedulePump();
          }
        }
      },
    });

    this.webrtc.onChannelReady = (channelTransport) => {
      channelTransport.onFrame = (frame) => this.handleIncomingFrame(frame);
      this.multipath?.registerTransport(channelTransport, 2, 8);
      if (this.events.onConnectionChange) {
        this.events.onConnectionChange('connected');
      }
      if (this.state === 'waiting_peer') {
        this.acquireWakeLock();
        this.setState('transferring');
        this.multipath?.start();
      }
    };

    this.webrtc.initialize(isInitiator);

    if (this.pendingEngineSignals.length > 0) {
      const queued = [...this.pendingEngineSignals];
      this.pendingEngineSignals = [];
      for (const sig of queued) {
        this.webrtc.handleSignal(sig).catch(console.error);
      }
    }
  }

  public async handleSignal(signal: any): Promise<void> {
    if (this.webrtc) {
      await this.webrtc.handleSignal(signal);
    } else {
      this.pendingEngineSignals.push(signal);
    }
  }

  public startTransfer(): void {
    if (this.state === 'waiting_peer' || this.state === 'idle') {
      this.acquireWakeLock();
      this.setState('transferring');
      this.multipath?.start();
      this.startProgressTicker();
    }
  }

  /**
   * Processes incoming binary frames (Data Chunks, ACKs, NACKs, Finalize).
   */
  public async handleIncomingFrame(frameData: Uint8Array): Promise<void> {
    const frame = FrameCodec.decodeFrame(frameData);
    if (!frame) return;

    if (frame.type === FrameType.CHUNK_ACK) {
      // SENDER received ACK
      if (this.scheduler && this.manifest) {
        const chunkLen = Math.min(
          this.manifest.chunkSize,
          this.manifest.size - frame.chunkIndex * this.manifest.chunkSize
        );
        this.bytesTransferred += chunkLen;
        this.scheduler.onChunkAck(frame.chunkIndex, chunkLen);
        this.saveCurrentSession();

        if (this.scheduler.isComplete()) {
          await this.finalizeSenderTransfer();
        } else {
          this.multipath?.triggerSchedulePump();
        }
      }
    } else if (frame.type === FrameType.CHUNK_NACK) {
      // SENDER received NACK: re-queue
      this.scheduler?.onChunkNack(frame.chunkIndex);
      this.multipath?.triggerSchedulePump();
    } else if (frame.type === FrameType.DATA_CHUNK) {
      // RECEIVER received chunk: decrypt, write directly to disk
      await this.processReceivedChunk(frame);
    } else if (frame.type === FrameType.MANIFEST_FINALIZE) {
      // RECEIVER received final Merkle root notification
      const dec = new TextDecoder();
      this.finalizedMerkleRoot = dec.decode(frame.payload);
      if (this.scheduler?.isComplete()) {
        await this.verifyAndFinalizeReceiver();
      }
    }
  }

  private async processReceivedChunk(frame: any): Promise<void> {
    if (!this.manifest || !this.diskWriter || !this.scheduler) return;
    const chunkIdx = frame.chunkIndex;

    // Skip if already completed
    if (this.scheduler.completedBitmap.has(chunkIdx)) return;

    try {
      // 1. Authenticated AES-256-GCM decryption
      const plaintext = await this.crypto.decryptChunk(chunkIdx, frame.payload);

      // 2. Compute leaf hash for final Merkle tree verification
      const computedHash = await Hasher.hashChunk(plaintext);

      // 3. Write chunk directly to disk at byte offset without memory accumulation
      const offset = chunkIdx * this.manifest.chunkSize;
      await this.diskWriter.writeChunk(offset, plaintext);

      // 4. Record verified leaf hash & update scheduler
      this.verifiedLeaves[chunkIdx] = computedHash;
      this.bytesTransferred += plaintext.length;
      this.scheduler.onChunkAck(chunkIdx, plaintext.length);

      // 5. Save resume checkpoint with leaf hashes
      this.saveCurrentSession();

      // 6. Send ACK frame back
      const ackFrame = FrameCodec.encodeControlFrame(FrameType.CHUNK_ACK, chunkIdx);
      const activeChannels = this.webrtc?.getActiveChannels() || [];
      if (activeChannels.length > 0) {
        activeChannels[0].sendFrame(ackFrame);
      }

      // Check for completion
      if (this.scheduler.isComplete() && this.finalizedMerkleRoot) {
        await this.verifyAndFinalizeReceiver();
      }
    } catch (e: any) {
      console.error(`Decryption/storage authentication failure on chunk ${chunkIdx}:`, e);
      this.scheduler.onChunkNack(chunkIdx);
    }
  }

  private async finalizeSenderTransfer(): Promise<void> {
    if (!this.manifest) return;

    // Build Merkle tree from accumulated leaf hashes
    const leaves = this.verifiedLeaves.filter((l): l is Uint8Array => l !== undefined);
    const tree = new MerkleTree(leaves);
    const computedRoot = await tree.computeRoot();
    this.manifest.merkleRoot = computedRoot;

    // Broadcast MANIFEST_FINALIZE frame to receiver
    const enc = new TextEncoder();
    const finalizeFrame = FrameCodec.encodeControlFrame(
      FrameType.MANIFEST_FINALIZE,
      0,
      enc.encode(computedRoot)
    );

    const activeChannels = this.webrtc?.getActiveChannels() || [];
    for (const ch of activeChannels) {
      await ch.sendFrame(finalizeFrame);
    }

    this.setState('complete');
    this.stopProgressTicker();
    this.releaseWakeLock();

    if (this.events.onComplete) {
      this.events.onComplete(computedRoot);
    }
  }

  private async verifyAndFinalizeReceiver(): Promise<void> {
    if (!this.manifest || !this.diskWriter) return;

    this.setState('verifying');

    // Compute whole-file Merkle root
    const leaves = this.verifiedLeaves.filter((l): l is Uint8Array => l !== undefined);
    const tree = new MerkleTree(leaves);
    const computedRoot = await tree.computeRoot();

    const expectedRoot = this.finalizedMerkleRoot || this.manifest.merkleRoot;

    if (expectedRoot && expectedRoot !== 'streaming' && computedRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
      const err = new Error(
        `Whole-file Merkle root mismatch! Expected: ${expectedRoot}, Computed: ${computedRoot}`
      );
      this.setState('error');
      if (this.events.onError) this.events.onError(err);
      return;
    }

    await this.diskWriter.finalize(this.manifest.name);
    await SessionPersistence.deleteSession(this.manifest.sessionId);

    this.setState('complete');
    this.stopProgressTicker();
    this.releaseWakeLock();

    if (this.events.onComplete) {
      this.events.onComplete(computedRoot);
    }
  }

  private startRelayPullWorker(): void {
    if (!this.httpRelay || !this.scheduler) return;

    const concurrency = 6; // 6 parallel HTTP range/chunk pulls
    for (let workerId = 0; workerId < concurrency; workerId++) {
      (async () => {
        while (this.state === 'transferring' && !this.scheduler!.isComplete()) {
          const chunkIndex = this.scheduler!.acquireNextChunk(`relay-worker-${workerId}`);
          if (chunkIndex === null) {
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }

          try {
            const frame = await this.httpRelay!.fetchChunk(chunkIndex);
            if (frame) {
              await this.handleIncomingFrame(frame);
            } else {
              this.scheduler!.onChunkNack(chunkIndex);
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch {
            this.scheduler!.onChunkNack(chunkIndex);
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      })();
    }
  }

  private saveCurrentSession(): void {
    if (!this.manifest || !this.scheduler) return;
    const leafHexes = this.verifiedLeaves.map((l) => (l ? Hasher.toHex(l) : ''));

    const session: StoredSession = {
      sessionId: this.manifest.sessionId,
      name: this.manifest.name,
      size: this.manifest.size,
      chunkSize: this.manifest.chunkSize,
      totalChunks: this.manifest.totalChunks,
      merkleRoot: this.finalizedMerkleRoot || this.manifest.merkleRoot,
      bitmapBase64: this.scheduler.completedBitmap.toBase64(),
      leafHashes: leafHexes,
      updatedAt: Date.now(),
    };
    SessionPersistence.saveSession(session);
  }

  private startProgressTicker(): void {
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.lastProgressTime = performance.now();
    this.lastProgressBytes = this.bytesTransferred;

    this.progressInterval = setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - this.lastProgressTime) / 1000;
      if (elapsedSec >= 0.5) {
        const deltaBytes = this.bytesTransferred - this.lastProgressBytes;
        const instantSpeed = deltaBytes / elapsedSec;
        this.currentSpeedBps = this.currentSpeedBps === 0
          ? instantSpeed
          : this.currentSpeedBps * 0.7 + instantSpeed * 0.3;

        this.lastProgressTime = now;
        this.lastProgressBytes = this.bytesTransferred;
        this.emitProgress();
      }
    }, 250);
  }

  private stopProgressTicker(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private emitProgress(): void {
    if (!this.events.onProgress) return;
    const remaining = Math.max(0, this.totalBytes - this.bytesTransferred);
    const etaSeconds = this.currentSpeedBps > 0 ? Math.ceil(remaining / this.currentSpeedBps) : 0;
    const totalChunks = this.scheduler ? this.scheduler.totalChunks : 1;
    const completedChunks = this.scheduler ? this.scheduler.getCompletedCount() : 0;

    const activeTransports = [
      ...(this.webrtc?.getActiveChannels().map((ch) => ch.name) || []),
      ...(this.httpRelay ? [this.httpRelay.name] : []),
    ];

    this.events.onProgress({
      state: this.state,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      chunksCompleted: completedChunks,
      totalChunks,
      speedBps: Math.round(this.currentSpeedBps),
      etaSeconds,
      merkleRoot: this.finalizedMerkleRoot || this.manifest?.merkleRoot || '',
      activeTransports,
    });
  }

  public pause(): void {
    this.setState('paused');
    this.multipath?.pause();
  }

  public resume(): void {
    this.setState('transferring');
    this.multipath?.resume();
  }

  public async cancel(): Promise<void> {
    this.stopProgressTicker();
    this.releaseWakeLock();
    this.multipath?.stop();
    await this.webrtc?.close();
    await this.diskWriter?.abort();
    this.setState('idle');
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      } catch (e) {
        console.warn('Wake Lock request skipped:', e);
      }
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
