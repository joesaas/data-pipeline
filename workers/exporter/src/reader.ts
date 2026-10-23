import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalCategory, parseTranslationZh } from "@data-pipeline/shared";

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

interface Row {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string;
  event_date: string | null;
  sources: string;
  translation_zh: string | null;
  source_agent: string;
  cleaned_at: string;
  provider: string;
  model: string;
}

function parseArray<T>(text: string): T[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
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
      .all() as unknown as Row[];
    const records = db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as unknown as { n: number };
    const last = db.prepare("SELECT MAX(cleaned_at) AS m FROM cleaned_records").get() as unknown as { m: string | null };
    return {
      items: rows.map((r) => {
        const zh = parseTranslationZh(r.translation_zh);
        const { translation_zh: _raw, ...rest } = r;
        return {
          ...rest,
          category: canonicalCategory(r.category),
          title_zh: zh?.title || null,
          summary_zh: zh?.summary || null,
          tags: parseArray<string>(r.tags),
          sources: parseArray<{ name: string; url: string }>(r.sources),
        };
      }),
      records: Number(records.n),
      lastCleanedAt: last.m,
      categories: rows.reduce<{ name: string; count: number }[]>((acc, r) => {
        const found = acc.find((c) => c.name === canonicalCategory(r.category));
        if (found) found.count += 1;
        else acc.push({ name: canonicalCategory(r.category), count: 1 });
        return acc;
      }, []).sort((a, b) => b.count - a.count),
    };
  } finally {
    db.close();
  }
}
