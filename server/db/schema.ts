import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * CASEFILE domain schema.
 *
 * Every user-facing table carries `owner_email` so every query can be scoped to
 * the authenticated user at the SQL level. Nothing here stores file bytes: an
 * evidence row points at a blob in the private evidence store, and the store is
 * read only through an authorized action.
 *
 * Ids are `case_`/`ev_`/`psg_`-prefixed opaque strings, generated in
 * `shared/casefile/ids.ts`. They are never sequential, so an id leaks nothing
 * about volume or ordering.
 */

export const cases = pgTable(
  "casefile_cases",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    // The kind of dispute under investigation (payment, chargeback, contract…).
    category: text("category").notNull().default("uncategorized"),
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    status: text("status").notNull().default("open"),
    // Monotonic counter bumped on every case-level change, so the UI can show
    // progress without recomputing it from the child tables.
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_cases_owner_idx").on(table.ownerEmail, table.updatedAt),
  ],
);

export const evidence = pgTable(
  "casefile_evidence",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    filename: text("filename").notNull(),
    // Server-detected MIME type, never the client-supplied one.
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    // SHA-256 of the raw bytes. Two rows with the same digest in one case are
    // the same document; the upload path reports the duplicate instead of
    // storing it twice.
    sha256: text("sha256").notNull(),
    // Where the bytes live. "db" keeps them in casefile_evidence_blobs (dev,
    // no external service); other values are handled by another store
    // implementation. The store is resolved in server/casefile/evidence-store.ts.
    storageProvider: text("storage_provider").notNull().default("db"),
    storageKey: text("storage_key").notNull(),
    // User-facing classification: what this document is in the case.
    category: text("category").notNull().default("uncategorized"),
    // Extraction lifecycle: pending | processing | complete | unsupported | failed.
    extractionStatus: text("extraction_status").notNull().default("pending"),
    extractionError: text("extraction_error"),
    extractedAt: text("extracted_at"),
    pageCount: integer("page_count"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_evidence_case_idx").on(table.caseId),
    index("casefile_evidence_owner_idx").on(table.ownerEmail),
    index("casefile_evidence_digest_idx").on(table.caseId, table.sha256),
  ],
);

/**
 * Evidence bytes. Kept in a separate table from `evidence` so metadata queries
 * never pull megabytes, and so a hosted deployment can move bytes to object
 * storage by pointing `storageProvider` elsewhere without touching this table.
 */
