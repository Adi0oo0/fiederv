/**
 * Merkle Tree implementation for Drop
 * Whole-file binary Merkle tree for verifying multi-gigabyte transfers with zero loss.
 */

import { Hasher } from './hasher.js';

export class MerkleTree {
  private leaves: Uint8Array[];
  private root: Uint8Array | null = null;

  constructor(leafHashes?: Uint8Array[]) {
    this.leaves = leafHashes ? [...leafHashes] : [];
  }

  public setLeaves(leafHashes: Uint8Array[]): void {
    this.leaves = [...leafHashes];
    this.root = null;
  }

  public setLeaf(index: number, hash: Uint8Array): void {
    this.leaves[index] = hash;
    this.root = null;
  }

  public getLeaf(index: number): Uint8Array | undefined {
    return this.leaves[index];
  }

  public getLeafCount(): number {
    return this.leaves.length;
  }

  /**
   * Computes the Merkle root hash across all leaves.
   * If leaf count is 0, returns a 32-byte zero hash.
   */
  public async computeRoot(): Promise<string> {
    if (this.leaves.length === 0) {
      return Hasher.toHex(new Uint8Array(32));
    }

    if (this.leaves.length === 1) {
      this.root = this.leaves[0];
      return Hasher.toHex(this.root);
    }

    let currentLevel: Uint8Array[] = [...this.leaves];

    while (currentLevel.length > 1) {
      const nextLevel: Uint8Array[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          const parent = await Hasher.combineMerkleNodes(currentLevel[i], currentLevel[i + 1]);
          nextLevel.push(parent);
        } else {
          // Odd node promoted directly to parent level
          nextLevel.push(currentLevel[i]);
        }
      }

      currentLevel = nextLevel;
    }

    this.root = currentLevel[0];
    return Hasher.toHex(this.root);
  }

  /**
   * Verifies an array of leaf hashes against an expected root hash.
   */
  public static async verify(leaves: Uint8Array[], expectedRootHex: string): Promise<boolean> {
    const tree = new MerkleTree(leaves);
    const calculatedRoot = await tree.computeRoot();
    return calculatedRoot.toLowerCase() === expectedRootHex.toLowerCase();
  }

  /**
   * Formats a Merkle root for clean monospace UI display:
   * e.g., "7f8b9a2c...4e1d"
   */
  public static formatMonospace(rootHex: string, short = false): string {
    if (!rootHex) return '—';
    if (!short || rootHex.length <= 16) return rootHex;
    return `${rootHex.substring(0, 8)}...${rootHex.substring(rootHex.length - 8)}`;
  }
}
