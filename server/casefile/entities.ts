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
  /** The matched text as it appears, including any label. */
  text: string;
  /** The identifier value alone, without its label ("SA-2024-0042"). */
  value: string;
  kind:
    | "transaction"
    | "order"
    | "invoice"
    | "account"
    | "reference"
    | "hash"
    | "policy"
    | "claim"
    | "case"
    | "contract";
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
  // A labelled amount: "Amount: 249.99", "Total 1,200.00", "Balance: 42". Real
  // financial documents label amounts instead of writing a currency symbol next
  // to every number, so a labelled value is read even with no symbol.
  for (const m of text.matchAll(
    /\b(?:amount|total|balance|fee|price|cost|charged|paid|debit|credit)\b\s*[:#]?\s*([$€£¥₹]?\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/gi,
  )) {
    const raw = (m[1] ?? "").trim();
    const symbol = raw.match(/^([$€£¥₹])/);
    const numeric = raw.replace(/[$€£¥₹\s]/g, "");
    if (!/^\d/.test(numeric)) continue;
    const value = Number(numeric.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const index = (m.index ?? 0) + m[0].indexOf(raw);
    if (found.some((f) => f.index === index)) continue;
    found.push({
      text: m[0].trim(),
      minor: Math.round(value * 100),
      currency: symbol ? (CURRENCY_SYMBOLS[symbol[1] ?? ""] ?? null) : null,
      index,
    });
  }
  return dedupeByIndex(found);
}

// The lookahead `(?=[A-Za-z0-9._/-]*\d)` requires the captured value to carry a
// digit. Two failures come from leaving it out. A label word can be captured as
// its own value ("Contract No. SA-2024-0042" yields "Contract"), and - worse -
// because the separator classes match whitespace, a match can start at one
// label and swallow the next word, so "AGREEMENT\nContract No. SA-2024-0042"
// consumes "Contract" as the value and the real identifier is never seen. With
// the lookahead the engine skips the label and lands on SA-2024-0042.
const REFERENCE_PATTERNS: Array<{ kind: DetectedReference["kind"]; re: RegExp }> = [
  { kind: "hash", re: /\b0x[a-fA-F0-9]{16,}\b/g },
  { kind: "transaction", re: /\b(?:txn|tx|transaction)[\s_-]?(?:id|no|number|ref)?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._-]{5,40})\b/gi },
  { kind: "order", re: /\b(?:order)[\s_-]?(?:id|no|number|ref)?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._-]{3,40})\b/gi },
  { kind: "invoice", re: /\b(?:invoice|inv)[\s_-]?(?:id|no|number|ref)?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "account", re: /\b(?:account|acct)[\s_-]?(?:id|no|number)[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9*._-]{3,40})\b/gi },
  // Policy, claim, and case numbers are what link a medical report to an
  // insurance claim, and a judgment to the pleadings it decides. Without them
  // those documents look unrelated.
  { kind: "policy", re: /\b(?:policy)[\s_-]?(?:id|no|number|ref)?\.?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "claim", re: /\b(?:claim)[\s_-]?(?:id|no|number|ref)?\.?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "case", re: /\b(?:case)[\s_-]?(?:id|no|number|ref)?\.?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "contract", re: /\b(?:contract|agreement|deed)[\s_-]?(?:id|no|number|ref)?\.?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._/-]{3,40})\b/gi },
  { kind: "reference", re: /\b(?:reference|ref|confirmation)[\s_-]?(?:id|no|number)?[:#\s-]*(?=[A-Za-z0-9._/-]*\d)([A-Za-z0-9][A-Za-z0-9._-]{5,40})\b/gi },
];

export function detectReferences(text: string): DetectedReference[] {
  const found: DetectedReference[] = [];
  for (const { kind, re } of REFERENCE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = (m[1] ?? m[0] ?? "").trim();
      if (!value) continue;
      found.push({ text: m[0].trim(), value, kind, index: m.index ?? 0 });
    }
  }
  return dedupeReferences(found);
}

/**
 * Keeps one reference per starting position.
 *
 * Two patterns can match at the same offset: "Reference: Contract No.
 * SA-2024-0042" is matched by the generic `reference` pattern (value
 * "Contract") and by the `contract` pattern (value "SA-2024-0042"). Keeping the
 * first would throw away the identifier and keep its label, so a value that
 * carries a digit - the actual identifier - wins; failing that, the longer value.
 */
