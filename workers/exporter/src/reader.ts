import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalCategory, parseTranslationZh } from "@data-pipeline/shared";
import type { PgPoolLike } from "./pg-pool.js";

export interface ExportItem {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string[];
  event_date: string | null;
  sources: { name: string; url: string }[];
  title_zh: string | null;
  summary_zh: string | null;
  source_agent: string;
  cleaned_at: string;
  provider: string;
  model: string;
}

export interface ExportData {
  items: ExportItem[];
  records: number;
  lastCleanedAt: string | null;
  categories: { name: string; count: number }[];
}

/**
 * One joined row, as either backend returns it. SQLite returns TEXT
 * JSON for tags/sources and TEXT ISO for cleaned_at; PG returns
 * native JSONB arrays and TIMESTAMPTZ Dates. translation_zh is TEXT
 * on both (three states: NULL = untranslated, '' = checked Chinese,
 * JSON text = {title, summary}) and goes through parseTranslationZh
 * unchanged on both paths.
 */
interface RawRow {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string | string[];
  event_date: string | null;
  sources: string | { name: string; url: string }[];
  translation_zh: string | null;
  source_agent: string;
  cleaned_at: string | Date;
  provider: string;
  model: string;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Shared row -> ExportData mapping: both backends funnel through
 * here, so the same rows always render the same site. Items come
 * back in publish order (cleaned_at desc, idx asc) — the UI's sort. */
function mapExportData(rows: RawRow[], records: number, lastCleanedAt: string | null): ExportData {
  return {
    items: rows.map((r) => {
      const zh = parseTranslationZh(r.translation_zh);
      return {
        // Key order matches the pre-PG SQLite mapper exactly (it spread
        // the SELECT row minus translation_zh, then appended the zh
        // fields): items.json key order is part of the output format.
        id: r.id,
        source_record_id: r.source_record_id,
        idx: Number(r.idx),
        title: r.title,
        summary: r.summary,
        detail: r.detail ?? null,
        category: canonicalCategory(r.category),
        tags: parseArray<string>(r.tags),
        event_date: r.event_date ?? null,
        sources: parseArray<{ name: string; url: string }>(r.sources),
        source_agent: r.source_agent ?? "",
        cleaned_at: toIso(r.cleaned_at),
        provider: r.provider,
        model: r.model,
        title_zh: zh?.title || null,
        summary_zh: zh?.summary || null,
      };
    }),
    records,
    lastCleanedAt,
    categories: rows.reduce<{ name: string; count: number }[]>((acc, r) => {
      const found = acc.find((c) => c.name === canonicalCategory(r.category));
      if (found) found.count += 1;
      else acc.push({ name: canonicalCategory(r.category), count: 1 });
      return acc;
    }, []).sort((a, b) => b.count - a.count),
  };
}

/** Read everything the site needs from the cleaner's SQLite (read-only).
 *  Items come back in publish order (cleaned_at desc) — the UI's sort. */
export function readExportData(dbFile: string): ExportData {
  const empty: ExportData = { items: [], records: 0, lastCleanedAt: null, categories: [] };
  if (!existsSync(dbFile)) return empty;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // source_agent exists only after the cleaner's v2 migration ran.
    const cols = db.prepare("PRAGMA table_info(cleaned_records)").all() as unknown as { name: string }[];
    const agentExpr = cols.some((c) => c.name === "source_agent") ? "r.source_agent" : "''";
    // translation_zh exists only after the cleaner's v3 migration ran.
    const itemCols = db.prepare("PRAGMA table_info(cleaned_items)").all() as unknown as { name: string }[];
    const zhExpr = itemCols.some((c) => c.name === "translation_zh") ? "i.translation_zh" : "NULL";
    const rows = db
      .prepare(
        `SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
                i.category, i.tags, i.event_date, i.sources,
                ${zhExpr} AS translation_zh,
                ${agentExpr} AS source_agent,
                r.cleaned_at, r.provider, r.model
         FROM cleaned_items i
         JOIN cleaned_records r ON r.source_record_id = i.source_record_id
         ORDER BY r.cleaned_at DESC, i.idx ASC`,
      )
      .all() as unknown as RawRow[];
    const records = db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as unknown as { n: number };
    const last = db.prepare("SELECT MAX(cleaned_at) AS m FROM cleaned_records").get() as unknown as { m: string | null };
    return mapExportData(rows, Number(records.n), last.m);
  } finally {
    db.close();
  }
}

/**
 * Read the same ExportData from PG schema cleaner.* — same JOIN, same
 * ORDER BY, same COUNT/MAX aggregates as the SQLite path. The PG
 * schema always has source_agent and translation_zh (migration DDL),
 * so no PRAGMA-style fallbacks are needed.
 *
 * Deliberate difference, same as the API PG reader: unlike the
 * SQLite path's missing-file degradation to an empty site, a PG
 * failure throws. The tables are pre-created, so a silent empty on a
 * DB outage would mask the outage and, worse, let a cleaner-triggered
 * export flip `current` to an empty site.
 */
export async function readExportDataPg(pool: PgPoolLike): Promise<ExportData> {
  const { rows } = await pool.query(
    `SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
            i.category, i.tags, i.event_date, i.sources,
            i.translation_zh,
            r.source_agent,
            r.cleaned_at, r.provider, r.model
     FROM cleaner.cleaned_items i
     JOIN cleaner.cleaned_records r ON r.source_record_id = i.source_record_id
     ORDER BY r.cleaned_at DESC, i.idx ASC`,
  );
  const records = await pool.query("SELECT COUNT(*) AS n FROM cleaner.cleaned_records");
  const last = await pool.query("SELECT MAX(cleaned_at) AS m FROM cleaner.cleaned_records");
  return mapExportData(
    rows as unknown as RawRow[],
    Number(records.rows[0]?.n ?? 0),
    last.rows[0]?.m == null ? null : toIso(last.rows[0].m as string | Date),
  );
}
