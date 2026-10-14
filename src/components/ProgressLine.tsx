interface ProgressLineProps {
  percent: number;
}

export function ProgressLine({ percent }: ProgressLineProps) {
  const clamped = Math.min(100, Math.max(0, percent));

  return (
    <div className="w-full h-[2px] bg-neutral-200 dark:bg-neutral-800 overflow-hidden my-6">
      <div
        className="h-full bg-neutral-950 dark:bg-neutral-50 transition-all duration-150 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
