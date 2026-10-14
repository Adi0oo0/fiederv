/**
 * Binary Framing & Transport Interface for Drop
 */

export const DROP_MAGIC = 0x44524f50; // "DROP"
export const DROP_VERSION = 1;

export enum FrameType {
  DATA_CHUNK = 0x0001,
  CHUNK_ACK = 0x0002,
  CHUNK_NACK = 0x0003,
  BITMAP_SYNC = 0x0004,
  CONTROL_PAUSE = 0x0005,
  CONTROL_RESUME = 0x0006,
}

export interface DecodedChunkFrame {
  type: FrameType;
  chunkIndex: number;
  payloadLength: number;
  hash: Uint8Array;
  nonce: Uint8Array;
  payload: Uint8Array;
}

export class FrameCodec {
  public static readonly HEADER_SIZE = 64;

  /**
   * Encodes a chunk data frame:
   * [ 4B magic | 2B version | 2B type | 8B chunkIdx | 4B payloadLen | 32B hash | 12B nonce ] + [ payload ]
   */
  public static encodeDataFrame(
    chunkIndex: number,
    hash: Uint8Array,
    nonce: Uint8Array,
    encryptedPayload: Uint8Array
  ): Uint8Array {
    const totalSize = this.HEADER_SIZE + encryptedPayload.length;
    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    view.setUint32(0, DROP_MAGIC, false);
    view.setUint16(4, DROP_VERSION, false);
    view.setUint16(6, FrameType.DATA_CHUNK, false);
    view.setBigUint64(8, BigInt(chunkIndex), false);
    view.setUint32(16, encryptedPayload.length, false);

    // 32-byte hash
    buffer.set(hash.subarray(0, 32), 20);

    // 12-byte nonce
    buffer.set(nonce.subarray(0, 12), 52);

    // Payload
    buffer.set(encryptedPayload, this.HEADER_SIZE);

    return buffer;
  }

  /**
   * Encodes an ACK or NACK control frame.
   */
  public static encodeControlFrame(type: FrameType, chunkIndex: number): Uint8Array {
    const buffer = new Uint8Array(16);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    view.setUint32(0, DROP_MAGIC, false);
    view.setUint16(4, DROP_VERSION, false);
    view.setUint16(6, type, false);
    view.setBigUint64(8, BigInt(chunkIndex), false);
    return buffer;
  }

  /**
   * Decodes a binary frame.
   */
  public static decodeFrame(buffer: Uint8Array): DecodedChunkFrame | null {
    if (buffer.byteLength < 16) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const magic = view.getUint32(0, false);
    if (magic !== DROP_MAGIC) return null;

    const _version = view.getUint16(4, false);
    const type = view.getUint16(6, false) as FrameType;
    const chunkIndex = Number(view.getBigUint64(8, false));

    if (type !== FrameType.DATA_CHUNK) {
      return {
        type,
        chunkIndex,
        payloadLength: 0,
        hash: new Uint8Array(0),
        nonce: new Uint8Array(0),
        payload: new Uint8Array(0),
      };
    }

    if (buffer.byteLength < this.HEADER_SIZE) return null;
    const payloadLength = view.getUint32(16, false);
    const hash = buffer.slice(20, 52);
    const nonce = buffer.slice(52, 64);
    const payload = buffer.slice(this.HEADER_SIZE, this.HEADER_SIZE + payloadLength);

    return {
      type,
      chunkIndex,
      payloadLength,
      hash,
      nonce,
      payload,
    };
  }
}

export interface ITransport {
  readonly id: string;
  readonly name: string;
  isConnected(): boolean;
  sendFrame(frame: Uint8Array): Promise<boolean>;
  getBufferedAmount(): number;
  close(): Promise<void>;
  onFrame?: (frame: Uint8Array) => void;
  onDrain?: () => void;
  onError?: (err: Error) => void;
}
