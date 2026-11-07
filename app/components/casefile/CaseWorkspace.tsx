import { useActionMutation, useActionQuery } from "@agent-native/core/client/use-action";
import {
  markAgentChatHomeHandoff,
  navigateWithAgentChatViewTransition,
} from "@agent-native/core/client/agent-chat";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import type {
  CaseStatus,
  EvidenceCategory,
  DocumentType,
  GapReviewStatus,
  Provenance,
} from "@shared/casefile/types";
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, label } from "@shared/casefile/types";

import {
  GapReviewBadge,
  NoteStatusBadge,
  ProvenanceBadge,
  ReviewBadge,
  StatusPill,
} from "@/components/casefile/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CASES_PATH } from "@/lib/casefile-paths";
import { getChatHomeThreadId } from "@/lib/chat-home-thread";
import { chatThreadPath } from "@/lib/chat-paths";
import { cn } from "@/lib/utils";

/**
 * The case workspace.
 *
 * The layout follows one rule: a reader must always be able to tell what is
 * established from what is merely claimed. Evidence, the investigation status,
 * and the finding list are separate panels, and every finding shows its
 * provenance, its review state, and the passages it rests on.
 */

interface EvidenceItem {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  category: string;
  documentType: string;
  classificationConfidence: string | null;
  classificationCorrectedBy: string | null;
  extractionStatus: string;
  extractionError: string | null;
  passageCount: number;
  citedByFindings: number;
}

interface Citation {
  evidenceId: string;
  passageId: string | null;
  quote: string | null;
}

interface Claim {
  id: string;
  statement: string;
  provenance: string;
  reviewStatus: string;
  confidence: string | null;
  uncertainty: string | null;
  correctedBy: string | null;
  citations: Citation[];
}

interface EventItem extends Claim {
  eventDate: string | null;
  eventDateText: string | null;
  datePrecision: string | null;
  dateConflict: boolean;
}

interface InvestigationStatus {
  evidence: { total: number; pending: number; extracted: number; notExtractable: number };
  claims: { proposed: number; confirmed: number; rejected: number };
  events: { proposed: number; confirmed: number; rejected: number };
  unsupportedClaims: number;
  conflictingEvents: number;
  blockers: string[];
  nextStep: string;
}

interface CitationRef {
  evidenceId: string;
  passageId: string | null;
  ref: string | null;
  quote: string | null;
}

interface Comparison {
  aId: string;
  bId: string;
  aStatement: string;
  bStatement: string;
  verdict: string;
  reason: string;
  sharedRefs: string[];
  sharedAmounts: string[];
  sharedParties: string[];
  aCitations: CitationRef[];
  bCitations: CitationRef[];
}

interface Relationship {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relationType: string;
  basis: string;
  matchKey: string | null;
  sourcePassageId: string | null;
  rationale: string;
  confidence: string | null;
  reviewStatus: string;
  createdBy: string;
}

interface Gap {
  id: string;
  kind: string;
  gapKey: string;
  missing: string;
  affectsFindingId: string | null;
  affectsStatement: string | null;
  whyItMatters: string;
  whatWouldHelp: string;
  relatedEvidenceIds: string[];
  reviewStatus: string;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

interface GraphResult {
  counts: {
    passages: number;
    documents: number;
    relationships: number;
    contradictions: number;
    potentialContradictions: number;
    agreements: number;
    gaps: number;
  };
  relationships: Relationship[];
  comparisons: Comparison[];
  gaps: Gap[];
}

interface ReadinessState {
  state: string;
  label: string;
  rationale: string;
  established: string[];
  unverified: string[];
  contradicted: string[];
  missing: string[];
  needsReview: string[];
  additionalEvidence: string[];
  nextStep: string;
  readyForReport: boolean;
}

interface CaseDetail {
  case: {
    id: string;
    title: string;
    description: string;
    category: string;
    status: string;
    amountMinor: number | null;
    currency: string | null;
  };
  evidence: EvidenceItem[];
  claims: Claim[];
  events: EventItem[];
}

const EVIDENCE_CATEGORIES = [
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
];

/**
 * The client aborts an action after 60s by default. Analysis runs a model over
 * every extracted passage and routinely takes longer, so it is given its own
 * budget instead of failing mid-flight.
 *
 * The three limits have to be ordered: the server's own model budget is 290s,
 * this client timeout is 295s, and the hosting platform stops a function at
 * 300s. The client must outlast the server, or the browser gives up first and
 * the server's stated reason - "ran out of its 290s budget" - is never seen.
 * Both must stay under the platform limit, or the function is killed mid-flight
 * and the failure is an opaque network error with nothing recorded.
 */
export const ANALYSIS_TIMEOUT_MS = 295_000;

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The provenance and review key, shown once at the top of the workspace.
 *
 * The whole product rests on a reader being able to tell a documented fact from
 * a party's assertion, an agent's inference, an unverified statement, and a
 * contradiction. Those words are the app's vocabulary, so they are defined here
 * rather than left for the reader to infer from colour.
 */
function ProvenanceLegend() {
  const rows: Array<{ provenance: Provenance; meaning: string }> = [
    { provenance: "documented", meaning: "read directly from a document in the case" },
    { provenance: "asserted", meaning: "a party's own statement, reported as a statement" },
    { provenance: "inferred", meaning: "the agent's reasoning, not something a document says" },
    { provenance: "unverified", meaning: "no supporting passage is attached yet" },
  ];
  return (
    <details className="group rounded-lg border border-border p-3" data-testid="provenance-legend">
      <summary className="cursor-pointer text-sm font-medium marker:content-none">
        How to read this file
        <span className="ms-2 text-xs font-normal text-muted-foreground">
          what each label means
        </span>
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.provenance} className="flex items-start gap-2">
            <ProvenanceBadge value={row.provenance} />
            <span className="text-xs text-muted-foreground">{row.meaning}</span>
          </div>
        ))}
        <div className="flex items-start gap-2">
          <span className="inline-flex shrink-0 items-center rounded-full border border-destructive/50 bg-destructive/5 px-2 py-0.5 text-xs font-medium">
            Contradiction
          </span>
          <span className="text-xs text-muted-foreground">
            two documents disagree on the same identifier
          </span>
        </div>
        <div className="flex items-start gap-2">
          <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium">
            Unresolved
          </span>
          <span className="text-xs text-muted-foreground">
            the record is missing something it needs
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Analysis proposes; a person confirms. Nothing is ever shown as established until a
        reviewer has accepted it.
      </p>
    </details>
  );
}

/**
 * The investigation brief.
 *
 * The first thing a reader sees: which investigation this is, what the evidence
 * has been found to establish, what still needs a person, where the record
 * conflicts, and what it cannot yet answer. Every count is derived from the
 * stored record — never from a model and never invented for the screen.
 */
