/**
 * Cryptographic operations for Drop
 * HKDF-SHA256 subkey derivation, AES-256-GCM chunk encryption with deterministic unique nonces,
 * PBKDF2 passphrase derivation (600k iterations), and encrypted manifest authentication.
 * Zero-knowledge: plaintext never reaches signaling server or relay.
 */

export interface DerivedKeys {
  rawKeyHex: string;
  saltHex: string;
  fragment: string;
  authSecret: string;
}

export class TransferCrypto {
  private masterKeyRaw: Uint8Array | null = null;
  private chunkKey: CryptoKey | null = null;
  private manifestKey: CryptoKey | null = null;
  private salt: Uint8Array = new Uint8Array(4);
  private authSecret: string = '';

  constructor() {}

  /**
   * Generates a new 256-bit master key and 4-byte session salt,
   * then derives chunk, manifest, and auth subkeys via HKDF.
   */
  public async generateKey(): Promise<DerivedKeys> {
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    crypto.getRandomValues(this.salt);

    await this.deriveSubkeys(rawKey, this.salt);

    const rawKeyHex = this.toHex(rawKey);
    const saltHex = this.toHex(this.salt);
    const fragment = `${rawKeyHex}.${saltHex}`;

    return {
      rawKeyHex,
      saltHex,
      fragment,
      authSecret: this.authSecret,
    };
  }

  /**
   * Derives master key from a user-supplied passphrase using PBKDF2 (600,000 iterations).
   */
  public async generateFromPassphrase(passphrase: string, existingSalt?: Uint8Array): Promise<DerivedKeys> {
    if (existingSalt && existingSalt.length >= 4) {
      this.salt = new Uint8Array(existingSalt.subarray(0, 4));
    } else {
      crypto.getRandomValues(this.salt);
    }

    const enc = new TextEncoder();
    const passphraseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    // Expand 4-byte session salt with fixed domain for PBKDF2 salt
    const pbkdf2Salt = new Uint8Array(16);
    pbkdf2Salt.set(this.salt, 0);
    pbkdf2Salt.set(enc.encode('drop-v1-kdf'), 4);

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: pbkdf2Salt,
        iterations: 600000,
        hash: 'SHA-256',
      },
      passphraseKey,
      256
    );

    const rawKey = new Uint8Array(derivedBits);
    await this.deriveSubkeys(rawKey, this.salt);

    const rawKeyHex = this.toHex(rawKey);
    const saltHex = this.toHex(this.salt);
    const fragment = `${rawKeyHex}.${saltHex}`;

    return {
      rawKeyHex,
      saltHex,
      fragment,
      authSecret: this.authSecret,
    };
  }

  /**
   * Initializes from fragment string: "<keyHex>.<saltHex>"
   */
  public async initFromFragment(fragment: string): Promise<void> {
    const clean = fragment.replace(/^#key=/, '').replace(/^key=/, '').trim();
    const [keyHex, saltHex] = clean.split('.');
    if (!keyHex || !saltHex || keyHex.length !== 64 || saltHex.length !== 8) {
      throw new Error('Invalid encryption fragment in URL.');
    }

    const rawKey = this.fromHex(keyHex);
    this.salt = this.fromHex(saltHex);

    await this.deriveSubkeys(rawKey, this.salt);
  }

  /**
   * Uses HKDF-SHA256 to derive:
   * 1. chunkKey (AES-256-GCM)
   * 2. manifestKey (AES-256-GCM)
   * 3. authSecret (bearer token for signaling and relay authorization)
   */
  private async deriveSubkeys(rawKey: Uint8Array, salt: Uint8Array): Promise<void> {
    this.masterKeyRaw = rawKey;
    const enc = new TextEncoder();

    // Import master key as HKDF secret
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      rawKey as any,
      { name: 'HKDF' },
      false,
      ['deriveKey', 'deriveBits']
    );

    // 1. Derive Chunk Encryption Key (AES-256-GCM)
    this.chunkKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as any,
        info: enc.encode('drop-chunk-aes-256-gcm'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // 2. Derive Manifest Encryption Key (AES-256-GCM)
    this.manifestKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as any,
        info: enc.encode('drop-manifest-aes-256-gcm'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // 3. Derive Auth Secret (128 bits for relay / signaling bearer token)
    const authBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as any,
        info: enc.encode('drop-signaling-auth-token'),
      },
      hkdfKey,
      128
    );
    this.authSecret = this.toHex(new Uint8Array(authBits));
  }

  public getAuthSecret(): string {
    return this.authSecret;
  }

  public isReady(): boolean {
    return this.chunkKey !== null;
  }

  /**
   * Constructs deterministic 12-byte nonce:
   * [ 4 bytes salt | 8 bytes chunk index big-endian ]
   */
  public constructNonce(chunkIndex: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(this.salt, 0);

    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setBigUint64(4, BigInt(chunkIndex), false);
    return nonce;
  }

  /**
   * Encrypts plaintext chunk with AES-256-GCM using deterministic chunk index nonce.
   */
  public async encryptChunk(chunkIndex: number, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.chunkKey) throw new Error('Crypto key not initialized.');

    const nonce = this.constructNonce(chunkIndex);
    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as any,
      },
      this.chunkKey,
      plaintext as any
    );

    return new Uint8Array(ciphertextBuffer);
  }

  /**
   * Decrypts ciphertext chunk with AES-256-GCM.
   */
  public async decryptChunk(chunkIndex: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.chunkKey) throw new Error('Crypto key not initialized.');

    const nonce = this.constructNonce(chunkIndex);
    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as any,
      },
      this.chunkKey,
      ciphertext as any
    );

    return new Uint8Array(plaintextBuffer);
  }

  /**
   * Encrypts file manifest JSON string using the derived manifestKey.
   */
  public async encryptManifest(manifestJson: string): Promise<string> {
    if (!this.manifestKey) throw new Error('Crypto key not initialized.');

    const enc = new TextEncoder();
    const data = enc.encode(manifestJson);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as any,
      },
      this.manifestKey,
      data as any
    );

    const combined = new Uint8Array(12 + ciphertextBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuffer), 12);
    return this.toHex(combined);
  }

  /**
   * Decrypts file manifest from hex string.
   */
  public async decryptManifest(encryptedHex: string): Promise<string> {
    if (!this.manifestKey) throw new Error('Crypto key not initialized.');

    const combined = this.fromHex(encryptedHex);
    if (combined.length < 28) throw new Error('Invalid encrypted manifest length');

    const iv = combined.subarray(0, 12);
    const ciphertext = combined.subarray(12);

    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as any,
      },
      this.manifestKey,
      ciphertext as any
    );

    const dec = new TextDecoder();
    return dec.decode(plaintextBuffer);
  }

  public getSaltHex(): string {
    return this.toHex(this.salt);
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
