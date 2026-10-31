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
import { ADMIN_IDENTITY } from "../domain/types.js";
import { createPgPool, type PgPoolLike } from "../pg/pool.js";
import { resolvePgConfig } from "../pg/verify.js";
import type { StorageDriver } from "./storage-driver.js";

/**
 * PostgreSQL implementation of StorageDriver (schema app.*).
 *
 * Selected only when STORAGE_DRIVER=pg (see config.ts); the default
 * stays SQLite, so deploying this file changes nothing on its own.
 * The driver never creates tables: the 16 tables come from the
 * migration DDL and are verified by the pg/verify probe before any
 * driver work starts. Constructor only builds the pool (lazy: no
 * connection is opened until the first query).
 *
 * Semantic notes (mirroring the SQLite driver, see docs/pg-driver.md):
 * - TIMESTAMPTZ columns arrive as Date objects from node-postgres and
 *   leave here as ISO strings (toISOString), exactly what callers got
 *   from SQLite TEXT columns. Writes accept ISO strings; pg parses
 *   them to timestamptz. A non-Z input normalizes to UTC Z form —
 *   the same instant, a different spelling.
 * - JSONB columns (records.tags/metadata) arrive as native arrays /
 *   objects; the mappers accept those directly and also parse TEXT
 *   (so a stub returning JSON strings behaves identically).
 * - Tag filtering uses tags ? $n (JSONB array contains the string),
 *   the PG equivalent of SQLite's json_each(tags) WHERE value = ?.
 * - BIGINT ids and COUNT(*) results go through Number() at the
 *   mapping boundary (plus the int8 parser in pg/pool.ts).
 * - 0/1 flags are BOOLEAN in PG; mappers return real booleans, which
 *   is what the SQLite driver already returned to callers.
 * - UNIQUE(pull_task_id, due_at) and the records partial unique index
 *   are enforced by the DDL constraints; a violation throws, and the
 *   admin handler's /UNIQUE|duplicate/i check matches pg's
 *   "duplicate key value violates unique constraint" message.
 */

type Row = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function reqIso(value: unknown): string {
  const s = toIso(value);
  if (s === null) throw new Error("expected a timestamp column, got null");
  return s;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number {
  return Number(value);
}

function asNullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return false;
}

function asJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function rowToRecord(r: Row): StoredRecord {
  return {
    id: String(r.id),
    token_id: String(r.token_id),
    external_id: asString(r.external_id),
    title: asString(r.title),
    prompt: String(r.prompt),
    content: String(r.content),
    content_format: String(r.content_format) as StoredRecord["content_format"],
    content_hash: String(r.content_hash),
    source_agent: String(r.source_agent),
    skill_version: asString(r.skill_version),
    tags: asJsonArray<string>(r.tags),
    metadata: asJsonObject(r.metadata),
    created_at: reqIso(r.created_at),
    updated_at: reqIso(r.updated_at),
  };
}

function rowToToken(r: Row): StoredToken {
  return {
    id: String(r.id),
    name: String(r.name),
    key_hash: String(r.key_hash),
    created_at: reqIso(r.created_at),
    revoked_at: toIso(r.revoked_at),
    role: r.role === "admin" ? "admin" : "user",
  };
}

export class PgDriver implements StorageDriver {
  private readonly pool: PgPoolLike;

