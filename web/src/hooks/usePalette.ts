/**
 * Color palette (neutral scale) — remaps Tailwind `zinc-*` tokens via
 * `data-palette` on <html>. Appearance (light/dark/system) stays separate.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';

/** Swatch hexes (light/mid/dark) for Settings previews — independent of the active page palette. */
export const PALETTES = [
  { id: 'zinc', label: 'Zinc', hint: 'Neutral cool gray (default)', swatch: ['#e4e4e7', '#71717a', '#27272a'] },
  { id: 'slate', label: 'Slate', hint: 'Blue-leaning gray', swatch: ['#e2e8f0', '#64748b', '#1e293b'] },
  { id: 'stone', label: 'Stone', hint: 'Warm gray', swatch: ['#e7e5e4', '#78716c', '#292524'] },
  { id: 'graphite', label: 'Graphite', hint: 'High-contrast charcoal', swatch: ['#e4e4e7', '#71717a', '#18181b'] },
  { id: 'sage', label: 'Sage', hint: 'Muted green-gray', swatch: ['#d5d9ce', '#6b7460', '#373d33'] },
  { id: 'forest', label: 'Forest', hint: 'Deep olive', swatch: ['#c5d3c1', '#557050', '#2e3d2d'] },
  { id: 'ocean', label: 'Ocean', hint: 'Deep blue-gray', swatch: ['#cdd9e8', '#5a7696', '#314054'] },
  { id: 'mist', label: 'Mist', hint: 'Soft cool blue', swatch: ['#d3e4f0', '#5f8fad', '#365063'] },
  { id: 'dusk', label: 'Dusk', hint: 'Muted indigo-gray', swatch: ['#d8d8eb', '#6f6f9a', '#3d3d55'] },
  { id: 'clay', label: 'Clay', hint: 'Earthy brown-gray', swatch: ['#e6d7cf', '#9a7260', '#574038'] },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

const STORAGE_KEY = 'palette';

export function isPaletteId(v: string | null): v is PaletteId {
  return PALETTES.some((p) => p.id === v);
}

function readStoredPalette(): PaletteId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isPaletteId(v)) return v;
  } catch {
    // private browsing, etc.
  }
  return 'zinc';
}

export function applyPalette(id: PaletteId): void {
  document.documentElement.dataset.palette = id;
}

export interface UsePaletteResult {
  palette: PaletteId;
  setPalette: (id: PaletteId) => void;
}

export function usePalette(): UsePaletteResult {
  const [palette, setPaletteState] = useState<PaletteId>(() => readStoredPalette());

  const setPalette = useCallback((id: PaletteId) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // best-effort
    }
    applyPalette(id);
    setPaletteState(id);
  }, []);

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  return { palette, setPalette };
}
