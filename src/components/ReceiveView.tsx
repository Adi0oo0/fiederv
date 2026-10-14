import React, { useState } from 'react';
import { TransferManifest, TransferProgress, TransferState } from '../../engine/types.js';
import { formatBytes, formatSpeed, formatETA } from '../lib/format.js';
import { ProgressLine } from './ProgressLine.js';
import { MerkleTree } from '../../engine/merkle.js';

interface ReceiveViewProps {
  progress: TransferProgress | null;
  state: TransferState;
  manifest: TransferManifest | null;
  initialCode: string;
  isConnecting: boolean;
  downloadUrl?: string | null;
  onConnectCode: (code: string) => void;
  onStartDownload: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export function ReceiveView({
  progress,
  state,
  manifest,
  initialCode,
  isConnecting,
  downloadUrl,
  onConnectCode,
  onStartDownload,
  onPause,
  onResume,
  onCancel,
  onReset,
}: ReceiveViewProps) {
  const [code, setCode] = useState(initialCode);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.replace(/\D/g, '');
    if (clean.length === 6) {
      onConnectCode(clean);
    }
  };

  const percent = progress && progress.totalBytes > 0
    ? Math.round((progress.bytesTransferred / progress.totalBytes) * 100)
    : 0;

  const getStateLabel = (s: TransferState) => {
    switch (s) {
      case 'idle':
        return 'READY';
      case 'waiting_peer':
        return 'CONNECTING TO SENDER';
      case 'transferring':
        return 'STREAMING DIRECT TO DISK';
      case 'paused':
        return 'PAUSED';
      case 'verifying':
        return 'VERIFYING INTEGRITY';
      case 'complete':
        return 'COMPLETE';
      case 'error':
        return 'ERROR';
      default:
        return 'READY';
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto py-12 px-4 sm:px-0">
      {!manifest ? (
        // Code entry form
        <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 sm:p-12 bg-white dark:bg-neutral-950 text-center">
          <div className="text-xs font-mono uppercase tracking-widest text-neutral-400 mb-2">
            RECEIVE FILE
          </div>
          <h2 className="text-lg font-sans font-bold text-neutral-950 dark:text-neutral-50 mb-6">
            Enter 6-digit pair code
          </h2>

          <form onSubmit={handleSubmit} className="space-y-6">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              placeholder="000000"
              disabled={isConnecting}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full max-w-xs mx-auto text-center text-3xl sm:text-4xl font-mono font-bold tracking-widest py-3 px-4 border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 rounded-xl focus:outline-none focus:border-neutral-950 dark:focus:border-neutral-50 text-neutral-950 dark:text-neutral-50 tabular-nums"
            />

            <div>
              <button
                type="submit"
                disabled={code.length !== 6 || isConnecting}
                className="px-8 py-3 bg-neutral-950 text-white dark:bg-neutral-50 dark:text-neutral-950 text-xs font-mono font-bold uppercase rounded-xl hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {isConnecting ? 'CONNECTING...' : 'CONNECT'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        // Manifest ready & streaming screen
        <div className="space-y-8">
          {/* File Name & Size */}
          <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 bg-white dark:bg-neutral-950">
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 border-b border-neutral-100 dark:border-neutral-800/80 pb-6 mb-6">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-1">
                  Incoming File
                </div>
                <h2 className="text-lg font-sans font-bold text-neutral-950 dark:text-neutral-50 truncate" title={manifest.name}>
                  {manifest.name}
                </h2>
              </div>
              <div className="font-mono text-sm text-neutral-500 shrink-0">
                {formatBytes(manifest.size)}
              </div>
            </div>

            {/* One button: Download */}
            {state === 'idle' && (
              <div className="text-center py-4">
                <button
                  type="button"
                  onClick={onStartDownload}
                  className="px-10 py-3.5 bg-neutral-950 text-white dark:bg-neutral-50 dark:text-neutral-950 text-sm font-mono font-bold uppercase rounded-xl hover:opacity-90 transition-opacity cursor-pointer"
                >
                  DOWNLOAD
                </button>
              </div>
            )}
          </div>

          {/* Progress & Live Stream Readout */}
          {state !== 'idle' && (
            <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 bg-white dark:bg-neutral-950">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="font-bold tracking-wider text-neutral-950 dark:text-neutral-50">
                  {getStateLabel(state)}
                </span>
                <span className="text-neutral-400">
                  {percent}%
                </span>
              </div>

              {/* Single thin progress bar */}
              <ProgressLine percent={percent} />

              {/* Numeric metrics: Speed, ETA, Bytes */}
              <div className="grid grid-cols-3 gap-4 pt-2 text-center font-mono">
                <div>
                  <span className="block text-[11px] text-neutral-400 uppercase tracking-wider mb-1">
                    Speed
                  </span>
                  <span className="text-base font-bold text-neutral-950 dark:text-neutral-50">
                    {state === 'transferring' ? formatSpeed(progress?.speedBps || 0) : '—'}
                  </span>
                </div>

                <div>
                  <span className="block text-[11px] text-neutral-400 uppercase tracking-wider mb-1">
                    ETA
                  </span>
                  <span className="text-base font-bold text-neutral-950 dark:text-neutral-50">
                    {state === 'transferring' ? formatETA(progress?.etaSeconds || 0) : '—'}
                  </span>
                </div>

                <div>
                  <span className="block text-[11px] text-neutral-400 uppercase tracking-wider mb-1">
                    Transferred
                  </span>
                  <span className="text-base font-bold text-neutral-950 dark:text-neutral-50">
                    {formatBytes(progress?.bytesTransferred || 0)}
                  </span>
                </div>
              </div>

              {/* Merkle Root Hash line */}
              {manifest?.merkleRoot && (
                <div className="mt-8 pt-4 border-t border-neutral-100 dark:border-neutral-800/80 text-center">
                  <span className="text-[10px] font-mono text-neutral-400 tracking-wider">
                    ROOT: {MerkleTree.formatMonospace(manifest.merkleRoot, true)}
                  </span>
                </div>
              )}

              {/* Browser fallback direct file link if memory writer used */}
              {downloadUrl && state === 'complete' && (
                <div className="mt-6 text-center">
                  <a
                    href={downloadUrl}
                    download={manifest.name}
                    className="underline text-xs font-mono text-neutral-950 dark:text-neutral-50"
                  >
                    Save File to Disk
                  </a>
                </div>
              )}

              {/* Control buttons */}
              <div className="mt-8 pt-6 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-center gap-4 text-xs font-mono">
                {state === 'transferring' && (
                  <button
                    type="button"
                    onClick={onPause}
                    className="px-4 py-2 border border-neutral-200 dark:border-neutral-800 rounded-xl hover:border-neutral-950 dark:hover:border-neutral-100 transition-colors cursor-pointer"
                  >
                    PAUSE
                  </button>
                )}

                {state === 'paused' && (
                  <button
                    type="button"
                    onClick={onResume}
                    className="px-4 py-2 border border-neutral-950 dark:border-neutral-100 bg-neutral-950 dark:bg-neutral-50 text-white dark:text-neutral-950 rounded-xl transition-colors cursor-pointer"
                  >
                    RESUME
                  </button>
                )}

                {state !== 'complete' && state !== 'error' && (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-neutral-400 hover:text-neutral-950 dark:hover:text-neutral-50 transition-colors cursor-pointer"
                  >
                    CANCEL
                  </button>
                )}

                {(state === 'complete' || state === 'error') && (
                  <button
                    type="button"
                    onClick={onReset}
                    className="px-6 py-2 border border-neutral-950 dark:border-neutral-100 bg-neutral-950 dark:bg-neutral-50 text-white dark:text-neutral-950 rounded-xl font-bold transition-colors cursor-pointer"
                  >
                    NEW TRANSFER
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
