import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
  importance: string;
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
  importance: string;
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

/** Read everything the site needs from the cleaner's SQLite (read-only). */
export function readExportData(dbFile: string): ExportData {
  const empty: ExportData = { items: [], records: 0, lastCleanedAt: null, categories: [] };
  if (!existsSync(dbFile)) return empty;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
                i.category, i.tags, i.event_date, i.sources, i.importance,
                r.cleaned_at, r.provider, r.model
         FROM cleaned_items i
         JOIN cleaned_records r ON r.source_record_id = i.source_record_id
         ORDER BY (i.event_date IS NULL), i.event_date DESC, r.cleaned_at DESC, i.idx ASC`,
      )
      .all() as unknown as Row[];
    const records = db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as unknown as { n: number };
    const last = db.prepare("SELECT MAX(cleaned_at) AS m FROM cleaned_records").get() as unknown as { m: string | null };
    return {
      items: rows.map((r) => ({ ...r, tags: parseArray<string>(r.tags), sources: parseArray<{ name: string; url: string }>(r.sources) })),
      records: Number(records.n),
      lastCleanedAt: last.m,
      categories: rows.reduce<{ name: string; count: number }[]>((acc, r) => {
        const found = acc.find((c) => c.name === r.category);
        if (found) found.count += 1;
        else acc.push({ name: r.category, count: 1 });
        return acc;
      }, []).sort((a, b) => b.count - a.count),
    };
  } finally {
    db.close();
  }
}
