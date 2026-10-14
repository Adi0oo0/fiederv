# Drop Wire Protocol & Transport Specification

**Version:** 1.0.0  
**Status:** Canonical  
**Architecture:** Zero-Knowledge, Multipath, Peer-to-Peer & Server-Relay File Stream

---

## 1. Overview & Security Architecture

Drop is an ultra-high throughput file transfer system engineered for single files and manifests spanning 50 GB to several hundred GB. Drop guarantees:
1. **Zero memory buffering**: Neither sender, receiver, nor relay buffers whole files or multiple gigabytes in memory. Processing operates on bounded chunk windows (streaming slice-and-write).
2. **Zero data loss**: Cryptographically verified chunk-level and whole-file Merkle root hashing.
3. **End-to-End Encryption (E2EE)**: Plaintext never touches the relay or wire unencrypted. The 256-bit transfer key resides exclusively in the client URL fragment (`#key=...`) and is never transmitted to the signaling or relay server.
4. **Multipath transport**: Simultaneous aggregation of WebRTC DataChannels, WebTransport (QUIC), and parallel HTTP/2-3 connections scheduled dynamically by real-time throughput.

---

## 2. Cryptographic Parameters & Key Derivation

### 2.1 Master Transfer Key
- **Algorithm:** AES-256-GCM
- **Key Generation:** Web Crypto API `crypto.getRandomValues(new Uint8Array(32))`
- **Distribution:** URL Fragment identifier `#key=<base64url>`
  - RFC 3986 specifies URL fragments are never sent in HTTP request headers.
- **Optional Passphrase Derivation:** PBKDF2-HMAC-SHA256 (100,000 iterations, 16-byte random salt).

### 2.2 Chunk Encryption & Nonce Construction
Each chunk is encrypted independently using AES-256-GCM.
- **Nonce (12 bytes / 96 bits):**
  - Bytes 0..3: Transfer Session Salt (random 4 bytes generated with the key)
  - Bytes 4..11: Chunk Index $i$ (64-bit unsigned big-endian integer: `Uint64BE(chunkIndex)`)
- **Authentication Tag:** 16 bytes (standard GCM tag appended or framed).
- **Security Invariant:** Because chunk indices are strictly monotonic and unique, no (key, nonce) pair is ever reused under any circumstances.

---

## 3. Chunk Framing Specification

All binary chunk transmissions across WebRTC DataChannels, WebTransport streams, and HTTP relay payloads use a uniform 62-byte binary header followed by the ciphertext.

### 3.1 Binary Chunk Frame Format

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Magic: "DROP" (0x44524F50)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       Version (0x01)          |        Frame Type             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Chunk Index (uint64_be)                 +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Encrypted Payload Length (uint32_be)      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                  Chunk Plaintext Hash (32 bytes)              +
|                      (BLAKE3 or SHA-256)                      |
|                                                               |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   AES-GCM Nonce / IV (12 bytes)               |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   AES-GCM Auth Tag (16 bytes)                 |
|                                                               |
|                                                               |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                 Encrypted Payload (N bytes)                   |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 3.2 Frame Types
- `0x0001`: `DATA_CHUNK` — Contains payload with chunk metadata and encrypted data.
- `0x0002`: `CHUNK_ACK` — Receiver acknowledgement of valid chunk verification.
- `0x0003`: `CHUNK_NACK` — Receiver negative-ack (hash mismatch or decryption error).
- `0x0004`: `BITMAP_SYNC` — Chunk presence bitmap synchronization.

---

## 4. Chunking, Scheduling & Sizing

### 4.1 Adaptive Chunk Size
- Base chunk size: 8 MB.
- Low-latency / constrained bandwidth fallback: 4 MB.
- High-bandwidth (> 500 Mbps / LAN): 16 MB, 32 MB, or 64 MB.
- Chunks are aligned to deterministic 64-bit byte offsets:  
  $$\text{Offset}(i) = i \times \text{ChunkSize}$$

