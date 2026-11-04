/**
 * Deterministic extraction of dates, amounts, and transaction references.
 *
 * The design constitution says deterministic before intelligent: anything that
 * can be computed from the text is computed, and the model is used only for
 * judgement (which passages matter, what a passage asserts). These functions
 * are pure and unit-tested against fixed inputs, so a change in their output is
 * a change a reviewer can see.
 *
 * Dates are returned exactly as written alongside a best-effort normalisation.
 * When the text is ambiguous the ambiguity is preserved in `precision` and
 * `conflict` rather than resolved by guessing.
 */

export interface DetectedDate {
  /** The date exactly as it appears in the source text. */
  text: string;
  /** ISO yyyy-mm-dd when the day is known; yyyy-mm when only the month is. */
  iso: string | null;
  precision: "day" | "month" | "year" | "unknown";
  index: number;
}

export interface DetectedAmount {
  text: string;
  /** Minor units (cents) as an integer, so arithmetic is exact. */
  minor: number;
  currency: string | null;
  index: number;
}

export interface DetectedReference {
  text: string;
  kind: "transaction" | "order" | "invoice" | "account" | "reference" | "hash";
  index: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Finds dates in the forms that appear in real financial documents. Deliberately
 * conservative: an unrecognised shape yields nothing rather than a wrong date.
 */
export function detectDates(text: string): DetectedDate[] {
  const found: DetectedDate[] = [];
  const push = (m: RegExpMatchArray, value: string | null, precision: DetectedDate["precision"]) => {
    found.push({ text: m[0], iso: value, precision, index: m.index ?? 0 });
  };

  // 2024-03-15 / 2024/03/15
  for (const m of text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g)) {
    push(m, iso(Number(m[1]), Number(m[2]), Number(m[3])), "day");
  }
  // 15/03/2024, 03/15/2024, 15.03.2024 - day and month are genuinely ambiguous
  // when both are <= 12, so record the raw text and mark it unknown.
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    push(m, ambiguous ? null : iso(y, b, a), ambiguous ? "unknown" : "day");
  }
  // 15 March 2024 / 15th March 2024 / March 15, 2024
  for (const m of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
  )) {
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    push(m, month ? iso(Number(m[3]), month, Number(m[1])) : null, month ? "day" : "unknown");
  }
  for (const m of text.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
  )) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    push(m, month ? iso(Number(m[3]), month, Number(m[2])) : null, month ? "day" : "unknown");
  }
  // March 2024 - month precision only
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/g)) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    if (!month) continue;
    if (found.some((f) => f.index === (m.index ?? 0))) continue;
    found.push({
      text: m[0],
      iso: `${m[2] ?? ""}-${String(month).padStart(2, "0")}`,
      precision: "month",
      index: m.index ?? 0,
    });
  }

  return dedupeByIndex(found);
}

function dedupeByIndex<T extends { index: number }>(items: T[]): T[] {
  const byIndex = new Map<number, T>();
  for (const item of items) if (!byIndex.has(item.index)) byIndex.set(item.index, item);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR",
};

/**
 * Finds monetary amounts and converts to minor units. Currency is reported only
 * when the document states it; an unlabelled amount is left without one rather
 * than assumed to be dollars.
 */
export function detectAmounts(text: string): DetectedAmount[] {
  const found: DetectedAmount[] = [];
  const seen = new Set<number>();

  // $1,234.56 / €99 / £12.5
  for (const m of text.matchAll(/([$€£¥₹])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
    const value = Number((m[2] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    seen.add(m.index ?? 0);
    found.push({
      text: m[0],
      minor: Math.round(value * 100),
      currency: CURRENCY_SYMBOLS[m[1] ?? ""] ?? null,
      index: m.index ?? 0,
    });
  }
  // 1234.56 USD / 1,234.56 EUR / 42 GBP
  for (const m of text.matchAll(
    /\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})\s?(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|SEK|NOK|DKK|PLN|BRL|MXN|ZAR|NZD|SGD|HKD)\b/gi,
  )) {
    if (seen.has(m.index ?? 0)) continue;
    const value = Number((m[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    found.push({
      text: m[0],
      minor: Math.round(value * 100),
      currency: (m[2] ?? "").toUpperCase(),
      index: m.index ?? 0,
    });
  }
  return dedupeByIndex(found);
}

const REFERENCE_PATTERNS: Array<{ kind: DetectedReference["kind"]; re: RegExp }> = [
  { kind: "hash", re: /\b0x[a-fA-F0-9]{16,}\b/g },
  { kind: "transaction", re: /\b(?:txn|tx|transaction)[\s_-]?(?:id|no|number|ref)?[:#\s-]*([A-Za-z0-9][A-Za-z0-9._-]{5,40})\b/gi },
  { kind: "order", re: /\b(?:order)[\s_-]?(?:id|no|number|ref)?[:#\s-]*([A-Za-z0-9][A-Za-z0-9._-]{3,40})\b/gi },
  { kind: "invoice", re: /\b(?:invoice|inv)[\s_-]?(?:id|no|number|ref)?[:#\s-]*([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "account", re: /\b(?:account|acct)[\s_-]?(?:id|no|number)[:#\s-]*([A-Za-z0-9][A-Za-z0-9*._-]{3,40})\b/gi },
  { kind: "reference", re: /\b(?:reference|ref|confirmation)[\s_-]?(?:id|no|number)?[:#\s-]*([A-Za-z0-9][A-Za-z0-9._-]{5,40})\b/gi },
];

export function detectReferences(text: string): DetectedReference[] {
  const found: DetectedReference[] = [];
  for (const { kind, re } of REFERENCE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0] ?? "";
      if (!value) continue;
      found.push({ text: m[0].trim(), kind, index: m.index ?? 0 });
    }
  }
  return dedupeByIndex(found);
}

/** ISO dates that appear in the text, used to detect conflicting dates. */
export function normalizedDates(dates: DetectedDate[]): string[] {
  return [...new Set(dates.map((d) => d.iso).filter((v): v is string => Boolean(v)))];
}

/**
 * Two events on different days of the same document are not a conflict; two
 * different full dates given for the same passage are. This reports the
 * distinct day-precision dates a single passage carries so the caller can flag
 * the passage rather than pick one.
 */
export function hasConflictingDates(dates: DetectedDate[]): boolean {
  const days = dates.filter((d) => d.precision === "day" && d.iso);
  return new Set(days.map((d) => d.iso)).size > 1;
}
