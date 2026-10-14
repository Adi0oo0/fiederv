/**
 * WebRTC Multi-DataChannel & Multi-Association Transport for Drop
 * Opens multiple parallel RTCPeerConnections (2-3 distinct SCTP associations with independent congestion windows)
 * with N data channels per association.
 * Slices large chunk frames into <= 32 KiB wire packets to strictly respect browser SCTP maxMessageSize limits.
 */

import { ITransport } from './types.js';

export const WIRE_MAGIC = 0x44525057; // 'DRPW'
export const MAX_WIRE_MESSAGE_SIZE = 32 * 1024; // 32 KiB safe limit for all browsers

export interface WebRTCChannelOptions {
  peerConnectionCount?: number; // 2-3 independent SCTP associations
  channelsPerPeer?: number;     // 2-4 channels per association
  iceServers?: RTCIceServer[];
  onSignal?: (signal: any) => void;
  onConnectionChange?: (state: RTCPeerConnectionState) => void;
}

interface InFlightReassembly {
  totalLength: number;
  receivedBytes: number;
  buffer: Uint8Array;
  lastActive: number;
}

export class WebRTCDataChannelTransport implements ITransport {
  public readonly id: string;
  public readonly name: string;
  private channel: RTCDataChannel;
  private isDraining: boolean = false;
  private nextFrameSeq: number = 0;

  // Reassembly map for incoming fragmented wire frames
  private reassemblyMap = new Map<number, InFlightReassembly>();

  public onFrame?: (frame: Uint8Array) => void;
  public onDrain?: () => void;
  public onError?: (err: Error) => void;