### 4.2 Work-Stealing Multipath Scheduler
1. The sender divides the file into $M = \lceil \text{FileSize} / \text{ChunkSize} \rceil$ chunks.
2. A priority queue tracks unassigned chunks.
3. Workers and transport pipes steal chunks when their inflight buffer dips below threshold.
4. If a transport channel exhibits latency spikes or stalls (> 3x average RTT), inflight chunks are reassigned to faster transports without waiting for timeout ("work-stealing").

---

## 5. Merkle Tree & Whole-File Integrity

1. **Leaf Hashes:** For each chunk $i \in [0, M-1]$, compute:
   $$H_i = \text{BLAKE3}(\text{Plaintext Chunk}_i) \quad \text{or} \quad \text{SHA256}(\text{Plaintext Chunk}_i)$$
2. **Intermediate Nodes:** Parent nodes are computed by:
   $$\text{Parent}(L, R) = \text{Hash}(0x01 \parallel L \parallel R)$$
3. **Merkle Root:** The top-level hash represents the immutable bitstream signature.
4. **Verification Flow:**
   - Receiver computes each leaf hash upon chunk arrival and decryption.
   - If leaf hash $\neq$ expected header hash, chunk is rejected immediately (`CHUNK_NACK`).
   - When all chunks are stored, the receiver reconstructs the root hash.
   - Only when $\text{ComputedRoot} == \text{ExpectedRoot}$ does the file move from `.part` to final destination.

---

## 6. Transport Hierarchy & Fallback Chain

```
           [ Start Transfer ]
                   |
     +-------------+-------------+
     |                           |
[ WebRTC P2P DataChannels ]   [ WebTransport QUIC Relay ]
  (8-32 parallel SCTP)          (HTTP/3 Multiplexed)
     |                           |
     +-------------+-------------+
                   |
         (If blocked / failed)
                   |
       [ HTTP/2 or HTTP/3 Relay ]
       (Parallel Range Requests)
```

1. **WebRTC DataChannels:**
   - 8 parallel channels opened by default (adaptive 4 to 32 based on bandwidth plateau).
   - Configuration: `ordered: false`, `maxRetransmits: null` (reliable, unordered per chunk).
   - Flow control: Monitored via `dataChannel.bufferedAmount` and paced by `bufferedAmountLowThreshold` (default 1 MB per channel).
2. **WebTransport (HTTP/3 / QUIC):**
   - Bidirectional and unidirectional QUIC streams to relay server.
   - Zero Head-of-Line (HoL) blocking across distinct chunks.
3. **HTTP/2 - HTTP/3 Parallel Relay:**
   - Zero-copy store-and-forward chunk upload (`PUT /api/relay/:sessionId/chunk/:index`) and download (`GET /api/relay/:sessionId/chunk/:index`).
   - Standard HTTP Range header support (`Range: bytes=start-end`).

---

## 7. Signaling & Handshake Protocol

Signaling runs over WebSocket (`ws://` / `wss://`) or HTTP fallback polling.

### 7.1 Messages
1. `CREATE_ROOM`: Sender initiates 6-digit room code.
2. `JOIN_ROOM`: Receiver joins with 6-digit code or URL parameter.
3. `MANIFEST`:
   ```json
   {
     "type": "manifest",
     "sessionId": "491823",
     "name": "large_archive.tar",
     "size": 107374182400,
     "chunkSize": 8388608,
     "totalChunks": 12800,
     "merkleRoot": "3f79a6...b8",
     "salt": "a98dfb01",
     "compressed": false
   }
   ```
4. `BITMAP_OFFER` / `BITMAP_ACK`:
   Exchange of 64-bit encoded chunk bitmap to resume interrupted transfers.
5. `WEBRTC_SIGNAL`: SDP offers, answers, and ICE candidates.
6. `RELAY_FALLBACK`: Instruction to pivot or augment traffic with server relay.
