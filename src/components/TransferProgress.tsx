import { useEffect, useRef, useState, useMemo } from 'react';
import { TransferProgress as TransferProgressType, ChannelStat } from '../types/transfer';
import { formatBytes } from '../lib/format';
import { sound } from '../lib/sound';
import {
  X,
  Volume2,
  VolumeX,
  Gauge,
  Play,
  Pause,
  TrendingDown,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';

interface TransferProgressProps {
  progress: TransferProgressType | null;
  channelStats: ChannelStat[];
  onCancel?: () => void;
  onPauseResume?: () => void;
  isPaused?: boolean;
  fileName?: string;
  isReceiving?: boolean;
}

interface ThroughputPoint {
  time: string;
  speedMBps: number;
  wireMBps: number;
  isCongested: boolean;
  bufferedKB: number;
}

export function TransferProgress({
  progress,
  channelStats,
  onCancel,
  onPauseResume,
  isPaused = false,
  fileName,
  isReceiving,
}: TransferProgressProps) {
  // Real-time speed tracking state
  const [realtimeSpeedMBps, setRealtimeSpeedMBps] = useState<number>(0);
  const [peakSpeedMBps, setPeakSpeedMBps] = useState<number>(0);
  const [smoothedEtaSeconds, setSmoothedEtaSeconds] = useState<number | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(() => sound.getMuted());

  // Rolling throughput history for the mini oscilloscope
  const [throughputHistory, setThroughputHistory] = useState<ThroughputPoint[]>(() => {
    return Array.from({ length: 12 }, (_, i) => ({
      time: `-${12 - i}s`,
      speedMBps: 0,
      wireMBps: 0,
      isCongested: false,
      bufferedKB: 0,
    }));
  });

  const lastSampleRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const speedHistoryRef = useRef<number[]>([]);
  const previousStatusRef = useRef<string | null>(null);
  const lastChartPointTimeRef = useRef<number>(0);

  const handleToggleSound = () => {
    const next = !isAudioMuted;
    setIsAudioMuted(next);
    sound.setMuted(next);
  };

  useEffect(() => {
    if (!progress) return;

    const currentStatus = progress.status;
    const prevStatus = previousStatusRef.current;

    if (prevStatus !== currentStatus) {
      if (currentStatus === 'transferring' && prevStatus !== 'transferring') {
        sound.playStart();
      } else if (currentStatus === 'completed' && prevStatus !== 'completed') {
        sound.playComplete();
      } else if (currentStatus === 'error' && prevStatus !== 'error') {
        sound.playError();
      }
      previousStatusRef.current = currentStatus;
    }
  }, [progress?.status]);

  useEffect(() => {
    if (!progress) {
      lastSampleRef.current = null;
      speedHistoryRef.current = [];
      setRealtimeSpeedMBps(0);
      setPeakSpeedMBps(0);
      setSmoothedEtaSeconds(null);
      previousStatusRef.current = null;
      return;
    }

    const now = performance.now();
    const currentBytes = progress.bytesTransferred;

    if (!lastSampleRef.current) {
      lastSampleRef.current = { bytes: currentBytes, timestamp: now };
      if (progress.speedBps && progress.speedBps > 0) {
        const initialMBps = progress.speedBps / (1024 * 1024);
        setRealtimeSpeedMBps(initialMBps);
        setPeakSpeedMBps(initialMBps);
      }
      return;
    }

    const deltaBytes = currentBytes - lastSampleRef.current.bytes;
    const deltaMs = now - lastSampleRef.current.timestamp;

    if (deltaMs >= 150 && deltaBytes >= 0) {
      const instantBps = deltaBytes / (deltaMs / 1000);
      const instantMBps = instantBps / (1024 * 1024);

      const history = speedHistoryRef.current;
      history.push(instantMBps);
      if (history.length > 6) history.shift();

      const weightedSum = history.reduce((acc, val, idx) => acc + val * (idx + 1), 0);
      const weightTotal = (history.length * (history.length + 1)) / 2;
      const smoothedMBps = weightedSum / weightTotal;

      setRealtimeSpeedMBps(smoothedMBps);
      setPeakSpeedMBps((prev) => Math.max(prev, smoothedMBps));

      lastSampleRef.current = { bytes: currentBytes, timestamp: now };
    }
  }, [progress?.bytesTransferred, progress?.speedBps]);

  const totalBufferedAmount = useMemo(() => {
    return channelStats.reduce((acc, ch) => acc + (ch.bufferedAmount || 0), 0);
  }, [channelStats]);

  const effectiveSpeedMBps = useMemo(() => {
    if (realtimeSpeedMBps > 0) return realtimeSpeedMBps;
    if (progress?.speedBps && progress.speedBps > 0) {
      return progress.speedBps / (1024 * 1024);
    }
    return 0;
  }, [realtimeSpeedMBps, progress?.speedBps]);

  const apparentSpeedMBps = useMemo(() => {
    if (progress?.apparentSpeedBps && progress.apparentSpeedBps > 0) {
      return Math.max(realtimeSpeedMBps, progress.apparentSpeedBps / (1024 * 1024));
    }
    return effectiveSpeedMBps;
  }, [progress?.apparentSpeedBps, realtimeSpeedMBps, effectiveSpeedMBps]);

  const compressionRatio = useMemo(() => {
    if (progress?.compressionRatio && progress.compressionRatio > 1) {
      return progress.compressionRatio;
    }
    return 1.0;
  }, [progress?.compressionRatio]);

  const physicalSpeedMBps = useMemo(() => {
    if (progress?.physicalSpeedBps && progress.physicalSpeedBps > 0) {
      return progress.physicalSpeedBps / (1024 * 1024);
    }
    if (compressionRatio > 1.0) {
      return apparentSpeedMBps / compressionRatio;
    }
    return apparentSpeedMBps;
  }, [progress?.physicalSpeedBps, compressionRatio, apparentSpeedMBps]);

  const apparentMbps = useMemo(() => Math.round(apparentSpeedMBps * 8), [apparentSpeedMBps]);
  const physicalMbps = useMemo(() => Math.round(physicalSpeedMBps * 8), [physicalSpeedMBps]);

  const remainingBytes = useMemo(() => {
    if (!progress) return 0;
    return Math.max(0, (progress.totalBytes || 0) - (progress.bytesTransferred || 0));
  }, [progress?.totalBytes, progress?.bytesTransferred]);

  useEffect(() => {
    if (!progress || progress.status !== 'transferring') return;

    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastChartPointTimeRef.current < 350) return;
      lastChartPointTimeRef.current = now;

      const date = new Date(now);
      const timeStr = date.toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
      const currentBufferedKB = Math.round(totalBufferedAmount / 1024);
      const isCongested = currentBufferedKB > 256 || (apparentSpeedMBps < 0.5 && progress.bytesTransferred > 0);

      setThroughputHistory((prev) => {
        const next = [
          ...prev,
          {
            time: timeStr,
            speedMBps: Number(apparentSpeedMBps.toFixed(2)),
            wireMBps: Number(physicalSpeedMBps.toFixed(2)),
            isCongested,
            bufferedKB: currentBufferedKB,
          },
        ];
        return next.length > 20 ? next.slice(next.length - 20) : next;
      });
    }, 400);

    return () => clearInterval(interval);
  }, [progress, apparentSpeedMBps, physicalSpeedMBps, totalBufferedAmount]);

  useEffect(() => {
    if (!progress) {
      setSmoothedEtaSeconds(null);
      return;
    }

    if (progress.status === 'completed' || remainingBytes === 0) {
      setSmoothedEtaSeconds(0);
      return;
    }

    if (progress.status === 'preparing') {
      setSmoothedEtaSeconds(null);
      return;
    }

    const currentSpeedBps = effectiveSpeedMBps > 0 ? effectiveSpeedMBps * 1024 * 1024 : progress.speedBps || 0;

    if (currentSpeedBps > 0 && remainingBytes > 0) {
      const rawEta = remainingBytes / currentSpeedBps;
      const roundedEta = Math.max(0, Math.ceil(rawEta));

      setSmoothedEtaSeconds((prev) => {
        if (prev === null) return roundedEta;
        const smoothed = Math.round(prev * 0.7 + roundedEta * 0.3);
        return Math.max(0, smoothed);
      });
    } else if (progress.etaSeconds !== undefined && progress.etaSeconds > 0) {
      setSmoothedEtaSeconds(progress.etaSeconds);
    }
  }, [effectiveSpeedMBps, remainingBytes, progress?.status, progress?.etaSeconds]);

  const formattedTimeRemaining = useMemo(() => {
    if (!progress) return '—';
    if (progress.status === 'completed') return '0s';
    if (progress.status === 'verifying') return 'Verifying...';
    if (progress.status === 'preparing') return 'Connecting...';

    if (smoothedEtaSeconds === null) {
      return progress.etaSeconds ? `${progress.etaSeconds}s` : 'Estimating...';
    }

    if (smoothedEtaSeconds <= 0) {
      return remainingBytes === 0 ? '0s' : '< 1s';
    }

    if (smoothedEtaSeconds < 60) {
      return `${smoothedEtaSeconds}s`;
    }

    const mins = Math.floor(smoothedEtaSeconds / 60);
    const secs = smoothedEtaSeconds % 60;
    if (mins < 60) {
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }

    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  }, [progress, smoothedEtaSeconds, remainingBytes]);

  const estimatedCompletionClock = useMemo(() => {
    if (!progress || progress.status !== 'transferring' || smoothedEtaSeconds === null || smoothedEtaSeconds <= 0) {
      return null;
    }
    const completionDate = new Date(Date.now() + smoothedEtaSeconds * 1000);
    return completionDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [progress?.status, smoothedEtaSeconds]);

  const isCurrentlyCongested = useMemo(() => {
    return totalBufferedAmount > 256 * 1024 || (progress?.status === 'transferring' && effectiveSpeedMBps < 0.4);
  }, [totalBufferedAmount, progress?.status, effectiveSpeedMBps]);

  const streamHealth = useMemo(() => {
    if (!progress) return { label: 'Idle', badgeClass: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500' };

    if (progress.status === 'completed') {
      return {
        label: 'Transfer Complete',
        badgeClass: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
      };
    }

    if (progress.status === 'verifying') {
      return {
        label: 'Verifying Bitstream',
        badgeClass: 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 animate-pulse',
      };
    }

    if (progress.status === 'preparing') {
      return {
        label: 'Opening Channels',
        badgeClass: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400',
      };
    }

    if (effectiveSpeedMBps >= 3.0) {
      return {
        label: 'Optimal P2P Tunnel',
        badgeClass: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900',
      };
    }

    if (effectiveSpeedMBps >= 0.8) {
      return {
        label: 'Active Tunnel',
        badgeClass: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300',
      };
    }

    return {
      label: isCurrentlyCongested ? 'Flow Throttled' : 'Starting Stream',
      badgeClass: 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-900',
    };
  }, [progress, effectiveSpeedMBps, isCurrentlyCongested]);

  if (!progress) return null;

  const percent = progress.percent || 0;

  return (
    <div className="w-full max-w-xl mx-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-4 sm:p-6 shadow-sm transition-all duration-200">
      {/* Top Bar: Direction, File Info & Clean Action Buttons */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-neutral-100 dark:border-neutral-800/80">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-neutral-400 uppercase tracking-wider mb-0.5">
            {isReceiving ? (
              <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <ArrowUpRight className="w-3.5 h-3.5 text-neutral-900 dark:text-neutral-100" />
            )}
            <span>{isReceiving ? 'Receiving File' : 'Sending File'}</span>
            {progress.totalBytes > 0 && (
              <span className="text-neutral-500 font-sans">· {formatBytes(progress.totalBytes)}</span>
            )}
          </div>
          <h3
            className="text-sm sm:text-base font-bold text-neutral-900 dark:text-neutral-100 truncate font-mono tracking-tight"
            title={fileName || 'File'}
          >
            {fileName || 'Transferring Data...'}
          </h3>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleToggleSound}
            className={`p-2 rounded-xl border transition-colors cursor-pointer ${
              isAudioMuted
                ? 'border-neutral-200 dark:border-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }`}
            title={isAudioMuted ? 'Unmute sounds' : 'Mute sounds'}
            aria-label="Toggle sound"
          >
            {isAudioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          {onPauseResume && progress.status === 'transferring' && (
            <button
              type="button"
              onClick={onPauseResume}
              className="p-2 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 transition-colors cursor-pointer"
              title={isPaused ? 'Resume transfer' : 'Pause transfer'}
              aria-label={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          {onCancel && progress.status === 'transferring' && (
            <button
              type="button"
              onClick={onCancel}
              className="p-2 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-red-50 dark:hover:bg-red-950/30 text-neutral-400 hover:text-red-500 transition-colors cursor-pointer"
              title="Cancel transfer"
              aria-label="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Main Progress Bar & Percentage Hero */}
      <div className="py-4">
        <div className="flex items-baseline justify-between mb-2">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl sm:text-4xl font-mono font-bold tracking-tight text-neutral-950 dark:text-neutral-50 tabular-nums">
              {percent}%
            </span>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${streamHealth.badgeClass}`}>
              {isPaused ? 'Paused' : streamHealth.label}
            </span>
          </div>
          <div className="text-xs font-mono text-neutral-400 tabular-nums text-right">
            <span>{formatBytes(progress.bytesTransferred)}</span>
            <span className="text-neutral-500"> / </span>
            <span>{formatBytes(progress.totalBytes)}</span>
          </div>
        </div>

        {/* Sleek, Rounded Progress Bar */}
        <div className="w-full h-2.5 bg-neutral-100 dark:bg-neutral-800 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ease-out rounded-full ${
              isPaused
                ? 'bg-amber-500'
                : progress.status === 'completed'
                ? 'bg-emerald-500'
                : 'bg-neutral-950 dark:bg-neutral-100'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Primary 3-Metric Clean Grid (Speed, Transferred, ETA) */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 py-3 border-y border-neutral-100 dark:border-neutral-800/80 text-center font-mono">
        {/* Metric 1: Transfer Speed */}
        <div className="flex flex-col justify-center px-1">
          <span className="text-[10px] sm:text-[11px] uppercase tracking-wider text-neutral-400 font-sans font-medium">
            Speed
          </span>
          <div className="mt-1 flex items-baseline justify-center gap-0.5">
            <span className="text-lg sm:text-2xl font-bold text-neutral-950 dark:text-neutral-50 tabular-nums">
              {apparentSpeedMBps.toFixed(1)}
            </span>
            <span className="text-[10px] sm:text-xs font-semibold text-neutral-400">MB/s</span>
          </div>
          <span className="text-[10px] text-neutral-400 truncate">
            {compressionRatio > 1.05 ? `${compressionRatio}x boost` : `${apparentMbps} Mbps`}
          </span>
        </div>

        {/* Metric 2: Progress Ratio */}
        <div className="flex flex-col justify-center px-1 border-x border-neutral-100 dark:border-neutral-800/80">
          <span className="text-[10px] sm:text-[11px] uppercase tracking-wider text-neutral-400 font-sans font-medium">
            Remaining
          </span>
          <div className="mt-1 flex items-baseline justify-center gap-0.5">
            <span className="text-lg sm:text-2xl font-bold text-neutral-950 dark:text-neutral-50 tabular-nums">
              {formatBytes(remainingBytes)}
            </span>
          </div>
          <span className="text-[10px] text-neutral-400 truncate">
            {progress.totalChunks > 0 ? `${progress.chunksCompleted || 0}/${progress.totalChunks} chunks` : 'Direct stream'}
          </span>
        </div>

        {/* Metric 3: Time Remaining */}
        <div className="flex flex-col justify-center px-1">
          <span className="text-[10px] sm:text-[11px] uppercase tracking-wider text-neutral-400 font-sans font-medium">
            Time Left
          </span>
          <div className="mt-1 flex items-baseline justify-center gap-0.5">
            <span className="text-lg sm:text-2xl font-bold text-neutral-950 dark:text-neutral-50 tabular-nums">
              {formattedTimeRemaining}
            </span>
          </div>
          <span className="text-[10px] text-neutral-400 truncate">
            {estimatedCompletionClock ? `ETA: ${estimatedCompletionClock}` : 'Live estimate'}
          </span>
        </div>
      </div>

      {/* Direct Realtime Throughput Graph */}
      <div className="pt-3">
        <div className="flex items-center justify-between text-[11px] font-mono text-neutral-400 mb-2">
          <span className="flex items-center gap-1 font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            <Gauge className="w-3.5 h-3.5 text-neutral-700 dark:text-neutral-300" />
            Realtime Speed
          </span>
          <span className="flex items-center gap-2">
            <span>Peak: {peakSpeedMBps.toFixed(1)} MB/s</span>
            {isCurrentlyCongested && (
              <span className="text-amber-500 font-semibold flex items-center gap-0.5">
                <TrendingDown className="w-3 h-3" /> Pacing
              </span>
            )}
          </span>
        </div>

        <div className="h-28 sm:h-32 w-full p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-950/50">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={throughputHistory} margin={{ top: 4, right: 0, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id="speedGradientClean" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor={isCurrentlyCongested ? '#f59e0b' : '#10b981'}
                    stopOpacity={0.35}
                  />
                  <stop
                    offset="95%"
                    stopColor={isCurrentlyCongested ? '#f59e0b' : '#10b981'}
                    stopOpacity={0.0}
                  />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" hide />
              <YAxis
                domain={[0, (dataMax: number) => Math.max(2, Math.ceil(dataMax * 1.2))]}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 9, fill: '#888' }}
              />
              <ReferenceLine y={0.5} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.4} />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload as ThroughputPoint;
                    return (
                      <div className="bg-neutral-900 text-white text-[10px] font-mono px-2 py-1 rounded shadow-md border border-neutral-700">
                        <span className="font-bold text-emerald-400">{data.speedMBps.toFixed(1)} MB/s</span>
                        <span className="text-neutral-400 text-[9px] block">{data.time}</span>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Area
                type="monotone"
                dataKey="speedMBps"
                stroke={isCurrentlyCongested ? '#f59e0b' : '#10b981'}
                strokeWidth={1.5}
                fillOpacity={1}
                fill="url(#speedGradientClean)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
