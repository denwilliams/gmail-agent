/** Milliseconds the demo clock is ahead of the real one (0 outside fake mode). */
let offset = 0;
export const setClockOffset = (ms: number) => { offset = ms; };
export const nowMs = () => Date.now() + offset;

export function ago(ms: number) {
  const s = Math.max(1, Math.round((nowMs() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "in 7m", "in 45s", or "due" for a time in the future/past (demo clock aware). */
export function until(ms: number) {
  const s = Math.round((ms - nowMs()) / 1000);
  if (s <= 5) return "due";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
}

export const usd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`;
