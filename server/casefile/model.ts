import { ActionContractError } from "@agent-native/core/action";
import { getAppConfig } from "@agent-native/core/app-config";
import {
  getStoredModelForEngine,
  resolveEngine,
} from "@agent-native/core/agent/engine";

/**
 * Model access for investigation actions.
 *
 * Investigation runs outside the chat loop, so it resolves the same engine and
 * model the chat already uses — the app config's `agent.engine`, else the
 * stored default-engine setting — instead of hardcoding a provider. That keeps
 * one credential story for the whole app, so switching engines in Settings
 * changes analysis too.
 *
 * Two hard rules:
 *  - No tools are offered. The model may only read the evidence it was given.
 *  - If the model is unavailable or returns unparseable output, the caller is
 *    told so. Nothing is ever fabricated to fill the gap.
 */

/**
 * The model could not be reached or returned nothing usable. Typed as a
 * contract error so the transport reports 503 with a stable code, and the
 * message ("nothing was recorded") reaches the caller instead of being hidden
 * behind a generic 500.
 */
export class ModelUnavailableError extends ActionContractError {
  readonly code = "model_unavailable";
  constructor(message: string) {
    super(message, { errorCode: "model_unavailable", statusCode: 503 });
    this.name = "ModelUnavailableError";
  }
}

export class ModelOutputError extends ActionContractError {
  readonly code = "model_output_invalid";
  constructor(message: string) {
    super(message, { errorCode: "model_output_invalid", statusCode: 502 });
    this.name = "ModelOutputError";
  }
}

const APP_ID = "casefile";
/**
 * The model call is given 290s. The hosting platform stops a function at 300s,
 * so a budget just under that leaves room for the database read, persistence,
 * and the response itself. When the budget is spent this module raises its own
 * typed "model timed out" error, which reaches the browser as a stated reason,
 * instead of the platform killing the function and surfacing an opaque network
 * failure with nothing recorded.
 *
 * The client's own timeout must sit ABOVE this number, or the browser drops the
 * request before the server can return its reason; see ANALYSIS_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 290_000;

export interface RunModelOptions {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

/**
 * Chooses the model an investigation run should use.
 *
 * The order is deliberate and each step exists because of an observed failure:
 *
 *  1. The app's configured model (`AGENT_MODEL`) - an explicit operator choice
 *     wins over everything.
 *  2. The chat's stored default for the resolved engine - so analysis follows
 *     the model the user already picked in Settings.
 *  3. The engine's stock default - last resort, and the reason this order is
 *     tested: on Ollama the stock default is `llama3.1`, which is frequently
 *     not installed, so falling here while chat uses another model makes
 *     investigation fail with "model not found" even though chat works.
 *
 * "auto" is not a model name; treating it as one would ask the engine for a
 * model called "auto". Kept separate from `runModel` so the order can be
 * verified without a live provider.
 */
export function selectInvestigationModel(input: {
  configuredModel?: string | undefined;
  storedModel?: string | undefined;
  engineDefaultModel: string;
}): string {
  const configured =
    input.configuredModel && input.configuredModel !== "auto" ? input.configuredModel : undefined;
  // An empty string is an absent value, not a model named ""; `??` alone would
  // pass it through and hand the engine a nameless model.
  const stored = input.storedModel ? input.storedModel : undefined;
  return configured ?? stored ?? input.engineDefaultModel;
}

