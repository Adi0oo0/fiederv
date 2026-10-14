export interface SignalingMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  fromPeerId?: string;
  initiator?: boolean;
  authSecret?: string;
  payload?: any;
  errorType?: string;
  message?: string;
}

export type SignalingCallback = (msg: SignalingMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Set<SignalingCallback> = new Set();
  private isConnecting = false;
  private reconnectTimer: any = null;
  private pollTimer: any = null;
  private isHttpMode = false;
  private isExplicitDisconnect = false;

  public myPeerId: string = Math.random().toString(36).substring(2, 9);
  public currentRoomId: string | null = null;

  constructor() {}

  public connect(): Promise<void> {
    this.isExplicitDisconnect = false;

    if (this.isHttpMode) {
      return Promise.resolve();
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }

    this.isConnecting = true;

    return new Promise((resolve) => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        const connectionTimeout = setTimeout(() => {
          if (this.isConnecting && !this.isExplicitDisconnect) {
            console.info('Signaling: WebSocket timeout, switching to HTTP signaling');
            this.fallbackToHttp();
            resolve();
          }
        }, 3500);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const data: SignalingMessage = JSON.parse(event.data);
            if (data.type === 'room_created' || data.type === 'room_joined') {
              if (data.roomId) {
                this.currentRoomId = data.roomId;
              }
            } else if (data.type === 'error') {
              if (data.errorType === 'room_not_found' || data.errorType === 'room_full') {
                this.currentRoomId = null;
              }
            }
            this.notifyListeners(data);
          } catch (e) {
            console.error('Failed to parse signaling message:', e);
          }
        };

        ws.onerror = (err) => {
          clearTimeout(connectionTimeout);
          if (this.isExplicitDisconnect) return;
          console.info('Signaling: WebSocket unavailable, using HTTP signaling fallback', err);
          this.fallbackToHttp();
          resolve();
        };

        ws.onclose = () => {
          if (!this.isExplicitDisconnect && !this.isHttpMode && this.currentRoomId) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        if (this.isExplicitDisconnect) return resolve();
        console.info('Signaling: WebSocket init failed, using HTTP signaling', err);
        this.fallbackToHttp();
        resolve();
      }
    });
  }

  private fallbackToHttp() {
    this.isHttpMode = true;
    this.isConnecting = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // ignore
      }
      this.ws = null;
    }
    if (this.currentRoomId) {
      this.startHttpPolling();
    }
  }

  private startHttpPolling() {
    this.stopHttpPolling();
    const poll = async () => {
      if (!this.currentRoomId || !this.isHttpMode) return;
      try {
        const res = await fetch(`/api/signaling/poll?roomId=${encodeURIComponent(this.currentRoomId)}&peerId=${encodeURIComponent(this.myPeerId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.messages)) {
            data.messages.forEach((msg: any) => {
              this.notifyListeners(msg);
            });
          }
        }
      } catch (e) {
        // quiet retry
      }
      if (this.currentRoomId && this.isHttpMode) {
        this.pollTimer = setTimeout(poll, 400);
      }
    };
    poll();
  }

  private stopHttpPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentRoomId && !this.isHttpMode) {
        this.connect().then(() => {
          if (this.currentRoomId && this.ws?.readyState === WebSocket.OPEN) {
            this.joinRoom(this.currentRoomId);
          }
        });
      }
    }, 2000);
  }

  private notifyListeners(data: SignalingMessage) {
    this.listeners.forEach((listener) => {
      try {
        listener(data);
      } catch (e) {
        console.error('Error in signaling listener:', e);
      }
    });
  }

  public subscribe(callback: SignalingCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  public async createRoom(requestedCode?: string, authSecret?: string) {
    if (this.currentRoomId && (!requestedCode || this.currentRoomId !== requestedCode)) {
      await this.leaveRoom();
    }

    if (this.isHttpMode) {
      try {
        const res = await fetch('/api/signaling/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestedCode, peerId: this.myPeerId, authSecret }),
        });
        if (res.ok) {
          const data = await res.json();
          this.currentRoomId = data.roomId;
          this.notifyListeners({
            type: 'room_created',
            roomId: data.roomId,
            peerId: data.peerId,
            payload: { peersCount: data.peersCount || 1 },
          });
          this.startHttpPolling();
        } else {
          const errData = await res.json().catch(() => ({}));
          this.notifyListeners({
            type: 'error',
            errorType: res.status === 409 ? 'room_taken' : 'create_failed',
            message: errData.error || 'Failed to create room',
          });
        }
      } catch (err) {
        console.error('Failed to create room via HTTP:', err);
      }
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    if (this.isHttpMode) {
      this.createRoom(requestedCode, authSecret);
      return;
    }

    this.send({
      type: 'create_room',
      peerId: this.myPeerId,
      authSecret,
      payload: { code: requestedCode },
    });
  }

  public async joinRoom(roomId: string, authSecret?: string) {
    if (this.currentRoomId && this.currentRoomId !== roomId) {
      await this.leaveRoom();
    }
    this.currentRoomId = roomId;

    if (this.isHttpMode) {
      try {
        const res = await fetch('/api/signaling/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, peerId: this.myPeerId, authSecret }),
        });
        if (res.ok) {
          const data = await res.json();
          this.currentRoomId = data.roomId;
          this.notifyListeners({
            type: 'room_joined',
            roomId: data.roomId,
            peerId: data.peerId,
            payload: { peersCount: data.peersCount || 1 },
          });
          this.startHttpPolling();
        } else {
          const errData = await res.json().catch(() => ({}));
          this.currentRoomId = null;
          this.notifyListeners({
            type: 'error',
            errorType: res.status === 404 ? 'room_not_found' : 'room_full',
            message: errData.error || 'Failed to join room',
          });
        }
      } catch (err) {
        console.error('Failed to join room via HTTP:', err);
      }
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    if (this.isHttpMode) {
      this.joinRoom(roomId, authSecret);
      return;
    }

    this.send({
      type: 'join_room',
      roomId,
      peerId: this.myPeerId,
      authSecret,
    });
  }

  public async sendSignal(payload: any) {
    if (this.isHttpMode) {
      if (!this.currentRoomId) return;
      try {
        await fetch('/api/signaling/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomId: this.currentRoomId,
            fromPeerId: this.myPeerId,
            payload,
          }),
        });
      } catch (e) {
        console.warn('Failed to send HTTP signal:', e);
      }
      return;
    }

    this.send({
      type: 'signal',
      roomId: this.currentRoomId || undefined,
      peerId: this.myPeerId,
      payload,
    });
  }

  public send(msg: SignalingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public async leaveRoom(): Promise<void> {
    this.stopHttpPolling();
    if (this.currentRoomId) {
      const roomToLeave = this.currentRoomId;
      this.currentRoomId = null;
      if (this.isHttpMode) {
        try {
          await fetch('/api/signaling/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: roomToLeave, peerId: this.myPeerId }),
          });
        } catch (e) {
          // ignore
        }
      } else {
        this.send({
          type: 'leave_room',
          roomId: roomToLeave,
          peerId: this.myPeerId,
        });
      }
    }
  }

  public disconnect() {
    this.isExplicitDisconnect = true;
    this.stopHttpPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.currentRoomId = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }
}
