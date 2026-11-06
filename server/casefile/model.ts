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
 * The model call is given 260s. The hosting platform stops a function at 300s,
 * so a budget comfortably under that leaves room for the database read,
 * persistence, and the response itself. When the budget is spent this module
 * raises its own typed "model timed out" error, which reaches the browser as a
 * stated reason, instead of the platform killing the function and surfacing an
 * opaque network failure with nothing recorded.
 */
const DEFAULT_TIMEOUT_MS = 260_000;

export interface RunModelOptions {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
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
  const configuredModel = getAppConfig().agent.model;
  const model =
    (configuredModel && configuredModel !== "auto" ? configuredModel : undefined) ??
    (await getStoredModelForEngine(engine, { appId: APP_ID })) ??
    engine.defaultModel;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("model call timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
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
    throw new ModelUnavailableError(
      `The investigation model could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    // The model name and stop reason are the two facts an operator needs to fix
    // this, so they go in the message rather than only into a log line.
    const detail = stopError
      ? ` The engine reported: ${stopError}`
      : stopReason && stopReason !== "end_turn"
        ? ` The engine stopped with reason "${stopReason}".`
        : "";
    throw new ModelUnavailableError(
      `The investigation model ("${model}") returned no output, so nothing was recorded.${detail}`,
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
