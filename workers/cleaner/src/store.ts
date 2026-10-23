import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CleanedItem, RawRecord } from "@data-pipeline/shared";

export interface CleanMeta {
  provider: string;
  model: string;
  promptVersion: string;
  cleanedAt: string;
}

/**
 * Cleaner's own SQLite store (sink decided 2026-10-22): cleaned output lives
 * next to the cleaner, not inside the API's database. Idempotency key is
 * (source_record_id, content_hash): a record is re-cleaned only when its
 * content actually changed.
 */
export class CleanerStore {
  private readonly db: DatabaseSync;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cleaned_records (
        source_record_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        cleaned_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        item_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cleaned_items (
        id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        category TEXT NOT NULL,
        tags TEXT NOT NULL,
        event_date TEXT,
        sources TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_record ON cleaned_items(source_record_id);
      CREATE TABLE IF NOT EXISTS cleaner_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        called_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_at ON llm_calls(called_at);
    `);
    this.migrateV2();
    this.migrateV3();
  }

  /**
   * Schema v2 (2026-10-23), idempotent:
   *  - cleaned_records gains source_agent (provenance of the raw record).
   *  - cleaned_items loses the importance column (table rebuild; the
   *    column was NOT NULL, so it cannot simply be dropped in place).
   */
  private migrateV2(): void {
    const recCols = this.db.prepare("PRAGMA table_info(cleaned_records)").all() as { name: string }[];
    if (!recCols.some((c) => c.name === "source_agent")) {
      this.db.exec("ALTER TABLE cleaned_records ADD COLUMN source_agent TEXT NOT NULL DEFAULT ''");
    }
    const itemCols = this.db.prepare("PRAGMA table_info(cleaned_items)").all() as { name: string }[];
    if (itemCols.some((c) => c.name === "importance")) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE cleaned_items_v2 (
            id TEXT PRIMARY KEY,
            source_record_id TEXT NOT NULL,
            idx INTEGER NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            detail TEXT,
            category TEXT NOT NULL,
            tags TEXT NOT NULL,
            event_date TEXT,
            sources TEXT NOT NULL
          );
          INSERT INTO cleaned_items_v2 (id, source_record_id, idx, title, summary, detail, category, tags, event_date, sources)
            SELECT id, source_record_id, idx, title, summary, detail, category, tags, event_date, sources FROM cleaned_items;
          DROP TABLE cleaned_items;
          ALTER TABLE cleaned_items_v2 RENAME TO cleaned_items;
          CREATE INDEX idx_items_record ON cleaned_items(source_record_id);
        `);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  /**
   * Translation column (2026-10-23): cleaned_items gains translation_zh —
   * NULL = not yet translated, '' = checked, already Chinese (no call
   * needed), JSON text = {title, summary} from the round's one batched
   * translation call.
   */
  private migrateV3(): void {
    const itemCols = this.db.prepare("PRAGMA table_info(cleaned_items)").all() as { name: string }[];
    if (!itemCols.some((c) => c.name === "translation_zh")) {
      this.db.exec("ALTER TABLE cleaned_items ADD COLUMN translation_zh TEXT");
    }
  }

  /** Items still awaiting a translation decision, newest first. */
  listUntranslated(limit: number): { id: string; title: string; summary: string }[] {
    return this.db
      .prepare(
        "SELECT id, title, summary FROM cleaned_items WHERE translation_zh IS NULL ORDER BY rowid DESC LIMIT ?",
      )
      .all(limit) as { id: string; title: string; summary: string }[];
  }

  setTranslation(id: string, zh: { title: string; summary: string }): void {
    this.db
      .prepare("UPDATE cleaned_items SET translation_zh = ? WHERE id = ?")
      .run(JSON.stringify(zh), id);
  }

  /** Mark an item as checked-but-not-needing-translation (already Chinese). */
  markNoTranslation(id: string): void {
    this.db.prepare("UPDATE cleaned_items SET translation_zh = '' WHERE id = ?").run(id);
  }

  static defaultPath(env: NodeJS.ProcessEnv = process.env): string {
    const dir = env.CLEANER_DATA_DIR?.trim();
    return join(dir && dir.length > 0 ? dir : join(process.cwd(), "data"), "cleaned.sqlite");
  }

  cleanedHash(sourceRecordId: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM cleaned_records WHERE source_record_id = ?")
      .get(sourceRecordId) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  save(record: RawRecord, meta: CleanMeta, items: CleanedItem[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO cleaned_records (source_record_id, content_hash, cleaned_at, provider, model, prompt_version, item_count, source_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_record_id) DO UPDATE SET
             content_hash = excluded.content_hash, cleaned_at = excluded.cleaned_at,
             provider = excluded.provider, model = excluded.model,
             prompt_version = excluded.prompt_version, item_count = excluded.item_count,
             source_agent = excluded.source_agent`,
        )
        .run(record.id, record.content_hash, meta.cleanedAt, meta.provider, meta.model, meta.promptVersion, items.length, record.source_agent ?? "");
      this.db.prepare("DELETE FROM cleaned_items WHERE source_record_id = ?").run(record.id);
      const insert = this.db.prepare(
        `INSERT INTO cleaned_items (id, source_record_id, idx, title, summary, detail, category, tags, event_date, sources)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      items.forEach((item, idx) => {
        const id = createHash("sha256").update(`${record.id}:${idx}:${item.title}`).digest("hex");
        insert.run(
          id,
          record.id,
          idx,
          item.title,
          item.summary,
          item.detail ?? null,
          item.category,
          JSON.stringify(item.tags),
          item.event_date,
          JSON.stringify(item.sources),
        );
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Dedupe keys of items stored in the last `windowDays` days, excluding
   * one record (the one being cleaned — its stored items are about to be
   * replaced by save(), so they must not dedupe against themselves).
   */
  recentItemKeys(windowDays: number, excludeRecordId: string): { title: string; sourceUrls: string[] }[] {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT i.title, i.sources FROM cleaned_items i
         JOIN cleaned_records r ON r.source_record_id = i.source_record_id
         WHERE r.cleaned_at >= ? AND i.source_record_id != ?`,
      )
      .all(cutoff, excludeRecordId) as { title: string; sources: string }[];
    return rows.map((r) => {
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(r.sources) as { url?: unknown }[];
        if (Array.isArray(parsed)) urls = parsed.map((s) => String(s?.url ?? "")).filter(Boolean);
      } catch { /* malformed sources: title key still applies */ }
      return { title: r.title, sourceUrls: urls };
    });
  }

  // ---- fetch cursor: (updated_at, id) of the last record the cleaner has
  // fully dealt with. Records after it are fetched next round; the cursor
  // never jumps over an unprocessed record (failure / rate limit stop the
  // batch first), so nothing is silently dropped.
  getCursor(): { updated_at: string; id: string } | null {
    const raw = this.getMeta("cursor");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { updated_at: string; id: string };
      return typeof parsed.updated_at === "string" && typeof parsed.id === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  setCursor(cursor: { updated_at: string; id: string }): void {
    this.setMeta("cursor", JSON.stringify(cursor));
  }

  // ---- consecutive failure attempts per record (poison-record escape hatch)
  getAttempts(sourceRecordId: string): number {
    return Number(this.getMeta(`attempts:${sourceRecordId}`) ?? 0) || 0;
  }

  setAttempts(sourceRecordId: string, n: number): void {
    if (n <= 0) {
      this.db.prepare("DELETE FROM cleaner_meta WHERE key = ?").run(`attempts:${sourceRecordId}`);
    } else {
      this.setMeta(`attempts:${sourceRecordId}`, String(n));
    }
  }

  // ---- LLM call log for rolling-window rate limits
  recordLlmCall(atMs: number): void {
    this.db.prepare("INSERT INTO llm_calls (called_at) VALUES (?)").run(atMs);
  }

  countLlmCalls(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE called_at >= ?")
      .get(sinceMs) as { n: number };
    return Number(row.n);
  }

  pruneLlmCalls(beforeMs: number): void {
    this.db.prepare("DELETE FROM llm_calls WHERE called_at < ?").run(beforeMs);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cleaner_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO cleaner_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  counts(): { records: number; items: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as { n: number };
    const i = this.db.prepare("SELECT COUNT(*) AS n FROM cleaned_items").get() as { n: number };
    return { records: Number(r.n), items: Number(i.n) };
  }

  close(): void {
    this.db.close();
  }
}
