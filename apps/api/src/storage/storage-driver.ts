import type { StoredRecord, StoredToken, StoredWebhookConfig, WebhookConfigMeta } from "../domain/types.js";

/**
 * The single storage interface (design doc §4). The ingest service depends
 * only on this interface; the SQLite and file implementations must behave
 * identically and pass the same contract tests.
 */
export interface StorageDriver {
  insertRecord(rec: StoredRecord): void;
  /** Replace mutable fields of an existing record (keeps id and created_at). */
  updateRecord(rec: StoredRecord): void;
  findRecordByExternalId(identity: string, externalId: string): StoredRecord | null;
  findRecordByHash(identity: string, contentHash: string): StoredRecord | null;
  getRecord(identity: string, id: string): StoredRecord | null;
  listRecords(
    identity: string,
    filter: {
      source_agent?: string;
      tag?: string;
      limit: number;
      offset: number;
      /** Keyset cursor mode (order="updated_asc"): only records strictly
       *  after (updated_after, after_id) in (updated_at, id) order. */
      updated_after?: string;
      after_id?: string;
      order?: "created_desc" | "updated_asc";
    },
  ): { items: StoredRecord[]; total: number };
  deleteRecord(identity: string, id: string): boolean;

  createToken(tok: StoredToken): void;
  findTokenByHash(keyHash: string): StoredToken | null;
  /** All tokens, oldest first. Never includes plaintext keys (only hashes are stored). */
  listTokens(): StoredToken[];
  revokeToken(id: string): boolean;

  /** Webhook configurations (e.g. the cursor-trigger endpoint). Tokens are
   *  plaintext by necessity (Bearer auth) and are never exposed: only
   *  getWebhookConfig returns one, and only to server-side callers. */
  getWebhookConfig(name: string): StoredWebhookConfig | null;
  /** Metadata views (no tokens), oldest-updated first. */
  listWebhookConfigs(): WebhookConfigMeta[];
  /** Insert or replace by name. */
  saveWebhookConfig(cfg: StoredWebhookConfig): void;
  deleteWebhookConfig(name: string): boolean;
  close(): void;
}
