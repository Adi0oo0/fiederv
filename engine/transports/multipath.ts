/**
 * Multipath Controller for Drop
 * Runs multiple transports simultaneously (WebRTC DataChannels + WebTransport + HTTP Relay)
 * and dynamically schedules chunks across them according to real-time measured throughput.
 */

import { ITransport } from './types.js';
import { WorkStealingScheduler } from '../scheduler.js';

export class MultipathController {
  private transports: Map<string, ITransport> = new Map();
  private scheduler: WorkStealingScheduler;
  private isRunning: boolean = false;
  private pumpScheduled: boolean = false;

  public onChunkReadyToSend?: (chunkIndex: number, transport: ITransport) => Promise<boolean>;

  constructor(scheduler: WorkStealingScheduler) {
    this.scheduler = scheduler;
  }

  public registerTransport(transport: ITransport, initialCwnd = 2, maxCwnd = 16): void {
    this.transports.set(transport.id, transport);
    this.scheduler.registerPipe(transport.id, transport.name, initialCwnd, maxCwnd);

    transport.onDrain = () => {
      this.triggerSchedulePump();
    };

    transport.onError = (_err) => {
      // Scheduler automatically reallocates inflight chunks
      this.triggerSchedulePump();
    };

    if (this.isRunning) {
      this.triggerSchedulePump();
    }
  }

  public unregisterTransport(id: string): void {
    const transport = this.transports.get(id);
    if (transport) {
      this.transports.delete(id);
      this.scheduler.unregisterPipe(id);
    }
  }

  public start(): void {
    this.isRunning = true;
    this.triggerSchedulePump();
  }

  public pause(): void {
    this.isRunning = false;
    this.scheduler.pause();
  }

  public stop(): void {
    this.isRunning = false;
    this.scheduler.pause();
  }

  public resume(): void {
    this.isRunning = true;
    this.scheduler.resume();
    this.triggerSchedulePump();
  }

  public triggerSchedulePump(): void {
    if (!this.isRunning || this.pumpScheduled) return;
    this.pumpScheduled = true;

    // Use microtask or setImmediate to avoid deep recursion
    queueMicrotask(async () => {
      this.pumpScheduled = false;
      await this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (!this.isRunning) return;

    for (const [id, transport] of this.transports.entries()) {
      if (!transport.isConnected()) continue;

      let chunkIndex: number | null = null;
      while ((chunkIndex = this.scheduler.acquireNextChunk(id)) !== null) {
        if (this.onChunkReadyToSend) {
          const sent = await this.onChunkReadyToSend(chunkIndex, transport);
          if (!sent) {
            this.scheduler.onChunkNack(chunkIndex);
            break;
          }
        }
      }
    }
  }

  public getActiveTransportCount(): number {
    return Array.from(this.transports.values()).filter((t) => t.isConnected()).length;
  }

  public getTransportNames(): string[] {
    return Array.from(this.transports.values())
      .filter((t) => t.isConnected())
      .map((t) => t.name);
  }
}
