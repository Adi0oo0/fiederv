import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header.js';
import { SendView } from './components/SendView.js';
import { ReceiveView } from './components/ReceiveView.js';
import { TransferEngine } from '../engine/engine.js';
import { SignalingClient, SignalingMessage } from './lib/signaling-client.js';
import { TransferManifest, TransferProgress, TransferState } from '../engine/types.js';
import { FileSystemAccessWriter, MemoryChunkWriter } from '../engine/storage.js';

export default function App() {
  const [mode, setMode] = useState<'send' | 'receive'>('send');
  const [state, setState] = useState<TransferState>('idle');
  const [progress, setProgress] = useState<TransferProgress | null>(null);

  // Sender state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [roomCode, setRoomCode] = useState<string>('');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [keyFragment, setKeyFragment] = useState<string>('');

  // Receiver state
  const [incomingManifest, setIncomingManifest] = useState<TransferManifest | null>(null);
  const [initialCode, setInitialCode] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // References
  const engineRef = useRef<TransferEngine | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);

  // Initialize or retrieve Engine
  const getOrCreateEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current;

    const engine = new TransferEngine(
      {
        relayUrl: window.location.origin,
      },
      {
        onStateChange: (s) => setState(s),
        onProgress: (p) => setProgress(p),
        onSignal: (signal) => {
          signalingRef.current?.sendSignal(signal);
        },
        onManifestReady: (manifest, shareLink, frag) => {
          setShareUrl(shareLink);
          setKeyFragment(frag);
          // Broadcast manifest to room
          signalingRef.current?.send({
            type: 'manifest',
            payload: manifest,
          });
        },
        onError: (err) => {
          console.error('Transfer engine error:', err);
          setState('error');
        },
      }
    );

    engineRef.current = engine;
    return engine;
  }, []);

  // Signaling setup
  useEffect(() => {
    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    // Check URL parameters on mount
    const searchParams = new URLSearchParams(window.location.search);
    const urlCode = searchParams.get('code');
    const hash = window.location.hash;
    const urlKeyFragment = hash.startsWith('#key=') ? hash.replace('#key=', '') : '';

    if (urlCode && /^\d{6}$/.test(urlCode)) {
      setMode('receive');
      setInitialCode(urlCode);
      if (urlKeyFragment) {
        setKeyFragment(urlKeyFragment);
      }
    }

    const unsubscribe = signaling.subscribe((msg: SignalingMessage) => {
      const engine = getOrCreateEngine();

      switch (msg.type) {
        case 'room_created': {
          setRoomCode(msg.roomId || '');
          break;
        }

        case 'room_joined': {
          setRoomCode(msg.roomId || '');
          setIsConnecting(false);
          break;
        }

        case 'peer_joined': {
          // A peer joined: if sender, send manifest
          if (mode === 'send' && engineRef.current) {
            // Already handled via engine signal initiation
          }
          break;
        }

        case 'manifest': {
          // Receiver got manifest from sender
          if (msg.payload) {
            setIncomingManifest(msg.payload);
            setIsConnecting(false);
          }
          break;
        }

        case 'signal': {
          engine.handleSignal(msg.payload);
          break;
        }
      }
    });

    signaling.connect().catch((e) => console.warn('Signaling connect notice:', e));

    return () => {
      unsubscribe();
      signaling.disconnect();
    };
  }, [getOrCreateEngine, mode]);

  // Sender starts transfer preparation on file select
  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    const signaling = signalingRef.current;
    if (!signaling) return;

    // Create room on signaling server
    signaling.createRoom();

    const engine = getOrCreateEngine();
    // Wait for roomCode from signaling
    const sessionId = Math.floor(100000 + Math.random() * 900000).toString();
    setRoomCode(sessionId);

    await engine.prepareSender(file, sessionId, window.location.origin);
  };

  // Receiver initiates connection with 6-digit code
  const handleConnectCode = (code: string) => {
    setIsConnecting(true);
    setRoomCode(code);
    signalingRef.current?.joinRoom(code);
  };

  // Receiver clicks Download
  const handleStartDownload = async () => {
    if (!incomingManifest) return;

    const engine = getOrCreateEngine();
    const frag = keyFragment || (window.location.hash.startsWith('#key=') ? window.location.hash.replace('#key=', '') : '');

    // Select disk writer: File System Access API or memory fallback
    let writer;
    if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      writer = new FileSystemAccessWriter();
    } else {
      const memWriter = new MemoryChunkWriter();
      writer = memWriter;
      // When complete, update downloadUrl
      const checkInterval = setInterval(() => {
        const url = memWriter.getDownloadUrl();
        if (url) {
          setDownloadUrl(url);
          clearInterval(checkInterval);
        }
      }, 500);
    }

    await engine.prepareReceiver(incomingManifest, frag, writer);
  };

  const handlePause = () => engineRef.current?.pause();
  const handleResume = () => engineRef.current?.resume();
  const handleCancel = () => {
    engineRef.current?.cancel();
    setState('idle');
    setProgress(null);
  };

  const handleReset = () => {
    engineRef.current?.cancel();
    engineRef.current = null;
    setSelectedFile(null);
    setIncomingManifest(null);
    setRoomCode('');
    setShareUrl('');
    setKeyFragment('');
    setState('idle');
    setProgress(null);
    setDownloadUrl(null);

    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    window.history.replaceState({}, '', url.toString());
  };

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 transition-colors">
      <Header
        mode={mode}
        onModeChange={(m) => {
          if (state === 'idle' || state === 'complete') {
            setMode(m);
            handleReset();
          }
        }}
        disabled={state === 'transferring' || state === 'verifying'}
      />

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 sm:px-6 flex flex-col justify-center">
        {mode === 'send' ? (
          <SendView
            progress={progress}
            state={state}
            roomCode={roomCode}
            shareUrl={shareUrl}
            selectedFile={selectedFile}
            onFileSelect={handleFileSelect}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
            onReset={handleReset}
          />
        ) : (
          <ReceiveView
            progress={progress}
            state={state}
            manifest={incomingManifest}
            initialCode={initialCode}
            isConnecting={isConnecting}
            downloadUrl={downloadUrl}
            onConnectCode={handleConnectCode}
            onStartDownload={handleStartDownload}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
            onReset={handleReset}
          />
        )}
      </main>

      <footer className="w-full border-t border-neutral-200 dark:border-neutral-800 py-6 text-center text-xs text-neutral-400 font-mono tracking-wider uppercase">
        <div className="max-w-2xl mx-auto px-6 flex items-center justify-between">
          <span>Drop · Monochromatic High-Throughput Stream</span>
          <span>Zero-Knowledge Relay</span>
        </div>
      </footer>
    </div>
  );
}
