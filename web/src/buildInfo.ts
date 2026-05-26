/**
 * Build metadata stamped in at compile time by `vite.config.ts`.
 *
 * - `COMMIT_SHA` is the full git SHA of the commit being built, or
 *   `"dev"` for ad-hoc local builds where git isn't reachable.
 * - `BUILD_TIMESTAMP` is the ISO-8601 UTC moment the Vite build ran.
 *
 * The footer on the sign-in page surfaces both so visitors can tell
 * exactly which deploy they're hitting (useful when triaging a bug
 * report).
 */

declare const __COMMIT_SHA__: string;
declare const __BUILD_TIMESTAMP__: string;

export const COMMIT_SHA: string = __COMMIT_SHA__;
export const BUILD_TIMESTAMP: string = __BUILD_TIMESTAMP__;

/** First 7 chars — the conventional short-form git hash. */
export const SHORT_SHA: string = COMMIT_SHA.length > 7 ? COMMIT_SHA.slice(0, 7) : COMMIT_SHA;

/**
 * Render `BUILD_TIMESTAMP` as `YYYY-MM-DD HH:MM UTC`. We deliberately
 * format in UTC rather than the visitor's local timezone so the footer
 * reads identically for everyone — the value is about "when was this
 * code built", not "when in your day are you reading it".
 */
export function formatBuildTimestamp(): string {
  const d = new Date(BUILD_TIMESTAMP);
  if (Number.isNaN(d.getTime())) return BUILD_TIMESTAMP;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}
