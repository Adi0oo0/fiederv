import { FileMetadata, TransferProgress, ReceivedFileItem, ConnectionState, ChannelStat } from '../types/transfer';
import { computeBlobCRC32 } from './crc32';
import { isCompressibleFast, compressBlock, decompressBlock, getFileCompressionCategory, getOptimalChunkSize } from './compression';
import { E2EESession } from './crypto';

// Default base chunk size for optimal WebRTC MTU
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
// Dynamic BDP Buffer thresholds: 512 KB min, 4 MB max based on throughput
export const MIN_BUFFER_THRESHOLD = 512 * 1024;
export const MAX_BUFFER_THRESHOLD = 4 * 1024 * 1024;
export const BUFFER_LOW_THRESHOLD = 128 * 1024;
// 4 dedicated high-throughput parallel stream channels
export const NUM_DATA_CHANNELS = 4;

// Binary Frame Header Size: 16 bytes
// [0..3] Uint32: File Sequence Index
//   Bit 31 (0x80000000): Compressed block flag
//   Bit 30 (0x40000000): End-to-End Encrypted (AES-256-GCM) block flag
// [4..7] Uint32: Chunk Index
// [8..11] Uint32: Total Chunks
// [12..15] Uint32: Payload Length
const HEADER_SIZE = 16;
const FLAG_COMPRESSED = 0x80000000;
const FLAG_ENCRYPTED = 0x40000000;

export interface WebRTCCallbacks {
  onConnectionStateChange: (state: ConnectionState) => void;
  onSignal: (signal: any) => void;
  onFileManifestReceived: (files: FileMetadata[]) => void;
  onTransferProgress: (progress: TransferProgress) => void;
  onFileCompleted: (file: ReceivedFileItem) => void;
  onAllCompleted: () => void;
  onChannelStats: (stats: ChannelStat[]) => void;
}

export class P2PTransferEngine {
  private pc: RTCPeerConnection | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private controlChannel: RTCDataChannel | null = null;
  private isInitiator = false;
  private callbacks: WebRTCCallbacks;

  // ICE candidates arrived before remote description
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Signals arrived before PC initialization
  private pendingSignals: any[] = [];

  // File sending state
  private isSending = false;
  private cancelRequested = false;

  // File receiving state
  private incomingFiles: Map<number, {
    metadata: FileMetadata;
    chunks: ArrayBuffer[];
    receivedChunksCount: number;
    receivedBytes: number;
    finalized?: boolean;
  }> = new Map();

  // Speed and throughput calculation state (physical vs apparent)
  private speedTimer: any = null;
  private lastPhysicalBytes = 0;
  private lastEffectiveBytes = 0;
  private currentSpeedBps = 0; // Apparent speed
  private currentPhysicalSpeedBps = 0; // Wire speed
  private currentApparentSpeedBps = 0; // Effective uncompressed speed
  private totalBytesToTransfer = 0;
  private totalBytesTransferred = 0; // Apparent bytes
  private totalPhysicalBytesTransferred = 0; // Physical wire bytes
  public e2ee: E2EESession = new E2EESession();

  constructor(callbacks: WebRTCCallbacks) {
    this.callbacks = callbacks;
  }

  public async setE2EEKey(keyFragment: string): Promise<void> {
    if (keyFragment) {
      await this.e2ee.initFromFragment(keyFragment);
    }
  }

