import { describe, expect, it } from "vitest";

import {
  ModelOutputError,
  ModelUnavailableError,
  parseModelJson,
} from "../server/casefile/model.js";

/**
 * The model boundary.
 *
 * Investigation asks a model for JSON. What comes back is not under our control,
 * so this module has exactly two jobs at the boundary: recover JSON that a model
 * wrapped in prose or a fence, and refuse everything else. The refusal is the
 * important half - inventing a result to fill the gap would put a fabricated
 * finding in a case file, so an unrecoverable reply must throw.
 */

describe("parseModelJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseModelJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = 'Here is the result:\n```json\n{"claims": []}\n```\nHope that helps.';
    expect(parseModelJson<{ claims: unknown[] }>(raw)).toEqual({ claims: [] });
  });

  it("parses JSON surrounded by prose", () => {
    const raw = 'Sure! The analysis is: {"claims": [{"statement": "x"}]} — done.';
    expect(parseModelJson<{ claims: Array<{ statement: string }> }>(raw).claims).toHaveLength(1);
  });

  it("handles braces inside strings without truncating early", () => {
    // A naive brace counter stops at the `}` inside the string and returns a
    // fragment; the scan must track string state to get the whole object.
    const raw = '{"note": "use } carefully", "n": 2}';
    expect(parseModelJson<{ note: string; n: number }>(raw)).toEqual({
      note: "use } carefully",
      n: 2,
    });
  });

  it("handles an escaped quote inside a string", () => {
    const raw = '{"quote": "he said \\"stop\\" loudly", "ok": true}';
    expect(parseModelJson<{ quote: string; ok: boolean }>(raw)).toEqual({
      quote: 'he said "stop" loudly',
      ok: true,
    });
  });

  it("parses a top-level array", () => {
    expect(parseModelJson<number[]>("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("throws a typed output error rather than inventing a result", () => {
    expect(() => parseModelJson("I cannot help with that request.")).toThrow(ModelOutputError);
  });

  it("reports the invalid-output contract on the error", () => {
    try {
      parseModelJson("no json here");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelOutputError);
      expect((error as ModelOutputError).code).toBe("model_output_invalid");
    }
  });
});

describe("model error contracts", () => {
  it("reports an unreachable model as 503 with a stable code", () => {
    const error = new ModelUnavailableError("no model configured");
    expect(error.code).toBe("model_unavailable");
    expect(error.statusCode).toBe(503);
  });

  it("reports unusable output as 502 with a stable code", () => {
    const error = new ModelOutputError("unparseable");
    expect(error.code).toBe("model_output_invalid");
    expect(error.statusCode).toBe(502);
  });
});
