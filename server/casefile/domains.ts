import { detectAmounts, detectDates } from "./entities.js";

/**
 * Specialised document intelligence.
 *
 * The shared evidence engine (entities, comparison, graph) is domain-neutral.
 * This module adds document-specific understanding on top of it, without a
 * separate application per industry: one sentence classifier that labels what a
 * statement *is* in its own field.
 *
 * The rules that matter most are the ones that stop the app overstating a
 * document:
 *
 *  - Legal: a judgment that recites a party's argument must not read as the
 *    court's own conclusion. The classifier distinguishes an allegation by a
 *    party, a witness's assertion, counsel's argument, a judicial finding, and
 *    an operative order, and attributes each to the speaker the text names.
 *  - Financial: an invoice is not a payment. The classifier distinguishes the
 *    amount requested, invoiced, transferred, received, refunded, and the
 *    outstanding balance, so "invoiced" can never be read as "paid".
 *  - Medical: a recorded observation, a reported symptom, a professional
 *    conclusion, and a hedged interpretation are different things.
 *  - Research: a claim, a method, a result, and a citation are different things.
 *
 * Everything is deterministic and sentence-level, so a reviewer can see the
 * exact sentence that produced each label.
 */

export const DOMAINS = [
  "legal",
  "financial",
  "contract",
  "medical",
  "research",
  "general",
] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<Domain, string> = {
  legal: "Legal",
  financial: "Financial",
  contract: "Contract",
  medical: "Medical",
  research: "Research",
  general: "General",
};

/**
 * Domain-specific roles. Kept as a single flat vocabulary so the UI can render
 * one table, while the domain field keeps the categories from colliding.
 */
export type DomainRole =
  // legal
  | "judicial-finding"
  | "court-order"
  | "counsel-argument"
  | "party-allegation"
  | "witness-assertion"
  | "recited-fact"
  // financial
  | "amount-requested"
  | "amount-invoiced"
  | "amount-transferred"
  | "amount-received"
  | "amount-refunded"
  | "outstanding-balance"
  // contract
  | "obligation"
  | "deliverable"
  | "deadline"
  | "payment-terms"
  | "renewal-term"
  | "termination-term"
  | "amendment"
  // medical
  | "recorded-observation"
  | "reported-symptom"
  | "professional-conclusion"
  | "hedged-interpretation"
  // research
  | "research-claim"
  | "research-method"
  | "research-result"
  | "source-reference"
  | "publication-date"
  // general (domain-neutral)
  | "recorded-fact"
  | "stated-belief"
  | "instruction"
  | "commitment"
  | "identified-question";

export const ROLE_LABELS: Record<DomainRole, string> = {
  "judicial-finding": "Judicial finding",
  "court-order": "Court order",
  "counsel-argument": "Counsel's argument",
  "party-allegation": "Party allegation",
  "witness-assertion": "Witness assertion",
  "recited-fact": "Recited fact",
  "amount-requested": "Amount requested",
  "amount-invoiced": "Amount invoiced",
  "amount-transferred": "Amount transferred",
  "amount-received": "Amount received",
  "amount-refunded": "Amount refunded",
  "outstanding-balance": "Outstanding balance",
  obligation: "Obligation",
  deliverable: "Deliverable",
  deadline: "Deadline",
  "payment-terms": "Payment terms",
  "renewal-term": "Renewal term",
  "termination-term": "Termination term",
  amendment: "Amendment",
  "recorded-observation": "Recorded observation",
  "reported-symptom": "Reported symptom",
  "professional-conclusion": "Professional conclusion",
  "hedged-interpretation": "Hedged interpretation",
  "research-claim": "Research claim",
  "research-method": "Research method",
  "research-result": "Research result",
  "source-reference": "Source reference",
  "publication-date": "Publication date",
  "recorded-fact": "Recorded fact",
  "stated-belief": "Stated belief",
  instruction: "Instruction",
  commitment: "Commitment",
  "identified-question": "Open question",
};

export interface DomainFinding {
  id: string;
  domain: Domain;
  role: DomainRole;
  /** The sentence this label applies to, exactly as written. */
  statement: string;
  evidenceId: string;
  filename: string;
  passageId: string;
  /** Human-readable locator: the passage ref plus the sentence number. */
  ref: string;
  quote: string;
  /** The party or speaker the statement is attributed to, when the text names one. */
  attributedTo: string | null;
  /** Amounts the sentence states, as minor-unit keys with their text. */
  amounts: Array<{ text: string; minor: number; currency: string | null }>;
  /** Dates the sentence states. */
  dates: Array<{ text: string; iso: string | null }>;
  confidence: "high" | "medium" | "low";
  /** The rule that produced this label, for explainability. */
  rule: string;
}

