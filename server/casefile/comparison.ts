import type { ComparisonVerdict } from "../../shared/casefile/types.js";
import {
  amountKey,
  detectAmounts,
  detectDates,
  detectParties,
  detectReferences,
  hasNegation,
  mostSpecificKeys,
  partyKey,
  referenceKeys,
  significantWords,
} from "./entities.js";

/**
 * Cross-document claim comparison.
 *
 * This module is pure: it turns a finding plus the text of the passages it cites
 * into a subject summary, and compares two summaries into a verdict. Nothing
 * here reads the database or calls a model, so the comparison a reviewer sees is
 * the comparison the code computes, and a change in behaviour is a change in
 * this file that a test can pin.
 *
 * The central rule is that a difference is not a contradiction. Two assertions
 * are only compared at all when they are about the same subject - they share an
 * explicit identifier, a stated amount, a named party, or enough of the same
 * words. Only then does the verdict distinguish agreement from conflict, and
 * only an incompatibility (opposite polarity, or the same identifier carrying a
 * different amount or date) is called a contradiction. A difference the
 * evidence cannot resolve is reported as a potential contradiction instead.
 */

/** One side of a comparison: what a finding asserts, reduced to comparable facts. */
export interface FindingSubject {
  id: string;
  kind: "claim" | "event";
  statement: string;
  /** Distinct documents this finding cites. */
  evidenceIds: Set<string>;
  citationCount: number;
  /** Normalised transaction/order/invoice references from cited passages. */
  refKeys: Set<string>;
  /** Amount+currency keys from cited passages. */
  amountKeys: Set<string>;
  /** Day-precision ISO dates from cited passages, plus the event's own date. */
  dates: Set<string>;
  partyKeys: Set<string>;
  words: Set<string>;
  /** Whether the assertion is a denial (one assertion, one denial = conflict). */
  negated: boolean;
}

export interface SubjectInput {
  id: string;
  kind: "claim" | "event";
  statement: string;
  eventDate?: string | null;
  citations: Array<{ evidenceId: string; text: string }>;
}

/**
 * Reduces a finding and its cited passage text to a comparable subject. Only
 * values a document literally contains are collected; nothing is inferred from
 * context, so two findings can only match on something one of them actually
 * says.
 */
export function buildFindingSubject(input: SubjectInput): FindingSubject {
  const evidenceIds = new Set<string>();
  const refKeys = new Set<string>();
  const amountKeys = new Set<string>();
  const dates = new Set<string>();
  const partyKeys = new Set<string>();
  const words = new Set<string>();

  // The finding's own statement is part of the record: it may name the reference,
  // the amount, or the party that a cited passage does not repeat.
  const texts = [input.statement, ...input.citations.map((citation) => citation.text)];

  for (const citation of input.citations) {
    evidenceIds.add(citation.evidenceId);
  }

  for (const text of texts) {
    for (const reference of detectReferences(text)) {
      for (const key of referenceKeys(reference)) refKeys.add(key);
    }
    for (const amount of detectAmounts(text)) {
      amountKeys.add(amountKey(amount));
    }
    for (const date of detectDates(text)) {
      if (date.precision === "day" && date.iso) dates.add(date.iso);
    }
    for (const party of detectParties(text)) {
      partyKeys.add(partyKey(party));
    }
    for (const word of significantWords(text)) words.add(word);
  }

  if (input.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) {
    dates.add(input.eventDate);
  }

  return {
    id: input.id,
    kind: input.kind,
    statement: input.statement,
    evidenceIds,
    citationCount: input.citations.length,
    refKeys,
    amountKeys,
    dates,
    partyKeys,
    words,
    negated: hasNegation(input.statement),
  };
}

export interface Comparison {
  verdict: ComparisonVerdict;
  /** Why the verdict was reached, in a sentence a reviewer can check. */
  reason: string;
  sharedRefs: string[];
  sharedAmounts: string[];
  sharedParties: string[];
  /** Dates each side states, when the two sides disagree. */
  conflictingDates: { a: string[]; b: string[] } | null;
  conflictingAmounts: { a: string[]; b: string[] } | null;
  polarityDiffers: boolean;
  /** How many significant words the two statements share. */
  wordOverlap: number;
  crossDocument: boolean;
}

function intersection(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => b.has(value));
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => !b.has(value));
}

/** A minimum of three shared significant words marks a strong topical link. */
const STRONG_WORD_OVERLAP = 3;

/**
 * Compares two findings. Both must cite at least one passage from a document the
 * other does not, otherwise the pair is not a cross-document comparison and is
 * reported as unrelated.
 */
