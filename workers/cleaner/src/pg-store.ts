import { createHash } from "node:crypto";
import type { CleanedItem, RawRecord } from "@data-pipeline/shared";
import { createPgPool, resolvePgConfig, type PgPoolLike } from "./pg-pool.js";
import type { CleanerStoreLike, CleanMeta } from "./store.js";

/**
 * PostgreSQL implementation of CleanerStoreLike over schema cleaner.*.
 * Mirrors the SQLite CleanerStore's semantics:
 * - translation_zh stays TEXT with three states: NULL = untranslated,
 *   '' = checked Chinese (no translation needed), JSON text =
 *   {title, summary}. Never JSONB, never merge '' with NULL.
 * - tags/sources are JSONB: read back as the same types JSON.parse
 *   produced (string rows are parsed, native values used directly).
 * - save() is one transaction: upsert the record row, delete old
 *   items, insert new items with the identical id formula
 *   sha256(record.id:idx:title). On any error the transaction rolls
 *   back and the client is released.
 * - listUntranslated order is the documented deviation: SQLite orders
 *   by rowid DESC; PG has no rowid, so this orders by
 *   (cleaned_at DESC, idx ASC) — newest record first, deterministic.
 * The constructor only builds a lazy pool; no query runs until first
 * use. With no pool argument it resolves PG env via resolvePgConfig()
 * and throws on missing/invalid config (fail fast at startup).
 */
export class PgCleanerStore implements CleanerStoreLike {
  readonly filePath: string | null = null;
  private readonly pool: PgPoolLike;

  constructor(pool?: PgPoolLike) {
    if (pool) {
      this.pool = pool;
      return;
    }
    const config = resolvePgConfig();
    if ("error" in config) throw new Error(config.error);
    this.pool = createPgPool(config);
  }

  async listUntranslated(limit: number): Promise<{ id: string; title: string; summary: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.title, i.summary FROM cleaner.cleaned_items i
         JOIN cleaner.cleaned_records r ON r.source_record_id = i.source_record_id
         WHERE i.translation_zh IS NULL
         ORDER BY r.cleaned_at DESC, i.idx ASC
         LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      summary: String(r.summary),
    }));
  }

  async setTranslation(id: string, zh: { title: string; summary: string }): Promise<void> {
    await this.pool.query(
      "UPDATE cleaner.cleaned_items SET translation_zh = $1 WHERE id = $2",
      [JSON.stringify(zh), id],
    );
  }

  async markNoTranslation(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE cleaner.cleaned_items SET translation_zh = '' WHERE id = $1",
      [id],
    );
  }

  async cleanedHash(sourceRecordId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT content_hash FROM cleaner.cleaned_records WHERE source_record_id = $1",
      [sourceRecordId],
    );
    return rows.length === 0 ? null : String(rows[0].content_hash);
  }

  async save(record: RawRecord, meta: CleanMeta, items: CleanedItem[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO cleaner.cleaned_records
           (source_record_id, content_hash, cleaned_at, provider, model, prompt_version, item_count, source_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (source_record_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash, cleaned_at = EXCLUDED.cleaned_at,
           provider = EXCLUDED.provider, model = EXCLUDED.model,
           prompt_version = EXCLUDED.prompt_version, item_count = EXCLUDED.item_count,
           source_agent = EXCLUDED.source_agent`,
        [record.id, record.content_hash, meta.cleanedAt, meta.provider, meta.model, meta.promptVersion, items.length, record.source_agent],
      );
      await client.query("DELETE FROM cleaner.cleaned_items WHERE source_record_id = $1", [record.id]);
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const id = createHash("sha256").update(`${record.id}:${idx}:${item.title}`).digest("hex");
        await client.query(
          `INSERT INTO cleaner.cleaned_items
             (id, source_record_id, idx, title, summary, detail, category, tags, event_date, sources, translation_zh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
          [id, record.id, idx, item.title, item.summary, item.detail ?? null, item.category,
           JSON.stringify(item.tags), item.event_date ?? null, JSON.stringify(item.sources)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recentItemKeys(windowDays: number, excludeRecordId: string): Promise<{ title: string; sourceUrls: string[] }[]> {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const { rows } = await this.pool.query(
      `SELECT i.title, i.sources FROM cleaner.cleaned_items i
         JOIN cleaner.cleaned_records r ON r.source_record_id = i.source_record_id
         WHERE r.cleaned_at >= $1 AND i.source_record_id != $2`,
      [cutoff, excludeRecordId],
    );
    return rows.map((r) => ({
      title: String(r.title),
      sourceUrls: asStringArray(r.sources).map((s) => s.url),
    }));
  }

  async getCursor(): Promise<{ updated_at: string; id: string } | null> {
    const raw = await this.getMeta("cursor");
    return raw ? (JSON.parse(raw) as { updated_at: string; id: string }) : null;
  }

  async setCursor(cursor: { updated_at: string; id: string }): Promise<void> {
    await this.setMeta("cursor", JSON.stringify(cursor));
  }

  async getAttempts(sourceRecordId: string): Promise<number> {
    return Number((await this.getMeta(`attempts:${sourceRecordId}`)) ?? 0) || 0;
  }

  async setAttempts(sourceRecordId: string, n: number): Promise<void> {
    if (n > 0) await this.setMeta(`attempts:${sourceRecordId}`, String(n));
    else await this.pool.query("DELETE FROM cleaner.cleaner_meta WHERE key = $1", [`attempts:${sourceRecordId}`]);
  }

  async recordLlmCall(atMs: number): Promise<void> {
    await this.pool.query("INSERT INTO cleaner.llm_calls (called_at) VALUES ($1)", [atMs]);
  }

  async countLlmCalls(sinceMs: number): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*) AS n FROM cleaner.llm_calls WHERE called_at >= $1",
      [sinceMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async pruneLlmCalls(beforeMs: number): Promise<void> {
    await this.pool.query("DELETE FROM cleaner.llm_calls WHERE called_at < $1", [beforeMs]);
  }

  async counts(): Promise<{ records: number; items: number }> {
    const rec = await this.pool.query("SELECT COUNT(*) AS n FROM cleaner.cleaned_records");
    const items = await this.pool.query("SELECT COUNT(*) AS n FROM cleaner.cleaned_items");
    return { records: Number(rec.rows[0]?.n ?? 0), items: Number(items.rows[0]?.n ?? 0) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getMeta(key: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT value FROM cleaner.cleaner_meta WHERE key = $1",
      [key],
    );
    return rows.length === 0 ? null : String(rows[0].value);
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO cleaner.cleaner_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
}

/** A JSONB column holding an array of {url} objects; JSON strings are
 * parsed for parity with the SQLite TEXT-JSON path. */
function asStringArray(v: unknown): { url: string }[] {
  if (Array.isArray(v)) return v as { url: string }[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? (parsed as { url: string }[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
