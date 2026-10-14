/**
 * WebTransport (HTTP/3 / QUIC) Relay Transport for Drop
 * Multiplexed bidirectional and unidirectional streams without head-of-line blocking.
 */

import { ITransport, FrameCodec } from './types.js';

export class WebTransportRelay implements ITransport {
  public readonly id: string;
  public readonly name: string;
  private url: string;
  private transport: any = null;
  private connected: boolean = false;

  public onFrame?: (frame: Uint8Array) => void;
  public onDrain?: () => void;
  public onError?: (err: Error) => void;

  constructor(id: string, url: string) {
    this.id = id;
    this.name = `WebTransport-${id}`;
    this.url = url;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<boolean> {
    if (typeof (globalThis as any).WebTransport === 'undefined') {
      return false;
    }

    try {
      const WebTransportCtor = (globalThis as any).WebTransport;
      this.transport = new WebTransportCtor(this.url);
      await this.transport.ready;
      this.connected = true;
      this.listenIncomingStreams();
      return true;
    } catch (e: any) {
      this.connected = false;
      return false;
    }
  }

  private async listenIncomingStreams(): Promise<void> {
    if (!this.transport) return;
    try {
      const reader = this.transport.incomingUnidirectionalStreams.getReader();
      while (this.connected) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        this.readStream(stream);
      }
    } catch {}
  }

  private async readStream(stream: any): Promise<void> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalLen += value.length;
        }
      }

      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
      }

      if (this.onFrame) {
        this.onFrame(combined);
      }
    } catch {}
  }

  public async sendFrame(frame: Uint8Array): Promise<boolean> {
    if (!this.connected || !this.transport) return false;

    try {
      const stream = await this.transport.createUnidirectionalStream();
      const writer = stream.getWriter();
      await writer.write(frame);
      await writer.close();

      // Trigger ACK
      const decoded = FrameCodec.decodeFrame(frame);
      if (decoded && this.onFrame) {
        const ack = FrameCodec.encodeControlFrame(0x0002, decoded.chunkIndex);
        this.onFrame(ack);
      }

      return true;
    } catch (e: any) {
      if (this.onError) this.onError(e);
      return false;
    }
  }

  public getBufferedAmount(): number {
    return 0;
  }

  public async close(): Promise<void> {
    this.connected = false;
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {}
      this.transport = null;
    }
  }
}
