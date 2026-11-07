import { defineAction } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import {
  amountKey,
  detectAmounts,
  detectDates,
  detectParties,
  detectReferences,
  partyKey,
} from "../server/casefile/entities.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reads the entities a case's documents introduce: the parties a document names,
 * the references (transaction, order, invoice, case number, …) it cites, the
 * amounts it states, and the dates it records.
 *
 * Entity resolution here is deterministic and explicit: two mentions are the
 * same entity only when they normalise to the same key (see `entities.ts`), never
 * because the words look similar. Each resolved entity keeps the passages that
 * mention it, so every row in the Entities view resolves to a real position in a
 * real document. Nothing is written.
 */

const MAX_SOURCES_PER_ENTITY = 8;

interface SourceRef {
  evidenceId: string;
  filename: string;
  passageId: string;
  quote: string;
}

interface EntityGroup {
  key: string;
  label: string;
  /** Mention count across the whole case, before the per-entity cap. */
  mentions: number;
  sources: SourceRef[];
}

/** Adds a mention to a group, keeping the source list bounded and de-duplicated. */
function addMention(
  groups: Map<string, EntityGroup>,
  key: string,
  label: string,
  source: SourceRef,
): void {
  const group = groups.get(key) ?? { key, label, mentions: 0, sources: [] };
  group.mentions += 1;
  const seen = group.sources.some(
    (existing) => existing.passageId === source.passageId && existing.quote === source.quote,
  );
  if (!seen && group.sources.length < MAX_SOURCES_PER_ENTITY) group.sources.push(source);
  groups.set(key, group);
}

function quoteFor(text: string, index: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + 120);
  const snippet = text.slice(start, end).trim().replace(/\s+/g, " ");
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

export default defineAction({
  description:
    "List the entities a case's documents introduce: named parties, references (transaction, order, invoice, case, policy, contract), amounts, and dates, each with the passages that mention it. Entity resolution is deterministic — mentions are the same entity only when they normalise to the same key, never by name similarity. Read-only.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose entities to read."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const passages = await db
      .select({
        id: schema.evidencePassages.id,
        evidenceId: schema.evidencePassages.evidenceId,
        text: schema.evidencePassages.text,
        filename: schema.evidence.filename,
      })
      .from(schema.evidencePassages)
      .innerJoin(
        schema.evidence,
        eq(schema.evidence.id, schema.evidencePassages.evidenceId),
      )
      .where(
        and(
          eq(schema.evidencePassages.caseId, ownedCase.id),
          eq(schema.evidencePassages.ownerEmail, userEmail),
        ),
      )
      .orderBy(asc(schema.evidencePassages.evidenceId), asc(schema.evidencePassages.ordinal));

    const parties = new Map<string, EntityGroup>();
    const references = new Map<string, EntityGroup>();
    const amounts = new Map<string, EntityGroup>();
    const dates = new Map<string, EntityGroup>();

    for (const passage of passages) {
      const source = (quote: string): SourceRef => ({
        evidenceId: passage.evidenceId,
        filename: passage.filename,
        passageId: passage.id,
        quote,
      });

      for (const party of detectParties(passage.text)) {
        addMention(
          parties,
          partyKey(party),
          `${party.text} (${party.label})`,
          source(quoteFor(passage.text, party.index)),
        );
      }
      for (const reference of detectReferences(passage.text)) {
        // Group by the normalised value, not by every key the reference yields,
        // so "TXN-44710298" is one entity rather than one per key shape.
        const key = reference.value.toUpperCase().replace(/\s+/g, "");
        addMention(
          references,
          key,
          `${reference.value} (${reference.kind})`,
          source(quoteFor(passage.text, reference.index)),
        );
      }
      for (const amount of detectAmounts(passage.text)) {
        addMention(
          amounts,
          amountKey(amount),
          `${amount.text}${amount.currency ? ` ${amount.currency}` : ""}`,
          source(quoteFor(passage.text, amount.index)),
        );
      }
      for (const date of detectDates(passage.text)) {
        if (!date.iso) continue;
        addMention(dates, date.iso, date.text, source(quoteFor(passage.text, date.index)));
      }
    }

    const sortByMentions = (groups: Map<string, EntityGroup>): EntityGroup[] =>
      [...groups.values()].sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label));

    return {
      caseId: ownedCase.id,
      counts: {
        documents: new Set(passages.map((passage) => passage.evidenceId)).size,
        passages: passages.length,
        parties: parties.size,
        references: references.size,
        amounts: amounts.size,
        dates: dates.size,
      },
      parties: sortByMentions(parties),
      references: sortByMentions(references),
      amounts: sortByMentions(amounts),
      dates: [...dates.values()].sort((a, b) => a.key.localeCompare(b.key)),
      note: "Entities are resolved from shared identifiers only. Two names that merely look alike are not merged.",
    };
  },
});
