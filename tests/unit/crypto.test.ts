import { describe, it, expect } from 'vitest';
import { TransferCrypto } from '../../engine/crypto.js';

describe('TransferCrypto', () => {
  it('encrypts and decrypts chunks accurately with unique nonces', async () => {
    const senderCrypto = new TransferCrypto();
    const { fragment } = await senderCrypto.generateKey();

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
});
