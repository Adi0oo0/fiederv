/**
 * Chunk Bitmap & Resume Persistence for Drop
 * 1-bit per chunk bitfield supporting up to millions of chunks with instant O(1) bitops.
 * Persisted in IndexedDB across tabs, restarts, network drops, and multi-day sessions.
 */

export class ChunkBitmap {
  public readonly totalChunks: number;
  private readonly buffer: Uint8Array;
  private completedCount: number = 0;

  constructor(totalChunks: number, existingBuffer?: Uint8Array) {
    this.totalChunks = totalChunks;
    const byteLength = Math.ceil(totalChunks / 8);

    if (existingBuffer && existingBuffer.byteLength >= byteLength) {
      this.buffer = new Uint8Array(existingBuffer);
      // Recalculate completed count
      this.completedCount = this.countBits();
    } else {
      this.buffer = new Uint8Array(byteLength);
      this.completedCount = 0;
    }
  }

  public mark(index: number): boolean {
    if (index < 0 || index >= this.totalChunks) return false;
    const byteIndex = Math.floor(index / 8);
    const bitMask = 1 << (index % 8);

    if ((this.buffer[byteIndex] & bitMask) === 0) {
      this.buffer[byteIndex] |= bitMask;
      this.completedCount++;
      return true;
    }
    return false;
  }

  public unmark(index: number): boolean {
    if (index < 0 || index >= this.totalChunks) return false;
    const byteIndex = Math.floor(index / 8);
    const bitMask = 1 << (index % 8);

    if ((this.buffer[byteIndex] & bitMask) !== 0) {
      this.buffer[byteIndex] &= ~bitMask;
      this.completedCount--;
      return true;
    }
    return false;
  }

  public has(index: number): boolean {
    if (index < 0 || index >= this.totalChunks) return false;
    const byteIndex = Math.floor(index / 8);
    const bitMask = 1 << (index % 8);
    return (this.buffer[byteIndex] & bitMask) !== 0;
  }

  public getCompletedCount(): number {
    return this.completedCount;
  }

  public isComplete(): boolean {
    return this.completedCount >= this.totalChunks;
  }

  public getMissingIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  public getRawBuffer(): Uint8Array {
    return this.buffer;
  }

  private countBits(): number {
    let count = 0;
    for (let i = 0; i < this.totalChunks; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitMask = 1 << (i % 8);
      if ((this.buffer[byteIndex] & bitMask) !== 0) {
        count++;
      }
    }
    return count;
  }

  public toBase64(): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(this.buffer).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < this.buffer.length; i++) {
      binary += String.fromCharCode(this.buffer[i]);
    }
    return btoa(binary);
  }

  public static fromBase64(base64: string, totalChunks: number): ChunkBitmap {
    let bytes: Uint8Array;
    if (typeof Buffer !== 'undefined') {
      bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    } else {
      const binary = atob(base64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    }
    return new ChunkBitmap(totalChunks, bytes);
  }
}

/**
 * Storage adapter for saving bitmap sessions in IndexedDB (Browser) or memory (Node/Tests)
 */
export interface StoredSession {
  sessionId: string;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  merkleRoot: string;
  bitmapBase64: string;
  leafHashes?: string[];
  updatedAt: number;
}

export class SessionPersistence {
  private static memoryStore = new Map<string, StoredSession>();
  private static dbPromise: Promise<IDBDatabase | null> | null = null;

  private static getDB(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('drop_storage_v1', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) {
            db.createObjectStore('sessions', { keyPath: 'sessionId' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  public static async saveSession(session: StoredSession): Promise<void> {
    this.memoryStore.set(session.sessionId, session);
    const db = await this.getDB();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        store.put(session);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public static async loadSession(sessionId: string): Promise<StoredSession | null> {
    const memory = this.memoryStore.get(sessionId);
    if (memory) return memory;

    const db = await this.getDB();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const req = store.get(sessionId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  public static async deleteSession(sessionId: string): Promise<void> {
    this.memoryStore.delete(sessionId);
    const db = await this.getDB();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        store.delete(sessionId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}
