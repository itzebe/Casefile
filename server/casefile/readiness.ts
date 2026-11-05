/**
 * Case readiness assessment.
 *
 * Readiness answers one question a reviewer actually asks: "is this record
 * ready to be turned into a report, and if not, what is missing?" It is
 * deliberately not a score. There is no percentage, no confidence number, and
 * no "case strength" figure, because none of those can be computed honestly
 * from a folder of documents, and a number invites a decision the evidence does
 * not support.
 *
 * Instead, readiness is a small set of named states, each reached by an
 * explicit, testable rule over the case's own record, plus a plain statement of
 * what is established, what is unverified, what is contradicted, what is
 * missing, and what the next step is. A case is never marked ready because a
 * model finished a task; it is ready when its evidence has been read, its
 * findings have been reviewed by a person, and nothing is left in an
 * unreviewable state.
 *
 * This module is pure: it takes counts and flags and returns an assessment, so
 * the rule for each state is visible in one place and a test can pin it.
 */

export const READINESS_STATES = [
  "processing-documents",
  "investigation-in-progress",
  "evidence-incomplete",
  "awaiting-human-review",
  "ready-for-report",
  "report-prepared",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const READINESS_LABELS: Record<ReadinessState, string> = {
  "processing-documents": "Processing documents",
  "investigation-in-progress": "Investigation in progress",
  "evidence-incomplete": "Evidence incomplete",
  "awaiting-human-review": "Awaiting human review",
  "ready-for-report": "Ready for report preparation",
  "report-prepared": "Report prepared",
};

export interface ReadinessInput {
  evidenceTotal: number;
  evidencePending: number;
  evidenceUnreadable: number;
  evidenceRead: number;
  claimTotal: number;
  claimConfirmed: number;
  eventTotal: number;
  eventConfirmed: number;
  proposedTotal: number;
  unsupportedClaimCount: number;
  contradictionCount: number;
  potentialContradictionCount: number;
  gapCount: number;
  /** Whether a report has been generated at least once. */
  reportExists: boolean;
  /** Number of distinct documents that contributed at least one passage. */
  documentsWithText: number;
}

export interface ReadinessAssessment {
  state: ReadinessState;
  label: string;
  /** One sentence stating why the case is in this state. */
  rationale: string;
  established: string[];
  unverified: string[];
  contradicted: string[];
  missing: string[];
  needsReview: string[];
  /** What additional evidence would help, in plain terms. */
  additionalEvidence: string[];
  nextStep: string;
  /** True only when every readiness rule passes. */
  readyForReport: boolean;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function assessReadiness(input: ReadinessInput): ReadinessAssessment {
  const established: string[] = [];
  const unverified: string[] = [];
  const contradicted: string[] = [];
  const missing: string[] = [];
  const needsReview: string[] = [];
  const additionalEvidence: string[] = [];

  if (input.documentsWithText > 0) {
    established.push(
      `${plural(input.documentsWithText, "document")} were read and their text is part of the record.`,
    );
  }
  if (input.claimConfirmed > 0 || input.eventConfirmed > 0) {
    established.push(
      `${plural(input.claimConfirmed + input.eventConfirmed, "finding")} have been confirmed by a reviewer.`,
    );
  }
  if (input.unsupportedClaimCount > 0) {
    unverified.push(
      `${plural(input.unsupportedClaimCount, "assertion")} have no cited source and cannot be checked.`,
    );
  }
  if (input.proposedTotal > 0) {
    unverified.push(
      `${plural(input.proposedTotal, "finding")} are still proposals and have not been reviewed.`,
    );
    needsReview.push(`${plural(input.proposedTotal, "proposed finding")} need a decision.`);
  }
  if (input.contradictionCount > 0) {
    contradicted.push(
      `${plural(input.contradictionCount, "assertion")} directly contradict another.`,
    );
  }
  if (input.potentialContradictionCount > 0) {
    contradicted.push(
      `${plural(
        input.potentialContradictionCount,
        "assertion",
      )} may conflict with another and the evidence does not decide which is right.`,
    );
  }
  if (input.gapCount > 0) {
    missing.push(`${plural(input.gapCount, "piece")} of information are missing from the record.`);
  }
  if (input.evidenceUnreadable > 0) {
    missing.push(
      `${plural(input.evidenceUnreadable, "document")} could not be read, so their contents are not in the record.`,
    );
    additionalEvidence.push(
      "A readable copy (or a text version) of each document that could not be read.",
    );
  }
  if (input.contradictionCount > 0 || input.potentialContradictionCount > 0) {
    additionalEvidence.push(
      "A document that resolves a conflict, such as an original record of the disputed fact.",
    );
  }
  if (input.unsupportedClaimCount > 0) {
    additionalEvidence.push("A source document for each assertion that currently has none.");
  }

  // The state is chosen by the first rule that applies, ordered from "not yet
  // started" to "done", so a case can only be ready when every earlier rule has
  // been passed.
  let state: ReadinessState;
  let rationale: string;
  let nextStep: string;

  if (input.evidenceTotal === 0) {
    state = "evidence-incomplete";
    rationale = "No evidence has been uploaded, so there is nothing to assess.";
    nextStep = "Upload the documents this investigation is about.";
  } else if (input.evidencePending > 0) {
    state = "processing-documents";
    rationale = `${plural(input.evidencePending, "document")} still need text extraction.`;
    nextStep = "Extract the text from the remaining documents.";
  } else if (input.evidenceRead === 0) {
    state = "evidence-incomplete";
    rationale = "No uploaded document could be read, so the record has no usable text.";
    nextStep = "Add a document whose text can be extracted, or a readable copy.";
  } else if (input.proposedTotal > 0) {
    state = "awaiting-human-review";
    rationale = `${plural(
      input.proposedTotal,
      "proposed finding",
    )} are waiting for a person to confirm or reject them.`;
    nextStep = "Review each proposed finding and confirm or reject it.";
  } else if (input.unsupportedClaimCount > 0) {
    state = "evidence-incomplete";
    rationale = `${plural(
      input.unsupportedClaimCount,
      "assertion",
    )} have no cited source, so the record is incomplete.`;
    nextStep = "Attach a source for each assertion that has none, or remove the assertion.";
  } else if (input.reportExists) {
    state = "report-prepared";
    rationale = "A report has been prepared from this record.";
    nextStep = "Review the report, then continue the investigation or treat it as final.";
  } else if (input.claimConfirmed + input.eventConfirmed === 0 && input.claimTotal + input.eventTotal === 0) {
    state = "investigation-in-progress";
    rationale = "The documents have been read, but no findings have been proposed yet.";
    nextStep = "Run the analysis to propose claims and events from the evidence.";
  } else {
    state = "ready-for-report";
    rationale = "Every document has been read and every finding has been reviewed.";
    nextStep = "Generate the investigation report for human review.";
  }

  const readyForReport = state === "ready-for-report" || state === "report-prepared";

  return {
    state,
    label: READINESS_LABELS[state],
    rationale,
    established,
    unverified,
    contradicted,
    missing,
    needsReview,
    additionalEvidence,
    nextStep,
    readyForReport,
  };
}
