import type { ClassificationConfidence, DocumentType } from "../../shared/casefile/types.js";

/**
 * Automatic document classification.
 *
 * The classifier reads the document's own text (and its filename) and decides
 * what kind of document it is. It is deterministic and rule-based, for the same
 * reason the rest of the engine is: a classification a reviewer can re-derive
 * from the text is a classification they can check, and a rule that changes
 * behaviour is a rule a test can pin.
 *
 * Two properties matter more than accuracy on any one document:
 *
 *  - A document that fits no category is `unknown`, not the nearest category.
 *    Forcing a misclassification is worse than admitting uncertainty, because a
 *    wrong type silently changes which analysis runs.
 *  - Confidence is a word, and a single weak signal is `low`. The classifier
 *    only says `high` when several independent signals agree, so `high` means
 *    something.
 *
 * A person can always override the result; this proposes, the user decides.
 */

export interface Classification {
  documentType: DocumentType;
  confidence: ClassificationConfidence;
  /** The signals that produced the result, so a reviewer can see the reasoning. */
  rationale: string[];
  /** A short human-facing reason for the proposal. */
  summary: string;
}

interface Signal {
  type: DocumentType;
  /** A phrase that, found in the text, is strong evidence for this type. */
  phrase: RegExp;
  /** How much this signal counts when it fires. */
  weight: number;
  label: string;
}

/**
 * Ordered so the most specific document types are considered first. A court
 * judgment mentions pleadings and witnesses, so it must be recognised before
 * the more general categories it also matches.
 */
const SIGNALS: Signal[] = [
  {
    type: "court-judgment",
    phrase:
      /\b(?:judgment|judgement)\b[\s\S]{0,40}\b(?:of the court|handed down|hereby ordered|the court finds|in the (?:high|county|supreme|federal|district) court)\b/i,
    weight: 4,
    label: "a judgment of a court",
  },
  {
    type: "court-judgment",
    phrase: /\b(?:the court finds|the court is satisfied|it is adjudged|judgment is entered)\b/i,
    weight: 4,
    label: "the court's own findings",
  },
  {
    type: "court-order",
    phrase: /\b(?:it is (?:hereby )?ordered|by order of the court|this order|the court orders)\b/i,
    weight: 4,
    label: "an operative order",
  },
  {
    type: "affidavit",
    phrase: /\b(?:affidavit|i (?:make oath|solemnly affirm|do solemnly and sincerely affirm)|sworn (?:before|at)|deponent)\b/i,
    weight: 4,
    label: "sworn affidavit language",
  },
  {
    type: "witness-statement",
    phrase: /\b(?:witness statement|statement of witness|my evidence is|i (?:saw|heard|observed) the)\b/i,
    weight: 3,
    label: "witness statement language",
  },
  {
    type: "pleading",
    phrase:
      /\b(?:statement of claim|particulars of claim|defence and counterclaim|the claimant|the plaintiff|the defendant|counsel for|application (?:notice|for permission))\b/i,
    weight: 3,
    label: "pleading and party-role language",
  },
  {
    type: "lab-report",
    phrase: /\b(?:laboratory report|lab result|specimen|assay|reference range|haemoglobin|haematocrit|white cell count)\b/i,
    weight: 4,
    label: "laboratory result language",
  },
  {
    type: "medical-report",
    phrase:
      /\b(?:medical report|clinical (?:note|report)|diagnosis|prognosis|patient|physician|attending doctor|examination findings|treatment plan|prescribed)\b/i,
    weight: 3,
    label: "medical report language",
  },
  {
    type: "insurance-document",
    phrase:
      /\b(?:insurance polic|policy (?:number|holder|schedule)|insured|insurer|claim (?:number|reference)|premium|cover(?:age)? (?:for|under)|excess)\b/i,
    weight: 3,
    label: "insurance policy language",
  },
  {
    type: "bank-statement",
    phrase:
      /\b(?:bank statement|statement period|opening balance|closing balance|account (?:number|holder|statement)|sort code|iban|bic|transactions? (?:listed|in this period))\b/i,
    weight: 4,
    label: "bank statement language",
  },
  {
    type: "payment-confirmation",
    phrase:
      /\b(?:payment (?:received|confirmed|successful|complete)|transfer (?:complete|confirmed)|your payment of|has been (?:paid|sent|received)|confirmation of payment|reference number)\b/i,
    weight: 3,
    label: "payment confirmation language",
  },
  {
    type: "receipt",
    phrase: /\b(?:receipt|till receipt|thank you for your purchase|card ending|approved|auth(?:orisation)? code)\b/i,
    weight: 3,
    label: "receipt language",
  },
  {
    type: "invoice",
    phrase:
      /\b(?:invoice|tax invoice|amount due|invoice (?:number|date|total)|bill to|payment terms|due date|subtotal)\b/i,
    weight: 3,
    label: "invoice language",
  },
  {
    type: "contract",
    phrase:
      /\b(?:agreement|contract|this deed|the parties|clause \d|terms and conditions|hereby agrees|shall be governed by|commencement date|termination|indemnif)\b/i,
    weight: 3,
    label: "contract language",
  },
  {
    type: "research-paper",
    phrase:
      /\b(?:abstract|we (?:present|propose|show|find)|methodology|results|discussion|conclusion|references|doi:|et al\.|literature review|hypothesis)\b/i,
    weight: 3,
    label: "academic paper structure",
  },
  {
    type: "business-report",
    phrase:
      /\b(?:executive summary|quarterly report|annual report|revenue|forecast|kpi|board (?:meeting|report)|financial statements|year[- ]on[- ]year)\b/i,
    weight: 3,
    label: "business reporting language",
  },
  {
    type: "email",
    phrase: /^(?:from|to|subject|date|cc|bcc)\s*:/im,
    weight: 3,
    label: "email header fields",
  },
  {
    type: "email",
    phrase: /\b(?:sent from my|unsubscribe|wrote:|on .{0,30} wrote)\b/i,
    weight: 2,
    label: "message-export language",
  },
  {
    type: "correspondence",
    phrase: /\b(?:dear (?:sir|madam|mr|ms|mrs)|yours (?:sincerely|faithfully)|kind regards|i am writing to|please find (?:attached|enclosed))\b/i,
    weight: 2,
    label: "correspondence language",
  },
];

