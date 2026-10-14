/**
 * File Chunker for Drop
 * Zero-memory buffering streaming reader using Blob.slice() and File.stream().
 * Never loads whole files into memory. Supports instant manifest generation
 * without upfront 100 GB hashing pre-passes.
 */

import { ChunkInfo, TransferManifest } from './types.js';
import { Hasher } from './hasher.js';
import { MerkleTree } from './merkle.js';

export interface ChunkSource {
  name: string;
  size: number;
  readSlice(start: number, end: number): Promise<Uint8Array>;
}

export class BlobChunkSource implements ChunkSource {
  public readonly name: string;
  public readonly size: number;
  private blob: Blob;

  constructor(fileOrBlob: Blob, name?: string) {
    this.blob = fileOrBlob;
    this.name = name || (fileOrBlob instanceof File ? fileOrBlob.name : 'transfer.bin');
    this.size = fileOrBlob.size;
  }

  public async readSlice(start: number, end: number): Promise<Uint8Array> {
    const slice = this.blob.slice(start, end);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

export class MemoryOrMockChunkSource implements ChunkSource {
  public readonly name: string;
  public readonly size: number;
  private generator?: (offset: number, length: number) => Uint8Array;

  constructor(name: string, size: number, generator?: (offset: number, length: number) => Uint8Array) {
    this.name = name;
    this.size = size;
    this.generator = generator;
  }

  public async readSlice(start: number, end: number): Promise<Uint8Array> {
    const length = Math.min(end - start, this.size - start);
    if (this.generator) {
      return this.generator(start, length);
    }
    // Default deterministic pattern for tests
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i += 4096) {
      arr[i] = (start + i) % 256;
    }
    return arr;
  }
}

export class FileChunker {
  public readonly source: ChunkSource;
  public readonly chunkSize: number;
  public readonly totalChunks: number;

  constructor(source: ChunkSource, chunkSize: number = 8 * 1024 * 1024) {
    this.source = source;
    // Adaptive chunk size between 256 KB and 64 MB
    this.chunkSize = Math.max(256 * 1024, Math.min(64 * 1024 * 1024, chunkSize));
    this.totalChunks = Math.ceil(source.size / this.chunkSize) || 1;
  }

  public getChunkInfo(index: number): ChunkInfo {
    if (index < 0 || index >= this.totalChunks) {
      throw new Error(`Chunk index ${index} out of bounds (0..${this.totalChunks - 1})`);
    }
    const offset = index * this.chunkSize;
    const length = Math.min(this.chunkSize, this.source.size - offset);
    return {
      index,
      offset,
      length,
      hash: '',
    };
  }

  /**
   * Reads a single chunk on-demand without buffering preceding or succeeding chunks.
   */
  public async readChunk(index: number): Promise<Uint8Array> {
    const info = this.getChunkInfo(index);
    return this.source.readSlice(info.offset, info.offset + info.length);
  }

  /**
   * Generates manifest immediately without blocking or pre-reading the entire file.
   * Transfer starts in 0 milliseconds; Merkle root is streamed and finalized at the end.
   */
  public createInstantManifest(sessionId: string, saltHex: string): TransferManifest {
    return {
      sessionId,
      name: this.source.name,
      size: this.source.size,
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
      merkleRoot: 'streaming',
      saltHex,
      createdAt: Date.now(),
    };
  }

  /**
   * Generates whole-file TransferManifest and Merkle tree root upfront (for tests and benchmarks).
   */
  public async generateManifest(
    sessionId: string,
    saltHex: string,
    onProgress?: (processedBytes: number, totalBytes: number) => void
  ): Promise<{ manifest: TransferManifest; leafHashes: Uint8Array[] }> {
    const leafHashes: Uint8Array[] = new Array(this.totalChunks);
    let processedBytes = 0;

    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = await this.readChunk(i);
      leafHashes[i] = await Hasher.hashChunk(chunk);
      processedBytes += chunk.length;
      if (onProgress) {
        onProgress(processedBytes, this.source.size);
      }
    }

    const tree = new MerkleTree(leafHashes);
    const merkleRoot = await tree.computeRoot();

    const manifest: TransferManifest = {
      sessionId,
      name: this.source.name,
      size: this.source.size,
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
      merkleRoot,
      saltHex,
      createdAt: Date.now(),
    };

    return { manifest, leafHashes };
  }
}
