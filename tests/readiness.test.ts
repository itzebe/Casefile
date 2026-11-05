import { describe, expect, it } from "vitest";

import { assessReadiness, type ReadinessInput } from "../server/casefile/readiness.js";

/**
 * Readiness tests.
 *
 * The rule under test is that a case reaches "ready for report" only when every
 * earlier condition has been met, and that no input produces a numeric score or
 * a claim of legal success.
 */

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    evidenceTotal: 1,
    evidencePending: 0,
    evidenceUnreadable: 0,
    evidenceRead: 1,
    claimTotal: 1,
    claimConfirmed: 1,
    eventTotal: 0,
    eventConfirmed: 0,
    proposedTotal: 0,
    unsupportedClaimCount: 0,
    contradictionCount: 0,
    potentialContradictionCount: 0,
    gapCount: 0,
    reportExists: false,
    documentsWithText: 1,
    ...overrides,
  };
}

describe("readiness", () => {
  it("reports evidence incomplete when nothing has been uploaded", () => {
    const result = assessReadiness(
      input({ evidenceTotal: 0, evidenceRead: 0, claimTotal: 0, claimConfirmed: 0, documentsWithText: 0 }),
    );
    expect(result.state).toBe("evidence-incomplete");
    expect(result.readyForReport).toBe(false);
  });

  it("reports processing while documents are pending", () => {
    const result = assessReadiness(input({ evidencePending: 2 }));
    expect(result.state).toBe("processing-documents");
    expect(result.readyForReport).toBe(false);
  });

  it("reports awaiting review while findings are proposed", () => {
    const result = assessReadiness(input({ proposedTotal: 3, claimConfirmed: 0 }));
    expect(result.state).toBe("awaiting-human-review");
    expect(result.needsReview.length).toBeGreaterThan(0);
  });

  it("reports investigation in progress when documents are read but nothing is proposed", () => {
    const result = assessReadiness(
      input({ claimTotal: 0, claimConfirmed: 0, eventTotal: 0, eventConfirmed: 0 }),
    );
    expect(result.state).toBe("investigation-in-progress");
  });

  it("is ready for report only when everything is read and reviewed", () => {
    const result = assessReadiness(input());
    expect(result.state).toBe("ready-for-report");
    expect(result.readyForReport).toBe(true);
  });

  it("is not ready while an assertion has no source", () => {
    const result = assessReadiness(input({ unsupportedClaimCount: 1 }));
    expect(result.state).toBe("evidence-incomplete");
    expect(result.readyForReport).toBe(false);
    expect(result.unverified.some((line) => /no cited source/.test(line))).toBe(true);
  });

  it("reports report-prepared once a report exists", () => {
    const result = assessReadiness(input({ reportExists: true }));
    expect(result.state).toBe("report-prepared");
  });

  it("never emits a numeric score", () => {
    const result = assessReadiness(input({ contradictionCount: 2, gapCount: 3 }));
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/score|confidence|percent/i);
  });

  it("names contradictions as a reason but does not call them fraud", () => {
    const result = assessReadiness(input({ contradictionCount: 1 }));
    expect(result.contradicted.length).toBeGreaterThan(0);
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toMatch(/fraud|dishonest|guilt|lie/);
  });

  it("treats a gap as missing information, not proof of absence", () => {
    const result = assessReadiness(input({ gapCount: 2 }));
    expect(result.missing.some((line) => /missing/.test(line))).toBe(true);
    expect(result.missing.join(" ")).not.toMatch(/did not happen|never occurred/);
  });
});
