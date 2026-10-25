import type {
  StoredPullTask,
  StoredRecord,
  StoredToken,
  StoredWebhook,
  WebhookMeta,
  WebhookPayload,
} from "../domain/types.js";

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

  /** Webhooks (the only webhook table). Tokens are plaintext by
   *  necessity (Bearer auth) and are never exposed: only getWebhook
   *  returns one, and only to server-side callers. */
  getWebhook(id: number): StoredWebhook | null;
  /** Metadata views (no tokens), oldest-updated first. */
  listWebhooks(): WebhookMeta[];
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  saveWebhook(w: StoredWebhook): StoredWebhook;
  deleteWebhook(id: number): boolean;

  /** Muse pull tasks (console-configured, Muse polls the due list). */
  getPullTask(id: number): StoredPullTask | null;
  /** All pull tasks, oldest-updated first. */
  listPullTasks(): StoredPullTask[];
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  savePullTask(t: StoredPullTask): StoredPullTask;
  deletePullTask(id: number): boolean;

  /** Saved payload templates the trigger job still reads for its active
   *  row (the console no longer manages this list). */
  listWebhookPayloads(): WebhookPayload[];
  getWebhookPayload(id: string): WebhookPayload | null;
  /** Insert or replace by id. */
  saveWebhookPayload(p: WebhookPayload): void;
  deleteWebhookPayload(id: string): boolean;
  close(): void;
}
