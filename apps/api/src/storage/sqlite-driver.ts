import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredRecord, StoredToken } from "../domain/types.js";
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
        revoked_at TEXT
      );
    `);
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
    const row = this.db
      .prepare("SELECT * FROM records WHERE token_id = ? AND external_id = ?")
      .get(identity, externalId) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findRecordByHash(identity: string, contentHash: string): StoredRecord | null {
    const row = this.db
      .prepare("SELECT * FROM records WHERE token_id = ? AND content_hash = ? ORDER BY created_at ASC LIMIT 1")
      .get(identity, contentHash) as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getRecord(identity: string, id: string): StoredRecord | null {
    const row = this.db
      .prepare("SELECT * FROM records WHERE token_id = ? AND id = ?")
      .get(identity, id) as RecordRow | undefined;
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
    let where = "WHERE token_id = ?";
    const params: unknown[] = [identity];
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
    const res = this.db
      .prepare("DELETE FROM records WHERE token_id = ? AND id = ?")
      .run(identity, id);
    return Number(res.changes) > 0;
  }

  createToken(tok: StoredToken): void {
    this.db
      .prepare("INSERT INTO tokens (id, name, key_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
      .run(tok.id, tok.name, tok.key_hash, tok.created_at, tok.revoked_at);
  }

  findTokenByHash(keyHash: string): StoredToken | null {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE key_hash = ?")
      .get(keyHash) as TokenRow | undefined;
    return row ?? null;
  }

  revokeToken(id: string): boolean {
    const res = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