  private closePeerConnection() {
    this.stopSpeedMonitor();
    this.isSending = false;
    this.cancelRequested = false;

    this.dataChannels.forEach((dc) => {
      try {
        dc.close();
      } catch (e) {
        // ignore
      }
    });
    this.dataChannels = [];

    if (this.controlChannel) {
      try {
        this.controlChannel.close();
      } catch (e) {
        // ignore
      }
      this.controlChannel = null;
    }

    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {
        // ignore
      }
      this.pc = null;
    }
  }

  public async initializeConnection(isInitiator: boolean, iceServers?: RTCIceServer[]) {
    this.closePeerConnection();
    this.isInitiator = isInitiator;
    this.callbacks.onConnectionStateChange('connecting_peer');

    const config: RTCConfiguration = {
      iceServers: iceServers && iceServers.length > 0 ? iceServers : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:openrelay.metered.ca:80' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelay',
          credential: 'openrelay'
        }
      ]
    };

    try {
      this.pc = new RTCPeerConnection(config);

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.callbacks.onSignal({
            type: 'candidate',
            candidate: event.candidate.toJSON()
          });
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        if (!this.pc) return;
        const iceState = this.pc.iceConnectionState;
        if (iceState === 'connected' || iceState === 'completed') {
          this.checkAllChannelsReady();
        } else if (iceState === 'failed') {
          console.warn('WebRTC ICE failed, attempting restart');
          this.pc.restartIce?.();
        }
      };

      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const state = this.pc.connectionState;
        if (state === 'connected') {
          this.checkAllChannelsReady();
          this.startSpeedMonitor();
        } else if (state === 'failed') {
          this.callbacks.onConnectionStateChange('failed');
          this.stopSpeedMonitor();
        } else if (state === 'disconnected' || state === 'closed') {
          this.callbacks.onConnectionStateChange('disconnected');
          this.stopSpeedMonitor();
        }
      };

      if (this.isInitiator) {
        // Initiator creates control channel and parallel data streams
        this.controlChannel = this.pc.createDataChannel('aero_control', {
          ordered: true
        });
        this.setupControlChannel(this.controlChannel);

        for (let i = 0; i < NUM_DATA_CHANNELS; i++) {
          const dc = this.pc.createDataChannel(`aero_stream_${i}`, {
            ordered: false
          });
          dc.binaryType = 'arraybuffer';
          this.dataChannels.push(dc);
          this.setupDataChannel(dc, i);
        }

        // Generate SDP offer
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.callbacks.onSignal({ type: 'offer', sdp: offer.sdp });
      } else {
        // Receiver listens for data channels created by initiator
        this.pc.ondatachannel = (event) => {
          const dc = event.channel;
          if (dc.label === 'aero_control') {
            this.controlChannel = dc;
            this.setupControlChannel(dc);
          } else if (dc.label.startsWith('aero_stream_')) {
            const channelIndex = parseInt(dc.label.replace('aero_stream_', ''), 10) || 0;
            dc.binaryType = 'arraybuffer';
            if (!this.dataChannels.some((c) => c.label === dc.label)) {
              this.dataChannels.push(dc);
            }
            this.setupDataChannel(dc, channelIndex);
          }
          this.checkAllChannelsReady();
        };
      }

      // Process any early signals that arrived before RTCPeerConnection was ready
      if (this.pendingSignals.length > 0) {
        const queued = [...this.pendingSignals];
        this.pendingSignals = [];
        for (const sig of queued) {
          await this.handleSignal(sig);
        }
      }
    } catch (err) {
      console.error('Failed to initialize WebRTC PeerConnection:', err);
      this.callbacks.onConnectionStateChange('failed');
    }
  }

  public async handleSignal(signal: any) {
    if (!this.pc) {
      this.pendingSignals.push(signal);
      return;
    }

    try {
      if (signal.type === 'offer') {
        // Handle SDP glare (collision)
        if (this.pc.signalingState !== 'stable') {
          if (!this.isInitiator) {
            await this.pc.setLocalDescription({ type: 'rollback' });
          } else {
            // Initiator ignores incoming offer collision
            return;
          }
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        await this.drainPendingCandidates();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.callbacks.onSignal({ type: 'answer', sdp: answer.sdp });
      } else if (signal.type === 'answer') {
        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
          await this.drainPendingCandidates();
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          this.pendingCandidates.push(signal.candidate);
        }
      }
    } catch (e) {
      console.error('Failed to handle WebRTC signal:', e);
    }
  }

  private async drainPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingCandidates.length > 0) {
      const cand = this.pendingCandidates.shift();
      if (cand) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('Failed to add queued ICE candidate:', e);
        }
      }
    }
  }

  private setupControlChannel(dc: RTCDataChannel) {
    if (dc.readyState === 'open') {
      this.checkAllChannelsReady();
    } else {
      dc.onopen = () => {
        this.checkAllChannelsReady();
      };
    }

    dc.onclose = () => {
      this.callbacks.onConnectionStateChange('disconnected');
    };

    dc.onerror = (e) => {
      console.warn('Control channel error:', e);
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'manifest') {
          const files: FileMetadata[] = msg.files;
          this.totalBytesToTransfer = files.reduce((acc, f) => acc + f.size, 0);
          this.totalBytesTransferred = 0;
          this.incomingFiles.clear();

          files.forEach((file, idx) => {
            this.incomingFiles.set(idx, {
              metadata: file,
              chunks: new Array(file.totalChunks),
              receivedChunksCount: 0,
              receivedBytes: 0,
            });
          });

          this.callbacks.onFileManifestReceived(files);

          // Immediately dispatch preparing progress so receiver UI sees it right away
          if (files.length > 0) {
            this.callbacks.onTransferProgress({
              fileId: files[0].id,
              chunksCompleted: 0,
              totalChunks: files[0].totalChunks,
              bytesTransferred: 0,
              totalBytes: files[0].size,
              speedBps: 0,
              percent: 0,
              etaSeconds: 0,
              status: 'preparing',
            });
          }
        } else if (msg.type === 'cancel') {
          this.isSending = false;
        }
      } catch (e) {
        console.error('Control message error:', e);
      }
    };
  }

  private setupDataChannel(dc: RTCDataChannel, _index: number) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    if (dc.readyState === 'open') {
      this.checkAllChannelsReady();
    } else {
      dc.onopen = () => {
        this.checkAllChannelsReady();
      };
    }

    dc.onerror = (e) => {
      console.warn('Data channel error:', e);
    };

    dc.onmessage = async (event) => {
      if (typeof event.data !== 'string') {
        await this.handleIncomingChunk(event.data as ArrayBuffer);
      }
    };
  }

  private checkAllChannelsReady() {
    const isControlOpen = this.controlChannel?.readyState === 'open';
    const openDataChannels = this.dataChannels.filter((ch) => ch.readyState === 'open');

    // Tunnel is active when control channel and at least one stream channel are fully open
    if (isControlOpen && openDataChannels.length > 0) {
      this.callbacks.onConnectionStateChange('connected');
      this.startSpeedMonitor();
    }
  }

  private async handleIncomingChunk(buffer: ArrayBuffer) {
    if (buffer.byteLength < HEADER_SIZE) return;

    const headerView = new DataView(buffer, 0, HEADER_SIZE);
    const rawFileIndex = headerView.getUint32(0, false);
    const chunkIndex = headerView.getUint32(4, false);
    const totalChunks = headerView.getUint32(8, false);
    const payloadLength = headerView.getUint32(12, false);

    if (buffer.byteLength < HEADER_SIZE + payloadLength) return;

    const isChunkCompressed = (rawFileIndex & FLAG_COMPRESSED) !== 0;
    const isChunkEncrypted = (rawFileIndex & FLAG_ENCRYPTED) !== 0;
    const fileIndex = (rawFileIndex & ~(FLAG_COMPRESSED | FLAG_ENCRYPTED)) >>> 0;

    const fileRecord = this.incomingFiles.get(fileIndex);
    if (!fileRecord || fileRecord.finalized) return;

    if (chunkIndex >= totalChunks) return;

    // Prevent duplicate processing
    if (fileRecord.chunks[chunkIndex]) return;

    let payload = new Uint8Array(buffer, HEADER_SIZE, payloadLength);

    // 1. Decrypt chunk if encrypted with E2EE AES-256-GCM
    if (isChunkEncrypted) {
      if (!this.e2ee.isReady()) {
        console.error(`Received encrypted chunk for file ${fileIndex} but E2EE key is not set.`);
        return;
      }
      try {
        payload = (await this.e2ee.decryptChunk(chunkIndex, payload)) as any;
      } catch (err) {
        console.error(`E2EE decryption authentication failed for file ${fileIndex} chunk ${chunkIndex}:`, err);
        return;
      }
    }

    // 2. Decompress chunk if compressed
    let rawBuffer: ArrayBuffer;
    if (isChunkCompressed) {
      try {
        const decompressed = await decompressBlock(payload);
        const copy = new Uint8Array(decompressed.byteLength);
        copy.set(decompressed);
        rawBuffer = copy.buffer;
      } catch (err) {
        console.error(`Decompression failed for file ${fileIndex} chunk ${chunkIndex}:`, err);
        return;
      }
    } else {
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      rawBuffer = copy.buffer;
    }

    fileRecord.chunks[chunkIndex] = rawBuffer;
    fileRecord.receivedChunksCount++;
    fileRecord.receivedBytes += rawBuffer.byteLength;
    this.totalBytesTransferred += rawBuffer.byteLength;
    this.totalPhysicalBytesTransferred += buffer.byteLength;

    // Update progress with apparent vs physical throughput
    const fileBytes = fileRecord.receivedBytes;
    const fileTotalBytes = fileRecord.metadata.size;
    const percent = fileTotalBytes > 0 ? Math.min(100, Math.round((fileBytes / fileTotalBytes) * 100)) : 100;
    const remainingBytes = fileTotalBytes - fileBytes;
    const speed = this.currentApparentSpeedBps || this.currentSpeedBps;
    const eta = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;
    const currentRatio = this.totalPhysicalBytesTransferred > 0
      ? (this.totalBytesTransferred / this.totalPhysicalBytesTransferred)
      : 1;

    this.callbacks.onTransferProgress({
      fileId: fileRecord.metadata.id,
      chunksCompleted: fileRecord.receivedChunksCount,
      totalChunks,
      bytesTransferred: fileBytes,
      totalBytes: fileTotalBytes,
      speedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
      physicalSpeedBps: this.currentPhysicalSpeedBps,
      apparentSpeedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
      compressionRatio: Number(currentRatio.toFixed(1)),
      percent,
      etaSeconds: eta,
      status: fileRecord.receivedChunksCount === totalChunks ? 'verifying' : 'transferring',
    });

    // Check if this file has received all chunks
    if (fileRecord.receivedChunksCount === totalChunks) {
      this.finalizeReceivedFile(fileIndex, fileRecord);
    }
  }

  private async finalizeReceivedFile(
    fileIndex: number,
    fileRecord: {
      metadata: FileMetadata;
      chunks: ArrayBuffer[];
      receivedChunksCount: number;
      receivedBytes: number;
      finalized?: boolean;
    }
  ) {
    if (fileRecord.finalized) return;
    fileRecord.finalized = true;

    try {
      const finalBlob = new Blob(fileRecord.chunks, {
        type: fileRecord.metadata.type || 'application/octet-stream'
      });

      // Release chunk ArrayBuffers from memory to prevent browser tab bloat
      fileRecord.chunks = [];

      // Streaming CRC32 calculation on reconstructed file - NO whole-file ArrayBuffer buffering!
      const finalHex = await computeBlobCRC32(finalBlob);
      const isVerified = !fileRecord.metadata.crc32 || fileRecord.metadata.crc32 === finalHex;

      const downloadUrl = URL.createObjectURL(finalBlob);

      const completedItem: ReceivedFileItem = {
        ...fileRecord.metadata,
        blob: finalBlob,
        downloadUrl,
        receivedBytes: finalBlob.size,
        chunksReceived: fileRecord.receivedChunksCount,
        verified: isVerified,
        completedAt: Date.now(),
      };

      const currentRatio = this.totalPhysicalBytesTransferred > 0
        ? (this.totalBytesTransferred / this.totalPhysicalBytesTransferred)
        : 1;

      this.callbacks.onTransferProgress({
        fileId: fileRecord.metadata.id,
        chunksCompleted: fileRecord.metadata.totalChunks,
        totalChunks: fileRecord.metadata.totalChunks,
        bytesTransferred: fileRecord.metadata.size,
        totalBytes: fileRecord.metadata.size,
        speedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
        physicalSpeedBps: this.currentPhysicalSpeedBps,
        apparentSpeedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
        compressionRatio: Number(currentRatio.toFixed(1)),
        percent: 100,
        etaSeconds: 0,
        status: 'completed',
      });

      this.callbacks.onFileCompleted(completedItem);

      // Check if all files in manifest are done
      let allDone = true;
      for (const rec of this.incomingFiles.values()) {
        if (rec.receivedChunksCount < rec.metadata.totalChunks) {
          allDone = false;
          break;
        }
      }
      if (allDone) {
        this.callbacks.onAllCompleted();
      }
    } catch (err) {
      console.error('Failed to finalize received file:', err);
    }
  }

  private getDynamicBufferThreshold(): number {
    // Dynamic BDP threshold: ~120ms of buffer flight time based on current physical throughput
    // Clamped between MIN_BUFFER_THRESHOLD (512 KB) and MAX_BUFFER_THRESHOLD (4 MB)
    const bps = this.currentPhysicalSpeedBps || (this.currentApparentSpeedBps > 0 ? this.currentApparentSpeedBps / 2 : 0);
    if (bps <= 0) return MIN_BUFFER_THRESHOLD;
    return Math.min(MAX_BUFFER_THRESHOLD, Math.max(MIN_BUFFER_THRESHOLD, Math.round(bps * 0.12)));
  }

  private getBestHeadroomChannel(): RTCDataChannel {
    const openChannels = this.dataChannels.filter((ch) => ch.readyState === 'open');
    if (openChannels.length === 0) {
      throw new Error('No open WebRTC data channels available for streaming.');
    }
    // Select channel with least buffered amount to prevent any channel from sitting idle
    let best = openChannels[0];
    for (let i = 1; i < openChannels.length; i++) {
      if (openChannels[i].bufferedAmount < best.bufferedAmount) {
        best = openChannels[i];
      }
    }
    return best;
  }

  private waitForBufferHeadroom(threshold: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const cleanups: (() => void)[] = [];

      const onReady = () => {
        if (!resolved) {
          resolved = true;
          cleanups.forEach((fn) => fn());
          resolve();
        }
      };

      const openChannels = this.dataChannels.filter((ch) => ch.readyState === 'open');
      if (openChannels.length === 0 || this.cancelRequested || !this.isSending) {
        onReady();
        return;
      }

      const lowThreshold = Math.max(64 * 1024, Math.round(threshold * 0.25));
      openChannels.forEach((ch) => {
        try {
          ch.bufferedAmountLowThreshold = lowThreshold;
          ch.addEventListener('bufferedamountlow', onReady, { once: true });
          cleanups.push(() => ch.removeEventListener('bufferedamountlow', onReady));
        } catch (e) {
          // ignore
        }
      });

      // Quick polling fallback in case threshold was crossed or event didn't fire
      const interval = setInterval(() => {
        if (this.cancelRequested || !this.isSending) {
          onReady();
          return;
        }
        const hasRoom = this.dataChannels.some(
          (ch) => ch.readyState === 'open' && ch.bufferedAmount <= lowThreshold * 1.5
        );
        if (hasRoom) {
          onReady();
        }
      }, 15);
      cleanups.push(() => clearInterval(interval));
    });
  }

  public async sendFiles(files: File[]): Promise<void> {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      throw new Error('WebRTC control channel is not open. Wait for connection.');
    }

    const openChannels = this.dataChannels.filter((ch) => ch.readyState === 'open');
    if (openChannels.length === 0) {
      throw new Error('No open WebRTC data channels available for file streaming.');
    }

    this.isSending = true;
    this.cancelRequested = false;

    // 1. Prepare manifest & fast compressibility assessment without whole-file memory buffering
    const manifest: FileMetadata[] = [];
    const compSettingsMap = new Map<number, { isComp: boolean; chunkSize: number; expectedRatio: number }>();

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];

      // Streaming CRC32 calculation in 2MB slices - NO whole-file ArrayBuffer buffering!
      const crc = await computeBlobCRC32(file);

      // Fast type-specific entropy + extension assessment
      const compEval = await isCompressibleFast(file);
      const chunkSize = getOptimalChunkSize(compEval.category);
      compSettingsMap.set(idx, { isComp: compEval.isCompressible, chunkSize, expectedRatio: compEval.expectedRatio });

      const totalChunks = Math.ceil(file.size / chunkSize) || 1;

      manifest.push({
        id: `${idx}_${file.name}_${file.size}`,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        totalChunks,
        chunkSize,
        crc32: crc,
        lastModified: file.lastModified,
        compressed: compEval.isCompressible,
        compressionRatio: compEval.expectedRatio,
        encrypted: this.e2ee.isReady(),
      });
    }

    this.totalBytesToTransfer = manifest.reduce((acc, m) => acc + m.size, 0);
    this.totalBytesTransferred = 0;
    this.totalPhysicalBytesTransferred = 0;

    // Send manifest over control channel
    this.controlChannel.send(JSON.stringify({
      type: 'manifest',
      files: manifest,
    }));

    // Brief tick for receiver to allocate indexed chunk slots
    await new Promise((r) => setTimeout(r, 100));

    // 2. Non-blocking asynchronous dispatch loop with dynamic BDP buffer management
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (this.cancelRequested) break;

      const file = files[fileIndex];
      const meta = manifest[fileIndex];
      const totalChunks = meta.totalChunks;
      const fileSettings = compSettingsMap.get(fileIndex) || { isComp: false, chunkSize: DEFAULT_CHUNK_SIZE, expectedRatio: 1.0 };
      const currentChunkSize = fileSettings.chunkSize;
      const isComp = fileSettings.isComp;

      let chunksCompleted = 0;
      let effectiveSentForFile = 0;
      let physicalSentForFile = 0;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.cancelRequested) break;

        const start = chunkIndex * currentChunkSize;
        const end = Math.min(start + currentChunkSize, file.size);
        const slice = file.slice(start, end);
        const rawArrayBuffer = await slice.arrayBuffer();
        const rawBytes = new Uint8Array(rawArrayBuffer);
        const rawLength = rawBytes.byteLength;

        // 1. Block-level in-flight compression without whole-file memory buffering
        let payloadBytes: Uint8Array = rawBytes;
        let chunkIsCompressed = false;

        if (isComp) {
          const compBlock = await compressBlock(rawBytes);
          if (compBlock) {
            payloadBytes = compBlock;
            chunkIsCompressed = true;
          }
        }

        // 2. Block-level End-to-End Encryption with AES-256-GCM
        let chunkIsEncrypted = false;
        if (this.e2ee.isReady()) {
          try {
            payloadBytes = await this.e2ee.encryptChunk(chunkIndex, payloadBytes);
            chunkIsEncrypted = true;
          } catch (err) {
            console.error('E2EE encryption error:', err);
          }
        }

        const payloadLength = payloadBytes.byteLength;

        // Construct 16-byte binary header with compression and encryption bitflags
        const packet = new ArrayBuffer(HEADER_SIZE + payloadLength);
        const headerView = new DataView(packet, 0, HEADER_SIZE);
        let fileIndexHeader = fileIndex;
        if (chunkIsCompressed) fileIndexHeader |= FLAG_COMPRESSED;
        if (chunkIsEncrypted) fileIndexHeader |= FLAG_ENCRYPTED;

        headerView.setUint32(0, fileIndexHeader, false);
        headerView.setUint32(4, chunkIndex, false);
        headerView.setUint32(8, totalChunks, false);
        headerView.setUint32(12, payloadLength, false);

        new Uint8Array(packet, HEADER_SIZE).set(payloadBytes);

        // Dynamic BDP Buffer Management: dispatch to channel with most headroom
        const dynamicThreshold = this.getDynamicBufferThreshold();
        let bestChannel = this.getBestHeadroomChannel();

        while (bestChannel.bufferedAmount > dynamicThreshold && !this.cancelRequested && this.isSending) {
          await this.waitForBufferHeadroom(dynamicThreshold);
          bestChannel = this.getBestHeadroomChannel();
        }

        if (this.cancelRequested || !this.isSending) break;

        bestChannel.send(packet);

        chunksCompleted++;
        effectiveSentForFile += rawLength;
        physicalSentForFile += packet.byteLength;
        this.totalBytesTransferred += rawLength; // Apparent uncompressed data delivered
        this.totalPhysicalBytesTransferred += packet.byteLength; // Physical wire bytes

        // Progress notification with apparent vs physical throughput metrics
        const percent = file.size > 0 ? Math.min(100, Math.round((effectiveSentForFile / file.size) * 100)) : 100;
        const remainingBytes = file.size - effectiveSentForFile;
        const speed = this.currentApparentSpeedBps || this.currentSpeedBps;
        const eta = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;
        const currentRatio = physicalSentForFile > 0 ? (effectiveSentForFile / physicalSentForFile) : 1;

        this.callbacks.onTransferProgress({
          fileId: meta.id,
          chunksCompleted,
          totalChunks,
          bytesTransferred: effectiveSentForFile,
          totalBytes: file.size,
          speedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
          physicalSpeedBps: this.currentPhysicalSpeedBps,
          apparentSpeedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
          compressionRatio: Number(currentRatio.toFixed(1)),
          percent,
          etaSeconds: eta,
          status: 'transferring',
        });
      }

      const finalRatio = physicalSentForFile > 0 ? (effectiveSentForFile / physicalSentForFile) : 1;
      this.callbacks.onTransferProgress({
        fileId: meta.id,
        chunksCompleted: totalChunks,
        totalChunks,
        bytesTransferred: file.size,
        totalBytes: file.size,
        speedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
        physicalSpeedBps: this.currentPhysicalSpeedBps,
        apparentSpeedBps: this.currentApparentSpeedBps || this.currentSpeedBps,
        compressionRatio: Number(finalRatio.toFixed(1)),
        percent: 100,
        etaSeconds: 0,
        status: 'completed',
      });
    }

    this.isSending = false;
    this.callbacks.onAllCompleted();
  }

  public cancelTransfer() {
    this.cancelRequested = true;
    this.isSending = false;
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      try {
        this.controlChannel.send(JSON.stringify({ type: 'cancel' }));
      } catch (e) {
        // ignore
      }
    }
  }

  private startSpeedMonitor() {
    this.stopSpeedMonitor();
    this.lastEffectiveBytes = this.totalBytesTransferred;
    this.lastPhysicalBytes = this.totalPhysicalBytesTransferred;
    let lastSampleTime = performance.now();

    this.speedTimer = setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - lastSampleTime) / 1000;
      lastSampleTime = now;
      if (elapsedSec <= 0) return;

      const deltaEffective = this.totalBytesTransferred - this.lastEffectiveBytes;
      const deltaPhysical = this.totalPhysicalBytesTransferred - this.lastPhysicalBytes;
      this.lastEffectiveBytes = this.totalBytesTransferred;
      this.lastPhysicalBytes = this.totalPhysicalBytesTransferred;

      this.currentPhysicalSpeedBps = Math.max(0, Math.round(deltaPhysical / elapsedSec));
      this.currentApparentSpeedBps = Math.max(0, Math.round(deltaEffective / elapsedSec));

      // Apparent speed is at least the physical wire speed
      if (this.currentApparentSpeedBps < this.currentPhysicalSpeedBps) {
        this.currentApparentSpeedBps = this.currentPhysicalSpeedBps;
      }
      this.currentSpeedBps = this.currentApparentSpeedBps;

      // Report channel stats
      const stats: ChannelStat[] = this.dataChannels.map((ch, idx) => ({
        id: idx,
        bufferedAmount: ch.bufferedAmount,
        bytesSent: 0,
        bytesReceived: 0,
        active: ch.readyState === 'open',
      }));
      this.callbacks.onChannelStats(stats);
    }, 500);
  }

  private stopSpeedMonitor() {
    if (this.speedTimer) {
      clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    this.currentSpeedBps = 0;
    this.currentPhysicalSpeedBps = 0;
    this.currentApparentSpeedBps = 0;
  }

  public cleanup() {
    this.closePeerConnection();
    this.pendingCandidates = [];
    this.pendingSignals = [];
    this.incomingFiles.clear();
    this.totalBytesTransferred = 0;
    this.totalPhysicalBytesTransferred = 0;
    this.lastPhysicalBytes = 0;
    this.lastEffectiveBytes = 0;
    this.currentPhysicalSpeedBps = 0;
    this.currentApparentSpeedBps = 0;
  }
}