export function compareFindings(a: FindingSubject, b: FindingSubject): Comparison {
  const crossDocument =
    [...a.evidenceIds].some((id) => !b.evidenceIds.has(id)) ||
    [...b.evidenceIds].some((id) => !a.evidenceIds.has(id));

  const sharedRefs = mostSpecificKeys(intersection(a.refKeys, b.refKeys));
  const sharedAmounts = intersection(a.amountKeys, b.amountKeys);
  const sharedParties = intersection(a.partyKeys, b.partyKeys);
  const sharedDates = intersection(a.dates, b.dates);
  const wordOverlap = intersection(a.words, b.words).length;
  const polarityDiffers = a.negated !== b.negated;

  const aDatesOnly = difference(a.dates, b.dates);
  const bDatesOnly = difference(b.dates, a.dates);
  const conflictingDates =
    a.dates.size > 0 && b.dates.size > 0 && aDatesOnly.length > 0 && bDatesOnly.length > 0
      ? { a: [...a.dates].sort(), b: [...b.dates].sort() }
      : null;

  const aAmountsOnly = difference(a.amountKeys, b.amountKeys);
  const bAmountsOnly = difference(b.amountKeys, a.amountKeys);
  const conflictingAmounts =
    a.amountKeys.size > 0 &&
    b.amountKeys.size > 0 &&
    aAmountsOnly.length > 0 &&
    bAmountsOnly.length > 0
      ? { a: [...a.amountKeys].sort(), b: [...b.amountKeys].sort() }
      : null;

  const base = {
    sharedRefs,
    sharedAmounts,
    sharedParties,
    conflictingDates,
    conflictingAmounts,
    polarityDiffers,
    wordOverlap,
    crossDocument,
  };

  if (a.citationCount === 0 || b.citationCount === 0) {
    return {
      ...base,
      verdict: "insufficient_information",
      reason:
        "At least one of the two assertions has no cited source, so there is nothing to compare it against.",
    };
  }

  if (!crossDocument) {
    return {
      ...base,
      verdict: "unrelated",
      reason: "Both assertions rest on the same document, so this is not a cross-document comparison.",
    };
  }

  // The subject link: what makes these two assertions about the same thing.
  const strongSubject =
    sharedRefs.length > 0 ||
    sharedAmounts.length > 0 ||
    sharedParties.length > 0 ||
    wordOverlap >= STRONG_WORD_OVERLAP;

  if (!strongSubject) {
    // A shared date alone, or one shared word, is too weak to call two
    // assertions related. Reporting it as unrelated avoids the false positives
    // that make a contradiction engine untrustworthy.
    return {
      ...base,
      verdict: "unrelated",
      reason:
        sharedDates.length > 0 || wordOverlap > 0
          ? "The two assertions share only a date or a single word, which is too weak a link to compare them."
          : "The two assertions have no identifier, amount, party, or wording in common.",
    };
  }

  // From here the two are about the same subject, so a difference is meaningful.
  if (polarityDiffers) {
    return {
      ...base,
      verdict: "contradiction",
      reason:
        "The two assertions address the same subject but one affirms it and the other denies it.",
    };
  }

  // An amount is the substance of a financial record, so two different amounts
  // for the same explicit reference is a contradiction rather than a nuance.
  if (conflictingAmounts && sharedRefs.length > 0) {
    return {
      ...base,
      verdict: "contradiction",
      reason: `The same reference is given two different amounts (${aAmountsOnly.join(
        ", ",
      )} versus ${bAmountsOnly.join(", ")}).`,
    };
  }

  // A date difference is reported as a potential contradiction, not a hard one:
  // the same event is routinely recorded on different dates by different systems
  // (a transaction date versus a posting date), so the evidence alone does not
  // establish that the two records disagree about when it happened.
  if (conflictingDates) {
    return {
      ...base,
      verdict: "potential_contradiction",
      reason:
        `The two assertions are about the same subject but state different dates (${aDatesOnly.join(
          ", ",
        )} versus ${bDatesOnly.join(", ")}). This may be a genuine conflict or the same event recorded ` +
        "on different dates, and the evidence does not decide which.",
    };
  }

  if (conflictingAmounts) {
    return {
      ...base,
      verdict: "potential_contradiction",
      reason:
        `The two assertions are about the same subject but state different amounts (${aAmountsOnly.join(
          ", ",
        )} versus ${bAmountsOnly.join(", ")}), and no shared reference fixes which is correct.`,
    };
  }

  if (sharedRefs.length > 0) {
    return {
      ...base,
      verdict: "direct_agreement",
      reason: `Both assertions name the same reference (${sharedRefs.join(
        ", ",
      )}) and do not conflict on amount or date.`,
    };
  }

  return {
    ...base,
    verdict: "partial_agreement",
    reason:
      "The two assertions are about the same subject and do not conflict, but they do not state the same facts.",
  };
}
