import { and, eq } from "drizzle-orm";

import { touchCase } from "./case-queries.js";
import { buildStorageKey, resolveEvidenceStore } from "./evidence-store.js";
import { safeFilename, validateEvidenceFile } from "./file-validation.js";
import { newEvidenceId } from "./ids.js";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";

/**
 * Validates, stores, and records one evidence file against a case.
 *
 * This is the write path shared by the `upload-evidence` action and the demo
 * loader, so a document that arrives through either route is validated by
 * content (magic bytes, size, digest), stored privately, and deduplicated the
 * same way. Bytes are validated before anything is written.
 *
 * The caller owns the case-scoped limits and the audit entry; this helper
 * reports a rejection as data so each caller can present it in its own voice.
 */

export type StoreEvidenceOutcome =
  | {
      kind: "stored";
      evidenceId: string;
      filename: string;
      mimeType: string;
      byteSize: number;
    }
  | {
      kind: "duplicate";
      existingEvidenceId: string;
      existingFilename: string;
    }
  | {
      kind: "rejected";
      code: string;
      message: string;
    };

export async function storeEvidenceFile(input: {
  caseId: string;
  ownerEmail: string;
  filename: string;
  data: Uint8Array;
  declaredMimeType?: string | undefined;
  category: string;
}): Promise<StoreEvidenceOutcome> {
  const validation = validateEvidenceFile({
    filename: input.filename,
    data: input.data,
    declaredMimeType: input.declaredMimeType,
  });
  if (!validation.ok) {
    return { kind: "rejected", code: validation.code, message: validation.message };
  }

  const db = getDb();

  // Duplicate detection is scoped to the case: the same receipt in two cases
  // is legitimate, the same receipt twice in one case is not.
  const [duplicate] = await db
    .select({ id: schema.evidence.id, filename: schema.evidence.filename })
    .from(schema.evidence)
    .where(
      and(
        eq(schema.evidence.caseId, input.caseId),
        eq(schema.evidence.sha256, validation.sha256),
      ),
    )
    .limit(1);
  if (duplicate) {
    return {
      kind: "duplicate",
      existingEvidenceId: duplicate.id,
      existingFilename: duplicate.filename,
    };
  }

  const evidenceId = newEvidenceId();
  const store = resolveEvidenceStore();
  const storageKey = buildStorageKey({
    ownerEmail: input.ownerEmail,
    caseId: input.caseId,
    evidenceId,
    suffix: validation.extension.replace(/^\./, "") || "bin",
  });

  await store.put({
    ownerEmail: input.ownerEmail,
    caseId: input.caseId,
    storageKey,
    mimeType: validation.mimeType,
    data: input.data,
  });

  await db.insert(schema.evidence).values({
    id: evidenceId,
    caseId: input.caseId,
    ownerEmail: input.ownerEmail,
    filename: safeFilename(input.filename),
    mimeType: validation.mimeType,
    byteSize: validation.byteSize,
    sha256: validation.sha256,
    storageProvider: store.id,
    storageKey,
    category: input.category,
    extractionStatus: "pending",
  });
  await touchCase(input.caseId, input.ownerEmail);

  return {
    kind: "stored",
    evidenceId,
    filename: safeFilename(input.filename),
    mimeType: validation.mimeType,
    byteSize: validation.byteSize,
  };
}
