import { beforeEach, describe, expect, it } from "vitest";

import { callAction, resetCasefileTables, setupTestDatabase, userContext } from "./helpers/harness.js";
import { RECEIPT_TEXT, STATEMENT_CSV, csvBytes, textBytes } from "./fixtures/evidence.js";

/**
 * The Entities and Activity views.
 *
 * Both read from real persisted rows through the real action layer. The point of
 * these tests is the product promise behind each view: an entity is resolved
 * from a shared identifier and never from a similar name, and the activity view
 * reports the writes that actually happened.
 */

const OWNER = "owner@example.com";

async function newCase(title = "Entities case"): Promise<string> {
  const result = await callAction<{ id: string }>(
    "create-case",
    { title, description: "Entities and activity", category: "payment-dispute" },
    userContext(OWNER),
  );
  return result.id;
}

async function upload(caseId: string, filename: string, data: Uint8Array): Promise<string> {
  const result = await callAction<{ evidenceId: string }>(
    "upload-evidence",
    {
      caseId,
      filename,
      dataBase64: Buffer.from(data).toString("base64"),
      category: "receipt",
    },
    userContext(OWNER),
  );
  return result.evidenceId;
}

interface EntityGroup {
  key: string;
  label: string;
  mentions: number;
  sources: Array<{ evidenceId: string; passageId: string; quote: string; filename: string }>;
}

interface EntityView {
  counts: { documents: number; passages: number; parties: number; references: number };
  parties: EntityGroup[];
  references: EntityGroup[];
  amounts: EntityGroup[];
  dates: EntityGroup[];
}

async function readEntities(caseId: string): Promise<EntityView> {
  return callAction<EntityView>("list-entities", { caseId }, userContext(OWNER));
}

describe("list-entities", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetCasefileTables();
  });

  it("resolves a party and a reference to the passages that mention them", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const view = await readEntities(caseId);
    expect(view.counts.documents).toBe(2);
    expect(view.counts.passages).toBeGreaterThan(0);

    // The reference cited by both documents resolves to one entity.
    const txn = view.references.find((entity) => entity.label.includes("TXN-88421907"));
    expect(txn).toBeDefined();
    expect(txn!.mentions).toBeGreaterThanOrEqual(2);
    // Every mention points at a real passage in a real document.
    expect(txn!.sources.length).toBeGreaterThan(0);
    for (const source of txn!.sources) {
      expect(source.passageId).toMatch(/^psg_/);
      expect(source.filename.length).toBeGreaterThan(0);
    }
  });

  it("does not merge two parties that merely look alike", async () => {
    const caseId = await newCase();
    // "Northwind Traders" and "Northwind Trading" share a stem but are not the
    // same party; a similarity match would wrongly join them.
    await upload(
      caseId,
      "a.txt",
      textBytes("PAYMENT RECEIPT\nMerchant: Northwind Traders\nReference: TXN-1\n"),
    );
    await upload(
      caseId,
      "b.txt",
      textBytes("INVOICE\nMerchant: Northwind Trading\nReference: INV-2\n"),
    );
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const view = await readEntities(caseId);
    const labels = view.parties.map((party) => party.label);
    expect(labels.some((label) => label.startsWith("Northwind Traders"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Northwind Trading"))).toBe(true);
    // Two distinct entities, not one merged row.
    const northwinds = view.parties.filter((party) => party.label.startsWith("Northwind"));
    expect(northwinds.length).toBe(2);
  });

  it("refuses a case the caller does not own", async () => {
    const caseId = await newCase();
    await expect(
      callAction("list-entities", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow();
  });
});

interface ActivityView {
  count: number;
  entries: Array<{ action: string; source: string; summary: string | null; createdAt: string }>;
}

describe("list-activity", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetCasefileTables();
  });

  it("records the writes that touched the case, newest first", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));

    const activity = await callAction<ActivityView>(
      "list-activity",
      { caseId, limit: 50 },
      userContext(OWNER),
    );
    expect(activity.count).toBeGreaterThan(0);
    const actions = activity.entries.map((entry) => entry.action);
    expect(actions).toContain("evidence.upload");

    // Newest first: each entry is at or before the one before it.
    const times = activity.entries.map((entry) => Date.parse(entry.createdAt));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }
  });

  it("attributes an agent write to the agent, not the person", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER, "tool"));

    const activity = await callAction<ActivityView>(
      "list-activity",
      { caseId, limit: 50 },
      userContext(OWNER),
    );
    const agentEntries = activity.entries.filter((entry) => entry.source === "agent");
    expect(agentEntries.length).toBeGreaterThan(0);
  });

  it("honours the limit", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    const activity = await callAction<ActivityView>(
      "list-activity",
      { caseId, limit: 1 },
      userContext(OWNER),
    );
    expect(activity.entries.length).toBe(1);
  });

  it("refuses a case the caller does not own", async () => {
    const caseId = await newCase();
    await expect(
      callAction("list-activity", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow();
  });
});
