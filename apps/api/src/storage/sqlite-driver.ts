import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import type { StorageDriver } from "./storage-driver.js";

interface RecordRow {
  id: string;
  token_id: string;
  external_id: string | null;
  title: string | null;
  prompt: string;
  content: string;
  content_format: string;
  content_hash: string;
  source_agent: string;
  skill_version: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface TokenRow {
  id: string;
  name: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
  role: string | null;
}

function rowToToken(r: TokenRow): StoredToken {
  return { ...r, role: r.role === "admin" ? "admin" : "user" };
}

function rowToRecord(r: RecordRow): StoredRecord {
  return {
    ...r,
    content_format: r.content_format as StoredRecord["content_format"],
    tags: JSON.parse(r.tags) as string[],
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  };
}

export class SqliteDriver implements StorageDriver {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        external_id TEXT,
        title TEXT,
        prompt TEXT NOT NULL,
        content TEXT NOT NULL,
        content_format TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        skill_version TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_records_identity_external
        ON records(token_id, external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_records_identity_hash
        ON records(token_id, content_hash);
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        role TEXT NOT NULL DEFAULT 'user'
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        payload TEXT,
        cron TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_payloads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_trigger_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL,
        webhook_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        http_status INTEGER,
        ok INTEGER NOT NULL DEFAULT 0,
        body_kind TEXT NOT NULL,
        body TEXT,
        body_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_history_webhook_time
        ON webhook_trigger_history(webhook_id, triggered_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS pull_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        cron TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'muse',
        is_active INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pull_task_id INTEGER NOT NULL,
        pull_task_name TEXT NOT NULL,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        due_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        result_external_id TEXT,
        result_record_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(pull_task_id, due_at)
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        in_reply_to INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_status_id
        ON chat_messages(status, id);
      CREATE TABLE IF NOT EXISTS site_nonces (
        address TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS site_sessions (
        token_hash TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS site_favorites (
        address TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (address, item_id)
      );
    `);
    // Migration for databases created before the queue redesign:
    // pull_tasks gains target (pending_tasks is created above for new DBs).
    {
      const cols = this.db.prepare("PRAGMA table_info(pull_tasks)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "target")) {
        this.db.exec("ALTER TABLE pull_tasks ADD COLUMN target TEXT NOT NULL DEFAULT 'muse'");
      }
    }
    // One-time migration from the old webhook_configs table (name-keyed,
    // endpoint + template + active in one row) to webhooks (id-keyed).
    // Old tables may lack the payload or is_active columns; the old
    // cursor-trigger row becomes the scheduled webhook, other rows stay
    // unscheduled. The old table is dropped once its rows are copied.
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_configs'")
      .get();
    if (legacy) {
      const cols = (
        this.db.prepare("PRAGMA table_info(webhook_configs)").all() as { name: string }[]
      ).map((c) => c.name);
      const hasPayload = cols.includes("payload");
      const hasActive = cols.includes("is_active");
      const rows = this.db.prepare("SELECT * FROM webhook_configs").all() as Record<string, unknown>[];
      const insert = this.db.prepare(
        "INSERT INTO webhooks (name, url, token, payload, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        insert.run(
          r.name,
          r.url,
          r.token,
          hasPayload ? (r.payload ?? null) : null,
          hasActive ? (r.is_active ? 1 : 0) : r.name === "cursor-trigger" ? 1 : 0,
          r.updated_at,
          r.updated_at,
        );
      }
      this.db.exec("DROP TABLE webhook_configs");
    }
    // Migration for databases created before token roles existed.
    const tokenCols = this.db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[];
    if (!tokenCols.some((c) => c.name === "role")) {
      this.db.exec("ALTER TABLE tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    // Migration for databases created before per-webhook cron existed:
    // CREATE TABLE IF NOT EXISTS never adds a column to an old table.
    const webhookCols = this.db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
    if (!webhookCols.some((c) => c.name === "cron")) {
      this.db.exec("ALTER TABLE webhooks ADD COLUMN cron TEXT");
    }
    // Same for trigger history rows written before body snapshots:
    // old tables lack body/body_truncated entirely.
    const historyExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_trigger_history'")
      .get();
    if (historyExists) {
      const historyCols = this.db.prepare("PRAGMA table_info(webhook_trigger_history)").all() as {
        name: string;
      }[];
      if (!historyCols.some((c) => c.name === "body")) {
        this.db.exec("ALTER TABLE webhook_trigger_history ADD COLUMN body TEXT");
      }
      if (!historyCols.some((c) => c.name === "body_truncated")) {
        this.db.exec("ALTER TABLE webhook_trigger_history ADD COLUMN body_truncated INTEGER NOT NULL DEFAULT 0");
      }
    }
  }

  insertRecord(rec: StoredRecord): void {
    this.db
      .prepare(
        `INSERT INTO records (id, token_id, external_id, title, prompt, content, content_format,
          content_hash, source_agent, skill_version, tags, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id, rec.token_id, rec.external_id, rec.title, rec.prompt, rec.content,
        rec.content_format, rec.content_hash, rec.source_agent, rec.skill_version,
        JSON.stringify(rec.tags), JSON.stringify(rec.metadata), rec.created_at, rec.updated_at,
      );
  }

  updateRecord(rec: StoredRecord): void {
    this.db
      .prepare(
        `UPDATE records SET title = ?, prompt = ?, content = ?, content_format = ?,
          content_hash = ?, source_agent = ?, skill_version = ?, tags = ?, metadata = ?,
          updated_at = ? WHERE id = ?`,
      )
      .run(
        rec.title, rec.prompt, rec.content, rec.content_format, rec.content_hash,
        rec.source_agent, rec.skill_version, JSON.stringify(rec.tags),
        JSON.stringify(rec.metadata), rec.updated_at, rec.id,
      );
  }

  findRecordByExternalId(identity: string, externalId: string): StoredRecord | null {
    const row = (
      identity === ADMIN_IDENTITY
        ? this.db.prepare("SELECT * FROM records WHERE external_id = ?").get(externalId)
        : this.db.prepare("SELECT * FROM records WHERE token_id = ? AND external_id = ?").get(identity, externalId)
    ) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findRecordByHash(identity: string, contentHash: string): StoredRecord | null {
    const row = (
      identity === ADMIN_IDENTITY
        ? this.db
            .prepare("SELECT * FROM records WHERE content_hash = ? ORDER BY created_at ASC LIMIT 1")
            .get(contentHash)
        : this.db
            .prepare("SELECT * FROM records WHERE token_id = ? AND content_hash = ? ORDER BY created_at ASC LIMIT 1")
            .get(identity, contentHash)
    ) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getRecord(identity: string, id: string): StoredRecord | null {
    const row = (
      identity === ADMIN_IDENTITY
        ? this.db.prepare("SELECT * FROM records WHERE id = ?").get(id)
        : this.db.prepare("SELECT * FROM records WHERE token_id = ? AND id = ?").get(identity, id)
    ) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listRecords(
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
  ): { items: StoredRecord[]; total: number } {
    let where = identity === ADMIN_IDENTITY ? "WHERE 1 = 1" : "WHERE token_id = ?";
    const params: unknown[] = identity === ADMIN_IDENTITY ? [] : [identity];
    if (filter.source_agent) {
      where += " AND source_agent = ?";
      params.push(filter.source_agent);
    }
    if (filter.tag) {
      where += " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
      params.push(filter.tag);
    }
    const keyset = filter.order === "updated_asc";
    if (keyset && filter.updated_after) {
      where += " AND (updated_at > ? OR (updated_at = ? AND id > ?))";
      params.push(filter.updated_after, filter.updated_after, filter.after_id ?? "");
    }
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM records ${where}`)
      .get(...params) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM records ${where} ORDER BY ${keyset ? "updated_at ASC, id ASC" : "created_at DESC"} LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as RecordRow[];
    return { items: rows.map(rowToRecord), total: totalRow.n };
  }

  deleteRecord(identity: string, id: string): boolean {
    const res =
      identity === ADMIN_IDENTITY
        ? this.db.prepare("DELETE FROM records WHERE id = ?").run(id)
        : this.db.prepare("DELETE FROM records WHERE token_id = ? AND id = ?").run(identity, id);
    return Number(res.changes) > 0;
  }

  createToken(tok: StoredToken): void {
    this.db
      .prepare("INSERT INTO tokens (id, name, key_hash, created_at, revoked_at, role) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tok.id, tok.name, tok.key_hash, tok.created_at, tok.revoked_at, tok.role ?? "user");
  }

  findTokenByHash(keyHash: string): StoredToken | null {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE key_hash = ?")
      .get(keyHash) as TokenRow | undefined;
    return row ? rowToToken(row) : null;
  }

  listTokens(): StoredToken[] {
    const rows = this.db
      .prepare("SELECT * FROM tokens ORDER BY created_at ASC, id ASC")
      .all() as TokenRow[];
    return rows.map(rowToToken);
  }

  revokeToken(id: string): boolean {
    const res = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return Number(res.changes) > 0;
  }

  deleteToken(id: string): boolean {
    const res = this.db.prepare("DELETE FROM tokens WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  saveSiteNonce(n: SiteNonce): void {
    this.db
      .prepare(
        "INSERT INTO site_nonces (address, nonce, message, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET nonce = excluded.nonce, message = excluded.message, expires_at = excluded.expires_at",
      )
      .run(n.address, n.nonce, n.message, n.expires_at);
  }

  getSiteNonce(address: string): SiteNonce | null {
    const row = this.db
      .prepare("SELECT * FROM site_nonces WHERE address = ?")
      .get(address) as SiteNonce | undefined;
    return row ?? null;
  }

  deleteSiteNonce(address: string): void {
    this.db.prepare("DELETE FROM site_nonces WHERE address = ?").run(address);
  }

  saveSiteSession(s: SiteSession): void {
    this.db
      .prepare("INSERT INTO site_sessions (token_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(s.token_hash, s.address, s.created_at, s.expires_at);
  }

  findSiteSessionByHash(tokenHash: string): SiteSession | null {
    const row = this.db
      .prepare("SELECT * FROM site_sessions WHERE token_hash = ?")
      .get(tokenHash) as SiteSession | undefined;
    return row ?? null;
  }

  deleteSiteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM site_sessions WHERE token_hash = ?").run(tokenHash);
  }

  listSiteFavorites(address: string): SiteFavorite[] {
    const rows = this.db
      .prepare("SELECT * FROM site_favorites WHERE address = ? ORDER BY created_at ASC")
      .all(address) as SiteFavorite[];
    return rows;
  }

  saveSiteFavorite(f: SiteFavorite): void {
    this.db
      .prepare("INSERT OR IGNORE INTO site_favorites (address, item_id, created_at) VALUES (?, ?, ?)")
      .run(f.address, f.item_id, f.created_at);
  }

  deleteSiteFavorite(address: string, itemId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM site_favorites WHERE address = ? AND item_id = ?")
      .run(address, itemId);
    return Number(res.changes) > 0;
  }

  getWebhook(id: number): StoredWebhook | null {
    type RawRow = Omit<StoredWebhook, "is_active"> & { is_active: number };
    const row = this.db
      .prepare("SELECT id, name, url, token, payload, cron, is_active, created_at, updated_at FROM webhooks WHERE id = ?")
      .get(id) as RawRow | undefined;
    if (!row) return null;
    const { is_active, ...rest } = row;
    return { ...rest, cron: rest.cron ?? null, is_active: is_active === 1 };
  }

  listWebhooks(): WebhookMeta[] {
    type RawRow = Omit<StoredWebhook, "is_active"> & { is_active: number };
    const rows = this.db
      .prepare("SELECT id, name, url, token, payload, cron, is_active, updated_at FROM webhooks ORDER BY updated_at ASC, id ASC")
      .all() as RawRow[];
    return rows.map(({ token, is_active, ...rest }) => ({
      ...rest,
      cron: rest.cron ?? null,
      is_active: is_active === 1,
      hasToken: token.trim() !== "",
    }));
  }

  saveWebhook(w: StoredWebhook): StoredWebhook {
    if (w.id > 0) {
      this.db
        .prepare(
          `INSERT INTO webhooks (id, name, url, token, payload, cron, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, token = excluded.token, payload = excluded.payload, cron = excluded.cron, is_active = excluded.is_active, updated_at = excluded.updated_at`,
        )
        .run(w.id, w.name, w.url, w.token, w.payload, w.cron ?? null, w.is_active ? 1 : 0, w.created_at, w.updated_at);
      return this.getWebhook(w.id) as StoredWebhook;
    }
    const res = this.db
      .prepare(
        "INSERT INTO webhooks (name, url, token, payload, cron, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(w.name, w.url, w.token, w.payload, w.cron ?? null, w.is_active ? 1 : 0, w.created_at, w.updated_at);
    return this.getWebhook(Number(res.lastInsertRowid)) as StoredWebhook;
  }

  deleteWebhook(id: number): boolean {
    const res = this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  listTriggerHistory(filter: { webhook_id?: number; limit: number }): {
    items: WebhookTriggerHistory[];
    total: number;
  } {
    type RawRow = Omit<WebhookTriggerHistory, "ok" | "body_truncated"> & {
      ok: number;
      body_truncated: number;
    };
    const where = filter.webhook_id !== undefined ? "WHERE webhook_id = ?" : "";
    const params = filter.webhook_id !== undefined ? [filter.webhook_id] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM webhook_trigger_history ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT id, webhook_id, webhook_name, kind, triggered_at, http_status, ok, body_kind, body, body_truncated, error, duration_ms
         FROM webhook_trigger_history ${where} ORDER BY triggered_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as RawRow[];
    return {
      items: rows.map(({ ok, body_truncated, ...rest }) => ({
        ...rest,
        kind: rest.kind as WebhookTriggerHistory["kind"],
        http_status: rest.http_status ?? null,
        ok: ok === 1,
        body: rest.body ?? null,
        body_truncated: body_truncated === 1,
        error: rest.error ?? null,
        duration_ms: rest.duration_ms ?? null,
      })),
      total,
    };
  }

  appendTriggerHistory(row: Omit<WebhookTriggerHistory, "id">): WebhookTriggerHistory {
    const res = this.db
      .prepare(
        `INSERT INTO webhook_trigger_history
         (webhook_id, webhook_name, kind, triggered_at, http_status, ok, body_kind, body, body_truncated, error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.webhook_id,
        row.webhook_name,
        row.kind,
        row.triggered_at,
        row.http_status,
        row.ok ? 1 : 0,
        row.body_kind,
        row.body,
        row.body_truncated ? 1 : 0,
        row.error,
        row.duration_ms,
      );
    // Bounded history: keep only the latest 1000 rows overall.
    this.db
      .prepare(
        `DELETE FROM webhook_trigger_history WHERE id NOT IN
         (SELECT id FROM webhook_trigger_history ORDER BY id DESC LIMIT 1000)`,
      )
      .run();
    const id = Number(res.lastInsertRowid);
    return { ...row, id };
  }

  getPullTask(id: number): StoredPullTask | null {
    type RawRow = Omit<StoredPullTask, "is_active"> & { is_active: number };
    const row = this.db
      .prepare("SELECT id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at FROM pull_tasks WHERE id = ?")
      .get(id) as RawRow | undefined;
    if (!row) return null;
    const { is_active, ...rest } = row;
    return { ...rest, target: rest.target ?? "muse", last_run_at: rest.last_run_at ?? null, is_active: is_active === 1 };
  }

  listPullTasks(): StoredPullTask[] {
    type RawRow = Omit<StoredPullTask, "is_active"> & { is_active: number };
    const rows = this.db
      .prepare("SELECT id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at FROM pull_tasks ORDER BY updated_at ASC, id ASC")
      .all() as RawRow[];
    return rows.map(({ is_active, ...rest }) => ({
      ...rest,
      target: rest.target ?? "muse",
      last_run_at: rest.last_run_at ?? null,
      is_active: is_active === 1,
    }));
  }

  savePullTask(t: StoredPullTask): StoredPullTask {
    if (t.id > 0) {
      this.db
        .prepare(
          `INSERT INTO pull_tasks (id, name, prompt, cron, target, is_active, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, cron = excluded.cron, target = excluded.target, is_active = excluded.is_active, last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
        )
        .run(t.id, t.name, t.prompt, t.cron, t.target, t.is_active ? 1 : 0, t.last_run_at, t.created_at, t.updated_at);
      return this.getPullTask(t.id) as StoredPullTask;
    }
    const res = this.db
      .prepare(
        "INSERT INTO pull_tasks (name, prompt, cron, target, is_active, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.name, t.prompt, t.cron, t.target, t.is_active ? 1 : 0, t.last_run_at, t.created_at, t.updated_at);
    return this.getPullTask(Number(res.lastInsertRowid)) as StoredPullTask;
  }

  deletePullTask(id: number): boolean {
    const res = this.db.prepare("DELETE FROM pull_tasks WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  getPendingTask(id: number): StoredPendingTask | null {
    const row = this.db
      .prepare("SELECT id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at FROM pending_tasks WHERE id = ?")
      .get(id) as StoredPendingTask | undefined;
    if (!row) return null;
    return {
      ...row,
      kind: row.kind as "scheduled" | "manual",
      status: row.status as PendingTaskStatus,
      result_external_id: row.result_external_id ?? null,
      result_record_id: row.result_record_id ?? null,
      error: row.error ?? null,
    };
  }

  listPendingTasks(filter: { target?: string; status?: PendingTaskStatus }): StoredPendingTask[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.target) {
      where.push("target = ?");
      params.push(filter.target);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at FROM pending_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`,
      )
      .all(...params) as StoredPendingTask[];
    return rows.map((r) => ({
      ...r,
      kind: r.kind as "scheduled" | "manual",
      status: r.status as PendingTaskStatus,
      result_external_id: r.result_external_id ?? null,
      result_record_id: r.result_record_id ?? null,
      error: r.error ?? null,
    }));
  }

  savePendingTask(t: StoredPendingTask): StoredPendingTask {
    if (t.id > 0) {
      this.db
        .prepare(
          `INSERT INTO pending_tasks (id, pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_external_id = excluded.result_external_id, result_record_id = excluded.result_record_id, error = excluded.error, updated_at = excluded.updated_at`,
        )
        .run(t.id, t.pull_task_id, t.pull_task_name, t.target, t.prompt, t.due_at, t.kind, t.status, t.result_external_id, t.result_record_id, t.error, t.created_at, t.updated_at);
      return this.getPendingTask(t.id) as StoredPendingTask;
    }
    // Throws on UNIQUE(pull_task_id, due_at) — the caller treats that as a conflict.
    const res = this.db
      .prepare(
        "INSERT INTO pending_tasks (pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.pull_task_id, t.pull_task_name, t.target, t.prompt, t.due_at, t.kind, t.status, t.result_external_id, t.result_record_id, t.error, t.created_at, t.updated_at);
    return this.getPendingTask(Number(res.lastInsertRowid)) as StoredPendingTask;
  }

  deletePendingTask(id: number): boolean {
    const res = this.db.prepare("DELETE FROM pending_tasks WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  createChatMessage(m: {
    source: ChatMessageSource;
    content: string;
    in_reply_to?: number | null;
  }): StoredChatMessage {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        "INSERT INTO chat_messages (source, content, status, in_reply_to, error, created_at, updated_at) VALUES (?, ?, 'pending', ?, NULL, ?, ?)",
      )
      .run(m.source, m.content, m.in_reply_to ?? null, now, now);
    return this.getChatMessage(Number(res.lastInsertRowid)) as StoredChatMessage;
  }

  getChatMessage(id: number): StoredChatMessage | null {
    const row = this.db
      .prepare(
        "SELECT id, source, content, status, in_reply_to, error, created_at, updated_at FROM chat_messages WHERE id = ?",
      )
      .get(id) as StoredChatMessage | undefined;
    if (!row) return null;
    return {
      ...row,
      source: row.source as ChatMessageSource,
      status: row.status as ChatMessageStatus,
      in_reply_to: row.in_reply_to ?? null,
      error: row.error ?? null,
    };
  }

  listChatMessages(filter: {
    source?: ChatMessageSource;
    status?: ChatMessageStatus;
  }): StoredChatMessage[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.source) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT id, source, content, status, in_reply_to, error, created_at, updated_at FROM chat_messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC`,
      )
      .all(...params) as StoredChatMessage[];
    return rows.map((r) => ({
      ...r,
      source: r.source as ChatMessageSource,
      status: r.status as ChatMessageStatus,
      in_reply_to: r.in_reply_to ?? null,
      error: r.error ?? null,
    }));
  }

  saveChatMessage(m: StoredChatMessage): StoredChatMessage {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, source, content, status, in_reply_to, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(m.id, m.source, m.content, m.status, m.in_reply_to, m.error, m.created_at, m.updated_at);
    return this.getChatMessage(m.id) as StoredChatMessage;
  }

  completeChatMessage(
    id: number,
    reply: string,
  ): { human: StoredChatMessage; muse: StoredChatMessage } | null {
    const now = new Date().toISOString();
    // node:sqlite has no transaction() helper on this version: BEGIN/COMMIT by hand.
    this.db.exec("BEGIN IMMEDIATE;");
    let museId: number | null = null;
    try {
      const res = this.db
        .prepare(
          "UPDATE chat_messages SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'",
        )
        .run(now, id);
      if (Number(res.changes) > 0) {
        const ins = this.db
          .prepare(
            "INSERT INTO chat_messages (source, content, status, in_reply_to, error, created_at, updated_at) VALUES ('muse', ?, 'done', ?, NULL, ?, ?)",
          )
          .run(reply, id, now, now);
        museId = Number(ins.lastInsertRowid);
      }
      this.db.exec("COMMIT;");
    } catch (e) {
      this.db.exec("ROLLBACK;");
      throw e;
    }
    if (museId === null) return null;
    return {
      human: this.getChatMessage(id) as StoredChatMessage,
      muse: this.getChatMessage(museId) as StoredChatMessage,
    };
  }

  deleteWaitingPendingTasks(pullTaskId: number): number {
    const res = this.db
      .prepare("DELETE FROM pending_tasks WHERE pull_task_id = ? AND status = 'waiting'")
      .run(pullTaskId);
    return Number(res.changes);
  }

  listWebhookPayloads(): WebhookPayload[] {
    return (
      this.db
        .prepare(
          "SELECT id, name, content, is_active, created_at, updated_at FROM webhook_payloads ORDER BY updated_at DESC, id ASC",
        )
        .all() as (Omit<WebhookPayload, "is_active"> & { is_active: number })[]
    ).map((r) => ({ ...r, is_active: r.is_active === 1 }));
  }

  getWebhookPayload(id: string): WebhookPayload | null {
    const row = this.db
      .prepare("SELECT id, name, content, is_active, created_at, updated_at FROM webhook_payloads WHERE id = ?")
      .get(id) as (Omit<WebhookPayload, "is_active"> & { is_active: number }) | undefined;
    return row ? { ...row, is_active: row.is_active === 1 } : null;
  }

  saveWebhookPayload(p: WebhookPayload): void {
    this.db
      .prepare(
        `INSERT INTO webhook_payloads (id, name, content, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, is_active = excluded.is_active, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.name, p.content, p.is_active ? 1 : 0, p.created_at, p.updated_at);
  }

  deleteWebhookPayload(id: string): boolean {
    const res = this.db.prepare("DELETE FROM webhook_payloads WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
