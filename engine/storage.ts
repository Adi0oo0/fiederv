/**
 * Disk Writer & Storage Abstractions for Drop
 * Multi-backend disk writer: File System Access API, OPFS, Node.js disk writer, and streaming fallback.
 * Allows out-of-order chunk writes at exact byte offsets with pre-allocation and atomic finalization.
 * Eliminates concurrent stream seek/write race conditions via atomic positioned write commands and promise-serialized write queues.
 */

import { IDiskWriter } from './types.js';

/**
 * Modern File System Access API writer (Chromium, Edge)
 * Strictly uses { type: 'write', position, data } and serializes writes
 * through a promise queue to prevent out-of-order write interleaving.
 */
export class FileSystemAccessWriter implements IDiskWriter {
  private fileHandle: FileSystemFileHandle | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private totalSize: number = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private writtenBytesMap: Map<number, number> = new Map();

  constructor(fileHandle?: FileSystemFileHandle) {
    this.fileHandle = fileHandle || null;
  }

  public async open(fileName: string, totalSize: number): Promise<void> {
    this.totalSize = totalSize;
    const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '_');

    if (!this.fileHandle && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        this.fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: safeName,
        });
      } catch (err: any) {
        if (err.name === 'AbortError') {
          throw new Error('User cancelled save destination picker.');
        }
        throw err;
      }
    }

    if (!this.fileHandle) {
      throw new Error('No File System Access file handle available.');
    }

    this.writable = await (this.fileHandle as any).createWritable({ keepExistingData: true });

    // Pre-allocate file size via truncate if supported to reduce disk fragmentation
    try {
      if (this.writable && 'truncate' in this.writable) {
        await (this.writable as any).truncate(totalSize);
      }
    } catch (e) {
      console.warn('Pre-allocation truncate skipped:', e);
    }
  }

  public async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error('Writable stream not opened.');

    // Enqueue write to guarantee strictly serialized execution on the underlying stream
    return new Promise<void>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .then(async () => {
          if (!this.writable) throw new Error('Stream closed');
          // Always use atomic positioned write command to prevent seek/write interleaving races
          await this.writable.write({
            type: 'write',
            position: offset,
            data: data as any,
          } as any);

          this.writtenBytesMap.set(offset, data.byteLength);
          resolve();
        })
        .catch(reject);
    });
  }

  public async finalize(_finalName: string): Promise<void> {
    // Await all queued writes to complete before closing stream
    await this.writeQueue;

    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
  }

  public async abort(): Promise<void> {
    if (this.writable) {
      try {
        await (this.writable as any).abort?.();
      } catch {}
      this.writable = null;
    }
  }

  public isPersistent(): boolean {
    return true;
  }
}

/**
 * Node.js filesystem writer (for unit/integration tests and CLI)
 * Uses native non-buffered random access pwrite via fs.write(fd, buffer, 0, len, position)
 * Includes path sanitization against directory traversal.
 */
export class NodeDiskWriter implements IDiskWriter {
  private fd: number | null = null;
  private tempPath: string = '';
  private finalPath: string = '';
  private fs: any = null;

  constructor(private outputDir: string = '.') {}

  public async open(fileName: string, totalSize: number): Promise<void> {
    const fsMod = 'node:fs/promises';
    const fsSyncMod = 'node:fs';
    const pathMod = 'node:path';
    const fs = await import(/* @vite-ignore */ fsMod);
    const fsSync = await import(/* @vite-ignore */ fsSyncMod);
    const path = await import(/* @vite-ignore */ pathMod);
    this.fs = { ...fs, ...fsSync };

    // Sanitize fileName to prevent directory traversal
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'download.bin';

    this.finalPath = path.resolve(this.outputDir, safeName);
    this.tempPath = path.resolve(this.outputDir, `${safeName}.part`);

    // Ensure directory exists
    await fs.mkdir(path.dirname(this.tempPath), { recursive: true });

    // Open file for read/write
    const handle = await fs.open(this.tempPath, 'w+');
    this.fd = handle.fd;

    // Pre-allocate file space
    await handle.truncate(totalSize);
    await handle.close();

    // Reopen with openSync descriptor for fast concurrent position writes
    this.fd = fsSync.openSync(this.tempPath, 'r+');
  }

