# Known Browser Limitations & Fallback Architecture

This document outlines browser-specific constraints when transferring multi-gigabyte files (50–100+ GB) and the automatic fallback behavior implemented in Drop.

---

## 1. File System Access API vs. OPFS vs. StreamSaver

| Feature / API | Chrome / Chromium (Desktop) | Edge (Desktop) | Firefox (Desktop) | Safari (macOS / iOS) | Drop Implementation & Fallback |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`showSaveFilePicker()`** | Full Support | Full Support | Behind flag / Limited | Not Supported | Direct disk writing with random chunk offsets. Prompts user once at start. |
| **`FileSystemWritableFileStream.seek()`** | Full Support | Full Support | Not Supported | Not Supported | Enables out-of-order chunk writes directly to disk. |
| **OPFS `createSyncAccessHandle()`** | Web Worker Only | Web Worker Only | Web Worker Only | Safari 15.2+ (Worker) | High-speed multi-threaded random-access I/O in dedicated Worker. |
| **StreamSaver (ServiceWorker / Transfer-Encoding)** | Fallback | Fallback | Secondary Fallback | Primary Fallback | Streams chunks strictly in-order via synthetic response download pipeline. |

### Fallback Behavior:
1. **Primary Target (Chromium/Edge):**
   - Invokes `window.showSaveFilePicker()` to obtain file handle.
   - Chunks are written directly at their calculated byte offsets (`offset = index * chunkSize`) out-of-order as they arrive across parallel channels.
   - Pre-allocates file size using `truncate(fileSize)` to avoid disk fragmentation.
2. **Worker-Based OPFS (Origin Private File System):**
   - Uses `navigator.storage.getDirectory()` and `createSyncAccessHandle()` inside a Web Worker.
   - Chunks are written synchronously with zero main-thread jank. Once complete, exported via file picker or blob stream.
3. **Safari / Firefox Fallback (In-Order Streaming):**
   - For browsers lacking random-access writable streams, the receiver buffers a bounded sliding window of chunks and flushes them in sequential order through a Service Worker / `ReadableStream` anchor download.
   - Memory is strictly capped: if an out-of-order gap occurs, backpressure pauses upstream network channels until the missing chunk arrives.

---

## 2. WebRTC DataChannel Limitations & Flow Control

1. **SCTP Buffer Overflow:**
   - Browsers buffer outbound DataChannel messages in OS/C++ memory. Calling `send()` in an unthrottled loop leads to memory bloat and channel crash.
   - **Drop Mitigation:** Strict backpressure pacing via `bufferedAmountLowThreshold` (1 MB) and listening to `onbufferedamountlow`. Sender yields until buffer drains below threshold.
2. **Parallel Channel Count:**
   - Some mobile browsers become unstable if more than 32 SCTP channels are opened simultaneously.
   - **Drop Mitigation:** Defaults to 8 parallel channels; adaptively scales between 4 and 16 channels based on device memory and packet loss measurements.
3. **Symmetric NAT & Strict Firewalls:**
   - Direct P2P host/srflx candidates fail between two symmetric NATs.
   - **Drop Mitigation:** Automatic relay fallback to WebTransport (HTTP/3 QUIC) and HTTP/2/3 chunked relay, combined with integrated Coturn TURN server support.

---

## 3. WebTransport (HTTP/3 / QUIC) Support

- **Chromium / Edge:** Supported over HTTPS/H3.
- **Safari / Firefox:** Experimental or partial.
- **Drop Mitigation:** Feature detection with graceful downgrade to HTTP/2-3 parallel range streaming.

---

## 4. Background Execution & Sleeping

- Mobile and laptop browsers throttle background tabs, sleep network connections, or kill workers.
- **Drop Mitigation:**
  - Screen Wake Lock API (`navigator.wakeLock.request('screen')`) keeps the device active during transfers.
  - Chunk state is continuously saved to IndexedDB.
  - On wake or reconnect, the engine exchanges chunk bitmaps and resumes seamlessly from the exact byte offset.
