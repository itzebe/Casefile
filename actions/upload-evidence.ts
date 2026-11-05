import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  EVIDENCE_CATEGORIES,
  MAX_BASE64_BYTES,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_PER_CASE,
} from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import {
  buildStorageKey,
  resolveEvidenceStore,
} from "../server/casefile/evidence-store.js";
import { safeFilename, validateEvidenceFile } from "../server/casefile/file-validation.js";
import { newEvidenceId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Uploads one file into a case's evidence vault.
 *
 * The bytes arrive base64-encoded in the action input because the app's own
 * HTTP action route reads JSON, and because the framework's multipart upload
 * route is public-URL oriented. Base64 inflates the payload by ~33%, so the
 * encoded ceiling is set accordingly. `maxBodyBytes` raises the route's
 * body limit above its default for this action only.
 *
 * Validation happens before anything is written: type from magic bytes, size,
 * and a digest for duplicate detection.
 */
export default defineAction({
  description:
    "Attach a file to a case as evidence. Accepts PDF, PNG, JPEG, TXT, and CSV. The file is validated by content, stored privately, and queued for text extraction. Never returns a public URL.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case this evidence belongs to."),
    filename: z.string().min(1).max(300).describe("Original filename."),
    dataBase64: z
      .string()
      .min(1)
      .max(MAX_BASE64_BYTES)
      .describe("Base64-encoded file contents."),
    mimeType: z
      .string()
      .max(120)
      .optional()
      .describe("Client-declared MIME type. Only used to explain a rejection; the type is detected from the file's bytes."),
    category: z
      .enum(EVIDENCE_CATEGORIES)
      .default("uncategorized")
      .describe("What kind of document this is in the case."),
  }),
  http: { method: "POST" },
  maxBodyBytes: MAX_BASE64_BYTES + 64 * 1024,
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const existingCount = await db
      .select({ id: schema.evidence.id })
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.ownerEmail, userEmail),
        ),
      );
    if (existingCount.length >= MAX_EVIDENCE_PER_CASE) {
      fail(
        `This case already holds ${MAX_EVIDENCE_PER_CASE} files, the per-case limit.`,
        { errorCode: "case_evidence_limit_reached", statusCode: 409 },
      );
    }

    // Reject an oversized payload before decoding, so a huge body is never
    // materialised as bytes.
    const approxBytes = Math.floor((args.dataBase64.length * 3) / 4);
    if (approxBytes > MAX_EVIDENCE_BYTES + 1024) {
      fail(
        `The file is about ${(approxBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${
          MAX_EVIDENCE_BYTES / 1024 / 1024
        } MB.`,
        { errorCode: "file_too_large", statusCode: 413 },
      );
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(Buffer.from(args.dataBase64, "base64"));
    } catch {
      fail("The file data could not be decoded from base64.", {
        errorCode: "invalid_base64",
        statusCode: 400,
      });
    }

    const validation = validateEvidenceFile({
      filename: args.filename,
      data,
      declaredMimeType: args.mimeType,
    });
    if (!validation.ok) {
      // A rejected file is reported with the reason, and nothing is stored.
      // A validation failure is the caller's, not the server's, so it is
      // surfaced as 4xx with a code rather than an opaque 500.
      fail(validation.message, {
        errorCode: validation.code,
        statusCode: validation.code === "file_too_large" ? 413 : 400,
      });
    }

    // Duplicate detection is scoped to the case: the same receipt in two cases
    // is legitimate, the same receipt twice in one case is not.
    const [duplicate] = await db
      .select({
        id: schema.evidence.id,
        filename: schema.evidence.filename,
      })
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.sha256, validation.sha256),
        ),
      )
      .limit(1);
    if (duplicate) {
      return {
        duplicate: true as const,
        existingEvidenceId: duplicate.id,
        existingFilename: duplicate.filename,
        message: `This file is already attached to the case as "${duplicate.filename}".`,
      };
    }

    const evidenceId = newEvidenceId();
    const store = resolveEvidenceStore();
    const storageKey = buildStorageKey({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      evidenceId,
      suffix: validation.extension.replace(/^\./, "") || "bin",
    });

    await store.put({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      storageKey,
      mimeType: validation.mimeType,
      data,
    });

    await db.insert(schema.evidence).values({
      id: evidenceId,
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      filename: safeFilename(args.filename),
      mimeType: validation.mimeType,
      byteSize: validation.byteSize,
      sha256: validation.sha256,
      storageProvider: store.id,
      storageKey,
      category: args.category,
      extractionStatus: "pending",
    });
    await touchCase(ownedCase.id, userEmail);

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.upload",
      targetType: "evidence",
      targetId: evidenceId,
      // Filename, size, and detected type only. Never document contents.
      summary: `Uploaded ${validation.mimeType} (${validation.byteSize} bytes)`,
      caller,
      runId,
    });

    return {
      duplicate: false as const,
      evidenceId,
      filename: safeFilename(args.filename),
      mimeType: validation.mimeType,
      byteSize: validation.byteSize,
      category: args.category,
      extractionStatus: "pending" as const,
    };
  },
});
