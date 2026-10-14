/**
 * Disk-Backed Zero-Knowledge Chunk Store for Drop Relay
 * Stores client-encrypted chunks directly to disk with TTL cleanup.
 * The server holds zero keys and can never decrypt the stored chunks.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export interface RelayStoreConfig {
  baseDir?: string;
  defaultTtlMs?: number; // default 24 hours
  maxChunkSizeBytes?: number; // max 64 MB
}

export interface SessionMetadata {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  totalSize: number;
  chunkCount: number;
}

export class RelayChunkStore {
  private baseDir: string;
  private defaultTtlMs: number;
  private maxChunkSizeBytes: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RelayStoreConfig = {}) {
    this.baseDir = path.resolve(config.baseDir || './.drop_chunks');
    this.defaultTtlMs = config.defaultTtlMs || 24 * 60 * 60 * 1000;
    this.maxChunkSizeBytes = config.maxChunkSizeBytes || 64 * 1024 * 1024;

    this.ensureBaseDir();
    this.startCleanupTimer();
  }

  private ensureBaseDir(): void {
    if (!fsSync.existsSync(this.baseDir)) {
      fsSync.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getSessionDir(sessionId: string): string {
    // Sanitize session ID
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.baseDir, safeId);
  }

  private getChunkPath(sessionId: string, chunkIndex: number): string {
    return path.join(this.getSessionDir(sessionId), `chunk_${chunkIndex}.bin`);
  }

  /**
   * Saves an encrypted chunk directly to disk.
   */
  public async putChunk(sessionId: string, chunkIndex: number, data: Buffer | Uint8Array): Promise<number> {
    if (data.length > this.maxChunkSizeBytes) {
      throw new Error(`Chunk size ${data.length} exceeds maximum limit of ${this.maxChunkSizeBytes}`);
    }

    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const chunkPath = this.getChunkPath(sessionId, chunkIndex);
    await fs.writeFile(chunkPath, data);

    // Update session expiry timestamp
    const metaPath = path.join(sessionDir, 'meta.json');
    const now = Date.now();
    const meta: SessionMetadata = {
      sessionId,
      createdAt: now,
      expiresAt: now + this.defaultTtlMs,
      totalSize: 0,
      chunkCount: 0,
    };
    try {
      await fs.writeFile(metaPath, JSON.stringify(meta), 'utf-8');
    } catch {}

    return data.length;
  }

  /**
   * Reads an encrypted chunk from disk. Supports byte range slice.
   */
  public async getChunk(
    sessionId: string,
    chunkIndex: number,
    range?: { start: number; end: number }
  ): Promise<{ data: Buffer; totalSize: number } | null> {
    const chunkPath = this.getChunkPath(sessionId, chunkIndex);
    try {
      const stats = await fs.stat(chunkPath);
      const totalSize = stats.size;

      if (range) {
        const start = Math.max(0, range.start);
        const end = Math.min(totalSize - 1, range.end);
        const length = end - start + 1;
        const buffer = Buffer.alloc(length);

        const handle = await fs.open(chunkPath, 'r');
        await handle.read(buffer, 0, length, start);
        await handle.close();

        return { data: buffer, totalSize };
      } else {
        const data = await fs.readFile(chunkPath);
        return { data, totalSize };
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Deletes all chunks for a completed session.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {}
  }

  /**
   * Periodic TTL cleanup pruning sessions older than 24h.
   */
  public async pruneExpired(): Promise<number> {
    let prunedCount = 0;
    try {
      const sessions = await fs.readdir(this.baseDir);
      const now = Date.now();

      for (const s of sessions) {
        const metaPath = path.join(this.baseDir, s, 'meta.json');
        try {
          const content = await fs.readFile(metaPath, 'utf-8');
          const meta: SessionMetadata = JSON.parse(content);
          if (now > meta.expiresAt) {
            await fs.rm(path.join(this.baseDir, s), { recursive: true, force: true });
            prunedCount++;
          }
        } catch {
          // If no meta or corrupted, check directory mtime
          const stat = await fs.stat(path.join(this.baseDir, s));
          if (now - stat.mtimeMs > this.defaultTtlMs) {
            await fs.rm(path.join(this.baseDir, s), { recursive: true, force: true });
            prunedCount++;
          }
        }
      }
    } catch {}
    return prunedCount;
  }

  private startCleanupTimer(): void {
    // Run cleanup every 30 minutes
    this.cleanupInterval = setInterval(() => {
      this.pruneExpired().catch((e) => console.error('Relay cleanup error:', e));
    }, 30 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  public close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
