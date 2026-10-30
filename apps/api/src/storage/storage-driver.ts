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
  /** Hard-delete a token row. The API only calls this for revoked
   *  rows; records pushed with the token are NOT deleted with it. */
  deleteToken(id: string): boolean;

  /** News-site wallet login + favorites (see domain/types.ts). */
  saveSiteNonce(n: SiteNonce): void;
  getSiteNonce(address: string): SiteNonce | null;
  deleteSiteNonce(address: string): void;
  saveSiteSession(s: SiteSession): void;
  findSiteSessionByHash(tokenHash: string): SiteSession | null;
  deleteSiteSession(tokenHash: string): void;
  listSiteFavorites(address: string): SiteFavorite[];
  saveSiteFavorite(f: SiteFavorite): void;
  deleteSiteFavorite(address: string, itemId: string): boolean;

  /** Webhooks (the only webhook table). Tokens are plaintext by
   *  necessity (Bearer auth) and are never exposed: only getWebhook
   *  returns one, and only to server-side callers. */
  getWebhook(id: number): StoredWebhook | null;
  /** Metadata views (no tokens), oldest-updated first. */
  listWebhooks(): WebhookMeta[];
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  saveWebhook(w: StoredWebhook): StoredWebhook;
  deleteWebhook(id: number): boolean;

  /** Muse pull tasks (console-configured, agents pull their own queue). */
  getPullTask(id: number): StoredPullTask | null;
  /** All pull tasks, oldest-updated first. */
  listPullTasks(): StoredPullTask[];
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  savePullTask(t: StoredPullTask): StoredPullTask;
  deletePullTask(id: number): boolean;

  /** Pending queue: one row per (pull_task_id, due_at), any status.
   *  Insert (id <= 0) throws on a duplicate (pull_task_id, due_at);
   *  callers check first and treat the throw as a conflict. */
  getPendingTask(id: number): StoredPendingTask | null;
  /** All pending rows, oldest-created first, optionally filtered. */
  listPendingTasks(filter: { target?: string; status?: PendingTaskStatus }): StoredPendingTask[];
  /** Insert (id <= 0 assigns the next id) or replace by id. Returns the stored row. */
  savePendingTask(t: StoredPendingTask): StoredPendingTask;
  deletePendingTask(id: number): boolean;
  /** Delete waiting rows of one pull task (used when the task itself is deleted). */
  deleteWaitingPendingTasks(pullTaskId: number): number;

  /** Console chat (single stream, see StoredChatMessage). Insert (id <= 0
   *  assigns the next id) or replace status/error by id. */
  createChatMessage(m: {
    source: ChatMessageSource;
    content: string;
    in_reply_to?: number | null;
  }): StoredChatMessage;
  getChatMessage(id: number): StoredChatMessage | null;
  /** All matching rows, oldest first; the caller slices head or tail. */
  listChatMessages(filter: {
    source?: ChatMessageSource;
    status?: ChatMessageStatus;
  }): StoredChatMessage[];
  saveChatMessage(m: StoredChatMessage): StoredChatMessage;
  /** Atomically mark a processing human row done and insert its muse
   *  reply. Returns null when the row is not processing (already
   *  claimed, done, or failed elsewhere). */
  completeChatMessage(
    id: number,
    reply: string,
  ): { human: StoredChatMessage; muse: StoredChatMessage } | null;

  /** Trigger history (written by the trigger job, read by the console).
   *  Newest first. Appending prunes the table to the latest 1000 rows
   *  so the history stays bounded no matter how often a webhook fires. */
  listTriggerHistory(filter: { webhook_id?: number; limit: number }): {
    items: WebhookTriggerHistory[];
    total: number;
  };
  /** Insert (id <= 0 assigns the next id) and prune to the latest 1000 rows. */
  appendTriggerHistory(row: Omit<WebhookTriggerHistory, "id">): WebhookTriggerHistory;

  /** Saved payload templates the trigger job still reads for its active
   *  row (the console no longer manages this list). */
  listWebhookPayloads(): WebhookPayload[];
  getWebhookPayload(id: string): WebhookPayload | null;
  /** Insert or replace by id. */
  saveWebhookPayload(p: WebhookPayload): void;
  deleteWebhookPayload(id: string): boolean;
  close(): void;
}
