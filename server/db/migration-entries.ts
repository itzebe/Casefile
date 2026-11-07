import type { MigrationEntry } from "@agent-native/core/db";

/**
 * The app's migrations, as data.
 *
 * Kept separate from the Nitro plugin wrapper so tests can apply the same
 * statements without importing a server plugin.
 */
export const MIGRATIONS: MigrationEntry[] = [
    {
      version: 1,
      name: "casefile-core-tables",
      sql: `
        CREATE TABLE IF NOT EXISTS casefile_cases (
          id TEXT PRIMARY KEY,
          owner_email TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'uncategorized',
          amount_minor INTEGER,
          currency TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_cases_owner_idx
          ON casefile_cases (owner_email, updated_at);

        CREATE TABLE IF NOT EXISTS casefile_evidence (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          owner_email TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          storage_provider TEXT NOT NULL DEFAULT 'db',
          storage_key TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'uncategorized',
          extraction_status TEXT NOT NULL DEFAULT 'pending',
          extraction_error TEXT,
          extracted_at TIMESTAMPTZ,
          page_count INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_evidence_case_idx ON casefile_evidence (case_id);
        CREATE INDEX IF NOT EXISTS casefile_evidence_owner_idx ON casefile_evidence (owner_email);
        CREATE INDEX IF NOT EXISTS casefile_evidence_digest_idx ON casefile_evidence (case_id, sha256);

        CREATE TABLE IF NOT EXISTS casefile_evidence_blobs (
          storage_key TEXT PRIMARY KEY,
          owner_email TEXT NOT NULL,
          case_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS casefile_evidence_passages (
          id TEXT PRIMARY KEY,
          evidence_id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          owner_email TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          locator_type TEXT NOT NULL,
          locator_value INTEGER,
          ref TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_passages_evidence_idx
          ON casefile_evidence_passages (evidence_id, ordinal);
        CREATE INDEX IF NOT EXISTS casefile_passages_case_idx
          ON casefile_evidence_passages (case_id);

        CREATE TABLE IF NOT EXISTS casefile_findings (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          owner_email TEXT NOT NULL,
          kind TEXT NOT NULL,
          statement TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'unverified',
          review_status TEXT NOT NULL DEFAULT 'proposed',
          event_date TEXT,
          event_date_text TEXT,
          date_precision TEXT,
          date_conflict BOOLEAN NOT NULL DEFAULT false,
          confidence TEXT,
          uncertainty TEXT,
          extraction_method TEXT,
          corrected_by TEXT,
          corrected_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_findings_case_idx ON casefile_findings (case_id, kind);
        CREATE INDEX IF NOT EXISTS casefile_findings_owner_idx ON casefile_findings (owner_email);

        CREATE TABLE IF NOT EXISTS casefile_finding_citations (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          passage_id TEXT,
          case_id TEXT NOT NULL,
          owner_email TEXT NOT NULL,
          quote TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_citations_finding_idx
          ON casefile_finding_citations (finding_id);
        CREATE INDEX IF NOT EXISTS casefile_citations_evidence_idx
          ON casefile_finding_citations (evidence_id);

        CREATE TABLE IF NOT EXISTS casefile_audit_log (
          id TEXT PRIMARY KEY,
          case_id TEXT,
          owner_email TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          summary TEXT,
          caller TEXT,
          run_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_audit_case_idx
          ON casefile_audit_log (case_id, created_at);
      `,
    },
    {
      version: 2,
      name: "casefile-cross-document-relationships",
      sql: `
        CREATE TABLE IF NOT EXISTS casefile_relationships (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          owner_email TEXT NOT NULL,
          from_type TEXT NOT NULL,
          from_id TEXT NOT NULL,
          to_type TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          basis TEXT NOT NULL DEFAULT 'direct',
          match_key TEXT,
          source_passage_id TEXT,
          rationale TEXT NOT NULL DEFAULT '',
          confidence TEXT,
          review_status TEXT NOT NULL DEFAULT 'proposed',
          created_by TEXT NOT NULL DEFAULT 'engine',
          corrected_by TEXT,
          corrected_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS casefile_relationships_case_idx
          ON casefile_relationships (case_id, relation_type);
        CREATE INDEX IF NOT EXISTS casefile_relationships_from_idx
          ON casefile_relationships (from_type, from_id);
        CREATE INDEX IF NOT EXISTS casefile_relationships_to_idx
          ON casefile_relationships (to_type, to_id);
        CREATE INDEX IF NOT EXISTS casefile_relationships_owner_idx
          ON casefile_relationships (owner_email);
      `,
    },
    {
      version: 3,
      name: "casefile-document-classification",
      sql: `
        ALTER TABLE casefile_evidence
          ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE casefile_evidence
          ADD COLUMN IF NOT EXISTS classification_confidence TEXT;
        ALTER TABLE casefile_evidence
          ADD COLUMN IF NOT EXISTS classification_rationale TEXT;
        ALTER TABLE casefile_evidence
          ADD COLUMN IF NOT EXISTS classification_corrected_by TEXT;
        ALTER TABLE casefile_evidence
          ADD COLUMN IF NOT EXISTS classification_corrected_at TIMESTAMPTZ;
      `,
    },
    {
      version: 4,
      name: "casefile-evidence-digest-unique",
      sql: `
        -- A case holds one row per document, not one per upload attempt. The
        -- upload path checked for a duplicate digest and then inserted, which
        -- two concurrent uploads of the same file could both pass, producing a
        -- second row for one document. The unique index below is what makes the
        -- check enforceable; the deletes above it are a one-time repair of any
        -- row a pre-index race already created, keeping the earliest copy and
        -- its passages and blob, so the index can be built.
        DELETE FROM casefile_evidence_passages
        WHERE evidence_id IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY case_id, sha256 ORDER BY created_at, id) AS rn
            FROM casefile_evidence
          ) ranked WHERE rn > 1
        );

        DELETE FROM casefile_evidence_blobs
        WHERE storage_key IN (
          SELECT storage_key FROM (
            SELECT storage_key, row_number() OVER (PARTITION BY case_id, sha256 ORDER BY created_at, id) AS rn
            FROM casefile_evidence
          ) ranked WHERE rn > 1
        );

        DELETE FROM casefile_evidence
        WHERE id IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY case_id, sha256 ORDER BY created_at, id) AS rn
            FROM casefile_evidence
          ) ranked WHERE rn > 1
        );

        DROP INDEX IF EXISTS casefile_evidence_digest_idx;
        CREATE UNIQUE INDEX IF NOT EXISTS casefile_evidence_case_digest_uidx
          ON casefile_evidence (case_id, sha256);
      `,
    },
  ];
