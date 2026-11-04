import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { CASE_STATUSES } from "../shared/casefile/types.js";
import { casefileContext } from "../server/casefile/context.js";
import { listCaseSummaries } from "../server/casefile/case-queries.js";

export default defineAction({
  description:
    "List the user's investigation cases, most recently updated first, with evidence and finding counts. Use this to find a case id before reading or analysing it.",
  schema: z.object({
    status: z.enum(CASE_STATUSES).optional().describe("Filter to one status."),
    includeArchived: z
      .boolean()
      .default(false)
      .describe("Include archived (closed) cases."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const summaries = await listCaseSummaries(userEmail);
    const cases = summaries.filter((item) => {
      if (args.status && item.status !== args.status) return false;
      if (!args.includeArchived && item.status === "closed" && !args.status) return false;
      return true;
    });
    return { cases, total: cases.length };
  },
});