function InvestigationBrief({
  caseTitle,
  amount,
  investigation,
  graph,
  reviewCount,
  onJump,
}: {
  caseTitle: string;
  amount: string | null;
  investigation: InvestigationStatus | undefined;
  graph: GraphResult | null;
  reviewCount: number;
  onJump: (anchor: string) => void;
}) {
  const contradictions = graph?.counts.contradictions ?? 0;
  const gaps = graph?.counts.gaps ?? 0;
  const established = investigation
    ? investigation.claims.confirmed + investigation.events.confirmed
    : 0;
  const proposed = investigation
    ? investigation.claims.proposed + investigation.events.proposed
    : 0;
  const files = investigation?.evidence.total ?? 0;
  const notRead = investigation?.evidence.pending ?? 0;

  const headline = ((): string => {
    if (files === 0) return "No evidence has been added yet.";
    if (notRead > 0 && established === 0 && proposed === 0) {
      return "Evidence has been added but not yet read.";
    }
    if (established === 0 && proposed > 0) {
      return "Findings have been proposed and are waiting for your review.";
    }
    if (established > 0 && contradictions > 0) {
      return "The case is partly established, with conflicts that still need a decision.";
    }
    if (established > 0) return "The case has findings a person has confirmed.";
    return "The evidence has been read and is ready to analyse.";
  })();

  const items: Array<{
    label: string;
    value: string;
    tone?: string | undefined;
    anchor?: string | undefined;
  }> = [
    { label: "Evidence received", value: `${files} file${files === 1 ? "" : "s"}`, anchor: "evidence" },
    {
      label: "Established",
      value: `${established} confirmed`,
      tone: established > 0 ? "text-emerald-700 dark:text-emerald-300" : undefined,
      anchor: "claims",
    },
    {
      label: "Needs your review",
      value: `${reviewCount} proposed`,
      tone: reviewCount > 0 ? "text-sky-700 dark:text-sky-300" : undefined,
      anchor: "review",
    },
    {
      label: "Contradictions",
      value: `${contradictions}`,
      tone: contradictions > 0 ? "text-destructive" : undefined,
      anchor: "across-documents",
    },
    {
      label: "Unresolved",
      value: `${gaps} question${gaps === 1 ? "" : "s"}`,
      tone: gaps > 0 ? "text-amber-700 dark:text-amber-300" : undefined,
      anchor: "across-documents",
    },
  ];

  return (
    <section
      className="mb-6 rounded-xl border border-border bg-muted/30 p-4 sm:p-5"
      data-testid="investigation-brief"
      aria-label="Investigation brief"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">Investigation brief</h2>
        {amount ? (
          <span className="text-sm font-medium tabular-nums" data-testid="brief-amount">
            {amount}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="brief-headline">
        {headline}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {item.label}
            </dt>
            <dd className={cn("text-lg font-semibold tabular-nums", item.tone)}>
              {item.anchor ? (
                <button
                  type="button"
                  className="inline-flex min-w-6 items-center justify-center rounded -mx-1 px-1 py-0.5 -my-0.5 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onJump(item.anchor!)}
                >
                  {item.value}
                </button>
              ) : (
                item.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {caseTitle ? `${caseTitle}. ` : ""}Counts are read from the stored record, not from a
        model.
      </p>
    </section>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read from disk.`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`"${file.name}" could not be read as data.`));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function EvidenceRow({
  item,
  onCategorize,
  onClassify,
  onDelete,
}: {
  item: EvidenceItem;
  onCategorize: (evidenceId: string, category: string) => void;
  onClassify: (evidenceId: string, documentType: string) => void;
  onDelete: (evidenceId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const extraction = item.extractionStatus;
  const typeLabel =
    DOCUMENT_TYPE_LABELS[item.documentType as DocumentType] ?? item.documentType;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{item.filename}</span>
        <span className="text-xs text-muted-foreground">
          {item.mimeType} · {humanBytes(item.byteSize)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <select
          aria-label={`Category for ${item.filename}`}
          value={item.category}
          onChange={(event) => onCategorize(item.id, event.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        >
          {EVIDENCE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value.replace(/-/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {item.passageCount} passage{item.passageCount === 1 ? "" : "s"}
        </span>
        {item.citedByFindings > 0 ? (
          <span className="text-xs text-muted-foreground">
            cited by {item.citedByFindings} finding{item.citedByFindings === 1 ? "" : "s"}
          </span>
        ) : null}
        <div className="ms-auto">
          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-destructive">
                Remove this file and any finding that relied on it?
              </span>
              <Button size="sm" variant="destructive" onClick={() => onDelete(item.id)}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Type:</span>
        <select
          aria-label={`Document type for ${item.filename}`}
          value={item.documentType}
          onChange={(event) => onClassify(item.id, event.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          data-testid="document-type-select"
        >
          {DOCUMENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px]",
            item.classificationCorrectedBy
              ? "border-sky-600/40 bg-sky-500/10 text-sky-800 dark:text-sky-300"
              : item.classificationConfidence === "high"
                ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                : item.classificationConfidence === "medium"
                  ? "border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  : "border-border text-muted-foreground",
          )}
          title={typeLabel}
        >
          {item.classificationCorrectedBy
            ? "set by you"
            : `${item.classificationConfidence ?? "low"} confidence`}
        </span>
      </div>
      {extraction === "unsupported" || extraction === "failed" ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {item.extractionError ?? "This file's text could not be read."}
        </p>
      ) : null}
    </div>
  );
}

function FindingCard({
  finding,
  evidenceById,
  onReview,
  onCorrectDate,
  onSelectEvidence,
}: {
  finding: Claim | EventItem;
  evidenceById: Map<string, EvidenceItem>;
  onReview: (findingId: string, reviewStatus: "confirmed" | "rejected") => void;
  onCorrectDate: (findingId: string, date: string) => void;
  onSelectEvidence: (evidenceId: string, passageId: string | null) => void;
}) {
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState("");
  const isEvent = "eventDate" in finding;
  const event = finding as EventItem;
  const unsupported = finding.citations.length === 0;

  return (
    <div
      id={`finding-${finding.id}`}
      tabIndex={-1}
      className={cn(
        "rounded-lg border p-3 scroll-mt-4",
        unsupported ? "border-amber-600/40 bg-amber-500/5" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge value={finding.provenance} />
        <ReviewBadge value={finding.reviewStatus} />
        {finding.confidence ? (
          <span className="text-xs text-muted-foreground">confidence: {finding.confidence}</span>
        ) : null}
        {isEvent && event.dateConflict ? (
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
            conflicting dates
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-sm">{finding.statement}</p>

      {isEvent && (event.eventDate || event.eventDateText) ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Date: {event.eventDate ?? "not resolved"}
          {event.eventDateText && event.eventDateText !== event.eventDate
            ? ` (as written: ${event.eventDateText})`
            : ""}
          {event.datePrecision && event.datePrecision !== "day"
            ? ` · ${event.datePrecision}-level precision only`
            : ""}
        </p>
      ) : null}

      {finding.uncertainty ? (
        <p className="mt-1 text-xs italic text-muted-foreground">{finding.uncertainty}</p>
      ) : null}

      <div className="mt-2 space-y-1">
        {unsupported ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            No supporting passage. Treat this as unsupported until a source is attached.
          </p>
        ) : (
          finding.citations.map((citation, index) => (
            <blockquote
              key={`${finding.id}-${index}`}
              className="border-s-2 border-border ps-3 text-xs text-muted-foreground"
            >
              {citation.quote ? `“${citation.quote}”` : "Quoted passage"}
              <button
                type="button"
                className="ms-1 underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectEvidence(citation.evidenceId, citation.passageId)}
                title="Open the source document at this passage"
              >
                — {evidenceById.get(citation.evidenceId)?.filename ?? "a source document"}
              </button>
            </blockquote>
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {finding.reviewStatus !== "confirmed" ? (
          <Button size="sm" variant="outline" onClick={() => onReview(finding.id, "confirmed")}>
            Confirm
          </Button>
        ) : null}
        {finding.reviewStatus !== "rejected" ? (
          <Button size="sm" variant="ghost" onClick={() => onReview(finding.id, "rejected")}>
            Reject
          </Button>
        ) : null}
        {isEvent ? (
          editingDate ? (
            <span className="flex items-center gap-2">
              <Input
                aria-label="Corrected date"
                value={dateValue}
                onChange={(inputEvent) => setDateValue(inputEvent.target.value)}
                placeholder="YYYY-MM-DD"
                className="h-8 w-32 text-xs"
              />
              <Button
                size="sm"
                onClick={() => {
                  onCorrectDate(finding.id, dateValue);
                  setEditingDate(false);
                }}
              >
                Save date
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingDate(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditingDate(true)}>
              Correct date
            </Button>
          )
        ) : null}
        {finding.correctedBy ? (
          <span className="text-xs text-muted-foreground">
            corrected by a person ({finding.correctedBy})
          </span>
        ) : null}
      </div>
    </div>
  );
}

const VERDICT_STYLE: Record<string, string> = {
  contradiction: "border-destructive/50 bg-destructive/5",
  potential_contradiction: "border-amber-600/40 bg-amber-500/5",
  direct_agreement: "border-emerald-600/40 bg-emerald-500/5",
  partial_agreement: "border-border",
  insufficient_information: "border-dashed border-border",
};

/**
 * The cross-document investigation view.
 *
 * This is the panel that makes CASEFILE more than a set of document summaries:
 * it shows what connects the case's documents, where their assertions agree or
 * conflict, and what the record is still missing. Every relationship shows the
 * identifier it matched on and, where there is one, the passage it came from, so
 * a reviewer can check the link instead of trusting a score.
 */
function CrossDocumentPanel({
  graph,
  loading,
  onBuild,
  building,
  onReviewRelationship,
  onReviewGap,
  onSelectEvidence,
}: {
  graph: GraphResult | null;
  loading?: boolean;
  onBuild: () => void;
  building: boolean;
  onReviewRelationship: (relationshipId: string, reviewStatus: "confirmed" | "rejected") => void;
  onReviewGap: (gapKey: string, status: GapReviewStatus) => void;
  onSelectEvidence: (evidenceId: string, passageId: string | null) => void;
}) {
  const counts = graph?.counts;
  const comparisons = graph?.comparisons ?? [];
  const relationships = graph?.relationships ?? [];
  const gaps = graph?.gaps ?? [];

  const contradictory = comparisons.filter(
    (c) => c.verdict === "contradiction" || c.verdict === "potential_contradiction",
  );
  const agreements = comparisons.filter(
    (c) => c.verdict === "direct_agreement" || c.verdict === "partial_agreement",
  );

  return (
    <section className="mb-6" data-testid="cross-document-panel" id="across-documents" tabIndex={-1}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Across documents</h2>
          <p className="text-sm text-muted-foreground">
            What connects these documents, where they agree or conflict, and what is still
            missing. Links are drawn only from shared identifiers, amounts, parties, and dates.
          </p>
        </div>
        <Button variant="outline" onClick={onBuild} disabled={building}>
          {building ? "Connecting…" : "Connect the documents"}
        </Button>
      </div>

      {!graph ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {loading
              ? "Reading the stored connections…"
              : "Run the connection to compare this case&apos;s documents against each other."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              {counts?.documents ?? 0} document{(counts?.documents ?? 0) === 1 ? "" : "s"} ·{" "}
              {counts?.passages ?? 0} passage{(counts?.passages ?? 0) === 1 ? "" : "s"}
            </span>
            <span>{counts?.relationships ?? 0} relationship{(counts?.relationships ?? 0) === 1 ? "" : "s"}</span>
            <span className={(counts?.contradictions ?? 0) > 0 ? "font-medium text-destructive" : undefined}>
              {counts?.contradictions ?? 0} contradiction{(counts?.contradictions ?? 0) === 1 ? "" : "s"}
            </span>
            <span>{counts?.agreements ?? 0} agreement{(counts?.agreements ?? 0) === 1 ? "" : "s"}</span>
            <span>{counts?.gaps ?? 0} gap{(counts?.gaps ?? 0) === 1 ? "" : "s"}</span>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium">Conflicting and unresolved assertions</h3>
            {contradictory.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No assertions in this case conflict across documents.
              </p>
            ) : (
              <div className="space-y-2">
                {contradictory.map((comparison) => (
                  <div
                    key={`${comparison.aId}-${comparison.bId}`}
                    className={cn(
                      "rounded-lg border p-3",
                      VERDICT_STYLE[comparison.verdict] ?? "border-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide">
                        {label(comparison.verdict)}
                      </span>
                      {comparison.sharedRefs.length > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          shared reference: {comparison.sharedRefs.join(", ")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <ComparisonSide
                        statement={comparison.aStatement}
                        citations={comparison.aCitations}
                        onSelectEvidence={onSelectEvidence}
                      />
                      <ComparisonSide
                        statement={comparison.bStatement}
                        citations={comparison.bCitations}
                        onSelectEvidence={onSelectEvidence}
                      />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{comparison.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {agreements.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">Assertions that agree</h3>
              <ul className="space-y-1 text-sm">
                {agreements.map((comparison) => (
                  <li key={`${comparison.aId}-${comparison.bId}`} className="text-muted-foreground">
                    <span className="text-foreground">{comparison.aStatement}</span> and{" "}
                    <span className="text-foreground">{comparison.bStatement}</span> — {comparison.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {gaps.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">What the record does not yet establish</h3>
              <div className="space-y-2">
                {gaps.map((gap) => (
                  <div key={gap.gapKey} className="rounded-lg border border-dashed border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{gap.missing}</p>
                      <GapReviewBadge value={gap.reviewStatus} />
                    </div>
                    {gap.affectsStatement ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Affects: {gap.affectsStatement}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">{gap.whyItMatters}</p>
                    <p className="mt-1 text-xs">
                      <span className="font-medium">Would help: </span>
                      {gap.whatWouldHelp}
                    </p>
                    {gap.reviewNote ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium">Reviewed: </span>
                        {gap.reviewNote}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      {gap.relatedEvidenceIds.length > 0 ? (
                        <button
                          type="button"
                          className="py-1 underline"
                          onClick={() => onSelectEvidence(gap.relatedEvidenceIds[0]!, null)}
                        >
                          Go to the related document
                        </button>
                      ) : null}
                      <span className="flex items-center gap-3">
                        {gap.reviewStatus !== "resolved" ? (
                          <button
                            type="button"
                            className="py-1 underline"
                            onClick={() => onReviewGap(gap.gapKey, "resolved")}
                          >
                            Resolved
                          </button>
                        ) : null}
                        {gap.reviewStatus !== "unresolved" ? (
                          <button
                            type="button"
                            className="py-1 underline"
                            onClick={() => onReviewGap(gap.gapKey, "unresolved")}
                          >
                            Unresolved
                          </button>
                        ) : null}
                        {gap.reviewStatus !== "not_applicable" ? (
                          <button
                            type="button"
                            className="py-1 underline"
                            onClick={() => onReviewGap(gap.gapKey, "not_applicable")}
                          >
                            Not applicable
                          </button>
                        ) : null}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <h3 className="mb-2 text-sm font-medium">
              Relationships ({relationships.length})
            </h3>
            {relationships.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No relationships were found between these documents.
              </p>
            ) : (
              <div className="space-y-1">
                {relationships.map((relationship) => (
                  <div
                    key={relationship.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-xs"
                  >
                    <span className="font-medium">{label(relationship.relationType)}</span>
                    <span className="text-muted-foreground">{relationship.basis}</span>
                    {relationship.matchKey ? (
                      <span className="text-muted-foreground">matched on {relationship.matchKey}</span>
                    ) : null}
                    <span className="text-muted-foreground">{relationship.rationale}</span>
                    {relationship.sourcePassageId ? (
                      <button
                        type="button"
                        className="py-1 underline"
                        onClick={() =>
                          onSelectEvidence(
                            relationship.fromType === "passage"
                              ? relationship.fromId
                              : relationship.sourcePassageId!,
                            relationship.sourcePassageId,
                          )
                        }
                      >
                        source
                      </button>
                    ) : null}
                    <span className="ms-auto flex items-center gap-2">
                      <ReviewBadge value={relationship.reviewStatus} />
                      {relationship.reviewStatus !== "confirmed" ? (
                        <button
                          type="button"
                          className="py-1 underline"
                          onClick={() => onReviewRelationship(relationship.id, "confirmed")}
                        >
                          Confirm
                        </button>
                      ) : null}
                      {relationship.reviewStatus !== "rejected" ? (
                        <button
                          type="button"
                          className="py-1 underline"
                          onClick={() => onReviewRelationship(relationship.id, "rejected")}
                        >
                          Dismiss
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ComparisonSide({
  statement,
  citations,
  onSelectEvidence,
}: {
  statement: string;
  citations: CitationRef[];
  onSelectEvidence: (evidenceId: string, passageId: string | null) => void;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-2">
      <p className="text-sm">{statement}</p>
      <div className="mt-1 space-y-1">
        {citations.length === 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">No cited source.</p>
        ) : (
          citations.map((citation, index) => (
            <button
              key={`${citation.evidenceId}-${citation.passageId ?? index}`}
              type="button"
              className="block w-full py-1 text-start text-xs text-muted-foreground underline decoration-dotted"
              onClick={() => onSelectEvidence(citation.evidenceId, citation.passageId)}
            >
              {citation.ref ?? "source"}
              {citation.quote ? `: “${citation.quote}”` : ""}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ReadinessPanel({ caseId }: { caseId: string }) {
  const readiness = useActionQuery<{
    readiness: {
      state: string;
      label: string;
      rationale: string;
      established: string[];
      unverified: string[];
      contradicted: string[];
      missing: string[];
      needsReview: string[];
      additionalEvidence: string[];
      nextStep: string;
      readyForReport: boolean;
    };
  }>("assess-readiness", { caseId });

  if (readiness.isPending) {
    return (
      <Card className="mb-6">
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Assessing readiness…
        </CardContent>
      </Card>
    );
  }
  if (readiness.isError || !readiness.data) return null;
  const state = readiness.data.readiness;

  const groups: Array<{ heading: string; items: string[]; tone: string }> = [
    { heading: "Established", items: state.established, tone: "text-emerald-700 dark:text-emerald-300" },
    { heading: "Unverified", items: state.unverified, tone: "text-amber-700 dark:text-amber-300" },
    { heading: "Contradicted", items: state.contradicted, tone: "text-destructive" },
    { heading: "Missing", items: state.missing, tone: "text-amber-700 dark:text-amber-300" },
  ];

  return (
    <Card className="mb-6" data-testid="readiness-panel">
      <CardHeader>
        <CardTitle className="text-base">Case readiness: {state.label}</CardTitle>
        <CardDescription>{state.rationale}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <div key={group.heading}>
                <p className={cn("text-xs font-semibold uppercase tracking-wide", group.tone)}>
                  {group.heading}
                </p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-sm">
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
        <p className="text-sm">
          <span className="font-medium">Next step: </span>
          {state.nextStep}
        </p>
        <p className="text-xs text-muted-foreground">
          Readiness is a named state with a stated reason, never a score. A case becomes ready
          only when its documents have been read and its findings reviewed by a person.
        </p>
      </CardContent>
    </Card>
  );
}

function DomainPanel({ caseId }: { caseId: string }) {
  const analysis = useActionQuery<{
    findings: Array<{
      id: string;
      domain: string;
      role: string;
      statement: string;
      filename: string;
      ref: string;
      attributedTo: string | null;
    }>;
    summary: Array<{ domain: string; total: number; roles: Array<{ role: string; count: number }> }>;
    counts: { total: number };
  }>("analyse-documents", { caseId });

  if (analysis.isPending) {
    return (
      <Card className="mb-6">
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Reading the documents for field-specific content…
        </CardContent>
      </Card>
    );
  }
  if (analysis.isError || !analysis.data) return null;
  const { findings, summary } = analysis.data;

  return (
    <Card className="mb-6" data-testid="domain-panel">
      <CardHeader>
        <CardTitle className="text-base">Field-specific analysis</CardTitle>
        <CardDescription>
          Each statement is labelled by what it is in its own field: a judicial finding versus a
          party&apos;s allegation, an invoiced amount versus a received one. Every label cites the
          sentence it came from.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No field-specific statements were identified yet.
          </p>
        ) : (
          summary.map((entry) => (
            <div key={entry.domain}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {entry.domain} · {entry.total}
              </p>
              <div className="mt-2 space-y-2">
                {findings
                  .filter((finding) => finding.domain === entry.domain)
                  .map((finding) => (
                    <div key={finding.id} className="rounded-md border border-border p-2 text-sm">
                      <span className="me-2 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {finding.role.replace(/-/g, " ")}
                        {finding.attributedTo ? ` · ${finding.attributedTo}` : ""}
                      </span>
                      {finding.statement}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {finding.filename} — {finding.ref}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ReportPanel({ caseId }: { caseId: string }) {
  const report = useActionQuery<{
    title: string;
    overview: string;
    readiness: { label: string };
    reviewSummary: { proposed: number; confirmed: number; rejected: number };
    documentRegister: unknown[];
    outstandingQuestions: string[];
  }>("build-report", { caseId });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const exportReport = useActionMutation("export-report");

  const download = async (format: "markdown" | "html" | "docx" | "pdf" | "json" | "csv") => {
    setBusy(format);
    setMessage(null);
    try {
      const result = await exportReport.mutateAsync({ caseId, format });
      const bytes = Uint8Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${result.filename}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-6" data-testid="report-panel">
      <CardHeader>
        <CardTitle className="text-base">Investigation report</CardTitle>
        <CardDescription>
          Assembled from the stored record, with citations and review marks preserved. The export
          is downloaded directly; no public link is created.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {report.data ? (
          <>
            <p className="text-sm">{report.data.overview}</p>
            <p className="text-sm text-muted-foreground">
              {report.data.documentRegister.length} document(s) ·{" "}
              {report.data.reviewSummary.confirmed} confirmed ·{" "}
              {report.data.reviewSummary.proposed} proposed ·{" "}
              {report.data.outstandingQuestions.length} outstanding question(s)
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Preparing the report…</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("markdown")}
            disabled={busy !== null}
          >
            {busy === "markdown" ? "Exporting…" : "Export Markdown"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("html")}
            disabled={busy !== null}
          >
            {busy === "html" ? "Exporting…" : "Export HTML"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("docx")}
            disabled={busy !== null}
          >
            {busy === "docx" ? "Exporting…" : "Export Word"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("pdf")}
            disabled={busy !== null}
          >
            {busy === "pdf" ? "Exporting…" : "Export PDF"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("json")}
            disabled={busy !== null}
          >
            {busy === "json" ? "Exporting…" : "Export JSON"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void download("csv")}
            disabled={busy !== null}
          >
            {busy === "csv" ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

interface EntitySource {
  evidenceId: string;
  filename: string;
  passageId: string;
  quote: string;
}

interface EntityGroup {
  key: string;
  label: string;
  mentions: number;
  sources: EntitySource[];
}

interface EntityView {
  counts: {
    documents: number;
    passages: number;
    parties: number;
    references: number;
    amounts: number;
    dates: number;
  };
  parties: EntityGroup[];
  references: EntityGroup[];
  amounts: EntityGroup[];
  dates: EntityGroup[];
}

/**
 * The entities a case's documents introduce: the parties named, the references
 * cited, the amounts stated, and the dates recorded. Every entity resolves to
 * the passages that mention it, so a reader can check the claim rather than
 * trust a name.
 */
export function EntitiesPanel({
  caseId,
  onSelectEvidence,
}: {
  caseId: string;
  onSelectEvidence: (evidenceId: string, passageId: string) => void;
}) {
  const entities = useActionQuery<EntityView>("list-entities", { caseId });

  const groups: Array<[string, EntityGroup[]]> = [
    ["Parties", entities.data?.parties ?? []],
    ["References", entities.data?.references ?? []],
    ["Amounts", entities.data?.amounts ?? []],
    ["Dates", entities.data?.dates ?? []],
  ];

  return (
    <section className="mb-6 scroll-mt-4" data-testid="entities-panel" id="entities" tabIndex={-1}>
      <h2 className="text-lg font-medium">Entities</h2>
      <p className="text-sm text-muted-foreground">
        Parties, references, amounts, and dates found across the documents. Two mentions are the
        same entity only when they share an identifier — similar-looking names are never merged.
      </p>

      {entities.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Reading the entities…</p>
      ) : entities.error ? (
        <p className="mt-3 text-sm text-destructive">
          {entities.error instanceof Error ? entities.error.message : String(entities.error)}
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map(([heading, list]) =>
            list.length === 0 ? null : (
              <div key={heading}>
                <h3 className="mb-2 text-sm font-medium">{heading}</h3>
                <div className="space-y-2">
                  {list.map((entity) => (
                    <Card key={`${heading}:${entity.key}`}>
                      <CardContent className="pt-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium">{entity.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {entity.mentions} mention{entity.mentions === 1 ? "" : "s"}
                          </span>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {entity.sources.map((source) => (
                            <li key={`${source.passageId}:${source.quote}`}>
                              <button
                                type="button"
                                className="text-left text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => onSelectEvidence(source.evidenceId, source.passageId)}
                              >
                                <span className="font-medium">{source.filename}</span> — {source.quote}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ),
          )}
          {groups.every(([, list]) => list.length === 0) ? (
            <p className="text-sm text-muted-foreground">
              No entities yet. Read the documents first.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

interface ActivityEntry {
  id: string;
  action: string;
  actor: string | null;
  source: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  createdAt: string;
}

/**
 * The investigator's own notes.
 *
 * A note is the human's record: it is attributed, editable, and never rewritten
 * by analysis. This panel is deliberately separate from the finding list so a
 * person's working notes are never confused with the case's evidence.
 */
export function NotesPanel({ caseId }: { caseId: string }) {
  const notes = useActionQuery<{
    notes: Array<{
      id: string;
      findingId: string | null;
      body: string;
      status: string;
      editedBy: string | null;
      editedAt: string | null;
      updatedAt: string;
    }>;
    count: number;
  }>("list-notes", { caseId });
  const [draft, setDraft] = useState("");
  const save = useActionMutation("update-note", {
    onSuccess: () => {
      setDraft("");
      void notes.refetch();
    },
  });

  return (
    <section className="mb-6 scroll-mt-4" data-testid="notes-panel" id="notes" tabIndex={-1}>
      <h2 className="text-lg font-medium">Investigator notes</h2>
      <p className="text-sm text-muted-foreground">
        Your own working notes on this case. They are attributed to you and are never overwritten
        by analysis.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a note about this case…"
          aria-label="New investigator note"
        />
        <Button
          onClick={() => {
            if (!draft.trim()) return;
            save.mutate({ caseId, body: draft.trim() });
          }}
          disabled={save.isPending || draft.trim().length === 0}
        >
          {save.isPending ? "Saving…" : "Add note"}
        </Button>
      </div>

      {notes.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Reading the notes…</p>
      ) : notes.error ? (
        <p className="mt-3 text-sm text-destructive">
          {notes.error instanceof Error ? notes.error.message : String(notes.error)}
        </p>
      ) : (notes.data?.notes.length ?? 0) === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No notes on this case yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.data!.notes.map((note) => (
            <li key={note.id} className="rounded-md border border-border px-3 py-2">
              <p className="text-sm">{note.body}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <NoteStatusBadge value={note.status} />
                <span>
                  {note.editedBy ? `edited by ${note.editedBy}` : "added"} ·{" "}
                  {new Date(note.updatedAt).toLocaleString()}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The case's activity history: every write that touched it, newest first, and
 * whether it came from a person or the agent. The audit trail was recorded all
 * along; this is where it becomes visible.
 */
export function ActivityPanel({ caseId }: { caseId: string }) {
  const activity = useActionQuery<{ count: number; entries: ActivityEntry[] }>("list-activity", {
    caseId,
    limit: 50,
  });

  return (
    <section className="mb-6 scroll-mt-4" data-testid="activity-panel" id="activity" tabIndex={-1}>
      <h2 className="text-lg font-medium">Activity</h2>
      <p className="text-sm text-muted-foreground">
        Every change to this case, newest first. Agent writes are recorded the same way as your own.
      </p>

      {activity.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Reading the history…</p>
      ) : activity.error ? (
        <p className="mt-3 text-sm text-destructive">
          {activity.error instanceof Error ? activity.error.message : String(activity.error)}
        </p>
      ) : (activity.data?.entries.length ?? 0) === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing has happened on this case yet.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {activity.data!.entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  <span className="font-medium">{entry.action}</span>
                  {entry.summary ? ` — ${entry.summary}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.source === "agent" ? "agent" : "you"} ·{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState<EvidenceCategory>("receipt");
  // Wall-clock start of the running analysis, and the elapsed seconds derived
  // from it. Analysis runs a model for minutes, so the pending state has to
  // visibly move; a button that reads the same at second 1 and second 120 is
  // indistinguishable from a click that did nothing.
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);

  const detail = useActionQuery<CaseDetail>("get-case", { caseId });
  const status = useActionQuery<InvestigationStatus>("get-investigation-status", { caseId });
  const timeline = useActionQuery<{ timeline: EventItem[]; undated: EventItem[]; counts: { undated: number; conflicting: number } }>(
    "build-timeline",
    { caseId },
  );

  const [graph, setGraph] = useState<GraphResult | null>(null);
  const storedGraph = useActionQuery<GraphResult>("read-case-graph", { caseId });
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [selectedPassageId, setSelectedPassageId] = useState<string | null>(null);
  const selectedPassageRef = useRef<HTMLQuoteElement | null>(null);
  const passageView = useActionQuery<{
    evidence: { id: string; filename: string; extractionStatus: string };
    passages: Array<{ id: string; ref: string; text: string; locatorType: string; locatorValue: number | null }>;
  }>(
    "get-evidence",
    { caseId, evidenceId: selectedEvidenceId ?? "", includeBytes: false },
    { enabled: Boolean(selectedEvidenceId) },
  );

  // When a citation is opened, bring the passage the finding actually rests on
  // into view. Without this the viewer opens at the top and the reviewer has to
  // hunt for the quoted line.
  useEffect(() => {
    if (!selectedPassageId || !selectedPassageRef.current) return;
    selectedPassageRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedPassageId, passageView.data]);

  const invalidate = () => {
    void detail.refetch();
    void status.refetch();
    void timeline.refetch();
    void storedGraph.refetch();
  };

  // Tick once a second while an analysis is in flight so the button can show how
  // long it has been running. The interval is cleared the moment the run ends,
  // so nothing keeps re-rendering afterwards.
  useEffect(() => {
    if (analysisStartedAt === null) {
      setAnalysisElapsed(0);
      return;
    }
    const update = () => setAnalysisElapsed(Math.floor((Date.now() - analysisStartedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [analysisStartedAt]);

  const buildGraph = useActionMutation("build-case-graph", {
    onSuccess: (result: GraphResult) => {
      setGraph(result);
      // The stored rows carry the ids a reviewer needs to confirm or dismiss an
      // edge, so pull them back rather than trusting the freshly computed ones.
      void storedGraph.refetch();
      setNotice(
        `Connected ${result.counts.documents} document(s): ${result.counts.relationships} relationship(s), ` +
          `${result.counts.contradictions} contradiction(s), ${result.counts.gaps} gap(s).`,
      );
    },
    onError: (err: Error) => setError(err.message),
  });

  const reviewRelationship = useActionMutation("update-relationship", {
    onSuccess: () => {
      // Rebuild so the reviewed edge's status is reflected from the stored record.
      buildGraph.mutate({ caseId, persist: true });
    },
    onError: (err: Error) => setError(err.message),
  });

  const reviewGap = useActionMutation("review-gap", {
    onSuccess: () => {
      // The verdict is stored, so re-read the graph to show it.
      void storedGraph.refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  const upload = useActionMutation("upload-evidence", {
    onSuccess: (result: { duplicate?: boolean; message?: string; filename?: string }) => {
      if (result?.duplicate) {
        setNotice(result.message ?? "That file is already attached to this case.");
      } else {
        setNotice(`Added ${result?.filename ?? "the file"}. It has not been read yet.`);
      }
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const extract = useActionMutation("extract-evidence", {
    onSuccess: (result: { summary: { complete: number; unsupported: number; failed: number } }) => {
      const { complete, unsupported, failed } = result.summary;
      const parts = [`${complete} file(s) read`];
      if (unsupported) parts.push(`${unsupported} could not be read`);
      if (failed) parts.push(`${failed} failed`);
      setNotice(parts.join(", ") + ".");
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const retryExtraction = useActionMutation("retry-extraction", {
    onSuccess: (result: { retried: number; note?: string }) => {
      setNotice(
        result.retried === 0
          ? result.note ?? "No failed or pending files to retry."
          : `Retried ${result.retried} file(s).`,
      );
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const analyze = useActionMutation("analyze-evidence", {
    // Analysis runs a model over every extracted passage, which routinely
    // exceeds the client's 60s default. Without this the request is aborted
    // while the server is still working, and the proposals are lost. The value
    // sits below the hosting platform's 300s function limit, so a slow run
    // ends with a stated error rather than a platform kill.
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onSuccess: (result: { claimsProposed: number; eventsProposed: number }) => {
      setAnalysisStartedAt(null);
      setNotice(
        `Proposed ${result.claimsProposed} claim(s) and ${result.eventsProposed} event(s). ` +
          "Nothing is confirmed until you confirm it.",
      );
      invalidate();
    },
    onError: (err: Error) => {
      setAnalysisStartedAt(null);
      setError(err.message);
    },
  });

  const updateFinding = useActionMutation("update-finding", {
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const categorize = useActionMutation("categorize-evidence", {
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const classify = useActionMutation("classify-evidence", {
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const removeEvidence = useActionMutation("delete-evidence", {
    onSuccess: (result: { removedFindings: number }) => {
      setNotice(
        result.removedFindings > 0
          ? `Removed the file and ${result.removedFindings} finding(s) that depended only on it.`
          : "Removed the file.",
      );
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateCase = useActionMutation("update-case", {
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const onFilesChosen = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const dataBase64 = await fileToBase64(file);
        await upload.mutateAsync({
          caseId,
          filename: file.name,
          dataBase64,
          mimeType: file.type || undefined,
          category,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  if (detail.isPending) {
    return <p className="p-8 text-sm text-muted-foreground">Loading case…</p>;
  }
  if (detail.isError) {
    return (
      <div className="p-8">
        <p className="text-sm text-destructive">
          This case could not be loaded: {(detail.error as Error).message}
        </p>
        <Link to={CASES_PATH} className="mt-3 inline-block text-sm underline">
          Back to cases
        </Link>
      </div>
    );
  }

  const data = detail.data;
  if (!data) return null;
  const evidenceById = new Map(data.evidence.map((item) => [item.id, item]));
  const investigation = status.data;
  const blockers = investigation?.blockers ?? [];
  const reviewCount = investigation
    ? investigation.claims.proposed + investigation.events.proposed
    : 0;
  const amount =
    data.case.amountMinor !== null
      ? `${(data.case.amountMinor / 100).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}${data.case.currency ? ` ${data.case.currency}` : ""}`
      : null;
  const jumpTo = (anchor: string) => {
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus?.();
  };
  /**
   * Opens the agent with this case already named in the prompt, so the reader
   * does not have to paste an id. The agent still reads the case through its
   * own actions; this only seeds the request.
   */
  const askAgentAboutCase = () => {
    const threadId = getChatHomeThreadId();
    const message = `Read case ${caseId} and summarise what the evidence establishes, what is still proposed, and what is unresolved. Cite the documents you rely on.`;
    markAgentChatHomeHandoff("chat");
    navigateWithAgentChatViewTransition(navigate, chatThreadPath(threadId), {
      state: { initialMessage: message },
    });
  };
  const graphForBrief = graph ?? storedGraph.data ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <Link to={CASES_PATH} className="text-sm text-muted-foreground hover:underline">
        ← Cases
      </Link>

      <header className="mt-3 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.case.title}</h1>
          <StatusPill value={data.case.status} />
        </div>
        {data.case.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{data.case.description}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {["open", "investigating", "review", "closed"].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={data.case.status === value ? "default" : "outline"}
              onClick={() => updateCase.mutate({ caseId, status: value as CaseStatus })}
            >
              {value === "review" ? "In review" : value}
            </Button>
          ))}
          <Button
            size="sm"
            variant="secondary"
            className="ms-auto"
            onClick={askAgentAboutCase}
            data-testid="ask-agent-about-case"
          >
            Ask the agent about this case
          </Button>
        </div>
      </header>

      <InvestigationBrief
        caseTitle={data.case.title}
        amount={amount}
        investigation={investigation}
        graph={graphForBrief}
        reviewCount={reviewCount}
        onJump={jumpTo}
      />

      <div className="mb-6">
        <ProvenanceLegend />
      </div>

      {notice ? (
        <p className="mb-4 rounded-md border border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {investigation ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Where this investigation stands</CardTitle>
            <CardDescription>
              Counts come from the stored record, not from a model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                {investigation.evidence.total} file{investigation.evidence.total === 1 ? "" : "s"}
              </span>
              <span>{investigation.evidence.extracted} with text</span>
              <span>{investigation.evidence.pending} not read yet</span>
              <span>{investigation.evidence.notExtractable} unreadable</span>
              <span>
                {investigation.claims.proposed + investigation.events.proposed} proposed
              </span>
              <span>
                {investigation.claims.confirmed + investigation.events.confirmed} confirmed
              </span>
            </div>
            {blockers.length > 0 ? (
              <ul className="list-inside list-disc space-y-1 text-sm text-amber-800 dark:text-amber-300">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing is blocking progress.</p>
            )}
            <p className="text-sm">
              <span className="font-medium">Next step: </span>
              {investigation.nextStep}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="mb-6" id="evidence" tabIndex={-1}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Evidence</h2>
            <p className="text-sm text-muted-foreground">
              Files are stored privately and are never given a public link.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Category for new files"
              value={category}
              onChange={(event) => setCategory(event.target.value as EvidenceCategory)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {EVIDENCE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/-/g, " ")}
                </option>
              ))}
            </select>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.log,.md,.docx,.xlsx,.eml"
              className="hidden"
              onChange={(event) => void onFilesChosen(event.target.files)}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Add files"}
            </Button>
          </div>
        </div>

        {data.evidence.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              No documents yet. Add a receipt, a bank statement, a contract, or the emails
              exchanged with the other side.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {data.evidence.map((item) => (
              <EvidenceRow
                key={item.id}
                item={item}
                onCategorize={(evidenceId, value) =>
                  categorize.mutate({ caseId, evidenceId, category: value as EvidenceCategory })
                }
                onClassify={(evidenceId, documentType) =>
                  classify.mutate({ caseId, evidenceId, documentType: documentType as DocumentType })
                }
                onDelete={(evidenceId) =>
                  removeEvidence.mutate({ caseId, evidenceId, confirm: true })
                }
              />
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => extract.mutate({ caseId })}
            disabled={extract.isPending || data.evidence.length === 0}
          >
            {extract.isPending ? "Reading…" : "Read the documents"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => retryExtraction.mutate({ caseId })}
            disabled={retryExtraction.isPending || data.evidence.length === 0}
          >
            {retryExtraction.isPending ? "Retrying…" : "Retry failed files"}
          </Button>
          <Button
            onClick={() => {
              setNotice(null);
              setError(null);
              setAnalysisStartedAt(Date.now());
              analyze.mutate({ caseId });
            }}
            disabled={analyze.isPending || investigation?.evidence.extracted === 0}
          >
            {analyze.isPending ? "Analysing…" : "Analyse the evidence"}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {analyze.isPending
              ? `Analysis is running on every extracted passage. Elapsed ${analysisElapsed}s — a long case can take a few minutes; leave this page open.`
              : "Analysis proposes; it never confirms."}
          </span>
        </div>
      </section>

      <CrossDocumentPanel
        graph={graph ?? storedGraph.data ?? null}
        loading={storedGraph.isLoading}
        building={buildGraph.isPending}
        onBuild={() => buildGraph.mutate({ caseId, persist: true })}
        onReviewRelationship={(relationshipId, reviewStatus) =>
          reviewRelationship.mutate({ caseId, relationshipId, reviewStatus })
        }
        onReviewGap={(gapKey, status) => reviewGap.mutate({ caseId, gapKey, status })}
        onSelectEvidence={(evidenceId, passageId) => {
          setSelectedEvidenceId(evidenceId);
          setSelectedPassageId(passageId);
        }}
      />

      <DomainPanel caseId={caseId} />

      <EntitiesPanel
        caseId={caseId}
        onSelectEvidence={(evidenceId, passageId) => {
          setSelectedEvidenceId(evidenceId);
          setSelectedPassageId(passageId);
        }}
      />

      <ReadinessPanel caseId={caseId} />

      <ReportPanel caseId={caseId} />

      {selectedEvidenceId ? (
        <section
          className="mb-6 scroll-mt-4"
          data-testid="passage-viewer"
          id="passage-viewer"
          tabIndex={-1}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">
              {passageView.data?.evidence.filename ?? "Source document"}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedEvidenceId(null);
                setSelectedPassageId(null);
              }}
            >
              Close
            </Button>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            The extracted text of this document, with the exact locator for each passage. The
            original file is not altered or re-rendered.
          </p>

          {(() => {
            const allFindings = [...data.claims, ...data.events];
            const users = allFindings.filter((finding) =>
              finding.citations.some((citation) => citation.evidenceId === selectedEvidenceId),
            );
            if (users.length === 0) return null;
            return (
              <div
                className="mb-3 rounded-lg border border-border bg-muted/30 p-3"
                data-testid="passage-viewer-findings"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Used by {users.length} finding{users.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-2 space-y-1">
                  {users.map((finding) => (
                    <li key={finding.id} className="flex items-start gap-2 text-sm">
                      <ProvenanceBadge value={finding.provenance} />
                      <button
                        type="button"
                        className="py-1 text-start underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => jumpTo(`finding-${finding.id}`)}
                      >
                        {finding.statement}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          <div className="space-y-2">
            {passageView.isPending ? (
              <p className="text-sm text-muted-foreground">Loading passages…</p>
            ) : (passageView.data?.passages.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                This document has no extracted text passages.
              </p>
            ) : (
              passageView.data?.passages.map((passage) => (
                <blockquote
                  key={passage.id}
                  id={`passage-${passage.id}`}
                  ref={passage.id === selectedPassageId ? selectedPassageRef : undefined}
                  className={cn(
                    "rounded-md border p-3 text-sm scroll-mt-4",
                    passage.id === selectedPassageId
                      ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                      : "border-border",
                  )}
                >
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {passage.ref}
                  </span>
                  {passage.text}
                </blockquote>
              ))
            )}
          </div>
        </section>
      ) : null}

      <section className="mb-6">
        <h2 className="text-lg font-medium">Timeline</h2>
        <p className="text-sm text-muted-foreground">
          Ordered by what the documents say. Events with no date, or with sources that disagree,
          are kept separate rather than placed on a guessed day.
        </p>
        <div className="mt-3 space-y-2">
          {(timeline.data?.timeline.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No dated events yet.</p>
          ) : (
            timeline.data?.timeline.map((event) => (
              <div key={event.id} className="flex gap-3 rounded-lg border border-border p-3">
                <span className="w-28 shrink-0 text-sm font-medium">
                  {event.eventDate ?? "—"}
                </span>
                <span className="text-sm">{event.statement}</span>
              </div>
            ))
          )}
          {(timeline.data?.undated.length ?? 0) > 0 ? (
            <div className="rounded-lg border border-dashed border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                No determinable date
              </p>
              <ul className="mt-1 space-y-1 text-sm">
                {timeline.data?.undated.map((event) => (
                  <li key={event.id}>{event.statement}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mb-6" id="claims" tabIndex={-1}>
        <h2 className="text-lg font-medium">Claims</h2>
        <p className="text-sm text-muted-foreground">
          Every claim shows where it came from and whether a person has accepted it.
        </p>
        <div className="mt-3 space-y-2">
          {data.claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No claims yet. Read the documents, then analyse them.
            </p>
          ) : (
            data.claims.map((claim) => (
              <FindingCard
                key={claim.id}
                finding={claim}
                evidenceById={evidenceById}
                onReview={(findingId, reviewStatus) =>
                  updateFinding.mutate({ caseId, findingId, reviewStatus })
                }
                onCorrectDate={(findingId, date) =>
                  updateFinding.mutate({
                    caseId,
                    findingId,
                    eventDate: date.trim() ? date.trim() : null,
                    datePrecision: "day",
                  })
                }
                onSelectEvidence={(evidenceId, passageId) => {
                  setSelectedEvidenceId(evidenceId);
                  setSelectedPassageId(passageId);
                }}
              />
            ))
          )}
        </div>
      </section>

      <section id="events" tabIndex={-1}>
        <h2 className="text-lg font-medium">Events</h2>
        <div className="mt-3 space-y-2">
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            data.events.map((event) => (
              <FindingCard
                key={event.id}
                finding={event}
                evidenceById={evidenceById}
                onReview={(findingId, reviewStatus) =>
                  updateFinding.mutate({ caseId, findingId, reviewStatus })
                }
                onCorrectDate={(findingId, date) =>
                  updateFinding.mutate({
                    caseId,
                    findingId,
                    eventDate: date.trim() ? date.trim() : null,
                    datePrecision: "day",
                  })
                }
                onSelectEvidence={(evidenceId, passageId) => {
                  setSelectedEvidenceId(evidenceId);
                  setSelectedPassageId(passageId);
                }}
              />
            ))
          )}
        </div>
      </section>

      <ActivityPanel caseId={caseId} />

      <NotesPanel caseId={caseId} />

      <Label className="mt-8 block text-xs text-muted-foreground">
        Case id: {data.case.id}
      </Label>
    </div>
  );
}

export default CaseWorkspace;
