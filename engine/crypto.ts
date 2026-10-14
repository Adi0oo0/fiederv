/**
 * Cryptographic operations for Drop
 * AES-256-GCM chunk encryption with deterministic unique nonces.
 * Works seamlessly in Browser (WebCrypto) and Node.js (globalThis.crypto).
 */

export class TransferCrypto {
  private key: CryptoKey | null = null;
  private salt: Uint8Array = new Uint8Array(4);

  constructor() {}

  /**
   * Generates a new 256-bit AES-GCM key and 4-byte session salt.
   */
  public async generateKey(): Promise<{ rawKeyHex: string; saltHex: string; fragment: string }> {
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    crypto.getRandomValues(this.salt);

    this.key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );

    const rawKeyHex = this.toHex(rawKey);
    const saltHex = this.toHex(this.salt);
    const fragment = `${rawKeyHex}.${saltHex}`;

    return { rawKeyHex, saltHex, fragment };
  }

  /**
   * Initializes from fragment string: "<keyHex>.<saltHex>"
   */
  public async initFromFragment(fragment: string): Promise<void> {
    const [keyHex, saltHex] = fragment.split('.');
    if (!keyHex || !saltHex || keyHex.length !== 64 || saltHex.length !== 8) {
      throw new Error('Invalid encryption fragment in URL.');
    }

    const rawKey = this.fromHex(keyHex);
    this.salt = this.fromHex(saltHex);

    this.key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Constructs deterministic 12-byte nonce:
   * [ 4 bytes salt | 8 bytes chunk index big-endian ]
   */
  public constructNonce(chunkIndex: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(this.salt, 0);

    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    // Write 64-bit chunk index as big endian
    // BigInt supports full 64-bit indices without overflow
    view.setBigUint64(4, BigInt(chunkIndex), false);
    return nonce;
  }

  /**
   * Encrypts plaintext chunk with AES-256-GCM using deterministic chunk index nonce.
   */
  public async encryptChunk(chunkIndex: number, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('Crypto key not initialized.');

    const nonce = this.constructNonce(chunkIndex);
    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
      },
      this.key,
      plaintext
    );

    return new Uint8Array(ciphertextBuffer);
  }

  /**
   * Decrypts ciphertext chunk with AES-256-GCM.
   */
  public async decryptChunk(chunkIndex: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('Crypto key not initialized.');

    const nonce = this.constructNonce(chunkIndex);
    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
      },
      this.key,
      ciphertext
    );

    return new Uint8Array(plaintextBuffer);
  }

  public getSaltHex(): string {
    return this.toHex(this.salt);
  }

  public setSaltHex(hex: string): void {
    this.salt = this.fromHex(hex);
  }

  public toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  public fromHex(hex: string): Uint8Array {
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