/** Streams one completion and returns the concatenated text. */
export async function runModel(options: RunModelOptions): Promise<string> {
  let engine;
  try {
    engine = await resolveEngine({ appId: APP_ID });
  } catch (error) {
    throw new ModelUnavailableError(
      `No model is configured for investigation. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The model the app is configured to use (AGENT_MODEL, else the chat's
  // stored default) wins over the engine's stock default. Without this the
  // engine's built-in default (`llama3.1` for Ollama) is used even when the app
  // and the chat are both on a different, installed model, so investigation
  // fails with "model not found" while chat works.
  const model = selectInvestigationModel({
    configuredModel: getAppConfig().agent.model,
    storedModel: await getStoredModelForEngine(engine, { appId: APP_ID }),
    engineDefaultModel: engine.defaultModel,
  });

  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // The flag is what makes the timeout reportable. An aborted stream can end
  // cleanly with partial text still in hand, and partial JSON is
  // indistinguishable from a model that answered badly - so without this the
  // caller reports "unparseable output" for a run that was simply out of time,
  // which sends an operator to the prompt instead of to the budget.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("model call timed out"));
  }, budgetMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let text = "";
  let stopReason: string | undefined;
  let stopError: string | undefined;
  try {
    const stream = engine.stream({
      model,
      systemPrompt: options.systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: options.userPrompt }] }],
      tools: [],
      abortSignal: controller.signal,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      temperature: 0,
    });
    for await (const event of stream) {
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "stop") {
        stopReason = event.reason;
        stopError = event.error;
      }
    }
  } catch (error) {
    // A spent budget is reported as a spent budget. The catch below would
    // otherwise wrap the abort reason into "could not be reached", which reads
    // like a network fault and hides the one fact that matters: the model was
    // working, and it needed more time than it was given.
    if (timedOut) throw new ModelUnavailableError(budgetExhaustedMessage(model, budgetMs, text.length));
    throw new ModelUnavailableError(
      `The investigation model could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }

  return finalizeModelOutput({
    model,
    text,
    timedOut,
    budgetMs,
    stopReason,
    stopError,
  });
}

/** The stated reason for a run that spent its whole budget. */
export function budgetExhaustedMessage(
  model: string,
  budgetMs: number,
  producedChars: number,
): string {
  const produced = producedChars > 0 ? ` after producing ${producedChars} characters` : "";
  return (
    `The investigation model ("${model}") ran out of its ${Math.round(budgetMs / 1000)}s budget${produced}, ` +
    "so no result was recorded. Run it again when the model is warm, or raise the budget."
  );
}

/**
 * Turns a finished model call into text, or the reason there is none.
 *
 * The timeout is checked before the empty-text case on purpose. An aborted
 * stream can end with partial output in hand, and partial JSON is
 * indistinguishable from a model that simply answered badly - so a run that was
 * cut off must be reported as cut off, or an operator is sent to inspect the
 * prompt when the real fault is the budget. Kept separate from `runModel` so
 * the decision can be tested without a live model.
 */
export function finalizeModelOutput(input: {
  model: string;
  text: string;
  timedOut: boolean;
  budgetMs: number;
  stopReason?: string | undefined;
  stopError?: string | undefined;
}): string {
  if (input.timedOut) {
    throw new ModelUnavailableError(
      budgetExhaustedMessage(input.model, input.budgetMs, input.text.trim().length),
    );
  }
  const trimmed = input.text.trim();
  if (!trimmed) {
    // The model name and stop reason are the two facts an operator needs to fix
    // this, so they go in the message rather than only into a log line.
    const detail = input.stopError
      ? ` The engine reported: ${input.stopError}`
      : input.stopReason && input.stopReason !== "end_turn"
        ? ` The engine stopped with reason "${input.stopReason}".`
        : "";
    throw new ModelUnavailableError(
      `The investigation model ("${input.model}") returned no output, so nothing was recorded.${detail}`,
    );
  }
  return trimmed;
}

/**
 * Extracts a JSON value from a model reply. Models wrap JSON in prose or code
 * fences even when told not to; that is recoverable. What is not recoverable is
 * inventing a result, so an unrecoverable reply throws and the caller records a
 * failure instead of a finding.
 */
export function parseModelJson<T>(raw: string): T {
  const candidates: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(raw);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Fall through to the balanced-scan attempt below.
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const opener = trimmed[start];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(slice) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new ModelOutputError(
    "The investigation model did not return parseable JSON, so no result was recorded.",
  );
}
