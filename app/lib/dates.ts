/**
 * Date-range helpers for reports. Days are handled as "YYYY-MM-DD" strings so a
 * "day" is stable regardless of timezone, and string comparison == date order.
 */

/** Convert a Date to a local "YYYY-MM-DD" string. */
export function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today as "YYYY-MM-DD". */
export function todayString(): string {
  return toDayString(new Date());
}

export type ResolvedRange = { start: string; end: string; preset: string };

/** Turn a preset (or a custom start/end) into concrete day-string bounds. */
export function resolveRange(
  preset: string | null | undefined,
  startParam?: string | null,
  endParam?: string | null,
): ResolvedRange {
  if (preset === "custom" && startParam && endParam) {
    // Keep them ordered just in case.
    const [start, end] = startParam <= endParam ? [startParam, endParam] : [endParam, startParam];
    return { start, end, preset: "custom" };
  }
  const now = new Date();
  const end = toDayString(now);
  switch (preset) {
    case "today":
      return { start: end, end, preset: "today" };
    case "7d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { start: toDayString(d), end, preset: "7d" };
    }
    case "this_month": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: toDayString(d), end, preset: "this_month" };
    }
    case "last_month": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: toDayString(s), end: toDayString(e), preset: "last_month" };
    }
    case "all":
      return { start: "2000-01-01", end, preset: "all" };
    case "30d":
    default: {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { start: toDayString(d), end, preset: "30d" };
    }
  }
}

/** Inclusive number of days between two "YYYY-MM-DD" strings (min 1). */
export function daysInclusive(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 1;
  return Math.floor((e - s) / 86_400_000) + 1;
}

/** "YYYY-MM-DD" for N days ago. */
export function daysAgoString(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDayString(d);
}

export const RANGE_PRESETS: { label: string; value: string }[] = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "This month", value: "this_month" },
  { label: "Last month", value: "last_month" },
  { label: "All time", value: "all" },
];
