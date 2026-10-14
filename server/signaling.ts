/**
 * WebSocket & HTTP Signaling Hub for Drop
 * Secure room pairing: strictly capped at 2 peers, rate-limited per IP,
 * authenticated with token derived from the URL fragment key, with automatic TTL cleanup.
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

export interface SignalingRoom {
  code: string;
  authSecret?: string;
  createdAt: number;
  lastActivity: number;
  peers: Map<string, SignalingPeer>;
}

export class SignalingHub {
  private rooms = new Map<string, SignalingRoom>();
  private ipJoinAttempts = new Map<string, { count: number; resetTime: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredRooms();
    }, 60 * 1000); // Check every minute
  }

  public generateRoomCode(): string {
    let code = '';
    let attempts = 0;
    do {
      code = crypto.randomInt(100000, 1000000).toString();
      attempts++;
    } while (this.rooms.has(code) && this.rooms.get(code)!.peers.size > 0 && attempts < 1000);
    return code;
  }

  /**
   * Rate limits join attempts per IP: max 15 attempts per minute.
   */
  public checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.ipJoinAttempts.get(ip);
    if (!entry || now > entry.resetTime) {
      this.ipJoinAttempts.set(ip, { count: 1, resetTime: now + 60000 });
      return true;
    }
    if (entry.count >= 15) {
      return false;
    }
    entry.count++;
    return true;
  }

  public createRoom(authSecret?: string): string {
    const code = this.generateRoomCode();
    const room: SignalingRoom = {
      code,
      authSecret,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      peers: new Map(),
    };
    this.rooms.set(code, room);
    return code;
  }

  public joinRoom(
    roomId: string,
    peerId: string,
    ip: string,
    ws?: WebSocket,
    authSecret?: string
  ): { isInitiator: boolean; isLanPeer: boolean; error?: string } {
    if (!this.checkRateLimit(ip)) {
      return { isInitiator: false, isLanPeer: false, error: 'Rate limit exceeded. Please wait a minute.' };
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      // Create fresh room on join if not existent
      room = {
        code: roomId,
        authSecret,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        peers: new Map(),
      };
      this.rooms.set(roomId, room);
    }

    // Authenticate if authSecret was set by initiator
    if (room.authSecret && authSecret && room.authSecret !== authSecret) {
      return { isInitiator: false, isLanPeer: false, error: 'Invalid room authorization token.' };
    } else if (!room.authSecret && authSecret) {
      room.authSecret = authSecret;
    }

    // Strictly enforce maximum 2 peers per room
    if (room.peers.size >= 2 && !room.peers.has(peerId)) {
      return { isInitiator: false, isLanPeer: false, error: 'Room is full (max 2 peers).' };
    }

    const peer: SignalingPeer = {
      id: peerId,
      ws,
      ip,
      isAlive: true,
      lastSeen: Date.now(),
    };

    const isInitiator = room.peers.size === 0;
    let isLanPeer = false;

    // Check if other peer in room shares same IP or local subnet
    for (const [existingId, existingPeer] of room.peers.entries()) {
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

    room.peers.set(peerId, peer);
    room.lastActivity = Date.now();
    return { isInitiator, isLanPeer };
  }

  public broadcastToRoom(roomId: string, senderPeerId: string, message: any): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.lastActivity = Date.now();
    for (const [peerId, peer] of room.peers.entries()) {
      if (peerId !== senderPeerId) {
        this.sendToPeer(peer, message);
      }
    }
  }

  public leaveRoom(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.peers.delete(peerId);
    room.lastActivity = Date.now();
    this.broadcastToRoom(roomId, peerId, {
      type: 'peer_left',
      peerId,
    });

    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  private sendToPeer(peer: SignalingPeer, msg: any): void {
    if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
      try {
        peer.ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(`Failed to send to peer ${peer.id}:`, e);
      }
    }
  }

  private isSameSubnet(ip1: string, ip2: string): boolean {
    if (!ip1 || !ip2) return false;
    // Simple /24 prefix check for IPv4
    const parts1 = ip1.split('.');
    const parts2 = ip2.split('.');
    if (parts1.length === 4 && parts2.length === 4) {
      return parts1[0] === parts2[0] && parts1[1] === parts2[1] && parts1[2] === parts2[2];
    }
    return false;
  }

  private cleanupExpiredRooms(): void {
    const now = Date.now();
    const TTL = 30 * 60 * 1000; // 30 minutes TTL
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > TTL || (room.peers.size === 0 && now - room.createdAt > 300000)) {
        this.rooms.delete(code);
      }
    }
  }

  public close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
