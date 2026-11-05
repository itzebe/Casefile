import { defineAction } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import {
  DOMAINS,
  analyzeDomainPassages,
  summariseDomains,
  type Domain,
} from "../server/casefile/domains.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reads the case's extracted passages and labels the domain-specific statements
 * in them: what is a judicial finding versus a party's allegation, an invoiced
 * amount versus a received one, an obligation versus a deliverable, and so on.
 *
 * This is deterministic and derived on read, so it is never stale and never
 * disagrees with the text it cites. It proposes nothing the reviewer must
 * accept; it labels what the documents already say.
 */
export default defineAction({
  description:
    "Analyse a case's documents for their field-specific content: legal findings vs party allegations vs witness assertions, financial amounts by role (requested/invoiced/transferred/received/refunded/balance), contract obligations and terms, medical observations vs conclusions, and research claims vs methods vs results. Returns each labelled sentence with its source locator.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to analyse."),
    domain: z
      .enum(DOMAINS)
      .optional()
      .describe("Limit the result to one domain. Omit for every domain."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const rows = await db
      .select({
        passageId: schema.evidencePassages.id,
        evidenceId: schema.evidencePassages.evidenceId,
        ref: schema.evidencePassages.ref,
        text: schema.evidencePassages.text,
        filename: schema.evidence.filename,
        documentType: schema.evidence.documentType,
      })
      .from(schema.evidencePassages)
      .innerJoin(schema.evidence, eq(schema.evidence.id, schema.evidencePassages.evidenceId))
      .where(
        and(
          eq(schema.evidencePassages.caseId, ownedCase.id),
          eq(schema.evidencePassages.ownerEmail, userEmail),
        ),
      )
      .orderBy(asc(schema.evidencePassages.evidenceId), asc(schema.evidencePassages.ordinal));

    const all = analyzeDomainPassages(
      rows.map((row) => ({
        evidenceId: row.evidenceId,
        filename: row.filename,
        passageId: row.passageId,
        ref: row.ref,
        text: row.text,
        documentType: row.documentType,
      })),
    );

    const findings = args.domain
      ? all.filter((finding) => finding.domain === (args.domain as Domain))
      : all;

    return {
      caseId: ownedCase.id,
      findings,
      summary: summariseDomains(findings),
      counts: { total: findings.length },
    };
  },
});
