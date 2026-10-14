/**
 * Drop Core Engine Types
 * Pure TypeScript types with zero UI dependencies.
 */

export interface TransferManifest {
  sessionId: string;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  merkleRoot: string;
  mimeType?: string;
  salt?: string; // 8-char hex (4 bytes) for AES-GCM nonce salt
  saltHex?: string;
  createdAt?: number;
  isFolder?: boolean;
  folderManifest?: FolderItem[];
}

export interface FolderItem {
  path: string;
  size: number;
  offset: number; // byte offset in unified tar stream
}

export interface ChunkInfo {
  index: number;
  offset: number;
  length: number;
  hash: string; // hex
}

export interface EncryptedChunkFrame {
  index: number;
  length: number;
  hash: Uint8Array; // 32 bytes
  nonce: Uint8Array; // 12 bytes
  tag: Uint8Array; // 16 bytes
  data: Uint8Array; // ciphertext
}

export type TransferState =
  | 'idle'
  | 'waiting_peer'
  | 'transferring'
  | 'paused'
  | 'verifying'
  | 'complete'
  | 'error';

export interface TransferProgress {
  state: TransferState;
  bytesTransferred: number;
  totalBytes: number;
  chunksCompleted: number;
  totalChunks: number;
  speedBps: number;
  etaSeconds: number;
  merkleRoot: string;
  activeTransports: string[];
  errorMessage?: string;
}

export interface EngineConfig {
  defaultChunkSize?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
  parallelChannels?: number;
  relayUrl?: string;
  iceServers?: RTCIceServer[];
  enableRelayFallback?: boolean;
  enableCompression?: boolean;
}

export interface IDiskWriter {
  open(fileName: string, totalSize: number): Promise<void>;
  writeChunk(offset: number, data: Uint8Array): Promise<void>;
  finalize(finalName: string): Promise<void>;
  abort(): Promise<void>;
  isPersistent(): boolean;
  getDownloadUrl?(): string | null;
}
