import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface CleanedSourceView {
  name: string;
  url: string;
}

export interface CleanedItemView {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string[];
  event_date: string | null;
  sources: CleanedSourceView[];
  importance: string;
  cleaned_at: string;
  provider: string;
  model: string;
}

export interface CleanedStats {
  records: number;
  items: number;
  last_cleaned_at: string | null;
  categories: { name: string; count: number }[];
  providers: { provider: string; model: string; records: number }[];
}

interface ItemRow {
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

function parseJsonArray<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function toView(row: ItemRow): CleanedItemView {
  return {
    ...row,
    tags: parseJsonArray<string>(row.tags),
    sources: parseJsonArray<CleanedSourceView>(row.sources),
  };
}

const SELECT = `
  SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
         i.category, i.tags, i.event_date, i.sources, i.importance,
         r.cleaned_at, r.provider, r.model
  FROM cleaned_items i
  JOIN cleaned_records r ON r.source_record_id = i.source_record_id`;

/**
 * Read-only access to the cleaner's SQLite output (workers/cleaner/data).
 * The API never writes there; the cleaner owns that file. When the file does
 * not exist yet (cleaner never ran), every method degrades to empty results
 * instead of failing. A fresh connection per call keeps this correct when
 * the cleaner replaces the file.
 */
export class CleanedReader {
  constructor(private readonly dbFile: string) {}

  private open(): DatabaseSync | null {
    if (!existsSync(this.dbFile)) return null;
    try {
      return new DatabaseSync(this.dbFile, { readOnly: true });
    } catch {
      return null;
    }
  }

  listItems(filter: {
    category?: string;
    importance?: string;
    q?: string;
    limit: number;
    offset: number;
  }): { items: CleanedItemView[]; total: number } {
    const db = this.open();
    if (!db) return { items: [], total: 0 };
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.category) {
        where.push("i.category = ?");
        params.push(filter.category);
      }
      if (filter.importance) {
        where.push("i.importance = ?");
        params.push(filter.importance);
      }
      if (filter.q) {
        where.push("(i.title LIKE ? OR i.summary LIKE ?)");
        params.push(`%${filter.q}%`, `%${filter.q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM cleaned_items i ${whereSql}`)
        .get(...params) as { n: number };
      const rows = db
        .prepare(
          `${SELECT} ${whereSql}
           ORDER BY (i.event_date IS NULL), i.event_date DESC, r.cleaned_at DESC, i.idx ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit, filter.offset) as ItemRow[];
      return { items: rows.map(toView), total: Number(totalRow.n) };
    } finally {
      db.close();
    }
  }

  getItem(id: string): CleanedItemView | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
      return row ? toView(row) : null;
    } finally {
      db.close();
    }
  }

  stats(): CleanedStats {
    const empty: CleanedStats = { records: 0, items: 0, last_cleaned_at: null, categories: [], providers: [] };
    const db = this.open();
    if (!db) return empty;
    try {
      const records = db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as { n: number };
      const items = db.prepare("SELECT COUNT(*) AS n FROM cleaned_items").get() as { n: number };
      const last = db.prepare("SELECT MAX(cleaned_at) AS m FROM cleaned_records").get() as { m: string | null };
      const categories = db
        .prepare("SELECT category AS name, COUNT(*) AS count FROM cleaned_items GROUP BY category ORDER BY count DESC")
        .all() as { name: string; count: number }[];
      const providers = db
        .prepare("SELECT provider, model, COUNT(*) AS records FROM cleaned_records GROUP BY provider, model")
        .all() as { provider: string; model: string; records: number }[];
      return {
        records: Number(records.n),
        items: Number(items.n),
        last_cleaned_at: last.m,
        categories: categories.map((c) => ({ name: c.name, count: Number(c.count) })),
        providers: providers.map((p) => ({ ...p, records: Number(p.records) })),
      };
    } finally {
      db.close();
    }
  }
}
