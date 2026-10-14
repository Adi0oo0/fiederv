import React, { useRef, useState } from 'react';
import { TransferProgress, TransferState } from '../../engine/types.js';
import { formatBytes, formatSpeed, formatETA, formatCode } from '../lib/format.js';
import { ProgressLine } from './ProgressLine.js';
import { MerkleTree } from '../../engine/merkle.js';

interface SendViewProps {
  progress: TransferProgress | null;
  state: TransferState;
  roomCode: string;
  shareUrl: string;
  selectedFile: File | null;
  onFileSelect: (file: File) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export function SendView({
  progress,
  state,
  roomCode,
  shareUrl,
  selectedFile,
  onFileSelect,
  onPause,
  onResume,
  onCancel,
  onReset,
}: SendViewProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {}
  };

  const percent = progress && progress.totalBytes > 0
    ? Math.round((progress.bytesTransferred / progress.totalBytes) * 100)
    : 0;

  // Format state label
  const getStateLabel = (s: TransferState) => {
    switch (s) {
      case 'idle':
        return 'IDLE';
      case 'waiting_peer':
        return 'WAITING FOR PEER';
      case 'transferring':
        return 'TRANSFERRING';
      case 'paused':
        return 'PAUSED';
      case 'verifying':
        return 'VERIFYING INTEGRITY';
      case 'complete':
        return 'COMPLETE';
      case 'error':
        return 'ERROR';
      default:
        return 'IDLE';
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto py-12 px-4 sm:px-0">
      {!selectedFile ? (
        // Drop zone state
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border border-neutral-300 dark:border-neutral-800 rounded-2xl p-16 text-center cursor-pointer transition-colors ${
            isDragOver
              ? 'border-neutral-950 dark:border-neutral-100 bg-neutral-100 dark:bg-neutral-900'
              : 'hover:border-neutral-400 dark:hover:border-neutral-700 bg-white dark:bg-neutral-950'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                onFileSelect(e.target.files[0]);
              }
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is standard in browsers
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                onFileSelect(e.target.files[0]);
              }
            }}
          />

          <div className="text-sm font-mono tracking-wider uppercase text-neutral-400 dark:text-neutral-500 mb-4">
            Drop
          </div>

          <p className="text-base sm:text-lg font-sans font-semibold text-neutral-950 dark:text-neutral-50 mb-6">
            Drag a file or folder here, or click to browse
          </p>

          <div className="flex items-center justify-center gap-4 text-xs font-mono" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 border border-neutral-200 dark:border-neutral-800 rounded-xl hover:border-neutral-950 dark:hover:border-neutral-100 transition-colors cursor-pointer"
            >
              SELECT FILE
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="px-4 py-2 border border-neutral-200 dark:border-neutral-800 rounded-xl hover:border-neutral-950 dark:hover:border-neutral-100 transition-colors cursor-pointer"
            >
              SELECT FOLDER
            </button>
          </div>
        </div>
      ) : (
        // Active Transfer / Pairing Screen
        <div className="space-y-8">
          {/* File details & short code */}
          <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 bg-white dark:bg-neutral-950">
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 border-b border-neutral-100 dark:border-neutral-800/80 pb-6 mb-6">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-1">
                  File
                </div>
                <h2 className="text-lg font-sans font-bold text-neutral-950 dark:text-neutral-50 truncate" title={selectedFile.name}>
                  {selectedFile.name}
                </h2>
              </div>
              <div className="font-mono text-sm text-neutral-500 shrink-0">
                {formatBytes(selectedFile.size)}
              </div>
            </div>

            {/* 6-Digit Pair Code & Share Link */}
            {roomCode && (
              <div className="text-center py-4">
                <div className="text-xs font-mono uppercase tracking-widest text-neutral-400 mb-2">
                  PAIR CODE
                </div>
                <div className="text-4xl sm:text-5xl font-mono font-bold tracking-widest text-neutral-950 dark:text-neutral-50 select-all mb-4">
                  {formatCode(roomCode)}
                </div>

                {shareUrl && (
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="text-xs font-mono uppercase px-4 py-2 border border-neutral-200 dark:border-neutral-800 rounded-xl hover:border-neutral-950 dark:hover:border-neutral-100 transition-colors cursor-pointer"
                  >
                    {copiedLink ? 'LINK COPIED' : 'COPY SHARE LINK'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Transfer State & Progress Readout */}
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
            {progress?.merkleRoot && (
              <div className="mt-8 pt-4 border-t border-neutral-100 dark:border-neutral-800/80 text-center">
                <span className="text-[10px] font-mono text-neutral-400 tracking-wider">
                  ROOT: {MerkleTree.formatMonospace(progress.merkleRoot, true)}
                </span>
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
        </div>
      )}
    </div>
  );
}
