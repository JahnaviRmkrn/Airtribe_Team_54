// Keep user-supplied limits finite and integral before passing them to SQL or
// date arithmetic. Large values retain the API's documented maximum clamp.
export function boundedInteger(raw: string | null, fallback: number, maximum: number, minimum = 1): number | null {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) return null;
  return Math.min(value, maximum);
}
