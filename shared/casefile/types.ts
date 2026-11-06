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
 * What a document is, decided from its own text and its filename, and always
 * correctable by a person.
 *
 * These are the categories a mixed investigation actually contains. They are
 * deliberately about the *document*, not the case: the same engine classifies a
 * court bundle, a payment dispute, and a research folder with no per-industry
 * code path. `unknown` is a first-class answer - a document the classifier
 * cannot place is reported as unknown rather than forced into the nearest
 * category.
 */
export const DOCUMENT_TYPES = [
  "court-judgment",
  "pleading",
  "affidavit",
  "witness-statement",
  "court-order",
  "contract",
  "invoice",
  "receipt",
  "bank-statement",
  "payment-confirmation",
  "correspondence",
  "email",
  "medical-report",
  "lab-report",
  "insurance-document",
  "research-paper",
  "business-report",
  "general-document",
  "unknown",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** How sure the classifier is. A word, not a number: 0.73 would be a fiction. */
export const CLASSIFICATION_CONFIDENCE = ["high", "medium", "low"] as const;
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCE)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  "court-judgment": "Court judgment",
  pleading: "Pleading or court filing",
  affidavit: "Affidavit",
  "witness-statement": "Witness statement",
  "court-order": "Court order",
  contract: "Contract or agreement",
  invoice: "Invoice",
  receipt: "Receipt",
  "bank-statement": "Bank statement",
  "payment-confirmation": "Payment confirmation",
  correspondence: "Correspondence",
  email: "Email or message",
  "medical-report": "Medical report",
  "lab-report": "Laboratory report",
  "insurance-document": "Insurance document",
  "research-paper": "Research paper",
  "business-report": "Business report",
  "general-document": "General document",
  unknown: "Unknown or mixed",
};

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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/markdown",
  "text/csv",
  "message/rfc822",
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

/**
 * A short label for each supported type, used in user-facing messages so a
 * rejection names the formats a person recognises (PDF, Word, Excel) rather
 * than MIME strings.
 */
export const SUPPORTED_FORMAT_LABELS: Record<SupportedMimeType, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "text/plain": "text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "message/rfc822": "email (.eml)",
};

/**
 * Cross-document relationship vocabulary (Mission 3).
 *
 * A relationship is an edge between two things that already exist in the case:
 * two passages, a passage and a finding, two findings. It is never invented
 * because two documents share a word; the engine requires a shared explicit
 * identifier (a transaction reference, an amount, a normalised date, a name)
 * before it will draw an edge, and it records the identifier it matched on.
 */
export const RELATIONSHIP_TYPES = [
  "same_identifier", // two passages carry the same transaction/order/invoice reference
  "same_amount", // two passages state the same monetary amount
  "same_date", // two passages carry the same normalised date
  "same_party", // two passages name the same person or organisation
  "corroborates", // one finding is supported by a passage from a second document
  "contradicts", // two findings make incompatible assertions about the same subject
  "potential_contradiction", // same subject, but the difference may be explainable
  "addresses_gap", // a passage supplies evidence a finding was missing
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * How an edge was established. `direct` means the two sides literally share an
 * explicit identifier. `inferred` means the engine joined them through a
 * normalised value (a date, an amount) and the edge is therefore weaker.
 */
export const RELATIONSHIP_BASIS = ["direct", "inferred"] as const;
export type RelationshipBasis = (typeof RELATIONSHIP_BASIS)[number];

export const RELATIONSHIP_NODE_TYPES = ["evidence", "passage", "finding"] as const;
export type RelationshipNodeType = (typeof RELATIONSHIP_NODE_TYPES)[number];

/**
 * How two assertions compare. This is the vocabulary that stops "different" from
 * meaning "contradictory": a difference of amount, date, or wording is reported
 * with its own verdict, and only incompatible assertions about the same subject
 * are called a contradiction.
 */
export const COMPARISON_VERDICTS = [
  "direct_agreement",
  "partial_agreement",
  "contradiction",
  "potential_contradiction",
  "unrelated",
  "insufficient_information",
] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

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
  // Relationship types
  same_identifier: "Same identifier",
  same_amount: "Same amount",
  same_date: "Same date",
  same_party: "Same party",
  corroborates: "Corroborates",
  contradicts: "Contradicts",
  potential_contradiction: "Possible contradiction",
  addresses_gap: "Fills a gap",
  // Relationship basis
  direct: "Direct",
  // Comparison verdicts
  direct_agreement: "Direct agreement",
  partial_agreement: "Partial agreement",
  contradiction: "Contradiction",
  unrelated: "Unrelated",
  insufficient_information: "Insufficient information",
};

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return HUMAN_LABELS[value] ?? value.replace(/-/g, " ");
}
