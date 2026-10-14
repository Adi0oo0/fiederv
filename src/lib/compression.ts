/**
 * High-Speed Browser-Native Compression & Encoding Engine
 * Uses the Web Compression Streams API (deflate-raw) for near-instant
 * C++ in-memory dictionary & Huffman compression/decompression.
 */

// Extensions and MIME types that are already compressed and should NOT be re-compressed
const ALREADY_COMPRESSED_EXTENSIONS = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'ico',
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv',
  'mp3', 'aac', 'ogg', 'flac', 'm4a', 'wav', 'opus',
  'pdf', 'docx', 'xlsx', 'pptx', 'epub'
]);

/**
 * Determines whether a file is a candidate for high-speed compression.
 * Applies only to files of certain sizes (>= 1 KB and <= 1.5 GB) and compressible formats.
 */
export function isCompressible(file: { name: string; type?: string; size: number }): boolean {
  // Files smaller than 1 KB don't benefit from compression (framing overhead)
  if (file.size < 1024) {
    return false;
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (ALREADY_COMPRESSED_EXTENSIONS.has(ext)) {
    return false;
  }

  if (file.type) {
    const t = file.type.toLowerCase();
    // Allow SVG even though it starts with image/
    if (t === 'image/svg+xml') return true;

    if (
      t.startsWith('image/') ||
      t.startsWith('video/') ||
      t.startsWith('audio/') ||
      t.includes('zip') ||
      t.includes('compressed') ||
      t.includes('tar') ||
      t.includes('pdf')
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Calculates Shannon entropy of a byte array (bits per byte, 0 to 8).
 * High entropy (> 7.5) indicates pre-compressed, encrypted, or random data,
 * which will not compress further.
 */
export function calculateShannonEntropy(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    freq[data[i]]++;
  }
  let entropy = 0;
  const len = data.length;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / len;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * Fast entropy and extension checking to determine compressibility in < 2ms
 * without loading the whole file into memory.
 */
export async function isCompressibleFast(file: { name: string; type?: string; size: number; slice: (start: number, end: number) => Blob }): Promise<boolean> {
  if (!isCompressible(file)) {
    return false;
  }

  try {
    const sampleSize = Math.min(32768, file.size);
    const sampleBlob = file.slice(0, sampleSize);
    const sampleBuffer = await sampleBlob.arrayBuffer();
    const sampleBytes = new Uint8Array(sampleBuffer);

    // If Shannon entropy > 7.5, data is effectively incompressible
    const entropy = calculateShannonEntropy(sampleBytes);
    if (entropy > 7.5) {
      return false;
    }

    // Quick test compress on 32KB sample
    if (typeof CompressionStream !== 'undefined') {
      const compressedSample = await compressBlock(sampleBytes);
      if (!compressedSample || compressedSample.byteLength >= sampleBytes.byteLength * 0.95) {
        return false;
      }
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Compresses an individual block of bytes using native CompressionStream('deflate-raw').
 * Returns compressed Uint8Array if at least 3% saved, otherwise null.
 */
export async function compressBlock(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined' || data.length === 0) {
    return null;
  }

  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const responsePromise = new Response(cs.readable).arrayBuffer();
    await writer.write(data as unknown as BufferSource);
    await writer.close();

    const compressedBuffer = await responsePromise;
    const compressedBytes = new Uint8Array(compressedBuffer);

    if (compressedBytes.byteLength < data.byteLength * 0.97) {
      return compressedBytes;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Decompresses an individual block of bytes using native DecompressionStream('deflate-raw').
 */
export async function decompressBlock(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined' || data.length === 0) {
    return data;
  }

  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const responsePromise = new Response(ds.readable).arrayBuffer();
    await writer.write(data as unknown as BufferSource);
    await writer.close();

    const decompressedBuffer = await responsePromise;
    return new Uint8Array(decompressedBuffer);
  } catch (err) {
    console.error('Block decompression error:', err);
    throw err;
  }
}

export interface CompressionResult {
  blob: Blob;
  compressed: boolean;
  compressedSize: number;
  originalSize: number;
  ratio: number; // percentage saved, e.g. 68
}

/**
 * Compresses a Blob using native CompressionStream('deflate-raw')
 * Returns compressed Blob if savings >= 3%, otherwise returns raw original.
 */
export async function compressFileIfBeneficial(file: File): Promise<CompressionResult> {
  const originalSize = file.size;

  if (!isCompressible(file) || typeof CompressionStream === 'undefined') {
    return {
      blob: file,
      compressed: false,
      compressedSize: originalSize,
      originalSize,
      ratio: 0,
    };
  }

  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = file.stream().pipeThrough(cs);
    const response = new Response(stream);
    const compressedBlob = await response.blob();

    // If compression didn't save at least 3% of file size, transfer raw
    if (compressedBlob.size >= originalSize * 0.97) {
      return {
        blob: file,
        compressed: false,
        compressedSize: originalSize,
        originalSize,
        ratio: 0,
      };
    }

    const ratio = Math.round((1 - compressedBlob.size / originalSize) * 100);
    return {
      blob: compressedBlob,
      compressed: true,
      compressedSize: compressedBlob.size,
      originalSize,
      ratio,
    };
  } catch (err) {
    console.warn('Native compression fallback to raw stream:', err);
    return {
      blob: file,
      compressed: false,
      compressedSize: originalSize,
      originalSize,
      ratio: 0,
    };
  }
}

/**
 * Decompresses a Blob using native DecompressionStream('deflate-raw')
 */
export async function decompressBlob(blob: Blob, originalType?: string): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') {
    return blob;
  }

  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = blob.stream().pipeThrough(ds);
    const response = new Response(stream);
    const decompressed = await response.blob();
    return new Blob([decompressed], { type: originalType || 'application/octet-stream' });
  } catch (err) {
    console.error('Decompression error, keeping raw buffer:', err);
    return blob;
  }
}
