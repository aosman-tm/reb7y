/**
 * The price timeline: pure functions with no database or Shopify access.
 *
 * Deliberately shared by the server (to decide what to store) and by the edit
 * screen (to preview the result before saving). If the preview were computed
 * separately it could disagree with what actually happens, which is exactly the
 * confusion this is meant to remove.
 */

/**
 * Far enough back to cover any order a Shopify store could have.
 *
 * Lives here rather than in costHistory.server.ts because the edit screens need
 * it too, and importing a `.server` module from component code would pull the
 * database layer into the browser bundle.
 */
export const EARLIEST_DAY = "2000-01-01";

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

// ---------------------------------------------------------------------------
// Rows: how a merchant edits a price
// ---------------------------------------------------------------------------

/**
 * One price the merchant typed, covering a stretch of time.
 *
 * `from` empty means "since the beginning" — the merchant should not have to
 * invent a start date for a price that was always the price.
 * `to` null means "until now": the price currently in effect.
 */
export type PriceRow = { from: string; to: string | null; amount: number };

/** Does this row cover `day`? */
function rowCovers(row: PriceRow, day: string, earliestDay: string): boolean {
  const start = row.from || earliestDay;
  if (day < start) return false;
  return row.to === null || day <= row.to;
}

/**
 * Turn the rows shown on screen into the entries we store.
 *
 * Later rows win where two overlap, and a day no row covers falls back to the
 * earliest price — the same rule reports use, so a gap can never leave an order
 * with no cost at all.
 */
export function entriesFromRows(rows: PriceRow[], earliestDay = EARLIEST_DAY): PriceEntry[] {
  const usable = rows.filter((r) => Number.isFinite(r.amount));
  if (usable.length === 0) return [];

  const ordered = [...usable].sort((a, b) => (a.from || earliestDay).localeCompare(b.from || earliestDay));
  const fallback = ordered[0].amount;

  // Every day a price could change: a row starting, or a row ending.
  const boundaries = new Set<string>([earliestDay]);
  for (const row of ordered) {
    boundaries.add(row.from || earliestDay);
    if (row.to) boundaries.add(nextDay(row.to));
  }

  const valueOn = (day: string): number => {
    let found: number | null = null;
    for (const row of ordered) {
      if (rowCovers(row, day, earliestDay)) found = row.amount; // later rows win
    }
    return found ?? fallback;
  };

  const days = Array.from(boundaries).sort();
  const entries: PriceEntry[] = [];
  for (const day of days) {
    const amount = valueOn(day);
    // Only record a day where the price actually changes.
    if (entries.length === 0 || entries[entries.length - 1].amount !== amount) {
      entries.push({ effectiveFrom: day, amount });
    }
  }
  return entries;
}

/**
 * How the edit screen holds a price: one current amount, plus any earlier
 * periods where it was different.
 *
 * The current amount is the baseline — it covers every date no period claims.
 * That way a merchant whose price never changed only ever sees one number, and
 * a period is something they add deliberately.
 */
export type PriceEditorModel = { current: number; periods: PriceRow[] };

/** Stored entries -> what the edit screen shows. */
export function toEditorModel(
  entries: PriceEntry[],
  today: string,
  earliestDay = EARLIEST_DAY,
): PriceEditorModel {
  if (entries.length === 0) return { current: 0, periods: [] };

  const current = amountOn(entries, today) ?? 0;
  const periods = toPeriods(entries)
    // Drop the stretch containing today: that one IS the current price.
    .filter((p) => !(p.from <= today && (p.to === null || today <= p.to)))
    // Drop stretches that already match the current price. The current price is
    // the baseline and covers them anyway, so showing them as rows would add
    // clutter the merchant never typed.
    .filter((p) => p.amount !== current)
    .map((p) => ({
      from: p.from <= earliestDay ? "" : p.from,
      to: p.to,
      amount: p.amount,
    }));

  return { current, periods };
}

/**
 * Read a model the edit screen submitted as JSON.
 *
 * Everything is re-validated: this arrives from a form, so a missing field or a
 * non-numeric amount must produce a usable model rather than a crash.
 */
export function parseEditorModel(raw: unknown): PriceEditorModel {
  try {
    const parsed = JSON.parse(String(raw ?? "")) as Partial<PriceEditorModel>;
    return {
      current: Number(parsed?.current) || 0,
      periods: Array.isArray(parsed?.periods)
        ? parsed.periods
            .filter((p) => p && Number.isFinite(Number(p.amount)))
            .map((p) => ({
              from: String(p.from ?? ""),
              to: p.to ? String(p.to) : null,
              amount: Number(p.amount),
            }))
        : [],
    };
  } catch {
    return { current: 0, periods: [] };
  }
}

/** What the edit screen shows -> the entries to store. */
export function fromEditorModel(
  model: PriceEditorModel,
  earliestDay = EARLIEST_DAY,
): PriceEntry[] {
  const baseline: PriceRow = { from: "", to: null, amount: model.current };
  return entriesFromRows([baseline, ...model.periods], earliestDay);
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
