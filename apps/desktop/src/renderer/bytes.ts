/**
 * Bytes as a person reads them.
 *
 * The renderer's own copy, because the renderer cannot import from
 * `@marimo/runtime` — that package is Node-side and pulls in `node:fs`. It is
 * deliberately the same rule as `formatBytes` there, so a size shown on the
 * welcome screen and the same size shown in the Model card are the same number:
 * a download that said "4.5 GB" on one screen and "4.2 GB" on the other would look
 * like two different files.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${String(Math.round(bytes))} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