  /**
   * With no argument, resolves PG_HOST/PG_PORT/PG_DATABASE/PG_USER/
   * PG_REGION (defaults = the migration target, same as pg/verify)
   * and throws on missing/invalid configuration — fail fast at
   * startup, never halfway through a request. Tests pass a stub pool.
   */
  constructor(pool?: PgPoolLike) {
    if (pool) {
      this.pool = pool;
      return;
    }
    const resolved = resolvePgConfig();
    if ("error" in resolved) {
      throw new Error(`pg driver configuration: ${resolved.error}`);
    }
    this.pool = createPgPool(resolved.config);
  }

  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    const res = await this.pool.query(text, params);
    return res.rows;
  }

  private async exec(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.pool.query(text, params);
    return res.rowCount ?? 0;
  }

  // ---- records -------------------------------------------------------

  async insertRecord(rec: StoredRecord): Promise<void> {
    await this.q(
      `INSERT INTO app.records (id, token_id, external_id, title, prompt, content, content_format,
         content_hash, source_agent, skill_version, tags, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        rec.id, rec.token_id, rec.external_id, rec.title, rec.prompt, rec.content,
        rec.content_format, rec.content_hash, rec.source_agent, rec.skill_version,
        // JSONB 列必须传 JSON 文本：node-postgres 会把 JS 数组直接序列化成
        // Postgres 数组字面量（["news"] -> {"news"}），jsonb 拒绝 22P02。
        // SQLite 驱动同款做法（JSON.stringify），见 2026-10-31 真实 PG contract 两例失败。
        JSON.stringify(rec.tags), JSON.stringify(rec.metadata), rec.created_at, rec.updated_at,
      ],
    );
  }

  async updateRecord(rec: StoredRecord): Promise<void> {
    await this.q(
      `UPDATE app.records SET title = $1, prompt = $2, content = $3, content_format = $4,
         content_hash = $5, source_agent = $6, skill_version = $7, tags = $8, metadata = $9,
         updated_at = $10 WHERE id = $11`,
      [
        rec.title, rec.prompt, rec.content, rec.content_format, rec.content_hash,
        rec.source_agent, rec.skill_version, JSON.stringify(rec.tags), JSON.stringify(rec.metadata), rec.updated_at, rec.id,
      ],
    );
  }

  async findRecordByExternalId(identity: string, externalId: string): Promise<StoredRecord | null> {
    const rows =
      identity === ADMIN_IDENTITY
        ? await this.q("SELECT * FROM app.records WHERE external_id = $1", [externalId])
        : await this.q("SELECT * FROM app.records WHERE token_id = $1 AND external_id = $2", [
            identity,
            externalId,
          ]);
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async findRecordByHash(identity: string, contentHash: string): Promise<StoredRecord | null> {
    const rows =
      identity === ADMIN_IDENTITY
        ? await this.q(
            "SELECT * FROM app.records WHERE content_hash = $1 ORDER BY created_at ASC LIMIT 1",
            [contentHash],
          )
        : await this.q(
            "SELECT * FROM app.records WHERE token_id = $1 AND content_hash = $2 ORDER BY created_at ASC LIMIT 1",
            [identity, contentHash],
          );
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async getRecord(identity: string, id: string): Promise<StoredRecord | null> {
    const rows =
      identity === ADMIN_IDENTITY
        ? await this.q("SELECT * FROM app.records WHERE id = $1", [id])
        : await this.q("SELECT * FROM app.records WHERE token_id = $1 AND id = $2", [identity, id]);
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async listRecords(
    identity: string,
    filter: {
      source_agent?: string;
      tag?: string;
      limit: number;
      offset: number;
      updated_after?: string;
      after_id?: string;
      order?: "created_desc" | "updated_asc";
    },
  ): Promise<{ items: StoredRecord[]; total: number }> {
    let where = identity === ADMIN_IDENTITY ? "WHERE 1 = 1" : "WHERE token_id = $1";
    const params: unknown[] = identity === ADMIN_IDENTITY ? [] : [identity];
    const next = (): string => `$${params.length + 1}`;
    if (filter.source_agent) {
      where += ` AND source_agent = ${next()}`;
      params.push(filter.source_agent);
    }
    if (filter.tag) {
      where += ` AND tags ? ${next()}`;
      params.push(filter.tag);
    }
    const keyset = filter.order === "updated_asc";
    if (keyset && filter.updated_after) {
      const a = next();
      params.push(filter.updated_after);
      const b = next();
      params.push(filter.updated_after);
      const c = next();
      params.push(filter.after_id ?? "");
      where += ` AND (updated_at > ${a} OR (updated_at = ${b} AND id > ${c}))`;
    }
    const totalRows = await this.q(`SELECT COUNT(*) AS n FROM app.records ${where}`, params);
    const limitP = next();
    params.push(filter.limit);
    const offsetP = next();
    params.push(filter.offset);
    const rows = await this.q(
      `SELECT * FROM app.records ${where} ORDER BY ${keyset ? "updated_at ASC, id ASC" : "created_at DESC"} LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );
    return { items: rows.map(rowToRecord), total: asInt(totalRows[0]?.n) };
  }

  async deleteRecord(identity: string, id: string): Promise<boolean> {
    const n =
      identity === ADMIN_IDENTITY
        ? await this.exec("DELETE FROM app.records WHERE id = $1", [id])
        : await this.exec("DELETE FROM app.records WHERE token_id = $1 AND id = $2", [identity, id]);
    return n > 0;
  }

  // ---- tokens --------------------------------------------------------

  async createToken(tok: StoredToken): Promise<void> {
    await this.q(
      "INSERT INTO app.tokens (id, name, key_hash, created_at, revoked_at, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [tok.id, tok.name, tok.key_hash, tok.created_at, tok.revoked_at, tok.role ?? "user"],
    );
  }

  async findTokenByHash(keyHash: string): Promise<StoredToken | null> {
    const rows = await this.q("SELECT * FROM app.tokens WHERE key_hash = $1", [keyHash]);
    return rows.length ? rowToToken(rows[0]) : null;
  }

  async listTokens(): Promise<StoredToken[]> {
    const rows = await this.q("SELECT * FROM app.tokens ORDER BY created_at ASC, id ASC");
    return rows.map(rowToToken);
  }

  async revokeToken(id: string): Promise<boolean> {
    const n = await this.exec(
      "UPDATE app.tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
      [new Date().toISOString(), id],
    );
    return n > 0;
  }

  async deleteToken(id: string): Promise<boolean> {
    return (await this.exec("DELETE FROM app.tokens WHERE id = $1", [id])) > 0;
  }

  // ---- site nonces / sessions / favorites ----------------------------

  async saveSiteNonce(n: SiteNonce): Promise<void> {
    await this.q(
      `INSERT INTO app.site_nonces (address, nonce, message, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT(address) DO UPDATE SET nonce = excluded.nonce, message = excluded.message, expires_at = excluded.expires_at`,
      [n.address, n.nonce, n.message, n.expires_at],
    );
  }

  async getSiteNonce(address: string): Promise<SiteNonce | null> {
    const rows = await this.q("SELECT * FROM app.site_nonces WHERE address = $1", [address]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      address: String(r.address),
      nonce: String(r.nonce),
      message: String(r.message),
      expires_at: reqIso(r.expires_at),
    };
  }

  async deleteSiteNonce(address: string): Promise<void> {
    await this.q("DELETE FROM app.site_nonces WHERE address = $1", [address]);
  }

  async saveSiteSession(s: SiteSession): Promise<void> {
    await this.q(
      "INSERT INTO app.site_sessions (token_hash, address, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [s.token_hash, s.address, s.created_at, s.expires_at],
    );
  }

  async findSiteSessionByHash(tokenHash: string): Promise<SiteSession | null> {
    const rows = await this.q("SELECT * FROM app.site_sessions WHERE token_hash = $1", [tokenHash]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      token_hash: String(r.token_hash),
      address: String(r.address),
      created_at: reqIso(r.created_at),
      expires_at: reqIso(r.expires_at),
    };
  }

  async deleteSiteSession(tokenHash: string): Promise<void> {
    await this.q("DELETE FROM app.site_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async listSiteFavorites(address: string): Promise<SiteFavorite[]> {
    const rows = await this.q(
      "SELECT * FROM app.site_favorites WHERE address = $1 ORDER BY created_at ASC",
      [address],
    );
    return rows.map((r) => ({
      address: String(r.address),
      item_id: String(r.item_id),
      created_at: reqIso(r.created_at),
    }));
  }

  async saveSiteFavorite(f: SiteFavorite): Promise<void> {
    await this.q(
      "INSERT INTO app.site_favorites (address, item_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [f.address, f.item_id, f.created_at],
    );
  }

  async deleteSiteFavorite(address: string, itemId: string): Promise<boolean> {
    return (
      (await this.exec("DELETE FROM app.site_favorites WHERE address = $1 AND item_id = $2", [
        address,
        itemId,
      ])) > 0
    );
  }

  // ---- webhooks ------------------------------------------------------

  private rowToWebhook(r: Row): StoredWebhook {
    return {
      id: asInt(r.id),
      name: String(r.name),
      url: String(r.url),
      token: String(r.token),
      payload: asString(r.payload),
      cron: asString(r.cron),
      is_active: asBool(r.is_active),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    };
  }

  async getWebhook(id: number): Promise<StoredWebhook | null> {
    const rows = await this.q(
      "SELECT id, name, url, token, payload, cron, is_active, created_at, updated_at FROM app.webhooks WHERE id = $1",
      [id],
    );
    return rows.length ? this.rowToWebhook(rows[0]) : null;
  }

  async listWebhooks(): Promise<WebhookMeta[]> {
    const rows = await this.q(
      "SELECT id, name, url, token, payload, cron, is_active, updated_at FROM app.webhooks ORDER BY updated_at ASC, id ASC",
    );
    return rows.map((r) => ({
      id: asInt(r.id),
      name: String(r.name),
      url: String(r.url),
      payload: asString(r.payload),
      cron: asString(r.cron),
      is_active: asBool(r.is_active),
      hasToken: String(r.token).trim() !== "",
      updated_at: reqIso(r.updated_at),
    }));
  }

  async saveWebhook(w: StoredWebhook): Promise<StoredWebhook> {
    if (w.id > 0) {
      await this.q(
        `INSERT INTO app.webhooks (id, name, url, token, payload, cron, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, token = excluded.token,
           payload = excluded.payload, cron = excluded.cron, is_active = excluded.is_active,
           updated_at = excluded.updated_at`,
        [w.id, w.name, w.url, w.token, w.payload, w.cron ?? null, w.is_active, w.created_at, w.updated_at],
      );
      return (await this.getWebhook(w.id)) as StoredWebhook;
    }
    const rows = await this.q(
      `INSERT INTO app.webhooks (name, url, token, payload, cron, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [w.name, w.url, w.token, w.payload, w.cron ?? null, w.is_active, w.created_at, w.updated_at],
    );
    return (await this.getWebhook(asInt(rows[0].id))) as StoredWebhook;
  }

  async deleteWebhook(id: number): Promise<boolean> {
    return (await this.exec("DELETE FROM app.webhooks WHERE id = $1", [id])) > 0;
  }

  // ---- trigger history -----------------------------------------------

  private rowToHistory(r: Row): WebhookTriggerHistory {
    return {
      id: asInt(r.id),
      webhook_id: asInt(r.webhook_id),
      webhook_name: String(r.webhook_name),
      kind: String(r.kind) as WebhookTriggerHistory["kind"],
      triggered_at: reqIso(r.triggered_at),
      http_status: asNullableInt(r.http_status),
      ok: asBool(r.ok),
      body_kind: String(r.body_kind),
      body: asString(r.body),
      body_truncated: asBool(r.body_truncated),
      error: asString(r.error),
      duration_ms: asNullableInt(r.duration_ms),
    };
  }

  async listTriggerHistory(filter: {
    webhook_id?: number;
    limit: number;
  }): Promise<{ items: WebhookTriggerHistory[]; total: number }> {
    const where = filter.webhook_id !== undefined ? "WHERE webhook_id = $1" : "";
    const params = filter.webhook_id !== undefined ? [filter.webhook_id] : [];
    const totalRows = await this.q(`SELECT COUNT(*) AS n FROM app.webhook_trigger_history ${where}`, params);
    const rows = await this.q(
      `SELECT id, webhook_id, webhook_name, kind, triggered_at, http_status, ok, body_kind, body, body_truncated, error, duration_ms
       FROM app.webhook_trigger_history ${where} ORDER BY triggered_at DESC, id DESC LIMIT $${params.length + 1}`,
      [...params, filter.limit],
    );
    return { items: rows.map((r) => this.rowToHistory(r)), total: asInt(totalRows[0]?.n) };
  }

  async appendTriggerHistory(row: Omit<WebhookTriggerHistory, "id">): Promise<WebhookTriggerHistory> {
    const rows = await this.q(
      `INSERT INTO app.webhook_trigger_history
       (webhook_id, webhook_name, kind, triggered_at, http_status, ok, body_kind, body, body_truncated, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        row.webhook_id,
        row.webhook_name,
        row.kind,
        row.triggered_at,
        row.http_status,
        row.ok,
        row.body_kind,
        row.body,
        row.body_truncated,
        row.error,
        row.duration_ms,
      ],
    );
    // Bounded history: keep only the latest 1000 rows overall (same
    // statement shape as the SQLite driver; not wrapped in the same
    // transaction there either).
    await this.q(
      `DELETE FROM app.webhook_trigger_history WHERE id NOT IN
       (SELECT id FROM app.webhook_trigger_history ORDER BY id DESC LIMIT 1000)`,
    );
    return { ...row, id: asInt(rows[0].id) };
  }

  // ---- pull tasks ----------------------------------------------------

  private rowToPullTask(r: Row): StoredPullTask {
    return {
      id: asInt(r.id),
      name: String(r.name),
      prompt: String(r.prompt),
      cron: String(r.cron),
      target: String(r.target ?? "muse"),
      is_active: asBool(r.is_active),
      last_run_at: toIso(r.last_run_at),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    };
  }

  async getPullTask(id: number): Promise<StoredPullTask | null> {
    const rows = await this.q(
      "SELECT id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at FROM app.pull_tasks WHERE id = $1",
      [id],
    );
    return rows.length ? this.rowToPullTask(rows[0]) : null;
  }

  async listPullTasks(): Promise<StoredPullTask[]> {
    const rows = await this.q(
      "SELECT id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at FROM app.pull_tasks ORDER BY updated_at ASC, id ASC",
    );
    return rows.map((r) => this.rowToPullTask(r));
  }

  async savePullTask(t: StoredPullTask): Promise<StoredPullTask> {
    if (t.id > 0) {
      await this.q(
        `INSERT INTO app.pull_tasks (id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, cron = excluded.cron,
           target = excluded.target, is_active = excluded.is_active, last_run_at = excluded.last_run_at,
           updated_at = excluded.updated_at`,
        [t.id, t.name, t.prompt, t.cron, t.target, t.is_active, t.last_run_at, t.created_at, t.updated_at],
      );
      return (await this.getPullTask(t.id)) as StoredPullTask;
    }
    const rows = await this.q(
      `INSERT INTO app.pull_tasks (name, prompt, cron, target, is_active, last_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [t.name, t.prompt, t.cron, t.target, t.is_active, t.last_run_at, t.created_at, t.updated_at],
    );
    return (await this.getPullTask(asInt(rows[0].id))) as StoredPullTask;
  }

  async deletePullTask(id: number): Promise<boolean> {
    return (await this.exec("DELETE FROM app.pull_tasks WHERE id = $1", [id])) > 0;
  }

  // ---- pending tasks -------------------------------------------------

  private rowToPendingTask(r: Row): StoredPendingTask {
    return {
      id: asInt(r.id),
      pull_task_id: asInt(r.pull_task_id),
      pull_task_name: String(r.pull_task_name),
      target: String(r.target),
      prompt: String(r.prompt),
      due_at: reqIso(r.due_at),
      kind: String(r.kind) as "scheduled" | "manual",
      status: String(r.status) as PendingTaskStatus,
      result_external_id: asString(r.result_external_id),
      result_record_id: asString(r.result_record_id),
      error: asString(r.error),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    };
  }

  async getPendingTask(id: number): Promise<StoredPendingTask | null> {
    const rows = await this.q(
      "SELECT id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at FROM app.pending_tasks WHERE id = $1",
      [id],
    );
    return rows.length ? this.rowToPendingTask(rows[0]) : null;
  }

  async listPendingTasks(filter: {
    target?: string;
    status?: PendingTaskStatus;
  }): Promise<StoredPendingTask[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.target) {
      where.push(`target = $${params.length + 1}`);
      params.push(filter.target);
    }
    if (filter.status) {
      where.push(`status = $${params.length + 1}`);
      params.push(filter.status);
    }
    const rows = await this.q(
      `SELECT id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at FROM app.pending_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map((r) => this.rowToPendingTask(r));
  }

  async savePendingTask(t: StoredPendingTask): Promise<StoredPendingTask> {
    if (t.id > 0) {
      await this.q(
        `INSERT INTO app.pending_tasks (id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_external_id = excluded.result_external_id,
           result_record_id = excluded.result_record_id, error = excluded.error, updated_at = excluded.updated_at`,
        [
          t.id, t.pull_task_id, t.pull_task_name, t.target, t.prompt, t.due_at, t.kind, t.status,
          t.result_external_id, t.result_record_id, t.error, t.created_at, t.updated_at,
        ],
      );
      return (await this.getPendingTask(t.id)) as StoredPendingTask;
    }
    // No ON CONFLICT on (pull_task_id, due_at): a duplicate throws,
    // exactly like the SQLite driver — the caller treats that as a
    // conflict (admin's /UNIQUE|duplicate/i check matches pg's
    // "duplicate key value violates unique constraint" message).
    const rows = await this.q(
      `INSERT INTO app.pending_tasks (pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        t.pull_task_id, t.pull_task_name, t.target, t.prompt, t.due_at, t.kind, t.status,
        t.result_external_id, t.result_record_id, t.error, t.created_at, t.updated_at,
      ],
    );
    return (await this.getPendingTask(asInt(rows[0].id))) as StoredPendingTask;
  }

  async deletePendingTask(id: number): Promise<boolean> {
    return (await this.exec("DELETE FROM app.pending_tasks WHERE id = $1", [id])) > 0;
  }

  async deleteWaitingPendingTasks(pullTaskId: number): Promise<number> {
    return this.exec("DELETE FROM app.pending_tasks WHERE pull_task_id = $1 AND status = 'waiting'", [
      pullTaskId,
    ]);
  }

  // ---- chat ----------------------------------------------------------

  private rowToChatMessage(r: Row): StoredChatMessage {
    return {
      id: asInt(r.id),
      source: String(r.source) as ChatMessageSource,
      content: String(r.content),
      status: String(r.status) as ChatMessageStatus,
      in_reply_to: asNullableInt(r.in_reply_to),
      error: asString(r.error),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    };
  }

  async createChatMessage(m: {
    source: ChatMessageSource;
    content: string;
    in_reply_to?: number | null;
  }): Promise<StoredChatMessage> {
    const now = new Date().toISOString();
    const rows = await this.q(
      "INSERT INTO app.chat_messages (source, content, status, in_reply_to, error, created_at, updated_at) VALUES ($1, $2, 'pending', $3, NULL, $4, $4) RETURNING id",
      [m.source, m.content, m.in_reply_to ?? null, now],
    );
    return (await this.getChatMessage(asInt(rows[0].id))) as StoredChatMessage;
  }

  async getChatMessage(id: number): Promise<StoredChatMessage | null> {
    const rows = await this.q(
      "SELECT id, source, content, status, in_reply_to, error, created_at, updated_at FROM app.chat_messages WHERE id = $1",
      [id],
    );
    return rows.length ? this.rowToChatMessage(rows[0]) : null;
  }

  async listChatMessages(filter: {
    source?: ChatMessageSource;
    status?: ChatMessageStatus;
  }): Promise<StoredChatMessage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.source) {
      where.push(`source = $${params.length + 1}`);
      params.push(filter.source);
    }
    if (filter.status) {
      where.push(`status = $${params.length + 1}`);
      params.push(filter.status);
    }
    const rows = await this.q(
      `SELECT id, source, content, status, in_reply_to, error, created_at, updated_at FROM app.chat_messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC`,
      params,
    );
    return rows.map((r) => this.rowToChatMessage(r));
  }

  async saveChatMessage(m: StoredChatMessage): Promise<StoredChatMessage> {
    await this.q(
      `INSERT INTO app.chat_messages (id, source, content, status, in_reply_to, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
      [m.id, m.source, m.content, m.status, m.in_reply_to, m.error, m.created_at, m.updated_at],
    );
    return (await this.getChatMessage(m.id)) as StoredChatMessage;
  }

  /**
   * Atomically mark a processing human row done and insert its muse
   * reply. One pooled client holds the transaction: BEGIN, conditional
   * UPDATE + INSERT, COMMIT; any error rolls back and rethrows, and
   * the client is always released. A row that is not processing
   * commits nothing and returns null, like the SQLite version.
   */
  async completeChatMessage(
    id: number,
    reply: string,
  ): Promise<{ human: StoredChatMessage; muse: StoredChatMessage } | null> {
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    let museId: number | null = null;
    try {
      await client.query("BEGIN");
      try {
        const res = await client.query(
          "UPDATE app.chat_messages SET status = 'done', error = NULL, updated_at = $1 WHERE id = $2 AND status = 'processing'",
          [now, id],
        );
        if ((res.rowCount ?? 0) > 0) {
          const ins = await client.query(
            "INSERT INTO app.chat_messages (source, content, status, in_reply_to, error, created_at, updated_at) VALUES ('muse', $1, 'done', $2, NULL, $3, $3) RETURNING id",
            [reply, id, now],
          );
          museId = asInt(ins.rows[0]?.id);
        }
        await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Already rolled back: nothing left to undo.
        }
        throw e;
      }
    } finally {
      client.release();
    }
    if (museId === null) return null;
    return {
      human: (await this.getChatMessage(id)) as StoredChatMessage,
      muse: (await this.getChatMessage(museId)) as StoredChatMessage,
    };
  }

  // ---- webhook payloads ----------------------------------------------

  async listWebhookPayloads(): Promise<WebhookPayload[]> {
    const rows = await this.q(
      "SELECT id, name, content, is_active, created_at, updated_at FROM app.webhook_payloads ORDER BY updated_at DESC, id ASC",
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      content: String(r.content),
      is_active: asBool(r.is_active),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    }));
  }

  async getWebhookPayload(id: string): Promise<WebhookPayload | null> {
    const rows = await this.q(
      "SELECT id, name, content, is_active, created_at, updated_at FROM app.webhook_payloads WHERE id = $1",
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      name: String(r.name),
      content: String(r.content),
      is_active: asBool(r.is_active),
      created_at: reqIso(r.created_at),
      updated_at: reqIso(r.updated_at),
    };
  }

  async saveWebhookPayload(p: WebhookPayload): Promise<void> {
    await this.q(
      `INSERT INTO app.webhook_payloads (id, name, content, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, is_active = excluded.is_active, updated_at = excluded.updated_at`,
      [p.id, p.name, p.content, p.is_active, p.created_at, p.updated_at],
    );
  }

  async deleteWebhookPayload(id: string): Promise<boolean> {
    return (await this.exec("DELETE FROM app.webhook_payloads WHERE id = $1", [id])) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
