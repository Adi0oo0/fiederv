/**
 * End-to-End Encryption (E2EE) Module for Drop
 * AES-256-GCM authenticated cipher with deterministic unique nonces per chunk.
 * The encryption key is held exclusively in the URL fragment (#key=...)
 * and is NEVER sent to the signaling server or relay.
 */

export class E2EESession {
  private cryptoKey: CryptoKey | null = null;
  private salt: Uint8Array = new Uint8Array(4);
  private rawKeyHex: string = '';
  private saltHex: string = '';

  constructor() {}

  /**
   * Generates a new 256-bit AES-GCM key and 4-byte session salt.
   * Returns fragment suitable for URL `#key=<keyHex>.<saltHex>`.
   */
  public async generate(): Promise<{ rawKeyHex: string; saltHex: string; fragment: string }> {
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    crypto.getRandomValues(this.salt);

    this.cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );

    this.rawKeyHex = this.toHex(rawKey);
    this.saltHex = this.toHex(this.salt);
    const fragment = `${this.rawKeyHex}.${this.saltHex}`;

    return { rawKeyHex: this.rawKeyHex, saltHex: this.saltHex, fragment };
  }

  /**
   * Initializes from fragment string: "<keyHex>.<saltHex>"
   */
  public async initFromFragment(fragment: string): Promise<void> {
    const clean = fragment.replace(/^#key=/, '').replace(/^key=/, '').trim();
    const [keyHex, saltHex] = clean.split('.');

    if (!keyHex || !saltHex || keyHex.length !== 64 || saltHex.length !== 8) {
      throw new Error('Invalid E2EE key fragment format. Expected 64-char key hex and 8-char salt hex.');
    }

    const rawKey = this.fromHex(keyHex);
    this.salt = this.fromHex(saltHex);
    this.rawKeyHex = keyHex;
    this.saltHex = saltHex;

    this.cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey as any,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  public isReady(): boolean {
    return this.cryptoKey !== null;
  }

  public getFragment(): string {
    return `${this.rawKeyHex}.${this.saltHex}`;
  }

  /**
   * Deterministic 12-byte (96-bit) nonce:
   * [ 4 bytes salt | 8 bytes chunk index big-endian ]
   * Strictly guarantees no (key, nonce) collision across chunks.
   */
  public constructNonce(chunkIndex: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(this.salt, 0);

    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setBigUint64(4, BigInt(chunkIndex), false);
    return nonce;
  }

  /**
   * Encrypts plaintext chunk using AES-256-GCM.
   */
  public async encryptChunk(chunkIndex: number, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.cryptoKey) throw new Error('E2EE key not initialized');

    const nonce = this.constructNonce(chunkIndex);
    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as any,
      },
      this.cryptoKey,
      plaintext as any
    );

    return new Uint8Array(ciphertextBuffer);
  }

  /**
   * Decrypts ciphertext chunk using AES-256-GCM.
   * Throws if tag verification fails (integrity violation or tampering).
   */
  public async decryptChunk(chunkIndex: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.cryptoKey) throw new Error('E2EE key not initialized');

    const nonce = this.constructNonce(chunkIndex);
    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as any,
      },
      this.cryptoKey,
      ciphertext as any
    );

    return new Uint8Array(plaintextBuffer);
  }

  private toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private fromHex(hex: string): Uint8Array {
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
