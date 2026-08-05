/**
 * The price timeline: pure functions with no database or Shopify access.
 *
 * Deliberately shared by the server (to decide what to store) and by the edit
 * screen (to preview the result before saving). If the preview were computed
 * separately it could disagree with what actually happens, which is exactly the
 * confusion this is meant to remove.
 */

/** One recorded price, in effect from `effectiveFrom` until the next entry. */
export type PriceEntry = { effectiveFrom: string; amount: number };

/** What the merchant is about to do. */
export type PriceChange =
  /** Normal change: applies from today, the past is untouched. */
  | { mode: "today"; amount: number; today: string }
  /** Entered late: the price really changed on `from`. */
  | { mode: "date"; amount: number; from: string }
  /** It was this price only between two dates, then went back. */
  | { mode: "range"; amount: number; from: string; to: string }
  /** The old number was wrong: correct the price in effect. */
  | { mode: "correct"; amount: number; today: string };

const DAY_MS = 86_400_000;

/** The day after `day`, as "YYYY-MM-DD". */
export function nextDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Date(t + DAY_MS).toISOString().slice(0, 10);
}

/** The day before `day`, as "YYYY-MM-DD". */
export function previousDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Date(t - DAY_MS).toISOString().slice(0, 10);
}

/**
 * The amount in effect on `day`: the newest entry starting on or before it.
 * Falls back to the oldest entry, so a day earlier than every entry still has a
 * price rather than nothing.
 */
export function amountOn(entries: PriceEntry[], day: string): number | null {
  let inEffect: PriceEntry | undefined;
  let oldest: PriceEntry | undefined;
  for (const e of entries) {
    if (!oldest || e.effectiveFrom < oldest.effectiveFrom) oldest = e;
    if (e.effectiveFrom <= day && (!inEffect || e.effectiveFrom > inEffect.effectiveFrom)) {
      inEffect = e;
    }
  }
  return (inEffect ?? oldest)?.amount ?? null;
}

function sorted(entries: PriceEntry[]): PriceEntry[] {
  return [...entries].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

function withEntry(entries: PriceEntry[], effectiveFrom: string, amount: number): PriceEntry[] {
  const rest = entries.filter((e) => e.effectiveFrom !== effectiveFrom);
  return sorted([...rest, { effectiveFrom, amount }]);
}

/**
 * The complete set of entries after applying a change.
 *
 * This is the single source of truth: the server stores exactly what this
 * returns, and the screen previews exactly what this returns.
 */
export function applyPriceChange(entries: PriceEntry[], change: PriceChange): PriceEntry[] {
  const current = sorted(entries);

  if (change.mode === "today") {
    return withEntry(current, change.today, change.amount);
  }

  if (change.mode === "date") {
    return withEntry(current, change.from, change.amount);
  }

  if (change.mode === "correct") {
    // Rewrite the entry in effect rather than adding a new one — the merchant
    // is fixing a number that was always wrong.
    let target: PriceEntry | undefined;
    let oldest: PriceEntry | undefined;
    for (const e of current) {
      if (!oldest || e.effectiveFrom < oldest.effectiveFrom) oldest = e;
      if (e.effectiveFrom <= change.today && (!target || e.effectiveFrom > target.effectiveFrom)) {
        target = e;
      }
    }
    const day = (target ?? oldest)?.effectiveFrom;
    if (!day) return [{ effectiveFrom: change.today, amount: change.amount }];
    return withEntry(current, day, change.amount);
  }

  // --- range -----------------------------------------------------------------
  // Read what happens after the period BEFORE changing anything, so the price
  // can be put back correctly once the period ends.
  const dayAfter = nextDay(change.to);
  const revertTo = amountOn(current, dayAfter);

  // Anything recorded inside the period is replaced: the whole period is now
  // this one price.
  let next = current.filter(
    (e) => !(e.effectiveFrom > change.from && e.effectiveFrom <= change.to),
  );
  next = withEntry(next, change.from, change.amount);

  // If a later change already starts the day after, it stands on its own.
  const hasFollowing = next.some((e) => e.effectiveFrom === dayAfter);
  if (!hasFollowing && revertTo != null) {
    next = withEntry(next, dayAfter, revertTo);
  }

  return sorted(next);
}

/** A period of one unchanging price, for display. `to` null means "still". */
export type PricePeriod = { from: string; to: string | null; amount: number };

/** Turn entries into the periods they describe. */
export function toPeriods(entries: PriceEntry[]): PricePeriod[] {
  const list = sorted(entries);
  return list.map((e, i) => ({
    from: e.effectiveFrom,
    to: i < list.length - 1 ? previousDay(list[i + 1].effectiveFrom) : null,
    amount: e.amount,
  }));
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-08-05" -> "5 Aug 2026". Plain and unambiguous for a non-technical reader. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** How a period reads in the preview: "Before 1 Mar 2026", "1–31 Mar 2026", "From 1 Mar 2026". */
export function describePeriod(period: PricePeriod, earliestDay: string): string {
  const openStart = period.from <= earliestDay;
  if (openStart && period.to === null) return "All the time";
  if (openStart) return `Up to ${formatDay(period.to as string)}`;
  if (period.to === null) return `From ${formatDay(period.from)} onward`;
  return `${formatDay(period.from)} – ${formatDay(period.to)}`;
}
