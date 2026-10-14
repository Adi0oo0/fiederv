/**
 * WebRTC Multi-DataChannel Transport for Drop
 * Opens N parallel channels (default 8, adaptive 4-32), unordered + reliable per chunk.
 * Implements strict backpressure via bufferedAmountLowThreshold (1MB).
 */

import { ITransport } from './types.js';

export interface WebRTCChannelOptions {
  channelCount?: number;
  iceServers?: RTCIceServer[];
  onSignal?: (signal: any) => void;
  onConnectionChange?: (state: RTCPeerConnectionState) => void;
}

export class WebRTCDataChannelTransport implements ITransport {
  public readonly id: string;
  public readonly name: string;
  private channel: RTCDataChannel;
  private isDraining: boolean = false;

  public onFrame?: (frame: Uint8Array) => void;
  public onDrain?: () => void;
  public onError?: (err: Error) => void;

  constructor(id: string, channel: RTCDataChannel) {
    this.id = id;
    this.name = `WebRTC-${id}`;
    this.channel = channel;
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = 1024 * 1024; // 1 MB

    this.channel.onmessage = (event) => {
      if (this.onFrame) {
        const data = new Uint8Array(event.data);
        this.onFrame(data);
      }
    };

    this.channel.onbufferedamountlow = () => {
      this.isDraining = false;
      if (this.onDrain) {
        this.onDrain();
      }
    };

    this.channel.onerror = (_err) => {
      if (this.onError) {
        this.onError(new Error(`DataChannel ${this.id} error`));
      }
    };
  }

  public isConnected(): boolean {
    return this.channel.readyState === 'open';
  }

  public async sendFrame(frame: Uint8Array): Promise<boolean> {
    if (!this.isConnected()) return false;

    // Strict backpressure pacing
    if (this.channel.bufferedAmount > this.channel.bufferedAmountLowThreshold) {
      this.isDraining = true;
      await new Promise<void>((resolve) => {
        const handler = () => {
          this.channel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        this.channel.addEventListener('bufferedamountlow', handler);
      });
    }

    try {
      this.channel.send(frame as any);
      return true;
    } catch (e: any) {
      if (this.onError) this.onError(e);
      return false;
    }
  }

  public getBufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  public async close(): Promise<void> {
    try {
      this.channel.close();
    } catch {}
  }
}

export class WebRTCPeerManager {
  private pc: RTCPeerConnection | null = null;
  private channels: Map<string, WebRTCDataChannelTransport> = new Map();
  private options: WebRTCChannelOptions;
  public onChannelReady?: (transport: WebRTCDataChannelTransport) => void;

  constructor(options: WebRTCChannelOptions = {}) {
    this.options = {
      channelCount: 8,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      ...options,
    };
  }

  public async initialize(isInitiator: boolean): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('RTCPeerConnection is not supported in this runtime environment.');
      return;
    }

    this.pc = new RTCPeerConnection({
      iceServers: this.options.iceServers,
      iceCandidatePoolSize: 8,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.options.onSignal) {
        this.options.onSignal({
          type: 'candidate',
          candidate: event.candidate,
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc && this.options.onConnectionChange) {
        this.options.onConnectionChange(this.pc.connectionState);
      }
    };

    if (isInitiator) {
      const count = this.options.channelCount || 8;
      for (let i = 0; i < count; i++) {
        const id = `ch_${i}`;
        const dc = this.pc.createDataChannel(id, {
          ordered: false,
          maxRetransmits: null, // reliable, unordered per chunk
        });
        this.setupChannel(id, dc);
      }

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.options.onSignal) {
        this.options.onSignal({
          type: 'offer',
          sdp: offer,
        });
      }
    } else {
      this.pc.ondatachannel = (event) => {
        const dc = event.channel;
        this.setupChannel(dc.label || `ch_${this.channels.size}`, dc);
      };
    }
  }

  private setupChannel(id: string, dc: RTCDataChannel): void {
    const transport = new WebRTCDataChannelTransport(id, dc);
    this.channels.set(id, transport);

    dc.onopen = () => {
      if (this.onChannelReady) {
        this.onChannelReady(transport);
      }
    };

    dc.onclose = () => {
      this.channels.delete(id);
    };
  }

  public async handleSignal(signal: any): Promise<void> {
    if (!this.pc) return;

    if (signal.type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      if (this.options.onSignal) {
        this.options.onSignal({
          type: 'answer',
          sdp: answer,
        });
      }
    } else if (signal.type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'candidate' && signal.candidate) {
      await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  public getActiveChannels(): WebRTCDataChannelTransport[] {
    return Array.from(this.channels.values()).filter((c) => c.isConnected());
  }

  public async close(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.close();
    }
    this.channels.clear();
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}
