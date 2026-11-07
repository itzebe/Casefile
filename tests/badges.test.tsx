import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GapReviewBadge,
  NoteStatusBadge,
  ReviewBadge,
} from "@/components/casefile/badges";

/**
 * Status badges are read, not just coloured, so the word a badge prints is part
 * of the contract. `ReviewBadge` renders a *finding's* review state; a gap
 * verdict and a note's state are different vocabularies with different words.
 *
 * This suite exists because they were once conflated: `ReviewBadge` was reused
 * for a gap's `not_applicable` and a note's `open`, and its fallback printed the
 * literal word "Rejected" for anything it did not recognise. A freshly written
 * note therefore shipped showing a red "Rejected" badge. These tests render the
 * components and assert the words, which substring assertions on the source
 * could not have caught.
 */

const text = (node: React.ReactElement) =>
  renderToStaticMarkup(node)
    .replace(/<[^>]*>/g, "")
    .trim();

const workspaceSource = readFileSync(
  fileURLToPath(new URL("../app/components/casefile/CaseWorkspace.tsx", import.meta.url)),
  "utf8",
);

describe("ReviewBadge (a finding's review state)", () => {
  it("prints the three finding review states", () => {
    expect(text(<ReviewBadge value="proposed" />)).toBe("Proposed");
    expect(text(<ReviewBadge value="confirmed" />)).toBe("Confirmed");
    expect(text(<ReviewBadge value="rejected" />)).toBe("Rejected");
  });

  it("never prints the word Rejected for a value it does not recognise", () => {
    // The old fallback was `key === "proposed" ? "Proposed" : key === "confirmed"
    // ? "Confirmed" : "Rejected"`, so any unknown status silently read as a
    // rejection. An unknown value must now be echoed, not mislabelled.
    expect(text(<ReviewBadge value="not_applicable" />)).toBe("not_applicable");
  });
});

describe("GapReviewBadge (a reviewer's verdict on a derived gap)", () => {
  it("prints a word for every gap review status", () => {
    expect(text(<GapReviewBadge value="open" />)).toBe("Not reviewed");
    expect(text(<GapReviewBadge value="resolved" />)).toBe("Resolved");
    expect(text(<GapReviewBadge value="unresolved" />)).toBe("Unresolved");
    expect(text(<GapReviewBadge value="not_applicable" />)).toBe("Not applicable");
  });

  it("does not reuse the finding word Rejected", () => {
    for (const status of ["open", "resolved", "unresolved", "not_applicable"]) {
      expect(text(<GapReviewBadge value={status} />)).not.toBe("Rejected");
    }
  });
});

describe("NoteStatusBadge (a note's own state)", () => {
  it("prints open and resolved as note states, not review states", () => {
    // The defect: a new note has status "open", and ReviewBadge printed
    // "Rejected" for it.
    expect(text(<NoteStatusBadge value="open" />)).toBe("Open");
    expect(text(<NoteStatusBadge value="resolved" />)).toBe("Resolved");
    expect(text(<NoteStatusBadge value="open" />)).not.toBe("Rejected");
  });
});

describe("wiring", () => {
  it("uses GapReviewBadge for a gap verdict and NoteStatusBadge for a note", () => {
    expect(workspaceSource).toContain("<GapReviewBadge value={gap.reviewStatus} />");
    expect(workspaceSource).toContain("<NoteStatusBadge value={note.status} />");
  });

  it("never passes a gap verdict or a note state to ReviewBadge", () => {
    expect(workspaceSource).not.toContain("<ReviewBadge value={gap.reviewStatus} />");
    expect(workspaceSource).not.toContain("<ReviewBadge value={note.status} />");
  });
});
