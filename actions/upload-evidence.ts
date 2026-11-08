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
import { agentDefault, agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { storeEvidenceFile } from "../server/casefile/evidence-upload.js";
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
 * Validation and storage live in `server/casefile/evidence-upload.ts`, shared
 * with the demo loader. Validation happens before anything is written: type
 * from magic bytes, size, and a digest for duplicate detection.
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
    mimeType: agentOptional(
      z
        .string()
        .max(120)
        .describe("Client-declared MIME type. Only used to explain a rejection; the type is detected from the file's bytes."),
    ),
    category: agentDefault(
      z
        .enum(EVIDENCE_CATEGORIES)
        .describe("What kind of document this is in the case."),
      "uncategorized",
    ),
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

    const outcome = await storeEvidenceFile({
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      filename: args.filename,
      data,
      declaredMimeType: args.mimeType,
      category: args.category,
    });

    if (outcome.kind === "rejected") {
      // A rejected file is reported with the reason, and nothing is stored.
      // A validation failure is the caller's, not the server's, so it is
      // surfaced as 4xx with a code rather than an opaque 500.
      fail(outcome.message, {
        errorCode: outcome.code,
        statusCode: outcome.code === "file_too_large" ? 413 : 400,
      });
    }

    if (outcome.kind === "duplicate") {
      return {
        duplicate: true as const,
        existingEvidenceId: outcome.existingEvidenceId,
        existingFilename: outcome.existingFilename,
        message: `This file is already attached to the case as "${outcome.existingFilename}".`,
      };
    }

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.upload",
      targetType: "evidence",
      targetId: outcome.evidenceId,
      // Filename, size, and detected type only. Never document contents.
      summary: `Uploaded ${outcome.mimeType} (${outcome.byteSize} bytes)`,
      caller,
      runId,
    });

    return {
      duplicate: false as const,
      evidenceId: outcome.evidenceId,
      filename: outcome.filename,
      mimeType: outcome.mimeType,
      byteSize: outcome.byteSize,
      category: args.category,
      extractionStatus: "pending" as const,
    };
  },
});
