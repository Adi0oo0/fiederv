/**
 * Chunk & stream hasher for Drop
 * Primary hardware SHA-256 / BLAKE3 fallback architecture.
 */

export class Hasher {
  /**
   * Hashes a chunk with hardware-accelerated SHA-256 or BLAKE3
   * Returns a 32-byte Uint8Array.
   */
  public static async hashChunk(data: Uint8Array): Promise<Uint8Array> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hashBuffer);
  }

  /**
   * Hashes a chunk and returns lowercase hex string.
   */
  public static async hashChunkHex(data: Uint8Array): Promise<string> {
    const hash = await this.hashChunk(data);
    return this.toHex(hash);
  }

  /**
   * Combines two child node hashes (L and R) with domain separation 0x01
   * H(0x01 || L || R)
   */
  public static async combineMerkleNodes(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
    const combined = new Uint8Array(1 + left.length + right.length);
    combined[0] = 0x01; // Internal node prefix
    combined.set(left, 1);
    combined.set(right, 1 + left.length);

    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    return new Uint8Array(hashBuffer);
  }

  public static toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  public static fromHex(hex: string): Uint8Array {
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
