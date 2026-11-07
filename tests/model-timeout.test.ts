import { describe, expect, it } from "vitest";

/**
 * A model call that spends its budget must say so.
 *
 * Observed defect: a run cut off by the time budget ended with partial output in
 * hand and was reported as "did not return parseable JSON". That message sends
 * an operator to inspect the prompt, which is the wrong place - the prompt was
 * fine and the model was still working when the clock ran out. The budget is now
 * checked before the text, and this test holds that order in place.
 */
const MODEL = "llama3.2:3b";

async function finalize() {
  const { finalizeModelOutput } = await import("../server/casefile/model.js");
  return finalizeModelOutput;
}

describe("finalizing a model reply", () => {
  it("reports a spent budget as a spent budget, even with partial text", async () => {
    const finalizeModelOutput = await finalize();
    // Partial JSON is the exact shape that used to be misreported.
    const partial = '{"claims": [{"statement": "the goods were';
    expect(() =>
      finalizeModelOutput({
        model: MODEL,
        text: partial,
        timedOut: true,
        budgetMs: 290_000,
      }),
    ).toThrow(/ran out of its 290s budget/);
  });

  it("names the model, the budget, and how much was produced", async () => {
    const finalizeModelOutput = await finalize();
    let message = "";
    try {
      finalizeModelOutput({
        model: MODEL,
        text: "x".repeat(1234),
        timedOut: true,
        budgetMs: 290_000,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(MODEL);
    expect(message).toContain("290s");
    expect(message).toContain("1234 characters");
    // Never claim the output was unparseable when the clock was the problem.
    expect(message).not.toMatch(/parseable JSON/i);
  });

  it("still reports genuinely empty output as empty, not as a timeout", async () => {
    const finalizeModelOutput = await finalize();
    expect(() =>
      finalizeModelOutput({
        model: MODEL,
        text: "   ",
        timedOut: false,
        budgetMs: 290_000,
      }),
    ).toThrow(/returned no output/);
  });

  it("reports an output budget consumed before any answer as a cap to raise", async () => {
    // Observed in production on a reasoning model (openai/gpt-oss-120b): the
    // engine stops with reason "max_tokens" and no text, because reasoning
    // tokens used the whole cap. That is a cap that is too small, not a broken
    // model, so the message must name the cap and the fix instead of sending an
    // operator to inspect the prompt.
    const finalizeModelOutput = await finalize();
    let message = "";
    try {
      finalizeModelOutput({
        model: "openai/gpt-oss-120b",
        text: "",
        timedOut: false,
        budgetMs: 290_000,
        maxOutputTokens: 3000,
        stopReason: "max_tokens",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("openai/gpt-oss-120b");
    expect(message).toContain("3000-token");
    expect(message).toMatch(/raise the output-token cap/i);
    expect(message).not.toMatch(/ran out of its/);
  });

  it("returns the text when the model finished in time", async () => {
    const finalizeModelOutput = await finalize();
    expect(
      finalizeModelOutput({
        model: MODEL,
        text: '  {"claims": []}  ',
        timedOut: false,
        budgetMs: 290_000,
      }),
    ).toBe('{"claims": []}');
  });

  it("does not say 'after producing 0 characters' when nothing was produced", async () => {
    const finalizeModelOutput = await finalize();
    let message = "";
    try {
      finalizeModelOutput({ model: MODEL, text: "", timedOut: true, budgetMs: 290_000 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ran out of its 290s budget");
    expect(message).not.toContain("after producing 0 characters");
  });
});