function dedupeReferences(items: DetectedReference[]): DetectedReference[] {
  const byIndex = new Map<number, DetectedReference>();
  for (const item of items) {
    const existing = byIndex.get(item.index);
    if (!existing || isMoreIdentifiable(item, existing)) byIndex.set(item.index, item);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function isMoreIdentifiable(a: DetectedReference, b: DetectedReference): boolean {
  const aDigit = /\d/.test(a.value);
  const bDigit = /\d/.test(b.value);
  if (aDigit !== bDigit) return aDigit;
  return a.value.length > b.value.length;
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

export interface DetectedParty {
  /** The name exactly as written. */
  text: string;
  /** The label that identified it ("Merchant", "Customer", "between", …). */
  label: string;
  index: number;
}

/**
 * Labels that introduce a named party. A name is only a party when a document
 * puts it in one of these positions, so two documents that merely share a
 * capitalised word are not linked. This is the rule that keeps party matching
 * from becoming "these two files mention similar words".
 */
const PARTY_LABELS = [
  "merchant", "customer", "client", "buyer", "seller", "vendor", "supplier",
  "contractor", "employer", "employee", "landlord", "tenant", "insured",
  "insurer", "patient", "provider", "claimant", "defendant", "plaintiff",
  "petitioner", "respondent", "appellant", "witness", "deponent", "author",
  "publisher", "from", "to", "cc", "bcc", "account holder", "cardholder",
  "policy holder", "policyholder", "beneficiary", "guarantor", "assignee",
  "assignor", "licensor", "licensee", "partner", "representative",
];

const PARTY_LABEL_RE = new RegExp(
  `\\b(${PARTY_LABELS.join("|")})\\b\\s*[:\\-–]\\s*([A-Za-z0-9][\\w&.,'’\\- ]{1,60}?)(?=\\s{2,}|[\\n;|]|$)`,
  "gi",
);

/** "between Acme Ltd and Northwind Traders" - both sides are parties. */
const BETWEEN_RE = /\bbetween\s+([A-Za-z0-9][\w&.,'’\- ]{1,50}?)\s+and\s+([A-Za-z0-9][\w&.,'’\- ]{1,50}?)(?=\s{2,}|[.\n;]|$)/gi;

/**
 * Finds named parties that a document explicitly introduces. Deliberately
 * conservative: an unlabelled capitalised phrase is not returned, because a
 * guessed name would create a relationship the evidence does not support.
 */
export function detectParties(text: string): DetectedParty[] {
  const found: DetectedParty[] = [];
  const push = (name: string, label: string, index: number) => {
    const trimmed = name.trim().replace(/[.,;:]+$/, "").trim();
    if (!trimmed) return;
    // A single character or a bare role word is not a name.
    if (trimmed.length < 2) return;
    if (PARTY_LABELS.includes(trimmed.toLowerCase())) return;
    found.push({ text: trimmed, label: label.toLowerCase(), index });
  };

  for (const m of text.matchAll(PARTY_LABEL_RE)) {
    push(m[2] ?? "", m[1] ?? "", m.index ?? 0);
  }
  for (const m of text.matchAll(BETWEEN_RE)) {
    push(m[1] ?? "", "between", m.index ?? 0);
    push(m[2] ?? "", "between", (m.index ?? 0) + (m[1]?.length ?? 0));
  }
  return dedupeByIndex(found);
}

/**
 * Candidate keys for a reference so the same transaction id matches across
 * formats. The same identifier is written "Transaction ID: TXN-88421907" in a
 * receipt and "TXN-88421907" in a CSV row, so a single normalisation is not
 * enough: the engine produces the value with and without its leading label and
 * matches when any candidate is shared.
 *
 * A candidate must be specific: it needs a letter, or at least six digits. That
 * keeps a bare "4242" (a card's last four) from being treated as an identifier.
 */
export function referenceKeys(reference: DetectedReference): string[] {
  const raw = reference.value.trim();
  const colon = raw.indexOf(":");
  const value = colon >= 0 ? raw.slice(colon + 1).trim() : raw;

  const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = new Set<string>();
  const consider = (text: string) => {
    const key = compact(text);
    if (key.length < 5) return;
    // An identifier carries a digit. A pure word - "contract", "agreement",
    // "policy" - is the label of an identifier, not the identifier itself, and
    // two unrelated documents both say "contract". Matching on it would link
    // them for no reason, so require at least one digit.
    if (!/\d/.test(key)) return;
    // A bare number must be long enough to be an identifier rather than a card's
    // last four digits or a short amount.
    if (/^\d+$/.test(key) && key.length < 6) return;
    candidates.add(key);
  };

  consider(value);
  // The final token, so "Order ID: ABC-123" also matches a bare "ABC-123".
  const tokens = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length > 1) consider(tokens[tokens.length - 1] ?? "");

  return [...candidates];
}

/**
 * The most specific shared key, for display. Two documents share both
 * "txn88421907" and its bare-numeric suffix; a reviewer should see the
 * alphanumeric identifier, not every normalisation of it.
 */
export function mostSpecificKeys(keys: string[]): string[] {
  if (keys.length <= 1) return keys;
  const withLetters = keys.filter((key) => /[a-z]/.test(key));
  return [...new Set(withLetters.length > 0 ? withLetters : keys)];
}

/** The minor-unit key for an amount, so $249.99 and 249.99 USD match. */
export function amountKey(amount: DetectedAmount): string {
  return String(amount.minor);
}

/** A stable key for a party name, tolerating case and punctuation. */
export function partyKey(party: DetectedParty): string {
  return party.text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NEGATIONS = [
  "not", "never", "no", "without", "didn't", "doesn't", "don't", "did not",
  "was not", "were not", "has not", "have not", "cannot", "can't", "refused",
  "denies", "denied", "unauthorised", "unauthorized", "unapproved",
];

/**
 * Whether a statement denies something. Used to compare two assertions about
 * the same subject: one asserting and one denying the same action is a
 * contradiction, whereas two assertions that simply differ are not.
 */
export function hasNegation(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  return NEGATIONS.some((word) => lower.includes(` ${word} `));
}

/** Significant lowercase words, for checking two assertions share a predicate. */
export function significantWords(text: string): Set<string> {
  const stop = new Set([
    "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "for", "was",
    "were", "is", "are", "be", "been", "that", "this", "it", "as", "by", "with",
    "from", "has", "have", "had", "not", "no", "never", "did", "does", "do",
    "customer", "charge", "payment",
  ]);
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z][a-z0-9]{2,}/g)
      ?.filter((word) => !stop.has(word)) ?? [],
  );
}

/** How many significant words two texts share. */
export function sharedWordCount(a: string, b: string): number {
  const wa = significantWords(a);
  const wb = significantWords(b);
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared;
}
