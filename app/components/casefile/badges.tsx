import type { Provenance, ReviewStatus } from "@shared/casefile/types";
import { cn } from "@/lib/utils";

/**
 * Provenance and review status are rendered with words as well as colour, so
 * the distinction between a documented fact, a party's assertion, an agent's
 * inference, and an unverified statement survives greyscale, screenshots, and
 * colour-blindness. This is the single most important visual rule in the app.
 */

const PROVENANCE_STYLES: Record<Provenance, string> = {
  documented: "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  asserted: "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  inferred: "border-violet-600/30 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  unverified: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

const PROVENANCE_WORDS: Record<Provenance, string> = {
  documented: "Documented",
  asserted: "Party assertion",
  inferred: "Agent inference",
  unverified: "Unverified",
};

export function ProvenanceBadge({ value }: { value: Provenance | string | null }) {
  const key = (value ?? "unverified") as Provenance;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        PROVENANCE_STYLES[key] ?? PROVENANCE_STYLES.unverified,
      )}
      title="Where this statement came from"
    >
      {PROVENANCE_WORDS[key] ?? value}
    </span>
  );
}

const REVIEW_STYLES: Record<ReviewStatus, string> = {
  proposed: "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  confirmed: "border-emerald-600/40 bg-emerald-600/15 text-emerald-900 dark:text-emerald-200",
  rejected: "border-rose-600/30 bg-rose-500/10 text-rose-800 line-through dark:text-rose-300",
};

export function ReviewBadge({ value }: { value: ReviewStatus | string | null }) {
  const key = (value ?? "proposed") as ReviewStatus;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        REVIEW_STYLES[key] ?? REVIEW_STYLES.proposed,
      )}
      title="Review state set by a person"
    >
      {key === "proposed" ? "Proposed" : key === "confirmed" ? "Confirmed" : "Rejected"}
    </span>
  );
}

/**
 * A confidence level is shown as a word plus a note that it is the model's
 * self-assessment, not a measured probability.
 */
export function ConfidenceBadge({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <span
      className="text-xs text-muted-foreground"
      title="The model's self-assessed confidence, not a measured probability"
    >
      confidence: {value}
    </span>
  );
}

/** Explains a date that is not on an exact day. */
export function PrecisionNote({
  precision,
  conflict,
  text,
}: {
  precision: string | null;
  conflict: boolean;
  text: string | null;
}) {
  if (conflict) {
    return (
      <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
        Sources give conflicting dates
      </span>
    );
  }
  if (!precision || precision === "day") {
    return text ? <span className="text-xs text-muted-foreground">as written: {text}</span> : null;
  }
  if (precision === "unknown") {
    return (
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        No determinable date
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      only {precision}-level precision{text ? ` (as written: ${text})` : ""}
    </span>
  );
}

export function StatusPill({ value }: { value: string }) {
  const styles: Record<string, string> = {
    open: "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
    investigating: "border-violet-600/30 bg-violet-500/10 text-violet-800 dark:text-violet-300",
    review: "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    closed: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  };
  const words: Record<string, string> = {
    open: "Open",
    investigating: "Investigating",
    review: "In review",
    closed: "Closed",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        styles[value] ?? styles.open,
      )}
    >
      {words[value] ?? value}
    </span>
  );
}

const EXTRACTION_STYLES: Record<string, string> = {
  pending: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  processing: "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  complete: "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  unsupported: "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  failed: "border-rose-600/30 bg-rose-500/10 text-rose-800 dark:text-rose-300",
};

const EXTRACTION_WORDS: Record<string, string> = {
  pending: "Not read yet",
  processing: "Reading",
  complete: "Text available",
  unsupported: "Cannot be read",
  failed: "Read failed",
};

export function ExtractionBadge({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        EXTRACTION_STYLES[value] ?? EXTRACTION_STYLES.pending,
      )}
    >
      {EXTRACTION_WORDS[value] ?? value}
    </span>
  );
}
