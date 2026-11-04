/**
 * Shared CASEFILE vocabulary. Imported by actions (server) and components
 * (client), so it must stay dependency-free.
 */

export const CASE_STATUSES = ["open", "investigating", "review", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const DISPUTE_CATEGORIES = [
  "uncategorized",
  "payment-dispute",
  "chargeback",
  "unauthorized-transaction",
  "contract-dispute",
  "service-dispute",
  "refund",
  "fraud",
  "other",
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const EVIDENCE_CATEGORIES = [
  "uncategorized",
  "receipt",
  "invoice",
  "bank-statement",
  "contract",
  "correspondence",
  "policy",
  "screenshot",
  "log",
  "identity",
  "other",
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export const EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "complete",
  "unsupported",
  "failed",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * Where a statement came from. This is the field that keeps the app honest:
 * the UI renders each value differently, and nothing is ever shown as an
 * established fact unless a human confirmed it.
 */
export const PROVENANCE = [
  "documented",
  "asserted",
  "inferred",
  "unverified",
] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const REVIEW_STATUSES = ["proposed", "confirmed", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const DATE_PRECISION = [
  "day",
  "month",
  "year",
  "range",
  "unknown",
] as const;
export type DatePrecision = (typeof DATE_PRECISION)[number];

/** Confidence is a word, not a number: a model cannot honestly emit 0.73. */
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/csv",
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024; // 8 MB per file
export const MAX_EVIDENCE_PER_CASE = 100;
export const MAX_BASE64_BYTES = 12 * 1024 * 1024; // encoded payload ceiling

export const HUMAN_LABELS: Record<string, string> = {
  documented: "Documented",
  asserted: "Party assertion",
  inferred: "Agent inference",
  unverified: "Unverified",
  proposed: "Proposed",
  confirmed: "Confirmed",
  rejected: "Rejected",
  pending: "Pending",
  processing: "Processing",
  complete: "Complete",
  unsupported: "Not extractable",
  failed: "Failed",
  open: "Open",
  investigating: "Investigating",
  review: "In review",
  closed: "Closed",
};

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return HUMAN_LABELS[value] ?? value.replace(/-/g, " ");
}
