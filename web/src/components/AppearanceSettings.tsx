/**
 * Labeled appearance controls for the Settings page.
 */

import { PALETTES, type PaletteId, usePalette } from '../hooks/usePalette';
import { type ThemePref, useTheme } from '../hooks/useTheme';

export function AppearanceSettings() {
  const { pref, setPref } = useTheme();
  const { palette, setPalette } = usePalette();

  return (
    <section class="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 class="text-lg font-semibold">Appearance</h2>
      <p class="text-xs text-zinc-500">Stored in this browser only — not synced to your account.</p>

      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Color mode</span>
        <select
          class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
          value={pref}
          onChange={(e) => setPref((e.target as HTMLSelectElement).value as ThemePref)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm font-medium">Color theme</legend>
        <div class="grid gap-2 sm:grid-cols-2">
          {PALETTES.map((p) => (
            <label
              key={p.id}
              class={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                palette === p.id
                  ? 'border-zinc-900 dark:border-zinc-100'
                  : 'border-zinc-200 dark:border-zinc-800'
              }`}
            >
              <input
                type="radio"
                name="palette"
                class="mt-1"
                checked={palette === p.id}
                onChange={() => setPalette(p.id as PaletteId)}
              />
              <span class="flex min-w-0 flex-1 items-start justify-between gap-2">
                <span>
                  <span class="font-medium">{p.label}</span>
                  <span class="mt-0.5 block text-xs text-zinc-500">{p.hint}</span>
                </span>
                <span class="mt-0.5 flex shrink-0 gap-0.5" aria-hidden="true">
                  {p.swatch.map((hex) => (
                    <span
                      key={hex}
                      class="h-4 w-4 rounded-sm ring-1 ring-black/10 dark:ring-white/15"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
