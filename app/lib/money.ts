/**
 * Money + number helpers shared across the app.
 * All amounts in the app are plain numbers in the shop's currency (default EGP).
 */

/** Format an amount as currency, e.g. 1234.5 -> "EGP 1,234.50". */
export function formatMoney(amount: number, currency = "EGP"): string {
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Format a signed amount, keeping the sign explicit (used for profit/loss). */
export function formatSigned(amount: number, currency = "EGP"): string {
  const s = formatMoney(Math.abs(amount), currency);
  if (amount < 0) return `-${s}`;
  return s;
}

/** Round to 2 decimal places, avoiding binary float noise. */
export function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100 + Number.EPSILON) / 100;
}

/** Format a percentage, e.g. 0.2537 -> "25.4%". */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Parse a number out of a form field, tolerating commas and stray spaces. */
export function parseAmount(
  value: FormDataEntryValue | null | undefined,
  fallback = 0,
): number {
  if (value == null) return fallback;
  const n = parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}
