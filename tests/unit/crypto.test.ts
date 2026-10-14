import { describe, it, expect } from 'vitest';
import { TransferCrypto } from '../../engine/crypto.js';
import { FrameCodec, FrameType } from '../../engine/transports/types.js';

describe('TransferCrypto & Zero-Knowledge Security', () => {
  it('encrypts and decrypts chunks accurately with unique nonces', async () => {
    const senderCrypto = new TransferCrypto();
    const { fragment, authSecret } = await senderCrypto.generateKey();
    expect(authSecret).toBeDefined();
    expect(authSecret.length).toBe(32); // 128-bit hex auth secret

    const receiverCrypto = new TransferCrypto();
    await receiverCrypto.initFromFragment(fragment);

    const plaintext = new TextEncoder().encode('Hello Drop High-Throughput E2EE Stream');

    // Encrypt chunk 0
    const ciphertext0 = await senderCrypto.encryptChunk(0, plaintext);
    const decrypted0 = await receiverCrypto.decryptChunk(0, ciphertext0);
    expect(new TextDecoder().decode(decrypted0)).toBe('Hello Drop High-Throughput E2EE Stream');

    // Chunk 1 uses different nonce: ciphertext must differ
    const ciphertext1 = await senderCrypto.encryptChunk(1, plaintext);
    expect(ciphertext0).not.toEqual(ciphertext1);

    // Decrypting chunk 1 with chunk 0 index must fail authentication
    await expect(receiverCrypto.decryptChunk(0, ciphertext1)).rejects.toThrow();
  });

  it('supports PBKDF2 passphrase derivation (600,000 iterations)', async () => {
    const sender = new TransferCrypto();
    const salt = new Uint8Array([1, 2, 3, 4]);
    const { fragment, authSecret } = await sender.generateFromPassphrase('super-secret-passphrase-2026', salt);

    const receiver = new TransferCrypto();
    await receiver.initFromFragment(fragment);
    expect(receiver.getAuthSecret()).toBe(authSecret);

    const data = new Uint8Array([10, 20, 30, 40]);
    const enc = await sender.encryptChunk(42, data);
    const dec = await receiver.decryptChunk(42, enc);
    expect(dec).toEqual(data);
  });

  it('encrypts and authenticates file manifests', async () => {
    const cryptoInstance = new TransferCrypto();
    await cryptoInstance.generateKey();

    const manifestJson = JSON.stringify({ name: 'huge-archive.tar', size: 107374182400, totalChunks: 12800 });
    const encryptedHex = await cryptoInstance.encryptManifest(manifestJson);
    expect(encryptedHex).not.toContain('huge-archive.tar');

    const decrypted = await cryptoInstance.decryptManifest(encryptedHex);
    expect(decrypted).toBe(manifestJson);
  });

  it('encodes and decodes frames without exposing plaintext hashes (zero-knowledge)', () => {
    const nonce = new Uint8Array(12);
    nonce.fill(7);
    const ciphertext = new Uint8Array([100, 101, 102, 103, 104]);

    const frame = FrameCodec.encodeDataFrame(42, nonce, ciphertext);
    const decoded = FrameCodec.decodeFrame(frame);

    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(FrameType.DATA_CHUNK);
    expect(decoded!.chunkIndex).toBe(42);
    expect(decoded!.nonce).toEqual(nonce);
    expect(decoded!.payload).toEqual(ciphertext);
  });
});
