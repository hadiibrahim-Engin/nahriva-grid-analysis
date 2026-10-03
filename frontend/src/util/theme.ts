export type ThemeMode = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'grid-monitor-theme-mode';

export const THEME_OPTIONS: { id: ThemeMode; label: string; icon: string }[] = [
  { id: 'dark', label: 'Dunkel', icon: '◐' },
  { id: 'light', label: 'Hell', icon: '☼' },
  { id: 'system', label: 'System', icon: '◌' },
];

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

export function storedThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : 'dark';
}

export function applyGridThemeMode(themeMode: ThemeMode): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const applyTheme = () => {
    const resolvedTheme = themeMode === 'system'
      ? (media.matches ? 'dark' : 'light')
      : themeMode;

    document.documentElement.dataset.gridTheme = resolvedTheme;
    document.documentElement.dataset.gridThemeMode = themeMode;
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  };

  applyTheme();
  if (themeMode !== 'system') return () => {};

  media.addEventListener('change', applyTheme);
  return () => media.removeEventListener('change', applyTheme);
}
