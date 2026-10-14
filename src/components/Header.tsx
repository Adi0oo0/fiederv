interface HeaderProps {
  mode: 'send' | 'receive';
  onModeChange: (mode: 'send' | 'receive') => void;
  disabled?: boolean;
}

export function Header({ mode, onModeChange, disabled }: HeaderProps) {
  const toggleTheme = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    document.body.classList.toggle('dark', isDark);
    localStorage.setItem('drop_theme', isDark ? 'dark' : 'light');
  };

  return (
    <header className="w-full border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 transition-colors">
      <div className="max-w-2xl mx-auto px-6 h-16 flex items-center justify-between">
        <a
          href="/"
          className="text-lg font-bold tracking-tight text-neutral-950 dark:text-neutral-50 font-display select-none flex items-center gap-1.5"
        >
          <span>drop</span>
          <span className="w-1.5 h-1.5 rounded-full bg-neutral-950 dark:bg-neutral-50 inline-block" />
        </a>

        <div className="flex items-center gap-6">
          <div className="flex items-center p-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onModeChange('send')}
              className={`px-3 py-1 text-xs font-mono font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
                mode === 'send'
                  ? 'bg-neutral-950 text-white dark:bg-neutral-50 dark:text-neutral-950'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
              }`}
            >
              SEND
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onModeChange('receive')}
              className={`px-3 py-1 text-xs font-mono font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
                mode === 'receive'
                  ? 'bg-neutral-950 text-white dark:bg-neutral-50 dark:text-neutral-950'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
              }`}
            >
              RECEIVE
            </button>
          </div>

          <button
            type="button"
            onClick={toggleTheme}
            className="text-xs font-mono text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors cursor-pointer"
            title="Toggle theme"
          >
            THEME
          </button>
        </div>
      </div>
    </header>
  );
}
