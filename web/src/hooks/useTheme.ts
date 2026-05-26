/**
 * Three-state theme controller: light, dark, or follow-the-OS.
 *
 * The inline script in `web/index.html` applies the right `dark` class
 * before React mounts so we never flash the wrong scheme on first paint.
 * After mount this hook owns the class and keeps it in sync with the
 * stored preference. Both pieces have to agree on the localStorage key
 * (`theme`) and the values (`light`, `dark`, `system`).
 *
 * When the preference is `system`, we subscribe to
 * `matchMedia('(prefers-color-scheme: dark)')` so the page tracks the OS
 * theme as it changes (e.g. macOS automatic at sunset).
 */

import { useCallback, useEffect, useState } from 'preact/hooks';

export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage may be unavailable in private windows; fall through.
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function resolveDark(pref: ThemePref): boolean {
  return pref === 'dark' || (pref === 'system' && systemPrefersDark());
}

function applyTheme(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  // Inform native form controls/scrollbars so they match too.
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export interface UseThemeResult {
  pref: ThemePref;
  /** What the page is actually rendering as right now. */
  resolved: 'light' | 'dark';
  setPref: (next: ThemePref) => void;
  /** Cycle system -> light -> dark -> system. */
  cycle: () => void;
}

export function useTheme(): UseThemeResult {
  const [pref, setPrefState] = useState<ThemePref>(() => readStoredPref());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolveDark(readStoredPref()) ? 'dark' : 'light',
  );

  const setPref = useCallback((next: ThemePref) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
    setPrefState(next);
    const dark = resolveDark(next);
    applyTheme(dark);
    setResolved(dark ? 'dark' : 'light');
  }, []);

  const cycle = useCallback(() => {
    setPref(pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system');
  }, [pref, setPref]);

  useEffect(() => {
    // Only need to track OS changes while we're in `system` mode. In
    // explicit modes the user has overridden the OS preference, so we
    // ignore those events.
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const dark = mq.matches;
      applyTheme(dark);
      setResolved(dark ? 'dark' : 'light');
    };
    // Older Safari (<14) lacks addEventListener on MediaQueryList.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [pref]);

  return { pref, resolved, setPref, cycle };
}
