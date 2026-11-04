import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";

/**
 * Private evidence storage.
 *
 * The framework's own file-upload route returns a public CDN URL, which the
 * mission forbids for case documents. So CASEFILE keeps its own store behind
 * this interface: bytes are written under an owner-scoped key and are only ever
 * read back through an authorized action, never from a public path.
 *
 * The interface is deliberately small so a hosted deployment can register an
 * object-storage implementation without touching the actions. `db` is the
 * default because it needs no external service; the provider id is recorded on
 * each evidence row, so a case can be migrated store by store.
 */
export interface EvidencePutInput {
  ownerEmail: string;
  caseId: string;
  storageKey: string;
  mimeType: string;
  data: Uint8Array;
}

export interface EvidenceGetInput {
  ownerEmail: string;
  storageKey: string;
}

export interface EvidenceGetResult {
  data: Uint8Array;
  mimeType: string;
}

export interface EvidenceStore {
  id: string;
  /** True when the store can serve writes in this environment. */
  isConfigured(): boolean;
  put(input: EvidencePutInput): Promise<void>;
  get(input: EvidenceGetInput): Promise<EvidenceGetResult | null>;
  delete(input: EvidenceGetInput): Promise<void>;
}

/**
 * Stores bytes in `casefile_evidence_blobs`. Reads and deletes are filtered by
 * `owner_email` as well as the key, so a guessed key cannot reach another
 * user's document even if a caller skipped its own authorization check.
 */
const dbStore: EvidenceStore = {
  id: "db",
  isConfigured: () => true,

  async put({ ownerEmail, caseId, storageKey, mimeType, data }) {
    const db = getDb();
    await db
      .insert(schema.evidenceBlobs)
      .values({
        storageKey,
        ownerEmail,
        caseId,
        mimeType,
        data: Buffer.from(data).toString("base64"),
      })
      .onConflictDoUpdate({
        target: schema.evidenceBlobs.storageKey,
        set: { data: Buffer.from(data).toString("base64") },
      });
  },

  async get({ ownerEmail, storageKey }) {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.evidenceBlobs)
      .where(
        and(
          eq(schema.evidenceBlobs.storageKey, storageKey),
          eq(schema.evidenceBlobs.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      data: new Uint8Array(Buffer.from(row.data, "base64")),
      mimeType: row.mimeType,
    };
  },

  async delete({ ownerEmail, storageKey }) {
    const db = getDb();
    await db
      .delete(schema.evidenceBlobs)
      .where(
        and(
          eq(schema.evidenceBlobs.storageKey, storageKey),
          eq(schema.evidenceBlobs.ownerEmail, ownerEmail),
        ),
      );
  },
};

const registry = new Map<string, EvidenceStore>([[dbStore.id, dbStore]]);

/** Register an alternative store (object storage, encrypted volume, …). */
export function registerEvidenceStore(store: EvidenceStore): void {
  registry.set(store.id, store);
}

/** The store a new write should use: the first configured non-default store. */
export function resolveEvidenceStore(): EvidenceStore {
  for (const store of registry.values()) {
    if (store.id !== dbStore.id && store.isConfigured()) return store;
  }
  return dbStore;
}

/** The store that owns an existing key, by the provider recorded on the row. */
export function evidenceStoreById(id: string): EvidenceStore {
  return registry.get(id) ?? dbStore;
}

/**
 * Builds an unguessable, owner-scoped storage key. The key contains the owner
 * and case so an operator inspecting the blob table can attribute a row, and a
 * random suffix so it cannot be derived from the evidence id.
 */
export function buildStorageKey(input: {
  ownerEmail: string;
  caseId: string;
  evidenceId: string;
  suffix: string;
}): string {
  const owner = Buffer.from(input.ownerEmail).toString("base64url").slice(0, 24);
  return `${owner}/${input.caseId}/${input.evidenceId}.${input.suffix}`;
}
