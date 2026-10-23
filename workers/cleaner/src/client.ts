import type { RawRecord, RecordsPage } from "@data-pipeline/shared";

export interface RecordCursor {
  updated_at: string;
  id: string;
}

export interface RecordsClient {
  /** Records strictly after the cursor, ascending by (updated_at, id). */
  fetchSince(cursor: RecordCursor | null, limit: number): Promise<RawRecord[]>;
}

export function createRecordsClient(baseUrl: string, fetchFn: typeof fetch = fetch): RecordsClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async fetchSince(cursor: RecordCursor | null, limit: number): Promise<RawRecord[]> {
      const out: RawRecord[] = [];
      let after: RecordCursor | null = cursor;
      const pageSize = Math.min(limit, 100);
      while (out.length < limit) {
        const params = new URLSearchParams({ limit: String(pageSize), order: "updated_asc" });
        if (after) {
          params.set("updated_after", after.updated_at);
          params.set("after_id", after.id);
        }
        const res = await fetchFn(`${base}/api/v1/records?${params.toString()}`);
        if (!res.ok) throw new Error(`GET records failed: ${res.status} ${res.statusText}`);
        const page = (await res.json()) as RecordsPage;
        out.push(...page.items);
        if (page.items.length === 0) break;
        const lastRec = page.items[page.items.length - 1];
        after = { updated_at: lastRec.updated_at, id: lastRec.id };
        if (page.items.length < pageSize) break;
      }
      return out.slice(0, limit);
    },
  };
}
