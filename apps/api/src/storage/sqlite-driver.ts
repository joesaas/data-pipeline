import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  StoredRecord,
  StoredToken,
  StoredWebhookConfig,
  WebhookConfigMeta,
  WebhookPayload,
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
      CREATE TABLE IF NOT EXISTS webhook_configs (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        payload TEXT,
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
    `);
    // Migration for databases created before the payload template existed.
    const webhookCols = this.db.prepare("PRAGMA table_info(webhook_configs)").all() as { name: string }[];
    if (!webhookCols.some((c) => c.name === "payload")) {
      this.db.exec("ALTER TABLE webhook_configs ADD COLUMN payload TEXT");
    }
    // Migration for databases created before token roles existed.
    const tokenCols = this.db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[];
    if (!tokenCols.some((c) => c.name === "role")) {
      this.db.exec("ALTER TABLE tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
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

  getWebhookConfig(name: string): StoredWebhookConfig | null {
    const row = this.db
      .prepare("SELECT name, url, token, payload, updated_at FROM webhook_configs WHERE name = ?")
      .get(name) as StoredWebhookConfig | undefined;
    return row ?? null;
  }

  listWebhookConfigs(): WebhookConfigMeta[] {
    return this.db
      .prepare("SELECT name, url, payload, updated_at FROM webhook_configs ORDER BY updated_at ASC, name ASC")
      .all() as WebhookConfigMeta[];
  }

  saveWebhookConfig(cfg: StoredWebhookConfig): void {
    this.db
      .prepare(
        `INSERT INTO webhook_configs (name, url, token, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, token = excluded.token, payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(cfg.name, cfg.url, cfg.token, cfg.payload, cfg.updated_at);
  }

  deleteWebhookConfig(name: string): boolean {
    const res = this.db.prepare("DELETE FROM webhook_configs WHERE name = ?").run(name);
    return Number(res.changes) > 0;
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
