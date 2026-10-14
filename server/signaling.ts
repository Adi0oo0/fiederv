/**
 * WebSocket & HTTP Signaling Hub for Drop
 * Room pairing, WebRTC SDP/ICE exchange, and LAN fast path candidate hint.
 */

import crypto from 'crypto';
import { WebSocket } from 'ws';

export interface SignalingPeer {
  id: string;
  ws?: WebSocket;
  ip: string;
  isAlive: boolean;
  lastSeen: number;
}

export class SignalingHub {
  private rooms = new Map<string, Map<string, SignalingPeer>>();

  public generateRoomCode(): string {
    let code = '';
    let attempts = 0;
    do {
      code = crypto.randomInt(100000, 1000000).toString();
      attempts++;
    } while (this.rooms.has(code) && this.rooms.get(code)!.size > 0 && attempts < 1000);
    return code;
  }

  public getOrCreateRoom(roomId: string): Map<string, SignalingPeer> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    return room;
  }

  public joinRoom(roomId: string, peerId: string, ip: string, ws?: WebSocket): { isInitiator: boolean; isLanPeer: boolean } {
    const room = this.getOrCreateRoom(roomId);
    const peer: SignalingPeer = {
      id: peerId,
      ws,
      ip,
      isAlive: true,
      lastSeen: Date.now(),
    };

    const isInitiator = room.size === 0;
    let isLanPeer = false;

    // Check if other peer in room shares same IP or local subnet
    for (const [existingId, existingPeer] of room.entries()) {
      if (existingId !== peerId) {
        if (existingPeer.ip === ip || this.isSameSubnet(existingPeer.ip, ip)) {
          isLanPeer = true;
        }

        // Notify existing peer
        this.sendToPeer(existingPeer, {
          type: 'peer_joined',
          peerId,
          initiator: true,
          isLanPeer,
        });

        // Notify joining peer
        if (ws) {
          this.sendToPeer(peer, {
            type: 'peer_joined',
            peerId: existingId,
            initiator: false,
            isLanPeer,
          });
        }
      }
    }

    room.set(peerId, peer);
    return { isInitiator, isLanPeer };
  }

  public broadcastToRoom(roomId: string, senderPeerId: string, message: any): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [peerId, peer] of room.entries()) {
      if (peerId !== senderPeerId) {
        this.sendToPeer(peer, message);
      }
    }
  }

  public leaveRoom(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.delete(peerId);
    this.broadcastToRoom(roomId, peerId, {
      type: 'peer_left',
      peerId,
    });

    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  private sendToPeer(peer: SignalingPeer, msg: any): void {
    if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
      try {
        peer.ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  private isSameSubnet(ip1: string, ip2: string): boolean {
    if (!ip1 || !ip2) return false;
    if (ip1 === ip2) return true;
    const p1 = ip1.split('.');
    const p2 = ip2.split('.');
    if (p1.length === 4 && p2.length === 4) {
      return p1[0] === p2[0] && p1[1] === p2[1] && p1[2] === p2[2];
    }
    return false;
  }
}
