/**
 * Drop Fastify Relay and Signaling Server
 * Zero-knowledge encrypted chunk store, WebSocket signaling, and Coturn integration.
 * Streams all chunk I/O directly to disk without in-memory buffering.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import middie from '@fastify/middie';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { RelayChunkStore } from './relay-store.js';
import { SignalingHub } from './signaling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';

const app = Fastify({
  logger: false,
});

// Configure streaming content parser to avoid buffering large payloads in RAM
app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => {
  done(null);
});

const chunkStore = new RelayChunkStore({
  baseDir: './.drop_chunks',
  defaultTtlMs: 24 * 60 * 60 * 1000,
  maxChunkSizeBytes: 64 * 1024 * 1024,
});

const signalingHub = new SignalingHub();

async function start() {
  // Restrict CORS in production
  await app.register(cors, {
    origin: isProduction
      ? (origin, cb) => {
          if (!origin || origin.startsWith('http://localhost') || origin.startsWith('https://')) {
            cb(null, true);
          } else {
            cb(new Error('Not allowed by CORS'), false);
          }
        }
      : true,
  });

  await app.register(websocket);
  await app.register(middie);

  // Health and STUN/TURN server endpoints with time-limited HMAC credentials
  app.get('/api/health', async () => ({ status: 'healthy', uptime: process.uptime() }));

  app.get('/api/ice-servers', async (req) => {
    const iceServers: any[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];

    const turnUrl = process.env.TURN_SERVER_URL;
    const turnSecret = process.env.COTURN_AUTH_SECRET || process.env.TURN_SECRET;

    if (turnUrl && turnSecret) {
      // Coturn ephemeral time-limited REST credentials (RFC 5766)
      const ttl = 24 * 3600; // 24 hours
      const timestamp = Math.floor(Date.now() / 1000) + ttl;
      const cleanIp = (req.ip || 'peer').replace(/[^a-zA-Z0-9]/g, '');
      const username = `${timestamp}:${cleanIp}`;

      const hmac = crypto.createHmac('sha1', turnSecret);
      hmac.update(username);
      const credential = hmac.digest('base64');

      iceServers.push({
        urls: turnUrl,
        username,
        credential,
      });
    } else if (process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
      iceServers.push({
        urls: process.env.TURN_SERVER_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD,
      });
    }

    return { iceServers };
  });

  // HTTP Signaling fallback endpoints
  app.post('/api/signaling/create', async (req) => {
    const { peerId, authSecret } = (req.body as any) || {};
    const assignedPeerId = peerId || Math.random().toString(36).substring(2, 9);
    const roomId = signalingHub.createRoom(authSecret);
    signalingHub.joinRoom(roomId, assignedPeerId, req.ip, undefined, authSecret);
    return { roomId, peerId: assignedPeerId };
  });

  app.post('/api/signaling/join', async (req, reply) => {
    const { roomId, peerId, authSecret } = (req.body as any) || {};
    if (!roomId) {
      return reply.status(400).send({ error: 'Room ID is required.' });
    }
    const assignedPeerId = peerId || Math.random().toString(36).substring(2, 9);
    const result = signalingHub.joinRoom(roomId, assignedPeerId, req.ip, undefined, authSecret);
    if (result.error) {
      return reply.status(403).send({ error: result.error });
    }
    return { roomId, peerId: assignedPeerId, ...result };
  });

  // Zero-Knowledge Encrypted Chunk Relay Endpoints (Streaming I/O directly to disk)
  // PUT /api/relay/:sessionId/chunk/:index
  app.put('/api/relay/:sessionId/chunk/:index', async (req, reply) => {
    const { sessionId, index } = req.params as { sessionId: string; index: string };
    const chunkIndex = parseInt(index, 10);
    if (isNaN(chunkIndex)) {
      return reply.status(400).send({ error: 'Invalid chunk index' });
    }

    // Check authorization token if session has registered an auth secret
    const meta = await chunkStore.getSessionMeta(sessionId);
    if (meta && meta.authSecret) {
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${meta.authSecret}`;
      if (authHeader !== expected) {
        return reply.status(401).send({ error: 'Unauthorized chunk upload' });
      }
    }

    try {
      // Stream directly from HTTP request to disk (.tmp -> atomic rename)
      const writtenBytes = await chunkStore.putChunkStream(sessionId, chunkIndex, req.raw);
      return reply.status(200).send({ success: true, chunkIndex, bytes: writtenBytes });
    } catch (err: any) {
      console.error(`Chunk upload error ${sessionId}#${chunkIndex}:`, err);
      return reply.status(500).send({ error: err.message || 'Failed to save chunk' });
    }
  });

  // GET /api/relay/:sessionId/chunk/:index
  app.get('/api/relay/:sessionId/chunk/:index', async (req, reply) => {
    const { sessionId, index } = req.params as { sessionId: string; index: string };
    const chunkIndex = parseInt(index, 10);
    if (isNaN(chunkIndex)) {
      return reply.status(400).send({ error: 'Invalid chunk index' });
    }

    const meta = await chunkStore.getSessionMeta(sessionId);
    if (meta && meta.authSecret) {
      const authHeader = req.headers.authorization;
      const queryAuth = (req.query as any)?.auth;
      const expected = meta.authSecret;
      if (authHeader !== `Bearer ${expected}` && queryAuth !== expected) {
        return reply.status(401).send({ error: 'Unauthorized chunk download' });
      }
    }

    // Parse HTTP Range header if requested
    let range: { start: number; end: number } | undefined;
    const rangeHeader = req.headers.range;
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Infinity;
      if (!isNaN(start)) {
        range = { start, end };
      }
    }

    const chunkResult = await chunkStore.getChunkStream(sessionId, chunkIndex, range);
    if (!chunkResult) {
      return reply.status(404).send({ error: 'Chunk not found' });
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');

    if (range) {
      const actualEnd = Math.min(chunkResult.totalSize - 1, range.end);
      reply.status(206);
      reply.header('Content-Range', `bytes ${range.start}-${actualEnd}/${chunkResult.totalSize}`);
    } else {
      reply.status(200);
      reply.header('Content-Length', chunkResult.totalSize);
    }

    return reply.send(chunkResult.stream);
  });

  // DELETE /api/relay/:sessionId
  app.delete('/api/relay/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const meta = await chunkStore.getSessionMeta(sessionId);
    if (meta && meta.authSecret) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${meta.authSecret}`) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }
    const success = await chunkStore.deleteSession(sessionId);
    return reply.status(200).send({ success });
  });

  // WebSocket Signaling Connection
  app.get('/ws/signaling', { websocket: true }, (socket, req) => {
    let currentRoomId: string | null = null;
    let currentPeerId: string | null = null;
    const clientIp = req.socket.remoteAddress || req.ip || 'unknown';

    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        const { type, roomId, peerId, payload, authSecret } = msg;

        switch (type) {
          case 'create_room': {
            const assignedRoomId = roomId || signalingHub.createRoom(authSecret);
            currentRoomId = assignedRoomId;
            currentPeerId = peerId || Math.random().toString(36).substring(2, 9);
            const { isInitiator, isLanPeer } = signalingHub.joinRoom(
              assignedRoomId,
              currentPeerId,
              clientIp,
              socket,
              authSecret
            );

            socket.send(
              JSON.stringify({
                type: 'room_created',
                roomId: assignedRoomId,
                peerId: currentPeerId,
                initiator: isInitiator,
                isLanPeer,
              })
            );
            break;
          }

          case 'join_room': {
            currentRoomId = roomId;
            currentPeerId = peerId || Math.random().toString(36).substring(2, 9);
            const result = signalingHub.joinRoom(
              roomId,
              currentPeerId,
              clientIp,
              socket,
              authSecret
            );

            if (result.error) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  message: result.error,
                })
              );
              return;
            }

            socket.send(
              JSON.stringify({
                type: 'room_joined',
                roomId,
                peerId: currentPeerId,
                initiator: result.isInitiator,
                isLanPeer: result.isLanPeer,
              })
            );
            break;
          }

          case 'signal': {
            if (currentRoomId && currentPeerId) {
              signalingHub.broadcastToRoom(currentRoomId, currentPeerId, {
                type: 'signal',
                fromPeerId: currentPeerId,
                payload,
              });
            }
            break;
          }

          case 'leave_room': {
            if (currentRoomId && currentPeerId) {
              signalingHub.leaveRoom(currentRoomId, currentPeerId);
              currentRoomId = null;
              currentPeerId = null;
            }
            break;
          }
        }
      } catch (e) {
        console.error('WS message parsing error:', e);
      }
    });

    socket.on('close', () => {
      if (currentRoomId && currentPeerId) {
        signalingHub.leaveRoom(currentRoomId, currentPeerId);
      }
    });
  });

  // Production static file serving or development Vite integration
  if (isProduction) {
    const distPath = path.resolve(__dirname, '../dist');
    await app.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
    });
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  } else {
    // In dev mode, dynamic Vite server middleware
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Drop server listening on http://0.0.0.0:${PORT}`);
}

start().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
