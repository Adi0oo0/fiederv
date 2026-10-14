/**
 * Drop Fastify Relay and Signaling Server
 * Zero-knowledge encrypted chunk store, WebSocket signaling, and Coturn integration.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
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
  bodyLimit: 128 * 1024 * 1024, // 128 MB max chunk payload
});

const chunkStore = new RelayChunkStore({
  baseDir: './.drop_chunks',
  defaultTtlMs: 24 * 60 * 60 * 1000,
});

const signalingHub = new SignalingHub();

// Public STUN & TURN servers for reliable traversal across symmetric NATs
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

if (process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
  ICE_SERVERS.push({
    urls: process.env.TURN_SERVER_URL,
    // @ts-expect-error turn server credentials
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_PASSWORD,
  });
}

async function start() {
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Health and STUN/TURN server endpoints
  app.get('/api/health', async () => ({ status: 'healthy', uptime: process.uptime() }));
  app.get('/api/ice-servers', async () => ({ iceServers: ICE_SERVERS }));

  // HTTP Signaling fallback
  app.post('/api/signaling/create', async (req) => {
    const { peerId } = (req.body as any) || {};
    const assignedPeerId = peerId || Math.random().toString(36).substring(2, 9);
    const roomId = signalingHub.generateRoomCode();
    signalingHub.joinRoom(roomId, assignedPeerId, req.ip);
    return { roomId, peerId: assignedPeerId };
  });

  app.post('/api/signaling/join', async (req, reply) => {
    const { roomId, peerId } = (req.body as any) || {};
    if (!roomId) {
      return reply.status(400).send({ error: 'Room ID is required.' });
    }
    const assignedPeerId = peerId || Math.random().toString(36).substring(2, 9);
    const result = signalingHub.joinRoom(roomId, assignedPeerId, req.ip);
    return { roomId, peerId: assignedPeerId, ...result };
  });

  // Zero-Knowledge Encrypted Chunk Relay Endpoints
  // PUT /api/relay/:sessionId/chunk/:index
  app.put('/api/relay/:sessionId/chunk/:index', async (req, reply) => {
    const { sessionId, index } = req.params as { sessionId: string; index: string };
    const chunkIndex = parseInt(index, 10);
    if (isNaN(chunkIndex)) {
      return reply.status(400).send({ error: 'Invalid chunk index' });
    }

    // Read raw body stream or buffer
    const buffer = await req.body as Buffer;
    if (!buffer || buffer.length === 0) {
      return reply.status(400).send({ error: 'Empty chunk payload' });
    }

    await chunkStore.putChunk(sessionId, chunkIndex, buffer);
    return reply.status(200).send({ success: true, chunkIndex, bytes: buffer.length });
  });

  // GET /api/relay/:sessionId/chunk/:index
  app.get('/api/relay/:sessionId/chunk/:index', async (req, reply) => {
    const { sessionId, index } = req.params as { sessionId: string; index: string };
    const chunkIndex = parseInt(index, 10);
    if (isNaN(chunkIndex)) {
      return reply.status(400).send({ error: 'Invalid chunk index' });
    }

    // Check Range header
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

    const chunk = await chunkStore.getChunk(sessionId, chunkIndex, range);
    if (!chunk) {
      return reply.status(404).send({ error: 'Chunk not found' });
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');

    if (range) {
      const actualEnd = Math.min(chunk.totalSize - 1, range.end);
      reply.status(206);
      reply.header('Content-Range', `bytes ${range.start}-${actualEnd}/${chunk.totalSize}`);
    } else {
      reply.status(200);
      reply.header('Content-Length', chunk.data.length);
    }

    return reply.send(chunk.data);
  });

  // DELETE /api/relay/:sessionId (Atomic cleanup on completion)
  app.delete('/api/relay/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    await chunkStore.deleteSession(sessionId);
    return reply.status(200).send({ success: true });
  });

  // WebSocket Signaling Channel
  app.get('/ws', { websocket: true }, (socket, req) => {
    let currentRoomId: string | null = null;
    let currentPeerId: string | null = null;
    const clientIp = req.ip;

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const { type, roomId, peerId, payload } = msg;

        switch (type) {
          case 'create_room': {
            const code = signalingHub.generateRoomCode();
            currentRoomId = code;
            currentPeerId = peerId || Math.random().toString(36).substring(2, 9);
            const { isInitiator } = signalingHub.joinRoom(code, currentPeerId, clientIp, socket);

            socket.send(
              JSON.stringify({
                type: 'room_created',
                roomId: code,
                peerId: currentPeerId,
                initiator: isInitiator,
              })
            );
            break;
          }

          case 'join_room': {
            currentRoomId = roomId;
            currentPeerId = peerId || Math.random().toString(36).substring(2, 9);
            const { isInitiator, isLanPeer } = signalingHub.joinRoom(
              roomId,
              currentPeerId,
              clientIp,
              socket
            );

            socket.send(
              JSON.stringify({
                type: 'room_joined',
                roomId,
                peerId: currentPeerId,
                initiator: isInitiator,
                isLanPeer,
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
        console.error('WS message error:', e);
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
    // @ts-expect-error vite middleware with fastify
    app.use(vite.middlewares);
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Drop server listening on http://0.0.0.0:${PORT}`);
}

start().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
