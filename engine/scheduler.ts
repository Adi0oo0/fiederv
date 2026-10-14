/**
 * Work-Stealing Multipath Scheduler with AIMD Concurrency Control
 * Distributes independent chunks across WebRTC DataChannels, WebTransport, and HTTP relays.
 * Fast channels steal work from stalled/slow pipes.
 */

import { ChunkBitmap } from './bitmap.js';

export interface TransportPipe {
  id: string;
  name: string;
  cwnd: number; // AIMD congestion window (inflight chunks allowed)
  maxCwnd: number;
  inflightCount: number;
  smoothedRttMs: number;
  throughputBps: number;
  lastActive: number;
  canAcceptWork: () => boolean;
}

export interface InflightRecord {
  chunkIndex: number;
  transportId: string;
  sentAt: number;
  attempts: number;
}

export class WorkStealingScheduler {
  public readonly totalChunks: number;
  public readonly completedBitmap: ChunkBitmap;
  private pendingQueue: number[] = [];
  private pendingSet: Set<number> = new Set();
  private inflight: Map<number, InflightRecord> = new Map();
  private pipes: Map<string, TransportPipe> = new Map();

  // AIMD parameters
  private readonly minCwnd = 1;
  private readonly defaultMaxCwnd = 16;
  private isPaused: boolean = false;

  constructor(totalChunks: number, initialBitmap?: ChunkBitmap) {
    this.totalChunks = totalChunks;
    this.completedBitmap = initialBitmap || new ChunkBitmap(totalChunks);

    // Populate initial pending queue with chunks not yet marked completed
    for (let i = 0; i < totalChunks; i++) {
      if (!this.completedBitmap.has(i)) {
        this.pendingQueue.push(i);
        this.pendingSet.add(i);
      }
    }
  }

  public registerPipe(id: string, name: string, initialCwnd = 2, maxCwnd = 16): void {
    this.pipes.set(id, {
      id,
      name,
      cwnd: initialCwnd,
      maxCwnd,
      inflightCount: 0,
      smoothedRttMs: 100, // baseline 100ms
      throughputBps: 0,
      lastActive: Date.now(),
      canAcceptWork: () => {
        const pipe = this.pipes.get(id);
        return pipe ? pipe.inflightCount < pipe.cwnd : false;
      },
    });
  }

  public unregisterPipe(id: string): void {
    const pipe = this.pipes.get(id);
    if (!pipe) return;

    // Return any inflight chunks on this pipe back to pending queue
    for (const [chunkIdx, record] of this.inflight.entries()) {
      if (record.transportId === id) {
        this.inflight.delete(chunkIdx);
        if (!this.pendingSet.has(chunkIdx) && !this.completedBitmap.has(chunkIdx)) {
          this.pendingQueue.unshift(chunkIdx);
          this.pendingSet.add(chunkIdx);
        }
      }
    }

    this.pipes.delete(id);
  }

  /**
   * Next chunk to be transmitted by a specific transport pipe.
   * If pending queue is empty, attempts to steal from a stalled/slow channel.
   */
  public acquireNextChunk(transportId: string): number | null {
    if (this.isPaused) return null;
    const pipe = this.pipes.get(transportId);
    if (!pipe || pipe.inflightCount >= pipe.cwnd) return null;

    let targetIndex: number | null = null;

    // 1. Regular queue pop
    while (this.pendingQueue.length > 0) {
      const idx = this.pendingQueue.shift()!;
      this.pendingSet.delete(idx);
      if (!this.completedBitmap.has(idx) && !this.inflight.has(idx)) {
        targetIndex = idx;
        break;
      }
    }

    // 2. Work stealing: if pending is empty, steal from stalled pipe
    if (targetIndex === null) {
      targetIndex = this.stealStalledChunk(transportId);
    }

    if (targetIndex !== null) {
      this.inflight.set(targetIndex, {
        chunkIndex: targetIndex,
        transportId,
        sentAt: Date.now(),
        attempts: (this.inflight.get(targetIndex)?.attempts || 0) + 1,
      });
      pipe.inflightCount++;
      pipe.lastActive = Date.now();
      return targetIndex;
    }

    return null;
  }