/** Filename hints, used only to break ties, never on their own. */
const FILENAME_HINTS: Array<{ type: DocumentType; re: RegExp }> = [
  { type: "court-judgment", re: /judg(?:e)?ment/i },
  { type: "court-order", re: /\border\b/i },
  { type: "affidavit", re: /affidavit/i },
  { type: "witness-statement", re: /witness|statement/i },
  { type: "pleading", re: /pleading|claim|counsel|submission/i },
  { type: "invoice", re: /invoice|inv[-_]?\d/i },
  { type: "receipt", re: /receipt/i },
  { type: "bank-statement", re: /statement|bank/i },
  { type: "payment-confirmation", re: /payment|transfer|remittance|confirmation/i },
  { type: "contract", re: /contract|agreement|deed/i },
  { type: "medical-report", re: /medical|clinical|health/i },
  { type: "lab-report", re: /lab|blood|specimen/i },
  { type: "insurance-document", re: /insurance|policy|claim/i },
  { type: "research-paper", re: /paper|preprint|study|research/i },
  { type: "business-report", re: /report|annual|quarterly|board/i },
  { type: "email", re: /email|message|\.eml|mail/i },
];

/**
 * Structural signals: the file's own shape, not its words. A CSV whose header
 * is date/description/amount/balance is a transaction ledger even if it never
 * says "bank statement", so structure can create a category on its own.
 */
function structuralSignals(input: {
  mimeType: string;
  text: string;
}): Array<{ type: DocumentType; weight: number; label: string }> {
  const found: Array<{ type: DocumentType; weight: number; label: string }> = [];
  const isTabular =
    input.mimeType === "text/csv" ||
    input.mimeType.includes("spreadsheetml") ||
    /^[\w ]+(?:,[\w ]+){2,}\n/m.test(input.text);
  if (isTabular) {
    const header = input.text.split("\n")[0]?.toLowerCase() ?? "";
    const transactionColumns = ["date", "description", "amount", "balance", "reference", "debit", "credit"];
    const matched = transactionColumns.filter((column) => header.includes(column));
    if (matched.length >= 3) {
      found.push({
        type: "bank-statement",
        weight: 4,
        label: "a transaction table (date, amount, balance columns)",
      });
    }
    if (header.includes("invoice") || header.includes("amount due")) {
      found.push({ type: "invoice", weight: 3, label: "an invoice table" });
    }
  }
  return found;
}

export function classifyDocument(input: {
  filename: string;
  mimeType: string;
  text: string;
}): Classification {
  const text = input.text.slice(0, 40_000);
  const scores = new Map<DocumentType, { score: number; labels: string[] }>();
  const bump = (type: DocumentType, weight: number, label: string) => {
    const entry = scores.get(type) ?? { score: 0, labels: [] };
    entry.score += weight;
    entry.labels.push(label);
    scores.set(type, entry);
  };

  for (const signal of SIGNALS) {
    if (signal.phrase.test(text)) bump(signal.type, signal.weight, signal.label);
  }

  for (const signal of structuralSignals({ mimeType: input.mimeType, text })) {
    bump(signal.type, signal.weight, signal.label);
  }

  const filenameHint = FILENAME_HINTS.find((hint) => hint.re.test(input.filename));
  if (filenameHint) {
    const entry = scores.get(filenameHint.type);
    // A filename alone never creates a category; it only strengthens one the
    // text already supports.
    if (entry) {
      entry.score += 1;
      entry.labels.push("the filename suggests this type");
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const best = ranked[0];
  if (!best || best[1].score < 2) {
    return {
      documentType: "unknown",
      confidence: "low",
      rationale: best ? best[1].labels : [],
      summary:
        "The document did not match any known document type strongly enough to classify it. Set the type yourself if you know what it is.",
    };
  }

  const [documentType, { score, labels }] = best;
  const runnerUp = ranked[1];
  // Confidence reflects both the strength of the winning score and the margin
  // over the next candidate, so a close call is never reported as high.
  let confidence: ClassificationConfidence = "low";
  if (score >= 4 && (!runnerUp || score - runnerUp[1].score >= 2)) confidence = "high";
  else if (score >= 3) confidence = "medium";

  return {
    documentType,
    confidence,
    rationale: labels,
    summary:
      confidence === "high"
        ? `Looks like a ${documentType.replace(/-/g, " ")} (${labels[0]}).`
        : confidence === "medium"
          ? `Probably a ${documentType.replace(/-/g, " ")} (${labels[0]}), but check it.`
          : `Could be a ${documentType.replace(/-/g, " ")}; the signals are weak.`,
  };
}
