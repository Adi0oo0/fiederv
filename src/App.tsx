import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header';
import { ModeToggle } from './components/ModeToggle';
import { PairingSection } from './components/PairingSection';
import { FileDropzone } from './components/FileDropzone';
import { TransferProgress } from './components/TransferProgress';
import { ConnectionStatusBanner } from './components/ConnectionStatusBanner';
import { SignalingClient, SignalingMessage } from './lib/signaling';
import { TransferEngine } from '../engine/engine';
import { BlobChunkSource } from '../engine/chunker';
import { FileSystemAccessWriter, StreamingFallbackWriter } from '../engine/storage';
import { TransferManifest, IDiskWriter } from '../engine/types';
import { ConnectionState, TransferProgress as TransferProgressType, ChannelStat } from './types/transfer';
import { sound } from './lib/sound';
import { formatBytes } from './lib/format';
import { Inbox, CheckCircle2, Download, Pause, Play, X, ShieldCheck } from 'lucide-react';

export default function App() {
  const [mode, setMode] = useState<'send' | 'receive'>('send');
  const [roomCode, setRoomCode] = useState<string>('');
  const [hostRoomCode, setHostRoomCode] = useState<string>('');
  const [urlParamCode, setUrlParamCode] = useState<string | null>(null);
  const [isGeneratingCode, setIsGeneratingCode] = useState<boolean>(true);
  const [peersCount, setPeersCount] = useState<number>(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [channelStats, setChannelStats] = useState<ChannelStat[]>([]);
  const [e2eeKey, setE2eeKey] = useState<string>('');
  const e2eeKeyRef = useRef<string>(e2eeKey);
  useEffect(() => {
    e2eeKeyRef.current = e2eeKey;
  }, [e2eeKey]);

  // Files to send
  const [filesToSend, setFilesToSend] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);

  // Transfer and receiving state
  const [transferProgress, setTransferProgress] = useState<TransferProgressType | null>(null);
  const [incomingManifest, setIncomingManifest] = useState<TransferManifest | null>(null);
  const [isReceiving, setIsReceiving] = useState(false);
  const [isTransferComplete, setIsTransferComplete] = useState(false);
  const [finalMerkleRoot, setFinalMerkleRoot] = useState<string>('');
  const [isPaused, setIsPaused] = useState(false);
  const [fallbackDownloadUrl, setFallbackDownloadUrl] = useState<string | null>(null);

  // References to engine and signaling instances
  const signalingRef = useRef<SignalingClient | null>(null);
  const engineRef = useRef<TransferEngine | null>(null);
  const diskWriterRef = useRef<IDiskWriter | null>(null);
  const activeManifestRef = useRef<TransferManifest | null>(null);

  // Cached ICE servers for instant connection without network fetch lag
  const cachedIceServersRef = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:openrelay.metered.ca:80' },
  ]);

  // Helper to fetch ICE servers in background
  const fetchIceServers = useCallback(async () => {
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = await res.json();
        if (data.iceServers && Array.isArray(data.iceServers)) {
          cachedIceServersRef.current = data.iceServers;
        }
      }
    } catch {
      console.warn('Using pre-configured STUN/TURN servers');
    }
  }, []);

  // Initialize Core TransferEngine with callbacks
  const getOrCreateEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current;

    const engine = new TransferEngine(
      {
        iceServers: cachedIceServersRef.current,
        relayUrl: typeof window !== 'undefined' ? window.location.origin : '',
      },
      {
        onStateChange: (state) => {
          if (state === 'transferring') {
            setConnectionState('connected');
          } else if (state === 'waiting_peer') {
            setConnectionState('waiting_peer');
          } else if (state === 'error') {
            setConnectionState('failed');
            sound.playError();
          }
        },
        onSignal: (signal) => {
          signalingRef.current?.sendSignal({
            type: 'p2p_signal',
            signal,
          });
        },
        onProgress: (p) => {
          const percent = Math.min(100, Math.round((p.bytesTransferred / (p.totalBytes || 1)) * 100));
          setTransferProgress({
            fileId: activeManifestRef.current?.sessionId || 'transfer_0',
            chunksCompleted: p.chunksCompleted,
            totalChunks: p.totalChunks,
            bytesTransferred: p.bytesTransferred,
            totalBytes: p.totalBytes,
            speedBps: p.speedBps,
            apparentSpeedBps: p.speedBps,
            physicalSpeedBps: p.speedBps,
            percent,
            etaSeconds: p.etaSeconds,
            status: p.state === 'complete' ? 'completed' : p.state === 'verifying' ? 'verifying' : p.state === 'error' ? 'error' : 'transferring',
          });

          if (p.merkleRoot) {
            setFinalMerkleRoot(p.merkleRoot);
          }
        },
        onComplete: async (merkleRoot) => {
          setIsSending(false);
          setIsReceiving(false);
          setIsTransferComplete(true);
          setFinalMerkleRoot(merkleRoot);
          sound.playComplete();

          if (diskWriterRef.current instanceof StreamingFallbackWriter) {
            setFallbackDownloadUrl(diskWriterRef.current.getDownloadUrl());
          }
        },
        onError: (err) => {
          setIsSending(false);
          setIsReceiving(false);
          setErrorMessage(err.message);
          sound.playError();
        },
      }
    );

    engineRef.current = engine;
    return engine;
  }, []);

  // Initialize signaling and room setup
  useEffect(() => {
    fetchIceServers();
    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    // Check URL parameters on mount
    const searchParams = new URLSearchParams(window.location.search);
    const urlCode = searchParams.get('code');
    const urlMode = searchParams.get('mode');

    const isValidUrlCode = urlCode ? /^\d{6}$/.test(urlCode) : false;
    if (isValidUrlCode) {
      setUrlParamCode(urlCode);
    }

    if (urlMode === 'send' || urlMode === 'receive') {
      setMode(urlMode);
    } else if (isValidUrlCode) {
      setMode('receive');
    }

    // Check E2EE key in URL hash (#key=<keyHex>.<saltHex>)
    let initialKey = '';
    const hash = window.location.hash;
    const keyMatch = hash.match(/key=([a-fA-F0-9]{64}\.[a-fA-F0-9]{8})/);

    if (keyMatch) {
      initialKey = keyMatch[1];
      setE2eeKey(initialKey);
      e2eeKeyRef.current = initialKey;
      // Strip key fragment from location bar to prevent XSS fragment leaks
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState({}, '', cleanUrl);
    }

    const unsubscribe = signaling.subscribe(async (msg: SignalingMessage) => {
      switch (msg.type) {
        case 'room_created': {
          setHostRoomCode(msg.roomId || '');
          setRoomCode(msg.roomId || '');
          setPeersCount(msg.payload?.peersCount || 1);
          setIsGeneratingCode(false);
          setErrorMessage(null);
          break;
        }

        case 'room_joined': {
          setRoomCode(msg.roomId || '');
          setPeersCount(msg.payload?.peersCount || 1);
          setIsGeneratingCode(false);
          setErrorMessage(null);
          break;
        }

        case 'peer_joined': {
          setPeersCount((prev) => prev + 1);
          setErrorMessage(null);

          // If sender has key, synchronize with peer immediately upon pairing
          if (e2eeKeyRef.current) {
            signaling.sendSignal({
              type: 'key_sync',
              keyFragment: e2eeKeyRef.current,
            });
          }

          // If sender has prepared manifest, dispatch it to peer
          if (activeManifestRef.current) {
            signaling.sendSignal({
              type: 'manifest_init',
              manifest: activeManifestRef.current,
              keyFragment: e2eeKeyRef.current,
            });
          }
          break;
        }

        case 'peer_left': {
          setPeersCount((prev) => Math.max(0, prev - 1));
          setConnectionState('disconnected');
          break;
        }

        case 'signal': {
          const payload = msg.payload;
          if (!payload) break;

          if (payload.type === 'key_sync' && payload.keyFragment) {
            setE2eeKey(payload.keyFragment);
            e2eeKeyRef.current = payload.keyFragment;
            const engine = getOrCreateEngine();
            engine.crypto.initFromFragment(payload.keyFragment).catch(console.error);
          } else if (payload.type === 'manifest_init' && payload.manifest) {
            setIncomingManifest(payload.manifest);
            activeManifestRef.current = payload.manifest;
            if (payload.keyFragment) {
              setE2eeKey(payload.keyFragment);
              e2eeKeyRef.current = payload.keyFragment;
              const engine = getOrCreateEngine();
              engine.crypto.initFromFragment(payload.keyFragment).catch(console.error);
            }
          } else if (payload.type === 'p2p_signal' && payload.signal) {
            const engine = getOrCreateEngine();
            engine.handleSignal(payload.signal);
          }
          break;
        }

        case 'error': {
          setIsGeneratingCode(false);
          setConnectionState('failed');
          setErrorMessage(msg.message || 'Room connection failed. Please check the 6-digit code.');
          break;
        }

        default:
          break;
      }
    });

    signaling
      .connect()
      .then(async () => {
        const engine = getOrCreateEngine();
        if (isValidUrlCode && urlCode) {
          setConnectionState('connecting_peer');
          setRoomCode(urlCode);
          setIsGeneratingCode(false);
          let authSecret: string | undefined;
          if (initialKey) {
            try {
              await engine.crypto.initFromFragment(initialKey);
              authSecret = engine.crypto.getAuthSecret();
            } catch (e) {
              console.warn('Failed to parse fragment authSecret', e);
            }
          }
          signaling.joinRoom(urlCode, authSecret);
        } else {
          setIsGeneratingCode(true);
          try {
            const derived = await engine.crypto.generateKey();
            setE2eeKey(derived.fragment);
            e2eeKeyRef.current = derived.fragment;
            signaling.createRoom(undefined, derived.authSecret);
          } catch (e) {
            console.error('Failed to generate upfront encryption key:', e);
            signaling.createRoom();
          }
        }
      })
      .catch((e) => {
        console.error('Signaling connection error:', e);
        setIsGeneratingCode(false);
        setErrorMessage('Failed to connect to signaling server.');
      });

    return () => {
      unsubscribe();
      signaling.disconnect();
      engineRef.current?.cancel();
    };
  }, [fetchIceServers, getOrCreateEngine]);

  const handleModeChange = (newMode: 'send' | 'receive') => {
    if (newMode === mode) return;
    setMode(newMode);
    setErrorMessage(null);

    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.set('mode', newMode);
    window.history.replaceState({}, '', url.toString());

    if (connectionState !== 'connected') {
      engineRef.current?.cancel();
      setConnectionState('disconnected');
      signalingRef.current?.leaveRoom();

      setIsGeneratingCode(true);
      setRoomCode('');
      setHostRoomCode('');

      if (newMode === 'send') {
        const engine = getOrCreateEngine();
        engine.crypto.generateKey().then((derived) => {
          setE2eeKey(derived.fragment);
          e2eeKeyRef.current = derived.fragment;
          signalingRef.current?.createRoom(undefined, derived.authSecret);
        }).catch(() => {
          signalingRef.current?.createRoom();
        });
      } else {
        signalingRef.current?.createRoom();
      }
    }
  };

  const handleRegenerateCode = () => {
    setIsGeneratingCode(true);
    setRoomCode('');
    setHostRoomCode('');
    setErrorMessage(null);
    setConnectionState('disconnected');
    engineRef.current?.cancel();
    const engine = getOrCreateEngine();
    engine.crypto.generateKey().then((derived) => {
      setE2eeKey(derived.fragment);
      e2eeKeyRef.current = derived.fragment;
      signalingRef.current?.createRoom(undefined, derived.authSecret);
    }).catch(() => {
      signalingRef.current?.createRoom();
    });
  };

  const handleJoinManualCode = async (code: string, keyFragment?: string) => {
    if (!code) return;
    const clean = code.trim();
    if (clean === roomCode && (connectionState === 'connected' || connectionState === 'connecting_peer')) {
      return;
    }
    setErrorMessage(null);
    setConnectionState('connecting_peer');
    engineRef.current?.cancel();
    const engine = getOrCreateEngine();

    let authSecret: string | undefined;
    if (keyFragment) {
      try {
        await engine.crypto.initFromFragment(keyFragment);
        setE2eeKey(keyFragment);
        e2eeKeyRef.current = keyFragment;
        authSecret = engine.crypto.getAuthSecret();
      } catch (e) {
        console.warn('Failed to parse fragment from QR scan', e);
      }
    }

    signalingRef.current?.joinRoom(clean, authSecret);
    setRoomCode(clean);
  };

  const handleResetSession = () => {
    setFilesToSend([]);
    setTransferProgress(null);
    setIncomingManifest(null);
    setIsTransferComplete(false);
    setIsSending(false);
    setIsReceiving(false);
    setFinalMerkleRoot('');
    setFallbackDownloadUrl(null);
    setErrorMessage(null);
    engineRef.current?.cancel();

    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    window.history.replaceState({}, '', url.pathname);

    handleRegenerateCode();
  };

  const handleAddFiles = (newFiles: File[]) => {
    setFilesToSend((prev) => [...prev, ...newFiles]);
  };

  const handleRemoveFile = (index: number) => {
    setFilesToSend((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClearFiles = () => {
    setFilesToSend([]);
  };

  // Sender: Stream directly using Core TransferEngine
  const handleStartSending = async () => {
    if (filesToSend.length === 0) return;
    try {
      setIsSending(true);
      setIsTransferComplete(false);
      const engine = getOrCreateEngine();
      const file = filesToSend[0];
      const source = new BlobChunkSource(file);

      const prep = await engine.prepareSender(source, roomCode, window.location.origin);
      activeManifestRef.current = prep.manifest;
      setE2eeKey(prep.keyFragment);

      // Transmit manifest to peer immediately
      signalingRef.current?.sendSignal({
        type: 'manifest_init',
        manifest: prep.manifest,
        keyFragment: prep.keyFragment,
      });
    } catch (err: any) {
      console.error('File transfer preparation error:', err);
      setIsSending(false);
      setErrorMessage(err.message || 'Transfer failed to start');
    }
  };

  // Receiver: Stream directly to disk without keeping whole file in RAM
  const handleStartReceiving = async () => {
    if (!incomingManifest) return;
    try {
      setIsReceiving(true);
      setErrorMessage(null);
      const engine = getOrCreateEngine();

      let writer: IDiskWriter;
      if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
        writer = new FileSystemAccessWriter();
      } else {
        writer = new StreamingFallbackWriter();
      }
      diskWriterRef.current = writer;

      await engine.prepareReceiver(incomingManifest, e2eeKey, writer);
    } catch (err: any) {
      console.error('Receiver streaming error:', err);
      setIsReceiving(false);
      setErrorMessage(err.message || 'Failed to initialize disk stream');
    }
  };

  const handlePauseResume = () => {
    if (!engineRef.current) return;
    if (isPaused) {
      engineRef.current.resume();
      setIsPaused(false);
    } else {
      engineRef.current.pause();
      setIsPaused(true);
    }
  };

  const handleCancelTransfer = () => {
    engineRef.current?.cancel();
    setIsSending(false);
    setIsReceiving(false);
    setTransferProgress(null);
  };

  const currentFileName =
    mode === 'send'
      ? filesToSend.length > 0 ? filesToSend[0].name : ''
      : incomingManifest?.name || '';

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 transition-colors duration-200">
      <Header
        onResetSession={handleResetSession}
        isConnected={connectionState === 'connected'}
      />

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Monochromatic Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-neutral-950 dark:text-neutral-50 uppercase">
            Drop
          </h1>
          <p className="mt-2 text-xs font-mono text-neutral-500 tracking-wider uppercase">
            Zero-Memory Stream · Authenticated E2EE · Resumable
          </p>
        </div>

        {/* Monochromatic Mode Toggle */}
        <ModeToggle
          mode={mode}
          onChange={handleModeChange}
          disabled={isSending || isReceiving}
        />

        {/* Connection & Tunnel Status Banner */}
        <ConnectionStatusBanner
          connectionState={connectionState}
          roomCode={roomCode}
          peersCount={peersCount}
          errorMessage={errorMessage}
          onRetry={() => {
            setErrorMessage(null);
            if (mode === 'send') {
              handleRegenerateCode();
            } else {
              setConnectionState('disconnected');
            }
          }}
        />

        {/* Pairing Section */}
        {connectionState !== 'connected' && !isSending && !isReceiving && (
          <PairingSection
            mode={mode}
            roomCode={roomCode}
            hostRoomCode={hostRoomCode}
            initialCode={urlParamCode || undefined}
            isGeneratingCode={isGeneratingCode}
            onRegenerateCode={handleRegenerateCode}
            onJoinCode={handleJoinManualCode}
            isConnecting={connectionState === 'connecting_peer'}
            e2eeKey={e2eeKey}
          />
        )}

        {/* Transfer Progress and Metrics */}
        {(transferProgress || isSending || isReceiving) && (
          <div className="w-full max-w-2xl mx-auto my-6 space-y-4">
            <TransferProgress
              progress={transferProgress}
              channelStats={channelStats}
              onCancel={handleCancelTransfer}
              fileName={currentFileName}
              isReceiving={mode === 'receive'}
            />

            {/* Monochromatic Controls: Pause / Resume / Cancel */}
            <div className="flex items-center justify-between px-2 pt-2 text-xs font-mono text-neutral-500">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handlePauseResume}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors cursor-pointer"
                >
                  {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                  <span>{isPaused ? 'Resume' : 'Pause'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleCancelTransfer}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-300 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Cancel</span>
                </button>
              </div>

              {/* Small Monospace Root Hash Line */}
              {finalMerkleRoot && (
                <div className="flex items-center gap-1.5 text-[11px] truncate max-w-xs text-neutral-400">
                  <ShieldCheck className="w-3 h-3 text-neutral-400 shrink-0" />
                  <span className="truncate">Root: {finalMerkleRoot}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Send Mode: Dropzone */}
        {mode === 'send' && !isSending && !isTransferComplete && (
          <FileDropzone
            files={filesToSend}
            onAddFiles={handleAddFiles}
            onRemoveFile={handleRemoveFile}
            onClearFiles={handleClearFiles}
            onSend={handleStartSending}
            isConnected={connectionState === 'connected'}
            isSending={isSending}
          />
        )}

        {/* Receive Mode: Single Download Button streaming directly to disk */}
        {mode === 'receive' && !isReceiving && !isTransferComplete && (
          <div className="w-full max-w-xl mx-auto my-6">
            {incomingManifest ? (
              <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 bg-white dark:bg-neutral-900 text-center space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100 tracking-tight">
                    {incomingManifest.name}
                  </h3>
                  <p className="text-xs font-mono text-neutral-500 mt-1">
                    {formatBytes(incomingManifest.size)} · {incomingManifest.totalChunks} chunks
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleStartReceiving}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-xl bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900 font-medium text-sm hover:opacity-90 active:scale-[0.99] transition-all cursor-pointer shadow-sm"
                >
                  <Download className="w-4 h-4 stroke-[2]" />
                  <span>Download (Stream Directly to Disk)</span>
                </button>
              </div>
            ) : (
              <div className="border border-dashed border-neutral-300 dark:border-neutral-800 rounded-3xl p-10 sm:p-14 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-400">
                  <Inbox className="w-6 h-6 stroke-[1.75]" />
                </div>
                <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                  Ready to Receive
                </h3>
                <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto">
                  {connectionState === 'connected'
                    ? 'Connected. Waiting for peer to drop files...'
                    : 'Enter the 6-digit code or open share link.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Completion Success Notification */}
        {isTransferComplete && (
          <div className="w-full max-w-2xl mx-auto my-6 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 space-y-4">
            <div className="flex items-center gap-2.5 text-neutral-900 dark:text-neutral-100 font-semibold text-sm">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              <span>Transfer Complete · 100% Bit-Verified</span>
            </div>

            {finalMerkleRoot && (
              <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 text-xs font-mono text-neutral-600 dark:text-neutral-400 break-all">
                <span className="text-neutral-400 select-none">Merkle Root: </span>
                {finalMerkleRoot}
              </div>
            )}

            {fallbackDownloadUrl && (
              <div className="pt-2">
                <a
                  href={fallbackDownloadUrl}
                  download={incomingManifest?.name || 'download.bin'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900 text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Save Downloaded File</span>
                </a>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={handleResetSession}
                className="text-xs font-mono underline text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
              >
                Start New Transfer
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Quiet Minimalist Footer */}
      <footer className="w-full border-t border-neutral-200 dark:border-neutral-800 py-6 text-center text-xs text-neutral-400 dark:text-neutral-500 transition-colors">
        <div className="max-w-4xl mx-auto px-4 flex items-center justify-between">
          <span className="font-mono text-[11px] tracking-wider uppercase">DROP · Zero-Memory Engine</span>
          <span className="font-mono text-[11px] text-neutral-400">Streamed Directly to Disk</span>
        </div>
      </footer>
    </div>
  );
}