interface DomainRule {
  domain: Domain;
  role: DomainRole;
  re: RegExp;
  /** A rule with a higher priority wins when several match one sentence. */
  priority: number;
  confidence: "high" | "medium" | "low";
  rule: string;
  /** Whether to try to name the speaker from the sentence. */
  attribution?: RegExp;
}

/**
 * Legal rules, ordered most-specific first. An operative order outranks a
 * finding; a finding outranks counsel's argument; an attributed statement
 * outranks an unattributed one, so a judgment's recital of an argument is not
 * misread as the court's own view.
 */
const LEGAL_RULES: DomainRule[] = [
  {
    domain: "legal",
    role: "court-order",
    re: /\b(?:it is (?:hereby )?ordered|the court orders|i (?:hereby )?order|it is (?:hereby )?directed|the court directs|directions? (?:are|is) (?:given|made))\b/i,
    priority: 100,
    confidence: "high",
    rule: "operative order language",
  },
  {
    domain: "legal",
    role: "judicial-finding",
    re: /\b(?:the court (?:finds|found|holds|held|is satisfied|concludes|concluded|determines|determined|accepts|accepted|rejects|rejected|notes|noted|observes|observed|is not satisfied)|i find that|i am satisfied that|it is (?:found|held) that|the (?:tribunal|judge) (?:finds|found|holds|held))\b/i,
    priority: 90,
    confidence: "high",
    rule: "the court's own finding",
  },
  {
    domain: "legal",
    role: "counsel-argument",
    re: /\b(?:counsel (?:for|submits?|submitted|argues?|argued|contends?|contended|says|said)|(?:the )?(?:claimant|defendant|appellant|respondent)'?s? (?:counsel|advocate|solicitor|attorney|representative)|(?:the )?(?:claimant|defendant|appellant|respondent) (?:submits?|submitted|argues?|argued|contends?|contended)|it (?:was|is) (?:submitted|argued|contended) (?:on behalf|that))\b/i,
    priority: 70,
    confidence: "high",
    rule: "counsel's submission",
    attribution: /\b(?:counsel for the (claimant|defendant|appellant|respondent)|the (claimant|defendant|appellant|respondent)'?s? (?:counsel|advocate|solicitor|attorney))\b/i,
  },
  {
    domain: "legal",
    role: "party-allegation",
    re: /\b(?:the (?:claimant|plaintiff|defendant|petitioner|respondent|appellant) (?:alleges?|alleged|asserts?|asserted|claims?|claimed|avers?|aversed|denies|denied|admits?|admitted|states?|stated)|it is alleged|the prosecution alleges?)\b/i,
    priority: 60,
    confidence: "high",
    rule: "a party's own assertion",
    attribution: /\bthe (claimant|plaintiff|defendant|petitioner|respondent|appellant|prosecution)\b/i,
  },
  {
    domain: "legal",
    role: "witness-assertion",
    re: /\b(?:i (?:saw|heard|observed|witnessed|was present|did not see|do not recall)|the witness (?:stated|said|testified|recalls?|described)|in (?:his|her|their) (?:witness )?statement|the witness's (?:evidence|account))\b/i,
    priority: 55,
    confidence: "medium",
    rule: "witness evidence language",
  },
  {
    domain: "legal",
    role: "recited-fact",
    re: /\b(?:background|the facts|it is common ground|the parties agree that|on \d{1,2} \w+ \d{4}|the (?:claimant|defendant) (?:entered|signed|paid))\b/i,
    priority: 10,
    confidence: "low",
    rule: "background narration",
  },
];

/**
 * Financial rules. The distinguishing words are the verbs, because that is what
 * separates a request from a transfer from a receipt: "requested", "invoiced",
 * "transferred", "received", "refunded".
 */
const FINANCIAL_RULES: DomainRule[] = [
  {
    domain: "financial",
    role: "amount-refunded",
    re: /\b(?:refund(?:ed|ing)?|reversed|credited back|chargeback|money back|reimburs(?:ed|ement))\b/i,
    priority: 90,
    confidence: "high",
    rule: "refund or reversal language",
  },
  {
    domain: "financial",
    role: "outstanding-balance",
    re: /\b(?:outstanding|balance (?:due|remaining|owing)|arrears|unpaid|still owed|overdue)\b/i,
    priority: 80,
    confidence: "high",
    rule: "outstanding balance language",
  },
  {
    domain: "financial",
    role: "amount-received",
    re: /\b(?:received|credited|paid in|deposited|cleared|settled in full|we have been paid)\b/i,
    priority: 70,
    confidence: "high",
    rule: "receipt of funds language",
  },
  {
    domain: "financial",
    role: "amount-transferred",
    re: /\b(?:transferred|remitted|sent|paid out|debited|withdrawn|wired)\b/i,
    priority: 60,
    confidence: "high",
    rule: "transfer of funds language",
  },
  {
    domain: "financial",
    role: "amount-invoiced",
    re: /\b(?:invoice[d]?|billed|amount due|invoiced|charged to|billing)\b/i,
    priority: 50,
    confidence: "high",
    rule: "invoicing language",
  },
  {
    domain: "financial",
    role: "amount-requested",
    re: /\b(?:request(?:ed|ing)?|sought|demand(?:ed|ing)?|asking for|claim(?:ed|ing)? (?:the sum|for)|please (?:refund|pay|reimburse))\b/i,
    priority: 40,
    confidence: "medium",
    rule: "request for payment language",
  },
];

const CONTRACT_RULES: DomainRule[] = [
  {
    domain: "contract",
    role: "amendment",
    re: /\b(?:amendment|amended|variation|varied|supplemental|addendum|revised terms|as amended)\b/i,
    priority: 80,
    confidence: "high",
    rule: "amendment language",
  },
  {
    domain: "contract",
    role: "termination-term",
    re: /\b(?:terminat(?:e|ion|ed)|may be cancelled|cancellation|notice period|expiry of the term)\b/i,
    priority: 70,
    confidence: "high",
    rule: "termination language",
  },
  {
    domain: "contract",
    role: "renewal-term",
    re: /\b(?:renew(?:s|al|ed)?|automatically (?:extend|renew)|rolling (?:term|period)|successive (?:term|period))\b/i,
    priority: 65,
    confidence: "high",
    rule: "renewal language",
  },
  {
    domain: "contract",
    role: "payment-terms",
    re: /\b(?:payment terms|payable (?:within|on|in)|net \d+|\d+ days (?:from|of) (?:the )?invoice|interest (?:shall accrue|on late))\b/i,
    priority: 60,
    confidence: "high",
    rule: "payment terms language",
  },
  {
    domain: "contract",
    role: "deadline",
    re: /\b(?:no later than|on or before|by \d{1,2} \w+ \d{4}|within \d+ (?:days|weeks|months|business days)|deadline|due (?:on|by))\b/i,
    priority: 50,
    confidence: "medium",
    rule: "deadline language",
  },
  {
    domain: "contract",
    role: "deliverable",
    re: /\b(?:deliver(?:able|ables|y|ies)|milestone|statement of work|scope of work|work product|shall (?:provide|supply|deliver))\b/i,
    priority: 45,
    confidence: "medium",
    rule: "deliverable language",
  },
  {
    domain: "contract",
    role: "obligation",
    re: /\b(?:shall|must|agrees? to|is (?:required|obliged|obligated) to|undertakes? to|responsible for|will (?:provide|pay|perform|deliver))\b/i,
    priority: 30,
    confidence: "medium",
    rule: "obligation language",
  },
];

const MEDICAL_RULES: DomainRule[] = [
  {
    domain: "medical",
    role: "reported-symptom",
    re: /\b(?:patient (?:reports?|complains?|described|states|denies)|reports? (?:of|feeling|pain)|complains? of|history of|presented with (?:a )?(?:complaint|pain))\b/i,
    priority: 80,
    confidence: "high",
    rule: "patient-reported symptom",
  },
  {
    domain: "medical",
    role: "recorded-observation",
    re: /\b(?:examination (?:revealed|showed|found|was)|on examination|observed|vital signs|blood pressure|heart rate|recorded|measured|no (?:evidence|sign) of)\b/i,
    priority: 70,
    confidence: "high",
    rule: "recorded clinical observation",
  },
  {
    domain: "medical",
    role: "professional-conclusion",
    re: /\b(?:diagnosis|diagnosed|clinical impression|in my (?:clinical )?(?:opinion|view)|findings? (?:are|were|is) consistent with|the impression is|confirmed (?:diagnosis|fracture|infection))\b/i,
    priority: 60,
    confidence: "high",
    rule: "professional conclusion",
  },
  {
    domain: "medical",
    role: "hedged-interpretation",
    re: /\b(?:suggests?|may indicate|might|could be|likely|appears to|possible|probable)\b/i,
    priority: 30,
    confidence: "low",
    rule: "hedged interpretation",
  },
];

const RESEARCH_RULES: DomainRule[] = [
  {
    domain: "research",
    role: "source-reference",
    re: /(?:et al\.|doi:\s*\S+|https?:\/\/\S+|\breferences?\b|\bbibliography\b|\bcite[ds]?\b|\([A-Z][a-z]+,\s*\d{4}\))/i,
    priority: 80,
    confidence: "high",
    rule: "citation or reference",
  },
  {
    domain: "research",
    role: "research-method",
    re: /\b(?:methodolog|method(?:s)? (?:were|was|used)|we (?:sampled|surveyed|measured|analysed|analyzed|collected|recruited)|participants were|sample size|dataset|randomi[sz]ed)\b/i,
    priority: 70,
    confidence: "high",
    rule: "method description",
  },
  {
    domain: "research",
    role: "research-result",
    re: /\b(?:results? (?:show|showed|indicate|indicated|revealed)|we (?:found|observed|demonstrate)|significan(?:t|ce)|p\s*[<=>]\s*0?\.\d+|\d+(?:\.\d+)?\s*% of)\b/i,
    priority: 60,
    confidence: "high",
    rule: "result statement",
  },
  {
    domain: "research",
    role: "research-claim",
    re: /\b(?:we (?:argue|claim|propose|hypothesi[sz]e|suggest|contend)|this (?:paper|study|article) (?:argues|claims|shows|demonstrates|proposes)|it is (?:argued|proposed|hypothesi[sz]ed))\b/i,
    priority: 50,
    confidence: "medium",
    rule: "research claim",
  },
];

/**
 * Domain-neutral rules. These are the "general documents" mode: they name what
 * a sentence is doing without asserting a field. They are kept out of
 * `ALL_RULES` and consulted only when no specialist rule fires, so a legal
 * judgment is not also labelled a generic "recorded fact" and a financial
 * statement is not also labelled a generic "commitment". A general label is
 * always the weakest claim the engine can make about a sentence.
 */
const GENERAL_RULES: DomainRule[] = [
  {
    domain: "general",
    role: "instruction",
    re: /\b(?:please|kindly|you (?:must|should|are required to)|i (?:direct|instruct|require) (?:you|that)|instructions? (?:are|is)|hereby instructed)\b/i,
    priority: 6,
    confidence: "medium",
    rule: "an instruction to act",
  },
  {
    domain: "general",
    role: "commitment",
    re: /\b(?:i (?:will|shall|promise|undertake|agree to)|we (?:will|shall|promise|undertake|agree to)|(?:will|shall) (?:deliver|pay|provide|send|complete|arrange)|agreed to|undertakes? to)\b/i,
    priority: 5,
    confidence: "medium",
    rule: "a promise or undertaking",
  },
  {
    domain: "general",
    role: "stated-belief",
    re: /\b(?:i (?:believe|think|understand|assume|expect|recall)|we (?:believe|think|understand|assume|expect|recall)|in my (?:view|opinion)|it (?:seems|appears) (?:to me |that )|as far as i (?:know|am aware))\b/i,
    priority: 4,
    confidence: "low",
    rule: "a stated belief or recollection",
  },
  {
    domain: "general",
    role: "identified-question",
    re: /\b(?:unclear|uncertain|not (?:known|clear)|remains? (?:unclear|unknown|open)|question of|unresolved|to be (?:confirmed|determined|established)|cannot be (?:confirmed|determined))\b/i,
    priority: 3,
    confidence: "low",
    rule: "an open or unresolved point",
  },
  {
    domain: "general",
    role: "recorded-fact",
    re: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}|(?:was|were|has been|have been|is|are) (?:sent|received|signed|issued|recorded|dated|created|paid|completed))\b/i,
    priority: 2,
    confidence: "low",
    rule: "a dated or state record",
  },
];

const ALL_RULES: DomainRule[] = [
  ...LEGAL_RULES,
  ...FINANCIAL_RULES,
  ...CONTRACT_RULES,
  ...MEDICAL_RULES,
  ...RESEARCH_RULES,
];

/**
 * Splits a passage into sentences, preserving order. A sentence is the unit
 * because a label like "the court finds" applies to one sentence, not a whole
 * page.
 */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (!normalised) return [];
  // Split after ., !, or ? when followed by a space and a capital, but not
  // inside an obvious abbreviation or a decimal number.
  const protectedText = normalised
    .replace(/\b(Mr|Mrs|Ms|Dr|No|vs|etc|Ltd|Inc|Co|Corp|St|Hon|Ex)\./gi, "$1<DOT>")
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2");
  const parts = protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map((part) => part.replace(/<DOT>/g, ".").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [normalised];
}

/** The speaker a statement is attributed to, if the sentence names one. */
function attribute(sentence: string, rule: DomainRule): string | null {
  if (rule.attribution) {
    const match = rule.attribution.exec(sentence);
    if (match) {
      const found = match.slice(1).find(Boolean);
      if (found) return found.toLowerCase();
    }
  }
  const generic = /\b(?:by|of|for) the (claimant|plaintiff|defendant|petitioner|respondent|appellant|witness|court|patient|insurer)\b/i.exec(
    sentence,
  );
  return generic?.[1]?.toLowerCase() ?? null;
}

export interface DomainPassageInput {
  evidenceId: string;
  filename: string;
  passageId: string;
  ref: string;
  text: string;
  documentType?: string | null;
}

/**
 * Labels every sentence of every passage with at most one domain role: the
 * highest-priority rule that fires. A sentence that matches no rule is simply
 * not labelled, rather than forced into a role.
 */
export function analyzeDomainPassages(passages: DomainPassageInput[]): DomainFinding[] {
  const findings: DomainFinding[] = [];
  let counter = 0;

  for (const passage of passages) {
    const sentences = splitSentences(passage.text);
    sentences.forEach((sentence, index) => {
      const specialist = ALL_RULES.filter((rule) => rule.re.test(sentence)).sort(
        (a, b) => b.priority - a.priority,
      );
      // A financial rule needs a number to be about: "received" in prose is not
      // a receipt. A rule that matches the words but has no amount to apply to
      // does not count as having recognised the sentence, so the sentence is
      // still eligible for a domain-neutral label.
      const applicableSpecialist = specialist.filter(
        (rule) => !(rule.domain === "financial" && detectAmounts(sentence).length === 0),
      );
      // The domain-neutral rules are the fallback: they apply only when no
      // field-specific rule recognised the sentence, so a general label never
      // competes with, or dilutes, a specialist one.
      const applicable =
        applicableSpecialist.length > 0
          ? applicableSpecialist
          : GENERAL_RULES.filter((rule) => rule.re.test(sentence));
      if (applicable.length === 0) return;

      // A sentence can carry more than one distinct fact: "The supplier shall
      // deliver by 30 June" states an obligation *and* a deadline. Emit the
      // top rule per (domain, role), so a sentence is not collapsed to one
      // label, while a role is not duplicated from two overlapping rules.
      const seenRoles = new Set<string>();
      for (const chosen of applicable) {
        const roleKey = `${chosen.domain}:${chosen.role}`;
        if (seenRoles.has(roleKey)) continue;

        const amounts = detectAmounts(sentence).map((amount) => ({
          text: amount.text,
          minor: amount.minor,
          currency: amount.currency,
        }));
        // Belt and braces: the filter above already removed a financial rule
        // with no amount, but never emit a financial label without a number.
        if (chosen.domain === "financial" && amounts.length === 0) continue;
        seenRoles.add(roleKey);

        counter += 1;
        findings.push({
          id: `df_${counter}`,
          domain: chosen.domain,
          role: chosen.role,
          statement: sentence,
          evidenceId: passage.evidenceId,
          filename: passage.filename,
          passageId: passage.passageId,
          ref: `${passage.ref}, sentence ${index + 1}`,
          quote: sentence,
          attributedTo: attribute(sentence, chosen),
          amounts,
          dates: detectDates(sentence).map((date) => ({ text: date.text, iso: date.iso })),
          confidence: chosen.confidence,
          rule: chosen.rule,
        });
      }
    });
  }

  return findings;
}

export interface DomainSummary {
  domain: Domain;
  total: number;
  roles: Array<{ role: DomainRole; count: number }>;
}

/** Counts per domain and role, for a summary panel. */
export function summariseDomains(findings: DomainFinding[]): DomainSummary[] {
  return DOMAINS.map((domain) => {
    const inDomain = findings.filter((finding) => finding.domain === domain);
    const roleCounts = new Map<DomainRole, number>();
    for (const finding of inDomain) {
      roleCounts.set(finding.role, (roleCounts.get(finding.role) ?? 0) + 1);
    }
    return {
      domain,
      total: inDomain.length,
      roles: [...roleCounts.entries()]
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count),
    };
  }).filter((summary) => summary.total > 0);
}

/**
 * The legal roles that must never be presented as the court's conclusion. Used
 * by the report and the UI to keep an allegation labelled as an allegation.
 */
export const NON_FINDING_LEGAL_ROLES: DomainRole[] = [
  "party-allegation",
  "counsel-argument",
  "witness-assertion",
  "recited-fact",
];

/** Whether a legal role is the court's own conclusion (as opposed to a claim). */
export function isJudicialConclusion(role: DomainRole): boolean {
  return role === "judicial-finding" || role === "court-order";
}
