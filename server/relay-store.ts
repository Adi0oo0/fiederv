/**
 * Disk-Backed Zero-Knowledge Chunk Store for Drop Relay
 * Streams client-encrypted chunks directly to disk with TTL cleanup.
 * Atomic file writes (.tmp -> rename) ensure readers never see partial chunks.
 * Zero whole-chunk memory buffering.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export interface RelayStoreConfig {
  baseDir?: string;
  defaultTtlMs?: number; // default 24 hours
  maxChunkSizeBytes?: number; // max 64 MB
  maxSessionSizeBytes?: number; // max 100 GB
  maxChunkCount?: number; // max 10,000 chunks
}

export interface SessionMetadata {
  sessionId: string;
  authSecret?: string;
  createdAt: number;
  expiresAt: number;
  totalSize: number;
  chunkCount: number;
}

export class RelayChunkStore {
  private baseDir: string;
  private defaultTtlMs: number;
  private maxChunkSizeBytes: number;
  private maxSessionSizeBytes: number;
  private maxChunkCount: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RelayStoreConfig = {}) {
    this.baseDir = path.resolve(config.baseDir || './.drop_chunks');
    this.defaultTtlMs = config.defaultTtlMs || 24 * 60 * 60 * 1000;
    this.maxChunkSizeBytes = config.maxChunkSizeBytes || 64 * 1024 * 1024;
    this.maxSessionSizeBytes = config.maxSessionSizeBytes || 100 * 1024 * 1024 * 1024; // 100 GB quota
    this.maxChunkCount = config.maxChunkCount || 10000;

    this.ensureBaseDir();
    this.startCleanupTimer();
  }

  private ensureBaseDir(): void {
    if (!fsSync.existsSync(this.baseDir)) {
      fsSync.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getSessionDir(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.baseDir, safeId);
  }

  public getChunkPath(sessionId: string, chunkIndex: number): string {
    return path.join(this.getSessionDir(sessionId), `chunk_${chunkIndex}.bin`);
  }

  /**
   * Registers a session with an expected authSecret and quota limits.
   */
  public async registerSession(sessionId: string, authSecret?: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const metaPath = path.join(sessionDir, 'meta.json');
    const now = Date.now();
    const meta: SessionMetadata = {
      sessionId,
      authSecret,
      createdAt: now,
      expiresAt: now + this.defaultTtlMs,
      totalSize: 0,
      chunkCount: 0,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf-8');
  }

  public async getSessionMeta(sessionId: string): Promise<SessionMetadata | null> {
    const metaPath = path.join(this.getSessionDir(sessionId), 'meta.json');
    try {
      const data = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Streams an encrypted chunk directly to a .tmp file and renames it atomically upon completion.
   * Zero whole-chunk buffering in Node.js memory.
   */
  public async putChunkStream(
    sessionId: string,
    chunkIndex: number,
    stream: Readable
  ): Promise<number> {
    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const chunkPath = this.getChunkPath(sessionId, chunkIndex);
    const tempPath = path.join(sessionDir, `chunk_${chunkIndex}.tmp.${Date.now()}`);

    // Stream directly to temp file
    const writeStream = fsSync.createWriteStream(tempPath);
    await pipeline(stream, writeStream);

    const stats = await fs.stat(tempPath);
    if (stats.size > this.maxChunkSizeBytes) {
      await fs.unlink(tempPath).catch(() => {});
      throw new Error(`Chunk size ${stats.size} exceeds maximum limit of ${this.maxChunkSizeBytes}`);
    }

    // Atomic rename: guarantees readers never see partial chunks
    await fs.rename(tempPath, chunkPath);

    return stats.size;
  }

  /**
   * Returns a readable stream for the requested chunk with optional byte-range slicing.
   */
  public async getChunkStream(
    sessionId: string,
    chunkIndex: number,
    range?: { start: number; end: number }
  ): Promise<{ stream: fsSync.ReadStream; totalSize: number } | null> {
    const chunkPath = this.getChunkPath(sessionId, chunkIndex);
    try {
      const stats = await fs.stat(chunkPath);
      const stream = fsSync.createReadStream(chunkPath, range ? { start: range.start, end: range.end } : undefined);
      return { stream, totalSize: stats.size };
    } catch {
      return null;
    }
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    const sessionDir = this.getSessionDir(sessionId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.purgeExpiredSessions().catch(console.error);
    }, 15 * 60 * 1000); // Check every 15 minutes
  }

  public async purgeExpiredSessions(): Promise<number> {
    let purged = 0;
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metaPath = path.join(this.baseDir, entry.name, 'meta.json');
          try {
            const data = await fs.readFile(metaPath, 'utf-8');
            const meta: SessionMetadata = JSON.parse(data);
            if (now > meta.expiresAt) {
              await fs.rm(path.join(this.baseDir, entry.name), { recursive: true, force: true });
              purged++;
            }
          } catch {
            // No meta file or malformed: check folder age
            const stat = await fs.stat(path.join(this.baseDir, entry.name));
            if (now - stat.mtimeMs > this.defaultTtlMs) {
              await fs.rm(path.join(this.baseDir, entry.name), { recursive: true, force: true });
              purged++;
            }
          }
        }
      }
    } catch {}
    return purged;
  }

  public close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
