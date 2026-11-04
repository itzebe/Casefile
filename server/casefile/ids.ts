import { randomUUID } from "node:crypto";

/**
 * Opaque, prefixed identifiers. Prefixed so a stray id in a log is obvious, and
 * random so an id reveals nothing about how many cases exist or in what order
 * they were created.
 */
function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export const newCaseId = () => makeId("case");
export const newEvidenceId = () => makeId("ev");
export const newPassageId = () => makeId("psg");
export const newFindingId = () => makeId("find");
export const newCitationId = () => makeId("cite");
export const newAuditId = () => makeId("audit");
