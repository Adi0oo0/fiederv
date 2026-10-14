/**
 * Signaling Client for Drop
 * WebSocket connection with auto-reconnect and message subscriptions.
 */

export interface SignalingMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  initiator?: boolean;
  isLanPeer?: boolean;
  payload?: any;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private subscribers: Set<(msg: SignalingMessage) => void> = new Set();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private url: string;

  constructor() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${protocol}//${window.location.host}/ws`;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data: SignalingMessage = JSON.parse(event.data);
            this.subscribers.forEach((sub) => sub(data));
          } catch {}
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.scheduleReconnect();
        };

        this.ws.onerror = (_err) => {
          if (!this.isConnected) {
            reject(new Error('WebSocket connection failed'));
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts > 10) return;
    const delay = Math.min(10000, 1000 * Math.pow(1.5, this.reconnectAttempts));
    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  public subscribe(handler: (msg: SignalingMessage) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  public createRoom(): void {
    this.send({ type: 'create_room' });
  }

  public joinRoom(roomId: string): void {
    this.send({ type: 'join_room', roomId });
  }

  public sendSignal(payload: any): void {
    this.send({ type: 'signal', payload });
  }

  public send(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}
