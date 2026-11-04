import { defineAction } from "@agent-native/core/action";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase, requireOwnedEvidence } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { evidenceStoreById } from "../server/casefile/evidence-store.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Returns a document's bytes for in-app preview.
 *
 * This is the only read path for evidence content, and it is authorization
 * gated: the caller must own both the case and the file. Nothing here produces
 * a public URL, and the response is marked `private, no-store` so a proxy
 * cannot cache a client's document.
 */
export default defineAction({
  description:
    "Read a document's extracted text passages, or its original bytes for preview. Authorized to the case owner only. Never returns a public URL.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the evidence belongs to."),
    evidenceId: z.string().min(1).describe("The evidence to read."),
    includeBytes: z
      .boolean()
      .default(false)
      .describe("Include base64 bytes of the original file for preview."),
    includePassages: z
      .boolean()
      .default(true)
      .describe("Include the extracted text passages with their locators."),
  }),
  http: { method: "POST" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    await requireOwnedCase(args.caseId, userEmail);
    const row = await requireOwnedEvidence(args.evidenceId, userEmail, args.caseId);
    const db = getDb();

    const passages = args.includePassages
      ? await db
          .select({
            id: schema.evidencePassages.id,
            ordinal: schema.evidencePassages.ordinal,
            locatorType: schema.evidencePassages.locatorType,
            locatorValue: schema.evidencePassages.locatorValue,
            ref: schema.evidencePassages.ref,
            text: schema.evidencePassages.text,
          })
          .from(schema.evidencePassages)
          .where(eq(schema.evidencePassages.evidenceId, row.id))
          .orderBy(asc(schema.evidencePassages.ordinal))
      : [];

    let bytesBase64: string | null = null;
    if (args.includeBytes) {
      const store = evidenceStoreById(row.storageProvider);
      const stored = await store.get({ ownerEmail: userEmail, storageKey: row.storageKey });
      if (!stored) {
        throw new Error(
          "The stored file could not be found. It may have been removed from storage.",
        );
      }
      bytesBase64 = Buffer.from(stored.data).toString("base64");
    }

    return {
      evidence: {
        id: row.id,
        caseId: row.caseId,
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        category: row.category,
        extractionStatus: row.extractionStatus,
        extractionError: row.extractionError,
        pageCount: row.pageCount,
        createdAt: String(row.createdAt),
      },
      passages,
      bytesBase64,
    };
  },
});
