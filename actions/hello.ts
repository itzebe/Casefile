import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { agentDefault } from "../server/casefile/action-input.js";

export default defineAction({
  description: "Return a friendly greeting.",
  mcpTool: true,
  schema: z.object({
    name: agentDefault(z.string().describe("Name to greet"), "world"),
  }),
  http: { method: "GET" },
  run: async ({ name }) => {
    return { message: `Hello, ${name}!` };
  },
});
