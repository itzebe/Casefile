import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildReport, renderReportHtml, renderReportMarkdown } from "../server/casefile/report.js";
import { renderReportDocx } from "../server/casefile/report-docx.js";

/**
 * Exports the investigation report in a shareable format.
 *
 * Markdown, HTML, and DOCX all come from the same report object, so the
 * citations and the proposed/confirmed marks are identical across formats. The
 * export is returned as base64 in the action response, so it is delivered
 * through the same authorized action surface as everything else - no public
 * URL is ever produced.
 *
 * Exporting does not finalise anything. The report remains a working record and
 * keeps its review marks.
 */
export default defineAction({
  description:
    "Export the investigation report as markdown, HTML, or DOCX. The export preserves citations and marks proposed statements as proposed. Returns base64-encoded file content; no public URL is created.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to export a report for."),
    format: z
      .enum(["markdown", "html", "docx"])
      .default("markdown")
      .describe("The export format."),
  }),
  http: { method: "POST" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const report = await buildReport(args.caseId, userEmail);

    let filename: string;
    let mimeType: string;
    let bytes: Uint8Array;
    const safeTitle = ownedCase.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "report";

    if (args.format === "html") {
      filename = `casefile-${safeTitle}.html`;
      mimeType = "text/html";
      bytes = new TextEncoder().encode(renderReportHtml(report));
    } else if (args.format === "docx") {
      filename = `casefile-${safeTitle}.docx`;
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      bytes = renderReportDocx(report);
    } else {
      filename = `casefile-${safeTitle}.md`;
      mimeType = "text/markdown";
      bytes = new TextEncoder().encode(renderReportMarkdown(report));
    }

    await recordAudit({
      ownerEmail: userEmail,
      caseId: args.caseId,
      actor,
      action: "report.export",
      targetType: "case",
      targetId: args.caseId,
      summary: `Report exported as ${args.format} (${bytes.length} bytes)`,
      caller,
      runId,
    });

    return {
      caseId: args.caseId,
      format: args.format,
      filename,
      mimeType,
      byteSize: bytes.length,
      contentBase64: Buffer.from(bytes).toString("base64"),
      reviewSummary: report.reviewSummary,
    };
  },
});