  /**
   * Work-stealing implementation: Finds chunks that have been in flight on
   * another pipe for > 2.5x that pipe's RTT.
   */
  private stealStalledChunk(stealingPipeId: string): number | null {
    const now = Date.now();
    let oldestStalled: { index: number; elapsed: number } | null = null;

    for (const [idx, record] of this.inflight.entries()) {
      if (record.transportId === stealingPipeId) continue;
      const originalPipe = this.pipes.get(record.transportId);
      const rtt = originalPipe ? originalPipe.smoothedRttMs : 300;
      const elapsed = now - record.sentAt;

      // Threshold: 2.5x smoothed RTT (min 500ms)
      if (elapsed > Math.max(500, rtt * 2.5)) {
        if (!oldestStalled || elapsed > oldestStalled.elapsed) {
          oldestStalled = { index: idx, elapsed };
        }
      }
    }

    if (oldestStalled) {
      const stolenIndex = oldestStalled.index;
      const oldRecord = this.inflight.get(stolenIndex);
      if (oldRecord) {
        const oldPipe = this.pipes.get(oldRecord.transportId);
        if (oldPipe && oldPipe.inflightCount > 0) {
          oldPipe.inflightCount--;
          // Backoff the slow pipe (multiplicative decrease)
          oldPipe.cwnd = Math.max(this.minCwnd, Math.floor(oldPipe.cwnd * 0.7));
        }
      }
      return stolenIndex;
    }

    return null;
  }

  /**
   * Called when a chunk is acknowledged as successfully received and verified.
   */
  public onChunkAck(chunkIndex: number, bytesTransferred: number): void {
    const record = this.inflight.get(chunkIndex);
    this.completedBitmap.mark(chunkIndex);
    this.inflight.delete(chunkIndex);
    this.pendingSet.delete(chunkIndex);

    if (record) {
      const pipe = this.pipes.get(record.transportId);
      if (pipe) {
        pipe.inflightCount = Math.max(0, pipe.inflightCount - 1);
        pipe.lastActive = Date.now();

        // RTT sample
        const rttSample = Math.max(5, Date.now() - record.sentAt);
        pipe.smoothedRttMs = Math.round(pipe.smoothedRttMs * 0.8 + rttSample * 0.2);

        // Throughput calculation
        const instantBps = bytesTransferred / (rttSample / 1000);
        pipe.throughputBps = pipe.throughputBps === 0
          ? instantBps
          : pipe.throughputBps * 0.7 + instantBps * 0.3;

        // AIMD Additive Increase: increase window if below max
        if (pipe.cwnd < (pipe.maxCwnd || this.defaultMaxCwnd)) {
          pipe.cwnd += 1;
        }
      }
    }
  }

  /**
   * Called when a chunk fails (NACK, timeout, or channel drop).
   */
  public onChunkNack(chunkIndex: number, reassignTransportId?: string): void {
    const record = this.inflight.get(chunkIndex);
    if (record) {
      const pipe = this.pipes.get(record.transportId);
      if (pipe) {
        pipe.inflightCount = Math.max(0, pipe.inflightCount - 1);
        // AIMD Multiplicative Decrease
        pipe.cwnd = Math.max(this.minCwnd, Math.floor(pipe.cwnd * 0.5));
      }
      this.inflight.delete(chunkIndex);
    }

    if (!this.completedBitmap.has(chunkIndex)) {
      // Re-queue chunk with high priority at front of queue
      this.pendingQueue.unshift(chunkIndex);
      this.pendingSet.add(chunkIndex);
    }
  }

  public pause(): void {
    this.isPaused = true;
  }

  public resume(): void {
    this.isPaused = false;
  }

  public getInflightCount(): number {
    return this.inflight.size;
  }

  public getPendingCount(): number {
    return this.pendingQueue.length;
  }

  public getCompletedCount(): number {
    return this.completedBitmap.getCompletedCount();
  }

  public isComplete(): boolean {
    return this.completedBitmap.isComplete();
  }

  public getPipeStats(): { id: string; name: string; cwnd: number; inflight: number; rtt: number; throughputMBps: number }[] {
    return Array.from(this.pipes.values()).map((p) => ({
      id: p.id,
      name: p.name,
      cwnd: p.cwnd,
      inflight: p.inflightCount,
      rtt: p.smoothedRttMs,
      throughputMBps: Number((p.throughputBps / (1024 * 1024)).toFixed(2)),
    }));
  }
}
