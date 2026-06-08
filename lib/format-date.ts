/**
 * Human-readable absolute dates, e.g. "7 January 2026" (or "7 januari 2026"
 * under a Dutch locale). Uses the viewer's locale via `undefined`. Prefer this
 * over `toLocaleDateString()` with no options, which renders "5/7/2026".
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** Same as formatDate but with the time appended, e.g. "7 January 2026, 14:32". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
