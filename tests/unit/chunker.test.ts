import { describe, it, expect } from 'vitest';
import { FileChunker, MemoryOrMockChunkSource } from '../../engine/chunker.js';

describe('FileChunker', () => {
  it('correctly splits file into bounded chunks without buffering', async () => {
    const totalSize = 25 * 1024 * 1024; // 25 MB
    const chunkSize = 8 * 1024 * 1024; // 8 MB

    const source = new MemoryOrMockChunkSource('test.dat', totalSize);
    const chunker = new FileChunker(source, chunkSize);

    // 25 MB / 8 MB = 4 chunks (8MB, 8MB, 8MB, 1MB)
    expect(chunker.totalChunks).toBe(4);

    const chunk0 = await chunker.readChunk(0);
    expect(chunk0.length).toBe(8 * 1024 * 1024);

    const chunk3 = await chunker.readChunk(3);
    expect(chunk3.length).toBe(1 * 1024 * 1024);
  });

  it('generates consistent Merkle root and manifest', async () => {
    const totalSize = 10 * 1024 * 1024;
    const source = new MemoryOrMockChunkSource('sample.bin', totalSize);
    const chunker = new FileChunker(source, 4 * 1024 * 1024);

    const { manifest, leafHashes } = await chunker.generateManifest('sess-1', '01020304');
    expect(manifest.name).toBe('sample.bin');
    expect(manifest.size).toBe(totalSize);
    expect(manifest.totalChunks).toBe(3);
    expect(manifest.merkleRoot).toBeTruthy();
    expect(leafHashes.length).toBe(3);
  });
});