export const evidenceBlobs = pgTable("casefile_evidence_blobs", {
  storageKey: text("storage_key").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  caseId: text("case_id").notNull(),
  mimeType: text("mime_type").notNull(),
  data: text("data").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

/**
 * Extracted passages. Each row is one locatable unit of text (a PDF page, a CSV
 * row, a text chunk) that an extraction or analysis result can cite. `ref` is
 * the human-readable location ("page 3", "row 12") and `locator` the machine
 * one, so a citation always resolves back to a real position in the file.
 */
export const evidencePassages = pgTable(
  "casefile_evidence_passages",
  {
    id: text("id").primaryKey(),
    evidenceId: text("evidence_id").notNull(),
    caseId: text("case_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    ordinal: integer("ordinal").notNull(),
    // page | row | chunk | document
    locatorType: text("locator_type").notNull(),
    // Page number, row number, or chunk index. Null for a whole-document unit.
    locatorValue: integer("locator_value"),
    ref: text("ref").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_passages_evidence_idx").on(table.evidenceId, table.ordinal),
    index("casefile_passages_case_idx").on(table.caseId),
  ],
);

/**
 * Claims and events the agent proposes. Both live in one table because they
 * share the citation and verification machinery; `kind` separates them.
 *
 * Provenance is explicit and load-bearing:
 *   documented  - read directly from a document's own text
 *   asserted    - a party's statement, reported as a statement
 *   inferred    - the agent's own reasoning over evidence
 *   unverified  - no supporting evidence attached
 *
 * A row is only ever `confirmed` after a human accepts it. The agent can
 * propose, never confirm.
 */
export const findings = pgTable(
  "casefile_findings",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    // claim | event
    kind: text("kind").notNull(),
    statement: text("statement").notNull(),
    provenance: text("provenance").notNull().default("unverified"),
    // proposed | confirmed | rejected
    reviewStatus: text("review_status").notNull().default("proposed"),
    // Event-only fields. `eventDate` is the resolved ISO date, `eventDateText`
    // the date exactly as the evidence wrote it. Keeping both means a
    // conflicting or partial date survives review instead of being normalised
    // into a wrong timestamp.
    eventDate: text("event_date"),
    eventDateText: text("event_date_text"),
    datePrecision: text("date_precision"),
    dateConflict: boolean("date_conflict").notNull().default(false),
    confidence: text("confidence"),
    uncertainty: text("uncertainty"),
    // documented | asserted | inferred | unverified - how the row was produced.
    extractionMethod: text("extraction_method"),
    // Set when a human edits the row, so the UI can show what changed and the
    // agent reads the corrected value.
    correctedBy: text("corrected_by"),
    correctedAt: text("corrected_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_findings_case_idx").on(table.caseId, table.kind),
    index("casefile_findings_owner_idx").on(table.ownerEmail),
  ],
);

/**
 * Citations. A finding with no citation row is unsupported, which the UI shows
 * rather than hides. `quote` is the exact excerpt relied on, so a reviewer can
 * check the citation without opening the file.
 */
export const findingCitations = pgTable(
  "casefile_finding_citations",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    passageId: text("passage_id"),
    caseId: text("case_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    quote: text("quote"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_citations_finding_idx").on(table.findingId),
    index("casefile_citations_evidence_idx").on(table.evidenceId),
  ],
);

/**
 * Append-only record of every write. Answers "who changed this, when, and from
 * where" without storing document contents. Agent-driven changes carry the run
 * id so a reviewer can trace a change back to the turn that made it.
 */
export const auditLog = pgTable(
  "casefile_audit_log",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id"),
    ownerEmail: text("owner_email").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    // Short, non-sensitive summary. Never document text or credentials.
    summary: text("summary"),
    caller: text("caller"),
    runId: text("run_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index("casefile_audit_case_idx").on(table.caseId, table.createdAt)],
);

/**
 * Cross-document relationships (Mission 3).
 *
 * An edge connects two nodes in the same case, each named by `type` + `id`:
 *   evidence | passage | finding
 *
 * Two properties keep this honest:
 *
 *  - `basis` records whether the edge is `direct` (the two sides literally share
 *    an explicit identifier) or `inferred` (the engine joined them through a
 *    normalised value). An inferred edge is weaker and is shown as such.
 *  - `matchKey` is the exact identifier or value the engine matched on, so a
 *    reviewer can see why two documents were linked instead of trusting a score.
 *
 * `sourcePassageId` is the passage the edge was derived from, so every
 * relationship can be navigated back to a real position in a real file. A
 * relationship is never created from word overlap alone.
 */
export const relationships = pgTable(
  "casefile_relationships",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    // RelationshipType, e.g. same_identifier | contradicts | corroborates.
    relationType: text("relation_type").notNull(),
    // direct | inferred
    basis: text("basis").notNull().default("direct"),
    // The identifier, amount, date, or name the two sides share.
    matchKey: text("match_key"),
    // The passage the relationship was derived from, for navigation.
    sourcePassageId: text("source_passage_id"),
    // Short, non-sensitive explanation of why the two sides are related.
    rationale: text("rationale").notNull().default(""),
    // high | medium | low, only when meaningful (an inferred edge).
    confidence: text("confidence"),
    // proposed | confirmed | rejected - a human can confirm or dismiss an edge.
    reviewStatus: text("review_status").notNull().default("proposed"),
    // engine (deterministic) | agent (model-proposed) - how the edge was made.
    createdBy: text("created_by").notNull().default("engine"),
    correctedBy: text("corrected_by"),
    correctedAt: text("corrected_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index("casefile_relationships_case_idx").on(table.caseId, table.relationType),
    index("casefile_relationships_from_idx").on(table.fromType, table.fromId),
    index("casefile_relationships_to_idx").on(table.toType, table.toId),
    index("casefile_relationships_owner_idx").on(table.ownerEmail),
  ],
);
