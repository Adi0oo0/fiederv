import { describe, it, expect } from 'vitest';
import { MerkleTree } from '../../engine/merkle.js';
import { Hasher } from '../../engine/hasher.js';

describe('MerkleTree', () => {
  it('computes identical root for identical leaves', async () => {
    const leaf1 = await Hasher.hashChunk(new Uint8Array([1, 2, 3]));
    const leaf2 = await Hasher.hashChunk(new Uint8Array([4, 5, 6]));
    const leaf3 = await Hasher.hashChunk(new Uint8Array([7, 8, 9]));

    const tree1 = new MerkleTree([leaf1, leaf2, leaf3]);
    const root1 = await tree1.computeRoot();

    const tree2 = new MerkleTree([leaf1, leaf2, leaf3]);
    const root2 = await tree2.computeRoot();

    expect(root1).toBe(root2);
    expect(root1.length).toBe(64); // 32-byte hex
  });

  it('fails verification if single bit is corrupted', async () => {
    const leaf1 = await Hasher.hashChunk(new Uint8Array([1, 2, 3]));
    const leaf2 = await Hasher.hashChunk(new Uint8Array([4, 5, 6]));

    const tree = new MerkleTree([leaf1, leaf2]);
    const expectedRoot = await tree.computeRoot();

    // Corrupt leaf 1
    const corruptedLeaf = new Uint8Array(leaf1);
    corruptedLeaf[0] ^= 0xff;

    const verified = await MerkleTree.verify([corruptedLeaf, leaf2], expectedRoot);
    expect(verified).toBe(false);
  });
});
