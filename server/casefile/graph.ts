import { and, asc, eq } from "drizzle-orm";

import type {
  ComparisonVerdict,
  RelationshipBasis,
  RelationshipType,
} from "../../shared/casefile/types.js";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { newRelationshipId } from "./ids.js";
import {
  amountKey,
  detectAmounts,
  detectDates,
  detectParties,
  detectReferences,
  mostSpecificKeys,
  partyKey,
  referenceKeys,
} from "./entities.js";
import {
  buildFindingSubject,
  compareFindings,
  type Comparison,
  type FindingSubject,
} from "./comparison.js";

/**
 * Cross-document evidence graph.
 *
 * This is what makes CASEFILE more than a set of document summaries: it links
 * passages that share an explicit identifier, amount, party, or date, and it
 * compares the assertions those passages support. Two design rules hold:
 *
 *  - Relationships are derived only from identifiers the documents literally
 *    contain. Two files that merely share words are not linked, because a graph
 *    built on word overlap is a graph of coincidences.
 *  - Every edge records what it matched on (`matchKey`), how strong it is
 *    (`basis`), and the passage it came from, so a reviewer can re-derive it.
 *
 * Building is idempotent and preserves human review: re-running replaces the
 * engine's untouched proposals and leaves anything a person confirmed or
 * rejected exactly as it was.
 */

/** Passages beyond this are not indexed, so a huge case cannot stall the build. */
const MAX_PASSAGES = 2000;
/** Most edges one shared key may produce, so one common value cannot fan out. */
const MAX_PAIRS_PER_KEY = 50;

export interface RelationshipRecord {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relationType: RelationshipType;
  basis: RelationshipBasis;
  matchKey: string | null;
  sourcePassageId: string | null;
  rationale: string;
  confidence: string | null;
  reviewStatus: string;
  createdBy: string;
  correctedBy: string | null;
}

export interface ComparisonRecord {
  aId: string;
  bId: string;
  aKind: string;
  bKind: string;
  aStatement: string;
  bStatement: string;
  verdict: ComparisonVerdict;
  reason: string;
  sharedRefs: string[];
  sharedAmounts: string[];
  sharedParties: string[];
  conflictingDates: Comparison["conflictingDates"];
  conflictingAmounts: Comparison["conflictingAmounts"];
  polarityDiffers: boolean;
  aCitations: Array<{ evidenceId: string; passageId: string | null; ref: string; quote: string | null }>;
  bCitations: Array<{ evidenceId: string; passageId: string | null; ref: string; quote: string | null }>;
}

export type GapKind =
  | "unsupported_claim"
  | "amount_without_transaction"
  | "conflicting_dates"
  | "undated_event"
  | "single_source_claim"
  | "obligation_without_performance";

export interface GapRecord {
  id: string;
  kind: GapKind;
  /** What is missing from the record. */
  missing: string;
  /** The claim or event this gap affects, if any. */
  affectsFindingId: string | null;
  affectsStatement: string | null;
  /** Why the missing information matters to the investigation. */
  whyItMatters: string;
  /** The kind of evidence that would resolve it. */
  whatWouldHelp: string;
  /** Passages or documents relevant to the gap, for navigation. */
  relatedEvidenceIds: string[];
}

export interface CaseGraph {
  caseId: string;
  relationships: RelationshipRecord[];
  comparisons: ComparisonRecord[];
  gaps: GapRecord[];
  counts: {
    passages: number;
    documents: number;
    relationships: number;
    contradictions: number;
    potentialContradictions: number;
    agreements: number;
    gaps: number;
  };
}

interface IndexedPassage {
  id: string;
  evidenceId: string;
  filename: string;
  ref: string;
  text: string;
}

/**
 * Groups passages by a key derived from their text. Only passages whose key is
 * non-null are indexed, so a passage with no identifier simply does not appear.
 */
function indexBy<T>(
  passages: IndexedPassage[],
  keyOf: (passage: IndexedPassage) => T[],
): Map<string, IndexedPassage[]> {
  const index = new Map<string, IndexedPassage[]>();
  for (const passage of passages) {
    for (const key of keyOf(passage)) {
      const list = index.get(String(key)) ?? [];
      list.push(passage);
      index.set(String(key), list);
    }
  }
  return index;
}

