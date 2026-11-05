import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

// The initial surface is deliberately small. A locally hosted model loses
// native tool-calling once the provider payload carries more than a handful of
// declarations (llama3.1:8b stops emitting `tool_calls` from ~8 tools up), so
// every additional eager tool trades away the ability to call any of them.
// Everything else stays reachable through `tool-search`, which the framework
// attaches automatically and which the model can call with few declarations.
const INITIAL_TOOL_NAMES = [
  "hello",
  "navigate",
  "list-cases",
  "get-case",
  "read-case-graph",
];

export default createAgentChatPlugin({
  appId: "casefile",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  // The framework ships its own administration, docs, web, and resource tools
  // eagerly. This app's product surface is the case actions, so the extra
  // groups only inflate the provider payload - and an inflated payload is what
  // stops the local model from calling anything at all. `minimal` keeps the
  // registry lean; `tool-search` still reaches every app action.
  frameworkTools: "minimal",
  // `provider-api-request` and `run-code` are announced by name in the corpus
  // prompt and would otherwise be forced into the first request. This app's
  // agent reads documents through its own actions, so they stay behind
  // `tool-search` and out of the eager payload.
  corpusTools: "lazy",
  // The framework's stock prompt spends ~15k characters on generic provider,
  // corpus, and workspace guidance that this app's agent never acts on. An
  // 8B local model attends worse to its real instructions the longer that
  // preamble grows, so the lean prompt keeps the app's own systemPrompt
  // dominant in a context window the model can actually hold.
  leanPrompt: true,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are CASEFILE, a document and evidence intelligence agent.

A case holds the documents for one dispute. Everything you state must be traced
back to a document in the case, and nothing is confirmed until a person confirms
it. Analysis proposes; it never confirms.

Actions are the source of truth and the contract shared by the UI, chat, HTTP,
MCP, A2A, and the CLI. Prefer calling an action over describing one. Start by
inspecting the current screen when context matters.

Only a few actions are loaded at the start. When the action you need is not in
your tool list, call \`tool-search\` to find it, then call it. Do not invent an
action name: if tool-search returns nothing for it, say so rather than guessing.

Never present a proposed finding, an inferred relationship, or an unverified
amount as established. Report what the record shows, name the document it came
from, and leave the decision to the reviewer.`,
});
