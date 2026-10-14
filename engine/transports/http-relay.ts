/**
 * HTTP/2 & HTTP/3 Parallel Relay Transport for Drop
 * Stores and forwards encrypted chunk frames over standard HTTP with Range support.
 * The relay server never sees plaintext chunks.
 */

import { ITransport, FrameCodec } from './types.js';

export class HttpRelayTransport implements ITransport {
  public readonly id: string;
  public readonly name: string;
  private baseUrl: string;
  private sessionId: string;
  private connected: boolean = true;
  private activeUploads: number = 0;

  public onFrame?: (frame: Uint8Array) => void;
  public onDrain?: () => void;
  public onError?: (err: Error) => void;

  constructor(id: string, baseUrl: string, sessionId: string) {
    this.id = id;
    this.name = `HTTP-Relay-${id}`;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionId = sessionId;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async sendFrame(frame: Uint8Array): Promise<boolean> {
    if (!this.connected) return false;

    const decoded = FrameCodec.decodeFrame(frame);
    if (!decoded) return false;

    const url = `${this.baseUrl}/api/relay/${this.sessionId}/chunk/${decoded.chunkIndex}`;
    this.activeUploads++;

    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Drop-Chunk': decoded.chunkIndex.toString(),
        },
        body: frame,
      });

      this.activeUploads--;

      if (!res.ok) {
        throw new Error(`HTTP relay chunk upload returned status ${res.status}`);
      }

      // Simulate ACK back to engine
      const ackFrame = FrameCodec.encodeControlFrame(0x0002, decoded.chunkIndex);
      if (this.onFrame) {
        this.onFrame(ackFrame);
      }

      return true;
    } catch (e: any) {
      this.activeUploads--;
      if (this.onError) {
        this.onError(e);
      }
      return false;
    }
  }

  /**
   * For the receiver to download an encrypted chunk from the relay.
   */
  public async fetchChunk(chunkIndex: number): Promise<Uint8Array | null> {
    if (!this.connected) return null;
    const url = `${this.baseUrl}/api/relay/${this.sessionId}/chunk/${chunkIndex}`;

    try {
      const res = await fetch(url);
      if (res.status === 404) {
        // Chunk not yet arrived at relay
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP relay chunk download error ${res.status}`);
      }

      const buffer = await res.arrayBuffer();
      const frame = new Uint8Array(buffer);

      if (this.onFrame) {
        this.onFrame(frame);
      }

      return frame;
    } catch (e: any) {
      if (this.onError) this.onError(e);
      return null;
    }
  }

  public getBufferedAmount(): number {
    return this.activeUploads * (8 * 1024 * 1024);
  }

  public async close(): Promise<void> {
    this.connected = false;
  }
}
