import { describe, expect, it } from "vitest";

import { selectInvestigationModel } from "../server/casefile/model.js";

/**
 * Which model an investigation run uses.
 *
 * This order was a real defect: chat and analysis could disagree, so analysis
 * asked the engine for a model that was not installed and failed with "model not
 * found" while chat worked. Each case below pins one step of the precedence.
 */
describe("selectInvestigationModel", () => {
  it("prefers the app's configured model", () => {
    expect(
      selectInvestigationModel({
        configuredModel: "gpt-4o-mini",
        storedModel: "llama3.2:3b",
        engineDefaultModel: "llama3.1",
      }),
    ).toBe("gpt-4o-mini");
  });

  it("treats 'auto' as no choice, not as a model name", () => {
    // Asking the engine for a model literally named "auto" is the bug this
    // guards; the stored default must win instead.
    expect(
      selectInvestigationModel({
        configuredModel: "auto",
        storedModel: "llama3.2:3b",
        engineDefaultModel: "llama3.1",
      }),
    ).toBe("llama3.2:3b");
  });

  it("falls to the stored default when nothing is configured", () => {
    expect(
      selectInvestigationModel({
        storedModel: "llama3.2:3b",
        engineDefaultModel: "llama3.1",
      }),
    ).toBe("llama3.2:3b");
  });

  it("uses the engine default only as a last resort", () => {
    expect(selectInvestigationModel({ engineDefaultModel: "llama3.1" })).toBe("llama3.1");
  });

  it("never returns an empty string", () => {
    expect(
      selectInvestigationModel({
        configuredModel: "",
        storedModel: "",
        engineDefaultModel: "llama3.1",
      }),
    ).toBe("llama3.1");
  });
});