  public async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    if (this.fd === null) throw new Error('NodeDiskWriter not opened.');
    const fsSync = this.fs;
    return new Promise((resolve, reject) => {
      fsSync.write(this.fd, data, 0, data.length, offset, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async finalize(_finalName: string): Promise<void> {
    if (this.fd !== null) {
      this.fs.closeSync(this.fd);
      this.fd = null;
    }

    // Atomic rename from .part to final file
    const fsMod = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ fsMod);
    try {
      await fs.unlink(this.finalPath);
    } catch {}
    await fs.rename(this.tempPath, this.finalPath);
  }

  public async abort(): Promise<void> {
    if (this.fd !== null) {
      this.fs.closeSync(this.fd);
      this.fd = null;
    }
    try {
      const fsMod = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ fsMod);
      await fs.unlink(this.tempPath);
    } catch {}
  }

  public isPersistent(): boolean {
    return true;
  }
}

/**
 * Streaming / OPFS Browser Writer Fallback
 * Used when File System Access API is unavailable (e.g. Safari / Firefox without showSaveFilePicker).
 * Supports OPFS Origin Private File System sync access handles or bounded blob streaming.
 */
export class StreamingFallbackWriter implements IDiskWriter {
  private opfsFileHandle: any = null;
  private opfsSyncHandle: any = null;
  private memoryChunks = new Map<number, Uint8Array>();
  private totalSize: number = 0;
  private fileName: string = '';
  private downloadUrl: string | null = null;
  private useOpfs: boolean = false;

  public async open(fileName: string, totalSize: number): Promise<void> {
    this.fileName = fileName.replace(/[/\\?%*:|"<>]/g, '_');
    this.totalSize = totalSize;
    this.memoryChunks.clear();
    this.downloadUrl = null;

    // Try OPFS first for zero-memory disk storage on Safari/Firefox
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        this.opfsFileHandle = await root.getFileHandle(`${this.fileName}.part`, { create: true });
        if ('createSyncAccessHandle' in this.opfsFileHandle) {
          this.opfsSyncHandle = await this.opfsFileHandle.createSyncAccessHandle();
          this.opfsSyncHandle.truncate(totalSize);
          this.useOpfs = true;
          return;
        } else if ('createWritable' in this.opfsFileHandle) {
          const writable = await this.opfsFileHandle.createWritable();
          await writable.truncate(totalSize);
          await writable.close();
          this.useOpfs = true;
          return;
        }
      } catch (err) {
        console.warn('OPFS initialization failed, falling back to streaming memory map:', err);
      }
    }
  }

  public async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    if (this.useOpfs && this.opfsSyncHandle) {
      this.opfsSyncHandle.write(data, { at: offset });
      return;
    }

    if (this.useOpfs && this.opfsFileHandle) {
      const writable = await this.opfsFileHandle.createWritable({ keepExistingData: true });
      await writable.write({ type: 'write', position: offset, data: data as any });
      await writable.close();
      return;
    }

    this.memoryChunks.set(offset, new Uint8Array(data));
  }

  public async finalize(_finalName: string): Promise<void> {
    if (this.useOpfs && this.opfsSyncHandle) {
      this.opfsSyncHandle.flush();
      this.opfsSyncHandle.close();
      this.opfsSyncHandle = null;

      // Create download URL from OPFS file
      const file = await this.opfsFileHandle.getFile();
      this.downloadUrl = URL.createObjectURL(file);
      return;
    }

    if (this.useOpfs && this.opfsFileHandle) {
      const file = await this.opfsFileHandle.getFile();
      this.downloadUrl = URL.createObjectURL(file);
      return;
    }

    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const sortedOffsets = Array.from(this.memoryChunks.keys()).sort((a, b) => a - b);
      const parts: Uint8Array[] = sortedOffsets.map((o) => this.memoryChunks.get(o)!);
      const blob = new Blob(parts as any);
      this.downloadUrl = URL.createObjectURL(blob);
    }
  }

  public async abort(): Promise<void> {
    if (this.opfsSyncHandle) {
      try {
        this.opfsSyncHandle.close();
      } catch {}
      this.opfsSyncHandle = null;
    }
    this.memoryChunks.clear();
    if (this.downloadUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
  }

  public isPersistent(): boolean {
    return this.useOpfs;
  }

  public getDownloadUrl(): string | null {
    return this.downloadUrl;
  }
}
