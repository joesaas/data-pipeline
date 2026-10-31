import type {
  ChatMessageSource,
  ChatMessageStatus,
  PendingTaskStatus,
  SiteFavorite,
  SiteNonce,
  SiteSession,
  StoredChatMessage,
  StoredPendingTask,
  StoredPullTask,
  StoredRecord,
  StoredToken,
  StoredWebhook,
  WebhookMeta,
  WebhookPayload,
  WebhookTriggerHistory,
} from "../domain/types.js";

/**
 * The single storage interface (design doc §4). The ingest service depends
 * only on this interface; the SQLite and file implementations must behave
 * identically and pass the same contract tests.
 *
 * Every method is async: the SQLite/file implementations resolve
 * immediately, the PG implementation awaits the pool. Callers always await.
 */
export interface StorageDriver {
  insertRecord(rec: StoredRecord): Promise<void>;
  /** Replace mutable fields of an existing record (keeps id and created_at). */
  updateRecord(rec: StoredRecord): Promise<void>;
  findRecordByExternalId(identity: string, externalId: string): Promise<StoredRecord | null>;
  findRecordByHash(identity: string, contentHash: string): Promise<StoredRecord | null>;
  getRecord(identity: string, id: string): Promise<StoredRecord | null>;
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
  ): Promise<{ items: StoredRecord[]; total: number }>;
  deleteRecord(identity: string, id: string): Promise<boolean>;

  createToken(tok: StoredToken): Promise<void>;
  findTokenByHash(keyHash: string): Promise<StoredToken | null>;
  /** All tokens, oldest first. Never includes plaintext keys (only hashes are stored). */
  listTokens(): Promise<StoredToken[]>;
  revokeToken(id: string): Promise<boolean>;
  /** Hard-delete a token row. The API only calls this for revoked
   *  rows; records pushed with the token are NOT deleted with it. */
  deleteToken(id: string): Promise<boolean>;

  /** News-site wallet login + favorites (see domain/types.ts). */
  saveSiteNonce(n: SiteNonce): Promise<void>;
  getSiteNonce(address: string): Promise<SiteNonce | null>;
  deleteSiteNonce(address: string): Promise<void>;
  saveSiteSession(s: SiteSession): Promise<void>;
  findSiteSessionByHash(tokenHash: string): Promise<SiteSession | null>;
  deleteSiteSession(tokenHash: string): Promise<void>;
  listSiteFavorites(address: string): Promise<SiteFavorite[]>;
  saveSiteFavorite(f: SiteFavorite): Promise<void>;
  deleteSiteFavorite(address: string, itemId: string): Promise<boolean>;

  /** Webhooks (the only webhook table). Tokens are plaintext by
   *  necessity (Bearer auth) and are never exposed: only getWebhook
   *  returns one, and only to server-side callers. */
  getWebhook(id: number): Promise<StoredWebhook | null>;
  /** Metadata views (no tokens), oldest-updated first. */
  listWebhooks(): Promise<WebhookMeta[]>;
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  saveWebhook(w: StoredWebhook): Promise<StoredWebhook>;
  deleteWebhook(id: number): Promise<boolean>;

  /** Muse pull tasks (console-configured, agents pull their own queue). */
  getPullTask(id: number): Promise<StoredPullTask | null>;
  /** All pull tasks, oldest-updated first. */
  listPullTasks(): Promise<StoredPullTask[]>;
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  savePullTask(t: StoredPullTask): Promise<StoredPullTask>;
  deletePullTask(id: number): Promise<boolean>;

  /** Pending queue: one row per (pull_task_id, due_at), any status.
   *  Insert (id <= 0) throws on a duplicate (pull_task_id, due_at);
   *  callers check first and treat the throw as a conflict. */
  getPendingTask(id: number): Promise<StoredPendingTask | null>;
  /** All pending rows, oldest-created first, optionally filtered. */
  listPendingTasks(filter: { target?: string; status?: PendingTaskStatus }): Promise<StoredPendingTask[]>;
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  savePendingTask(t: StoredPendingTask): Promise<StoredPendingTask>;
  deletePendingTask(id: number): Promise<boolean>;
  /** Delete waiting rows of one pull task (used when the task itself is deleted). */
  deleteWaitingPendingTasks(pullTaskId: number): Promise<number>;

  /** Console chat (single stream, see StoredChatMessage). Insert (id <= 0
   *  assigns the next id) or replace status/error by id. */
  createChatMessage(m: {
    source: ChatMessageSource;
    content: string;
    in_reply_to?: number | null;
  }): Promise<StoredChatMessage>;
  getChatMessage(id: number): Promise<StoredChatMessage | null>;
  /** All matching rows, oldest first; the caller slices head or tail. */
  listChatMessages(filter: {
    source?: ChatMessageSource;
    status?: ChatMessageStatus;
  }): Promise<StoredChatMessage[]>;
  saveChatMessage(m: StoredChatMessage): Promise<StoredChatMessage>;
  /** Atomically mark a processing human row done and insert its muse
   *  reply. Returns null when the row is not processing (already
   *  claimed, done, or failed elsewhere). */
  completeChatMessage(
    id: number,
    reply: string,
  ): Promise<{ human: StoredChatMessage; muse: StoredChatMessage } | null>;

  /** Trigger history (written by the trigger job, read by the console).
   *  Newest first. Appending prunes the table to the latest 1000 rows
   *  so the history stays bounded no matter how often a webhook fires. */
  listTriggerHistory(filter: { webhook_id?: number; limit: number }): Promise<{
    items: WebhookTriggerHistory[];
    total: number;
  }>;
  /** Insert (id <= 0 assigns the next id) and prune to the latest 1000 rows. */
  appendTriggerHistory(row: Omit<WebhookTriggerHistory, "id">): Promise<WebhookTriggerHistory>;

  /** Saved payload templates the trigger job still reads for its active
   *  row (the console no longer manages this list). */
  listWebhookPayloads(): Promise<WebhookPayload[]>;
  getWebhookPayload(id: string): Promise<WebhookPayload | null>;
  /** Insert or replace by id. */
  saveWebhookPayload(p: WebhookPayload): Promise<void>;
  deleteWebhookPayload(id: string): Promise<boolean>;
  close(): Promise<void>;
}
