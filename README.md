# Drop

> **Zero-Memory-Buffering, Monochromatic High-Throughput Stream for 50–100+ GB Transfers**

Drop is an ultra-minimalist, strictly monochromatic peer-to-peer and server-assisted file transfer application engineered for transfers of 50–100 GB (up to several hundred GB) with maximum throughput and zero data loss.

---

## 1. Design System & Aesthetics

Drop strictly adheres to the typography, spacing, tokens, and conventions of [fiederv](https://github.com/Adi0oo0/fiederv.git):
- **Typography:** `Syne` (display), `Plus Jakarta Sans` (body), and `JetBrains Mono` (numeric readouts, hashes, and pair codes).
- **Monochrome:** Strict black, white, and neutral greys only (`neutral-50` to `neutral-950`).
- **Zero Distractions:** No gradients, no emojis, no decorative icons. Progress, state, and errors are communicated through type, weight, contrast, and thin lines only.
- **Single Centered Column:** Generous whitespace, responsive from 360px wide to 4K displays.

---

## 2. Product Architecture & Two Flows

Drop has exactly two flows, one screen each:
- **SEND:** Drag a file or folder onto the page (or click). A share link and 6-digit short code appear. Transfer starts when the receiver connects, or uploads to the zero-knowledge server relay if the receiver is offline.
- **RECEIVE:** Open the share link or enter the 6-digit code. One button: **"DOWNLOAD"**. The file streams directly to disk.
- **UI Readout:** File name, size, single thin progress bar, live speed, ETA, pause / resume / cancel, and whole-file Merkle tree root hash. No accounts, no sign-up.

---

## 3. Performance & Reliability Guarantees

### Zero-Memory Buffering
- Neither sender, receiver, nor relay buffers whole files in memory.
- Sliced reading with `Blob.slice()` and `File.stream()`.
- Receiver writes chunks directly to disk at deterministic byte offsets (`offset = index * chunkSize`) using the File System Access API (`showSaveFilePicker` + `createWritable` with pre-allocation) and OPFS.
- Streaming fallback for Safari and browsers lacking random-access disk writers.

### End-to-End Encryption (E2EE)
- 256-bit AES-GCM master transfer key generated in browser.
- Stored exclusively in the URL fragment (`#key=...`), which is never transmitted to the server.
- Deterministic 96-bit nonce per chunk: `[4-byte session salt | 8-byte chunk index big-endian]`.
- Chunks are encrypted client-side before reaching the wire or the relay.

### Multipath Transport Hierarchy
1. **WebRTC DataChannels (Direct P2P):** 8 parallel channels (adaptive 4–32), unordered and reliable per chunk, with backpressure flow control via `bufferedAmountLowThreshold` (1 MB).
2. **WebTransport (HTTP/3 / QUIC):** Multiplexed streams to relay without Head-of-Line (HoL) blocking.
3. **HTTP/2 - HTTP/3 Parallel Relay:** Fastify chunk store with range request support and automated TTL cleanup.
- **Work-Stealing Scheduler:** Fast pipes pull more chunks; stalled channels are retried elsewhere.
- **AIMD Congestion Controller:** Concurrency dynamically scales with latency and packet loss feedback.

### Integrity & Resumability
- Per-chunk SHA-256 / BLAKE3 hash verified on receipt; bad chunks are automatically re-requested.
- Whole-file binary Merkle tree root hash verified before marking complete.
- Chunk bitmap persisted to IndexedDB: tab reloads, network switches, or sleep states resume seamlessly from the exact byte offset.
- Screen Wake Lock API prevents device sleep during active transfers.

---

## 4. Quickstart

### Prerequisites
- Node.js >= 20
- npm >= 10

### Development
```bash
# Install dependencies
npm install

# Start development server (Fastify relay + Vite frontend)
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build
```bash
npm run build
npm start
```

---

## 5. Docker & Coturn Deployment

Drop includes a production Dockerfile and a `docker-compose.yml` that provisions both the Fastify relay server and a self-hosted Coturn TURN server for symmetric NAT traversal:

```bash
cd docker
docker compose up -d
```

---

## 6. Testing & Benchmarks

Run the complete test suite:
```bash
# Unit tests (Chunker, Scheduler, Merkle Tree, Crypto, Bitmap)
npm test

# 10 GB integration test with simulated 5% packet loss, latency, and mid-transfer disconnect
npm run test:integration

# Transport throughput and memory benchmark (< 500 MB peak RSS assertion)
npm run benchmark
```

---

## 7. Documentation
- [PROTOCOL.md](./PROTOCOL.md): Wire framing format, cryptographic nonce derivation, handshake, and transport specifications.
- [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md): Browser-specific constraints (Safari File System Access, WebTransport support) and fallback mechanics.
