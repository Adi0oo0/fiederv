/**
 * Disk Writer & Storage Abstractions for Drop
 * Multi-backend disk writer: File System Access API, OPFS, Node.js disk writer, and streaming fallback.
 * Allows out-of-order chunk writes at exact byte offsets with pre-allocation and atomic finalization.
 */

import { IDiskWriter } from './types.js';

/**
 * Modern File System Access API writer (Chromium, Edge)
 */
export class FileSystemAccessWriter implements IDiskWriter {
  private fileHandle: FileSystemFileHandle | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private totalSize: number = 0;

  constructor(fileHandle?: FileSystemFileHandle) {
    this.fileHandle = fileHandle || null;
  }

  public async open(fileName: string, totalSize: number): Promise<void> {
    this.totalSize = totalSize;
    if (!this.fileHandle && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      this.fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: `${fileName}.part`,
      });
    }

    if (!this.fileHandle) {
      throw new Error('No File System Access file handle available.');
    }

    this.writable = await (this.fileHandle as any).createWritable({ keepExistingData: true });

    // Pre-allocate file size if supported to reduce disk fragmentation
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

    if ('seek' in this.writable) {
      await (this.writable as any).seek(offset);
      await this.writable.write(data);
    } else {
      await this.writable.write({
        type: 'write',
        position: offset,
        data,
      } as any);
    }
  }

  public async finalize(_finalName: string): Promise<void> {
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
 */
export class NodeDiskWriter implements IDiskWriter {
  private fd: number | null = null;
  private tempPath: string = '';
  private finalPath: string = '';
  private fs: any = null;

  constructor(private outputDir: string = '.') {}

  public async open(fileName: string, totalSize: number): Promise<void> {
    const fs = await import('fs/promises');
    const fsSync = await import('fs');
    const path = await import('path');
    this.fs = { ...fs, ...fsSync };

    this.finalPath = path.resolve(this.outputDir, fileName);
    this.tempPath = path.resolve(this.outputDir, `${fileName}.part`);

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
    const fs = await import('fs/promises');
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
      const fs = await import('fs/promises');
      await fs.unlink(this.tempPath);
    } catch {}
  }

  public isPersistent(): boolean {
    return true;
  }
}

/**
 * In-memory / Bounded-memory chunk writer fallback
 * Useful for environments without disk access or small files in browser tests.
 */
export class MemoryChunkWriter implements IDiskWriter {
  private chunks = new Map<number, Uint8Array>();
  private totalSize: number = 0;
  private downloadUrl: string | null = null;

  public async open(_fileName: string, totalSize: number): Promise<void> {
    this.totalSize = totalSize;
    this.chunks.clear();
    this.downloadUrl = null;
  }

  public async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    this.chunks.set(offset, new Uint8Array(data));
  }

  public async finalize(_finalName: string): Promise<void> {
    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const sortedOffsets = Array.from(this.chunks.keys()).sort((a, b) => a - b);
      const parts: Uint8Array[] = sortedOffsets.map((o) => this.chunks.get(o)!);
      const blob = new Blob(parts);
      this.downloadUrl = URL.createObjectURL(blob);
    }
  }

  public async abort(): Promise<void> {
    this.chunks.clear();
    if (this.downloadUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
  }

  public isPersistent(): boolean {
    return false;
  }

  public getDownloadUrl(): string | null {
    return this.downloadUrl;
  }
}
