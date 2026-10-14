import { describe, it, expect } from 'vitest';
import { ChunkBitmap } from '../../engine/bitmap.js';

describe('ChunkBitmap', () => {
  it('tracks bits, missing indices, and serialization correctly', () => {
    const bitmap = new ChunkBitmap(16);
    expect(bitmap.getCompletedCount()).toBe(0);
    expect(bitmap.isComplete()).toBe(false);

    bitmap.mark(0);
    bitmap.mark(2);
    bitmap.mark(15);

    expect(bitmap.has(0)).toBe(true);
    expect(bitmap.has(1)).toBe(false);
    expect(bitmap.has(2)).toBe(true);
    expect(bitmap.has(15)).toBe(true);
    expect(bitmap.getCompletedCount()).toBe(3);

    const base64 = bitmap.toBase64();
    const restored = ChunkBitmap.fromBase64(base64, 16);

    expect(restored.has(0)).toBe(true);
    expect(restored.has(1)).toBe(false);
    expect(restored.has(2)).toBe(true);
    expect(restored.has(15)).toBe(true);
    expect(restored.getCompletedCount()).toBe(3);
  });
});