  constructor(id: string, channel: RTCDataChannel) {
    this.id = id;
    this.name = `WebRTC-${id}`;
    this.channel = channel;
    this.channel.binaryType = 'arraybuffer';
    // Backpressure threshold at 1 MB
    this.channel.bufferedAmountLowThreshold = 1024 * 1024;

    this.channel.onmessage = (event) => {
      this.handleIncomingWireMessage(new Uint8Array(event.data));
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

  /**
   * Slices large chunk frames into <= 32KB sub-messages to strictly prevent
   * Chromium SCTP maxMessageSize throws.
   */
  public async sendFrame(frame: Uint8Array): Promise<boolean> {
    if (!this.isConnected()) return false;

    const frameSeq = this.nextFrameSeq++;
    const totalLength = frame.length;
    const WIRE_HEADER_SIZE = 20;
    const maxPayloadPerWire = MAX_WIRE_MESSAGE_SIZE - WIRE_HEADER_SIZE;

    let subOffset = 0;
    while (subOffset < totalLength) {
      if (!this.isConnected()) return false;

      // Strict backpressure wait
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

      const chunkSliceSize = Math.min(maxPayloadPerWire, totalLength - subOffset);
      const wirePacket = new Uint8Array(WIRE_HEADER_SIZE + chunkSliceSize);
      const view = new DataView(wirePacket.buffer, wirePacket.byteOffset, wirePacket.byteLength);

      // Wire Header (20 bytes):
      // [ 4B WIRE_MAGIC | 2B flags | 2B reserved | 4B frameSeq | 4B subOffset | 4B frameTotalLen ]
      view.setUint32(0, WIRE_MAGIC, false);
      view.setUint16(4, 0, false);
      view.setUint16(6, 0, false);
      view.setUint32(8, frameSeq, false);
      view.setUint32(12, subOffset, false);
      view.setUint32(16, totalLength, false);

      wirePacket.set(frame.subarray(subOffset, subOffset + chunkSliceSize), WIRE_HEADER_SIZE);

      try {
        this.channel.send(wirePacket as any);
      } catch (err: any) {
        if (this.onError) this.onError(err);
        return false;
      }

      subOffset += chunkSliceSize;
    }

    return true;
  }

  private handleIncomingWireMessage(wirePacket: Uint8Array): void {
    if (wirePacket.byteLength < 20) return;
    const view = new DataView(wirePacket.buffer, wirePacket.byteOffset, wirePacket.byteLength);

    const magic = view.getUint32(0, false);
    if (magic !== WIRE_MAGIC) {
      // Direct raw unfragmented frame fallback
      if (this.onFrame) this.onFrame(wirePacket);
      return;
    }

    const frameSeq = view.getUint32(8, false);
    const subOffset = view.getUint32(12, false);
    const frameTotalLen = view.getUint32(16, false);
    const subPayload = wirePacket.subarray(20);

    let reassembly = this.reassemblyMap.get(frameSeq);
    if (!reassembly) {
      reassembly = {
        totalLength: frameTotalLen,
        receivedBytes: 0,
        buffer: new Uint8Array(frameTotalLen),
        lastActive: Date.now(),
      };
      this.reassemblyMap.set(frameSeq, reassembly);
    }

    reassembly.buffer.set(subPayload, subOffset);
    reassembly.receivedBytes += subPayload.length;
    reassembly.lastActive = Date.now();

    if (reassembly.receivedBytes >= reassembly.totalLength) {
      this.reassemblyMap.delete(frameSeq);
      if (this.onFrame) {
        this.onFrame(reassembly.buffer);
      }
    }
  }

  public getBufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  public async close(): Promise<void> {
    try {
      this.channel.close();
    } catch {}
    this.reassemblyMap.clear();
  }
}

export class WebRTCPeerManager {
  private peerConnections: RTCPeerConnection[] = [];
  private channels: Map<string, WebRTCDataChannelTransport> = new Map();
  private options: WebRTCChannelOptions;
  public onChannelReady?: (transport: WebRTCDataChannelTransport) => void;

  constructor(options: WebRTCChannelOptions = {}) {
    this.options = {
      peerConnectionCount: 2, // 2 parallel SCTP associations by default
      channelsPerPeer: 3,     // 3 channels per peer = 6 total streams
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      ...options,
    };
  }

  public async initialize(isInitiator: boolean): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      return;
    }

    const pcCount = Math.max(1, Math.min(4, this.options.peerConnectionCount || 2));
    const channelsPerPc = Math.max(1, Math.min(8, this.options.channelsPerPeer || 3));

    for (let pcIdx = 0; pcIdx < pcCount; pcIdx++) {
      const pc = new RTCPeerConnection({
        iceServers: this.options.iceServers,
        iceCandidatePoolSize: 4,
      });

      this.peerConnections.push(pc);

      pc.onicecandidate = (event) => {
        if (event.candidate && this.options.onSignal) {
          this.options.onSignal({
            type: 'candidate',
            pcIndex: pcIdx,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.options.onConnectionChange) {
          this.options.onConnectionChange(pc.connectionState);
        }
      };

      if (isInitiator) {
        // Initiator creates data channels
        for (let chIdx = 0; chIdx < channelsPerPc; chIdx++) {
          const chId = `pc${pcIdx}_ch${chIdx}`;
          const channel = pc.createDataChannel(chId, {
            ordered: false,
            maxRetransmits: 30,
          });

          channel.onopen = () => {
            const transport = new WebRTCDataChannelTransport(chId, channel);
            this.channels.set(chId, transport);
            if (this.onChannelReady) {
              this.onChannelReady(transport);
            }
          };
        }

        // Create Offer for this PC
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (this.options.onSignal) {
          this.options.onSignal({
            type: 'offer',
            pcIndex: pcIdx,
            sdp: offer.sdp,
          });
        }
      } else {
        // Receiver waits for data channels
        pc.ondatachannel = (event) => {
          const channel = event.channel;
          const chId = channel.label || `pc${pcIdx}_rx_${Date.now()}`;
          const transport = new WebRTCDataChannelTransport(chId, channel);
          this.channels.set(chId, transport);

          channel.onopen = () => {
            if (this.onChannelReady) {
              this.onChannelReady(transport);
            }
          };
        };
      }
    }
  }

  public async handleSignal(signal: any): Promise<void> {
    const pcIdx = typeof signal.pcIndex === 'number' ? signal.pcIndex : 0;
    const pc = this.peerConnections[pcIdx];
    if (!pc) return;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (this.options.onSignal) {
          this.options.onSignal({
            type: 'answer',
            pcIndex: pcIdx,
            sdp: answer.sdp,
          });
        }
      } else if (signal.type === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.warn(`ICE candidate add error on PC ${pcIdx}:`, e);
        }
      }
    } catch (err) {
      console.error(`Signaling error on PC ${pcIdx}:`, err);
    }
  }

  public getActiveChannels(): WebRTCDataChannelTransport[] {
    return Array.from(this.channels.values()).filter((ch) => ch.isConnected());
  }

  public async close(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.close();
    }
    this.channels.clear();

    for (const pc of this.peerConnections) {
      try {
        pc.close();
      } catch {}
    }
    this.peerConnections = [];
  }
}