async function loadIndexedPassages(
  caseId: string,
  userEmail: string,
): Promise<IndexedPassage[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.evidencePassages.id,
      evidenceId: schema.evidencePassages.evidenceId,
      ref: schema.evidencePassages.ref,
      text: schema.evidencePassages.text,
      filename: schema.evidence.filename,
    })
    .from(schema.evidencePassages)
    .innerJoin(schema.evidence, eq(schema.evidence.id, schema.evidencePassages.evidenceId))
    .where(
      and(
        eq(schema.evidencePassages.caseId, caseId),
        eq(schema.evidencePassages.ownerEmail, userEmail),
      ),
    )
    .orderBy(asc(schema.evidencePassages.evidenceId), asc(schema.evidencePassages.ordinal))
    .limit(MAX_PASSAGES);
  return rows;
}

interface CandidateEdge {
  fromPassage: IndexedPassage;
  toPassage: IndexedPassage;
  relationType: RelationshipType;
  basis: RelationshipBasis;
  matchKey: string;
  rationale: string;
  confidence: string | null;
}

/**
 * Derives candidate edges between passages in different documents. A pair is
 * only considered when it shares a key, so the work is proportional to the
 * number of shared identifiers, not to the square of the document count.
 */
function candidatePassageEdges(passages: IndexedPassage[]): CandidateEdge[] {
  const edges: CandidateEdge[] = [];
  const seen = new Set<string>();
  // One edge per passage pair per relation type. Two documents can share several
  // normalisations of the same identifier (with and without its label), but a
  // reviewer should see one relationship, not one per spelling, so the first
  // match key encountered wins and later ones are dropped.
  const pairSeen = new Set<string>();

  const add = (
    group: IndexedPassage[],
    relationType: RelationshipType,
    basis: RelationshipBasis,
    matchKey: string,
    describe: (key: string) => string,
    confidence: string | null,
    compatible?: (a: IndexedPassage, b: IndexedPassage) => boolean,
  ) => {
    let pairs = 0;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        // Cross-document only: the whole point is connecting documents, and a
        // within-document repeat is not a cross-document relationship.
        if (a.evidenceId === b.evidenceId) continue;
        if (compatible && !compatible(a, b)) continue;
        if (pairs >= MAX_PAIRS_PER_KEY) return;
        pairs += 1;
        const pairKey = `${a.id}|${b.id}|${relationType}`;
        if (pairSeen.has(pairKey)) continue;
        const edgeKey = `${a.id}|${b.id}|${relationType}|${matchKey}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        pairSeen.add(pairKey);
        edges.push({
          fromPassage: a,
          toPassage: b,
          relationType,
          basis,
          matchKey,
          rationale: describe(matchKey),
          confidence,
        });
      }
    }
  };

  // One key per passage: the most specific identifier it carries. Indexing
  // every normalisation would make a pair match on whichever key happened to be
  // seen first, and passage rows come back in random-id order, so the recorded
  // matchKey would vary between runs. Choosing the most specific key up front
  // makes the relationship, and the explanation printed for it, deterministic.
  for (const [key, group] of indexBy(passages, (p) =>
    mostSpecificKeys(detectReferences(p.text).flatMap((r) => referenceKeys(r))),
  )) {
    add(
      group,
      "same_identifier",
      "direct",
      key,
      (k) => `Both passages carry the same reference "${k}".`,
      "high",
    );
  }

  for (const [key, group] of indexBy(passages, (p) =>
    detectAmounts(p.text).map((a) => amountKey(a)),
  )) {
    add(
      group,
      "same_amount",
      "inferred",
      key,
      (k) => `Both passages state the same amount (${(Number(k) / 100).toFixed(2)}).`,
      "medium",
      // Two amounts only match when their currencies do not disagree. A stated
      // USD amount and a stated EUR amount are not the same amount, even at the
      // same numeric value; an unlabelled amount is allowed through.
      (a, b) => {
        const currencies = (p: IndexedPassage) =>
          new Set(detectAmounts(p.text).map((amount) => amount.currency).filter(Boolean));
        const ca = currencies(a);
        const cb = currencies(b);
        if (ca.size === 0 || cb.size === 0) return true;
        return [...ca].some((currency) => cb.has(currency));
      },
    );
  }

  for (const [key, group] of indexBy(passages, (p) =>
    detectParties(p.text).map((party) => partyKey(party)),
  )) {
    add(
      group,
      "same_party",
      "inferred",
      key,
      () => `Both passages name the same party "${key}".`,
      "medium",
    );
  }

  for (const [key, group] of indexBy(passages, (p) =>
    detectDates(p.text)
      .filter((d) => d.precision === "day" && d.iso)
      .map((d) => d.iso as string),
  )) {
    add(
      group,
      "same_date",
      "inferred",
      key,
      (k) => `Both passages carry the same date ${k}.`,
      "low",
    );
  }

  return edges;
}

/** Loads findings with the exact text of each cited passage. */
async function loadFindingsWithCitations(
  caseId: string,
  userEmail: string,
): Promise<
  Array<{
    id: string;
    kind: "claim" | "event";
    statement: string;
    eventDate: string | null;
    dateConflict: boolean;
    reviewStatus: string;
    citations: Array<{ evidenceId: string; passageId: string | null; ref: string; quote: string | null; text: string }>;
  }>
> {
  const db = getDb();
  const findings = await db
    .select()
    .from(schema.findings)
    .where(
      and(eq(schema.findings.caseId, caseId), eq(schema.findings.ownerEmail, userEmail)),
    )
    .orderBy(asc(schema.findings.createdAt));

  if (findings.length === 0) return [];

  const citationRows = await db
    .select({
      findingId: schema.findingCitations.findingId,
      evidenceId: schema.findingCitations.evidenceId,
      passageId: schema.findingCitations.passageId,
      quote: schema.findingCitations.quote,
      ref: schema.evidencePassages.ref,
      text: schema.evidencePassages.text,
    })
    .from(schema.findingCitations)
    .leftJoin(
      schema.evidencePassages,
      eq(schema.evidencePassages.id, schema.findingCitations.passageId),
    )
    .where(eq(schema.findingCitations.caseId, caseId));

  const byFinding = new Map<string, typeof citationRows>();
  for (const row of citationRows) {
    const list = byFinding.get(row.findingId) ?? [];
    list.push(row);
    byFinding.set(row.findingId, list);
  }

  return findings.map((finding) => ({
    id: finding.id,
    kind: finding.kind as "claim" | "event",
    statement: finding.statement,
    eventDate: finding.eventDate,
    dateConflict: finding.dateConflict,
    reviewStatus: finding.reviewStatus,
    citations: (byFinding.get(finding.id) ?? []).map((row) => ({
      evidenceId: row.evidenceId,
      passageId: row.passageId,
      ref: row.ref ?? "an untraceable position",
      quote: row.quote,
      text: row.text ?? "",
    })),
  }));
}

/**
 * Compares every pair of findings. The pairwise set is bounded because a case
 * holds tens of findings, not thousands; the comparison itself is cheap and
 * pure.
 */
export function compareAllFindings(
  subjects: FindingSubject[],
  citationsById: Map<
    string,
    Array<{ evidenceId: string; passageId: string | null; ref: string; quote: string | null }>
  >,
): ComparisonRecord[] {
  const records: ComparisonRecord[] = [];
  for (let i = 0; i < subjects.length; i += 1) {
    for (let j = i + 1; j < subjects.length; j += 1) {
      const a = subjects[i]!;
      const b = subjects[j]!;
      const comparison = compareFindings(a, b);
      if (comparison.verdict === "unrelated") continue;
      records.push({
        aId: a.id,
        bId: b.id,
        aKind: a.kind,
        bKind: b.kind,
        aStatement: a.statement,
        bStatement: b.statement,
        verdict: comparison.verdict,
        reason: comparison.reason,
        sharedRefs: comparison.sharedRefs,
        sharedAmounts: comparison.sharedAmounts,
        sharedParties: comparison.sharedParties,
        conflictingDates: comparison.conflictingDates,
        conflictingAmounts: comparison.conflictingAmounts,
        polarityDiffers: comparison.polarityDiffers,
        aCitations: citationsById.get(a.id) ?? [],
        bCitations: citationsById.get(b.id) ?? [],
      });
    }
  }
  // Contradictions first: the thing a reviewer most needs to see.
  const order: ComparisonVerdict[] = [
    "contradiction",
    "potential_contradiction",
    "direct_agreement",
    "partial_agreement",
    "insufficient_information",
  ];
  records.sort((x, y) => order.indexOf(x.verdict) - order.indexOf(y.verdict));
  return records;
}

const OBLIGATION_RE = /\b(shall|must|agrees? to|is required to|undertakes? to|will deliver|will pay)\b/i;
const PERFORMANCE_RE = /\b(delivered|received|paid|completed|fulfilled|shipped|confirmed|performed|signed|settled|refunded)\b/i;

/**
 * Evidence-gap analysis. Every gap names what is missing, why it matters, and
 * what would resolve it, and it is never treated as proof that something did
 * not happen.
 */
export function findEvidenceGaps(input: {
  findings: Array<{
    id: string;
    kind: "claim" | "event";
    statement: string;
    eventDate: string | null;
    dateConflict: boolean;
    citations: Array<{ evidenceId: string; text: string }>;
  }>;
  passages: IndexedPassage[];
  comparisons: ComparisonRecord[];
}): GapRecord[] {
  const gaps: GapRecord[] = [];
  let counter = 0;
  const nextId = () => `gap_${(counter += 1)}`;

  const corroborated = new Map<string, number>();
  for (const comparison of input.comparisons) {
    if (comparison.verdict === "direct_agreement" || comparison.verdict === "partial_agreement") {
      corroborated.set(comparison.aId, (corroborated.get(comparison.aId) ?? 0) + 1);
      corroborated.set(comparison.bId, (corroborated.get(comparison.bId) ?? 0) + 1);
    }
  }

  for (const finding of input.findings) {
    const evidenceIds = [...new Set(finding.citations.map((c) => c.evidenceId))];
    const citedText = finding.citations.map((c) => c.text).join("\n");

    if (finding.citations.length === 0) {
      gaps.push({
        id: nextId(),
        kind: "unsupported_claim",
        missing: "Any source passage for this assertion.",
        affectsFindingId: finding.id,
        affectsStatement: finding.statement,
        whyItMatters:
          "An assertion with no cited source cannot be checked, so it cannot support a conclusion.",
        whatWouldHelp:
          "A document that states or records this directly, attached as evidence and cited.",
        relatedEvidenceIds: [],
      });
      // Fall through: an unsourced event still needs its missing date reported,
      // and an unsourced claim still needs its missing corroboration reported.
    }

    if (finding.kind === "claim") {
      const hasAmount = detectAmounts(citedText).length > 0;
      const hasReference = detectReferences(citedText).length > 0;
      if (hasAmount && !hasReference) {
        gaps.push({
          id: nextId(),
          kind: "amount_without_transaction",
          missing: "A transaction record matching the asserted amount.",
          affectsFindingId: finding.id,
          affectsStatement: finding.statement,
          whyItMatters:
            "An amount is asserted but no document records the matching transaction, so the payment itself is not evidenced.",
          whatWouldHelp:
            "A bank statement, receipt, or payment confirmation showing the transaction and its reference.",
          relatedEvidenceIds: evidenceIds,
        });
      }
      if (evidenceIds.length === 1 && (corroborated.get(finding.id) ?? 0) === 0) {
        gaps.push({
          id: nextId(),
          kind: "single_source_claim",
          missing: "A second, independent source for this assertion.",
          affectsFindingId: finding.id,
          affectsStatement: finding.statement,
          whyItMatters:
            "This assertion rests on a single document, so it is uncorroborated and turns entirely on that one source.",
          whatWouldHelp:
            "Any independent document that records the same fact.",
          relatedEvidenceIds: evidenceIds,
        });
      }
    }

    if (finding.kind === "event") {
      if (finding.dateConflict) {
        gaps.push({
          id: nextId(),
          kind: "conflicting_dates",
          missing: "A single agreed date for this event.",
          affectsFindingId: finding.id,
          affectsStatement: finding.statement,
          whyItMatters:
            "The sources give different dates for the same event, so its position in the timeline cannot be fixed without deciding which is right.",
          whatWouldHelp:
            "A document that states the date unambiguously, or a person's decision on which source to trust.",
          relatedEvidenceIds: evidenceIds,
        });
      }
      if (!finding.eventDate) {
        gaps.push({
          id: nextId(),
          kind: "undated_event",
          missing: "A date for this event.",
          affectsFindingId: finding.id,
          affectsStatement: finding.statement,
          whyItMatters:
            "Without a date the event cannot be placed on the timeline or compared to others.",
          whatWouldHelp:
            "A document that dates the event, or metadata that fixes when it occurred.",
          relatedEvidenceIds: evidenceIds,
        });
      }
    }
  }

  // Contractual obligations with no evidence of performance.
  const hasPerformance = input.passages.some((passage) => PERFORMANCE_RE.test(passage.text));
  if (!hasPerformance) {
    const obligation = input.passages.find((passage) => OBLIGATION_RE.test(passage.text));
    if (obligation) {
      gaps.push({
        id: nextId(),
        kind: "obligation_without_performance",
        missing: "Evidence that a stated obligation was performed.",
        affectsFindingId: null,
        affectsStatement: obligation.text.slice(0, 200),
        whyItMatters:
          "A document states an obligation but no document records its performance, so whether it was met is not established.",
        whatWouldHelp:
          "A delivery note, payment record, or confirmation that shows the obligation was carried out.",
        relatedEvidenceIds: [obligation.evidenceId],
      });
    }
  }

  return gaps;
}

/**
 * Builds the full cross-document graph for a case and persists the
 * relationships. Comparisons and gaps are derived deterministically from the
 * stored record, so they are recomputed on read rather than cached.
 */
export async function buildCaseGraph(
  caseId: string,
  userEmail: string,
  options?: { persist?: boolean },
): Promise<CaseGraph> {
  const persist = options?.persist ?? true;
  const db = getDb();

  const passages = await loadIndexedPassages(caseId, userEmail);
  const passageEdges = candidatePassageEdges(passages);

  const findings = await loadFindingsWithCitations(caseId, userEmail);
  const citationsById = new Map<
    string,
    Array<{ evidenceId: string; passageId: string | null; ref: string; quote: string | null }>
  >();
  const subjects: FindingSubject[] = [];
  for (const finding of findings) {
    subjects.push(
      buildFindingSubject({
        id: finding.id,
        kind: finding.kind,
        statement: finding.statement,
        eventDate: finding.eventDate,
        citations: finding.citations.map((c) => ({ evidenceId: c.evidenceId, text: c.text })),
      }),
    );
    citationsById.set(
      finding.id,
      finding.citations.map((c) => ({
        evidenceId: c.evidenceId,
        passageId: c.passageId,
        ref: c.ref,
        quote: c.quote,
      })),
    );
  }

  const comparisons = compareAllFindings(subjects, citationsById);

  const gaps = findEvidenceGaps({
    findings: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      statement: finding.statement,
      eventDate: finding.eventDate,
      dateConflict: finding.dateConflict,
      citations: finding.citations.map((c) => ({ evidenceId: c.evidenceId, text: c.text })),
    })),
    passages,
    comparisons,
  });

  // Relationship rows: passage-to-passage edges plus finding-to-finding edges
  // derived from the comparisons.
  const relationshipRows: Array<Omit<RelationshipRecord, "id" | "reviewStatus" | "correctedBy">> = [];
  for (const edge of passageEdges) {
    relationshipRows.push({
      fromType: "passage",
      fromId: edge.fromPassage.id,
      toType: "passage",
      toId: edge.toPassage.id,
      relationType: edge.relationType,
      basis: edge.basis,
      matchKey: edge.matchKey,
      sourcePassageId: edge.fromPassage.id,
      rationale: edge.rationale,
      confidence: edge.confidence,
      createdBy: "engine",
    });
  }
  for (const comparison of comparisons) {
    let relationType: RelationshipType | null = null;
    if (comparison.verdict === "contradiction") relationType = "contradicts";
    else if (comparison.verdict === "potential_contradiction")
      relationType = "potential_contradiction";
    else if (
      comparison.verdict === "direct_agreement" ||
      comparison.verdict === "partial_agreement"
    )
      relationType = "corroborates";
    if (!relationType) continue;
    relationshipRows.push({
      fromType: "finding",
      fromId: comparison.aId,
      toType: "finding",
      toId: comparison.bId,
      relationType,
      basis: comparison.verdict === "direct_agreement" ? "direct" : "inferred",
      matchKey:
        comparison.sharedRefs[0] ??
        comparison.sharedAmounts[0] ??
        comparison.sharedParties[0] ??
        null,
      sourcePassageId: comparison.aCitations[0]?.passageId ?? null,
      rationale: comparison.reason,
      confidence: comparison.verdict === "contradiction" ? "high" : "medium",
      createdBy: "engine",
    });
  }

  let stored: RelationshipRecord[] = [];
  if (persist) {
    stored = await persistRelationships(caseId, userEmail, relationshipRows);
  } else {
    stored = relationshipRows.map((row) => ({
      ...row,
      id: "transient",
      reviewStatus: "proposed",
      correctedBy: null,
    }));
  }

  return {
    caseId,
    relationships: stored,
    comparisons,
    gaps,
    counts: {
      passages: passages.length,
      documents: new Set(passages.map((p) => p.evidenceId)).size,
      relationships: stored.length,
      contradictions: comparisons.filter((c) => c.verdict === "contradiction").length,
      potentialContradictions: comparisons.filter(
        (c) => c.verdict === "potential_contradiction",
      ).length,
      agreements: comparisons.filter(
        (c) => c.verdict === "direct_agreement" || c.verdict === "partial_agreement",
      ).length,
      gaps: gaps.length,
    },
  };
}

/**
 * Writes the engine's relationships, preserving anything a human has reviewed.
 *
 * The engine owns only rows it created and no one has touched. A row a person
 * confirmed or rejected stays, and the engine will not recreate an edge with the
 * same endpoints and type, so a dismissed relationship does not come back on the
 * next build.
 */
async function persistRelationships(
  caseId: string,
  userEmail: string,
  rows: Array<Omit<RelationshipRecord, "id" | "reviewStatus" | "correctedBy">>,
): Promise<RelationshipRecord[]> {
  const db = getDb();

  const existing = await db
    .select()
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.caseId, caseId),
        eq(schema.relationships.ownerEmail, userEmail),
      ),
    );

  const reviewedKeys = new Set(
    existing
      .filter((row) => row.reviewStatus !== "proposed")
      .map((row) => `${row.fromId}|${row.toId}|${row.relationType}`),
  );

  // Remove the engine's untouched proposals; keep reviewed rows and agent rows.
  for (const row of existing) {
    if (row.createdBy === "engine" && row.reviewStatus === "proposed") {
      await db
        .delete(schema.relationships)
        .where(
          and(
            eq(schema.relationships.id, row.id),
            eq(schema.relationships.ownerEmail, userEmail),
          ),
        );
    }
  }

  for (const row of rows) {
    const key = `${row.fromId}|${row.toId}|${row.relationType}`;
    if (reviewedKeys.has(key)) continue;
    await db.insert(schema.relationships).values({
      id: newRelationshipId(),
      caseId,
      ownerEmail: userEmail,
      fromType: row.fromType,
      fromId: row.fromId,
      toType: row.toType,
      toId: row.toId,
      relationType: row.relationType,
      basis: row.basis,
      matchKey: row.matchKey,
      sourcePassageId: row.sourcePassageId,
      rationale: row.rationale,
      confidence: row.confidence,
      reviewStatus: "proposed",
      createdBy: row.createdBy,
    });
  }

  const after = await db
    .select()
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.caseId, caseId),
        eq(schema.relationships.ownerEmail, userEmail),
      ),
    );

  return after.map((row) => ({
    id: row.id,
    fromType: row.fromType,
    fromId: row.fromId,
    toType: row.toType,
    toId: row.toId,
    relationType: row.relationType as RelationshipType,
    basis: row.basis as RelationshipBasis,
    matchKey: row.matchKey,
    sourcePassageId: row.sourcePassageId,
    rationale: row.rationale,
    confidence: row.confidence,
    reviewStatus: row.reviewStatus,
    createdBy: row.createdBy,
    correctedBy: row.correctedBy,
  }));
}

/** Reads the stored relationships for a case without rebuilding them. */
export async function readRelationships(
  caseId: string,
  userEmail: string,
): Promise<RelationshipRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.caseId, caseId),
        eq(schema.relationships.ownerEmail, userEmail),
      ),
    )
    .orderBy(asc(schema.relationships.createdAt));
  return rows.map((row) => ({
    id: row.id,
    fromType: row.fromType,
    fromId: row.fromId,
    toType: row.toType,
    toId: row.toId,
    relationType: row.relationType as RelationshipType,
    basis: row.basis as RelationshipBasis,
    matchKey: row.matchKey,
    sourcePassageId: row.sourcePassageId,
    rationale: row.rationale,
    confidence: row.confidence,
    reviewStatus: row.reviewStatus,
    createdBy: row.createdBy,
    correctedBy: row.correctedBy,
  }));
}
