import { useActionMutation, useActionQuery } from "@agent-native/core/client/use-action";
import { useRef, useState } from "react";
import { Link } from "react-router";

import type {
  CaseStatus,
  EvidenceCategory,
} from "@shared/casefile/types";

import { ProvenanceBadge, ReviewBadge, StatusPill } from "@/components/casefile/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CASES_PATH } from "@/lib/casefile-paths";
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
 */
export const ANALYSIS_TIMEOUT_MS = 5 * 60_000;

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  onDelete,
}: {
  item: EvidenceItem;
  onCategorize: (evidenceId: string, category: string) => void;
  onDelete: (evidenceId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const extraction = item.extractionStatus;

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
}: {
  finding: Claim | EventItem;
  evidenceById: Map<string, EvidenceItem>;
  onReview: (findingId: string, reviewStatus: "confirmed" | "rejected") => void;
  onCorrectDate: (findingId: string, date: string) => void;
}) {
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState("");
  const isEvent = "eventDate" in finding;
  const event = finding as EventItem;
  const unsupported = finding.citations.length === 0;

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
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
              <span className="ms-1 opacity-80">
                — {evidenceById.get(citation.evidenceId)?.filename ?? "a source document"}
              </span>
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

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState<EvidenceCategory>("receipt");

  const detail = useActionQuery<CaseDetail>("get-case", { caseId });
  const status = useActionQuery<InvestigationStatus>("get-investigation-status", { caseId });
  const timeline = useActionQuery<{ timeline: EventItem[]; undated: EventItem[]; counts: { undated: number; conflicting: number } }>(
    "build-timeline",
    { caseId },
  );

  const invalidate = () => {
    void detail.refetch();
    void status.refetch();
    void timeline.refetch();
  };

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

  const analyze = useActionMutation("analyze-evidence", {
    // Analysis runs a model over every extracted passage, which routinely
    // exceeds the client's 60s default. Without this the request is aborted
    // while the server is still working, and the proposals are lost.
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onSuccess: (result: { claimsProposed: number; eventsProposed: number }) => {
      setNotice(
        `Proposed ${result.claimsProposed} claim(s) and ${result.eventsProposed} event(s). ` +
          "Nothing is confirmed until you confirm it.",
      );
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateFinding = useActionMutation("update-finding", {
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const categorize = useActionMutation("categorize-evidence", {
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
        </div>
      </header>

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

      <section className="mb-6">
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
              accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.log,.md"
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
            onClick={() => analyze.mutate({ caseId })}
            disabled={analyze.isPending || investigation?.evidence.extracted === 0}
          >
            {analyze.isPending ? "Analysing…" : "Analyse the evidence"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Analysis proposes; it never confirms.
          </span>
        </div>
      </section>

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

      <section className="mb-6">
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
              />
            ))
          )}
        </div>
      </section>

      <section>
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
              />
            ))
          )}
        </div>
      </section>

      <Label className="mt-8 block text-xs text-muted-foreground">
        Case id: {data.case.id}
      </Label>
    </div>
  );
}

export default CaseWorkspace;
