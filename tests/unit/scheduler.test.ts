import { describe, it, expect } from 'vitest';
import { WorkStealingScheduler } from '../../engine/scheduler.js';

describe('WorkStealingScheduler', () => {
  it('allocates chunks respecting cwnd and updates on ACK', () => {
    const scheduler = new WorkStealingScheduler(10);
    scheduler.registerPipe('p1', 'Channel-1', 2, 4);

    const c0 = scheduler.acquireNextChunk('p1');
    const c1 = scheduler.acquireNextChunk('p1');
    const c2 = scheduler.acquireNextChunk('p1');

    expect(c0).toBe(0);
    expect(c1).toBe(1);
    // cwnd was 2, so third request returns null
    expect(c2).toBeNull();

    // ACK first chunk: should free capacity and increase cwnd (AIMD)
    scheduler.onChunkAck(0, 8 * 1024 * 1024);
    expect(scheduler.getCompletedCount()).toBe(1);

    const c3 = scheduler.acquireNextChunk('p1');
    expect(c3).toBe(2);
  });

  it('backs off cwnd on NACK and re-queues chunk', () => {
    const scheduler = new WorkStealingScheduler(5);
    scheduler.registerPipe('p1', 'Channel-1', 4, 8);

    const chunk = scheduler.acquireNextChunk('p1');
    expect(chunk).toBe(0);

    scheduler.onChunkNack(0);
    const stats = scheduler.getPipeStats();
    // cwnd reduced from 4 to 2 (multiplicative decrease)
    expect(stats[0].cwnd).toBe(2);

    // Chunk 0 is available again
    const reacquired = scheduler.acquireNextChunk('p1');
    expect(reacquired).toBe(0);
  });
});
