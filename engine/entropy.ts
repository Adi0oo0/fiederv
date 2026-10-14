/**
 * Entropy probe and compression decision engine for Drop.
 * Computes Shannon entropy on data samples to detect already-compressed data (zip, mp4, etc.)
 * and bypass compression overhead.
 */

export class EntropyProbe {
  private static COMPRESSED_EXTENSIONS = new Set([
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst',
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv',
    'mp3', 'aac', 'ogg', 'flac', 'm4a',
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif',
    'pdf', 'docx', 'xlsx', 'pptx'
  ]);

  /**
   * Fast file extension / name check.
   */
  public static isLikelyCompressedExtension(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext) return false;
    return this.COMPRESSED_EXTENSIONS.has(ext);
  }

  /**
   * Computes Shannon Entropy over a sample buffer.
   * Theoretical range: 0.0 (completely uniform/zeroes) to 8.0 (completely random / high-density compressed).
   * Data with entropy >= 7.3 bits/byte gives negative or negligible compression ratio.
   */
  public static calculateEntropy(sample: Uint8Array): number {
    if (sample.length === 0) return 0;

    const frequencies = new Uint32Array(256);
    const len = sample.length;

    for (let i = 0; i < len; i++) {
      frequencies[sample[i]]++;
    }

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      const count = frequencies[i];
      if (count > 0) {
        const p = count / len;
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Decides whether compression should be attempted on this file/chunk.
   * Returns false if already compressed.
   */
  public static shouldCompress(sample: Uint8Array, fileName?: string): boolean {
    if (fileName && this.isLikelyCompressedExtension(fileName)) {
      return false;
    }

    // Inspect first 64KB sample
    const probeSlice = sample.subarray(0, Math.min(sample.length, 65536));
    const entropy = this.calculateEntropy(probeSlice);

    // Skip compression if entropy is >= 7.3
    return entropy < 7.3;
  }
}
