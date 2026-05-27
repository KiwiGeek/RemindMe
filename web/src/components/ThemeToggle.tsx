/**
 * Header theme toggle — a single icon button that cycles through
 * System → Light → Dark → System. Hover text and `aria-label` reflect
 * both the current state and what the next click will do, so it's
 * usable with keyboard + screen reader.
 */

import { type UseThemeResult, useTheme } from '../hooks/useTheme';

interface Props {
  /**
   * Optional: pass a shared hook result if you already have one in scope.
   * Useful when multiple toggles co-exist on the same page (unlikely now,
   * but cheap to support).
   */
  controller?: UseThemeResult;
}

export function ThemeToggle({ controller }: Props) {
  const fallback = useTheme();
  const { pref, cycle } = controller ?? fallback;
  const next: typeof pref = pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system';
  const label =
    pref === 'system'
      ? 'Theme: System (click for Light)'
      : pref === 'light'
        ? 'Theme: Light (click for Dark)'
        : 'Theme: Dark (click for System)';

  return (
    <button
      type="button"
      onClick={cycle}
      title={label}
      aria-label={label}
      class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200/90 bg-white text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
    >
      {pref === 'light' ? <SunIcon /> : pref === 'dark' ? <MoonIcon /> : <SystemIcon />}
      <span class="sr-only">Cycle to {next} theme</span>
    </button>
  );
}

// Inline SVGs (Heroicons-inspired, hand-tuned to 14×14). Inline so the
// theme toggle has zero runtime deps and zero extra HTTP requests.

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
