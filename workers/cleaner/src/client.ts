import type { RawRecord, RecordsPage } from "@data-pipeline/shared";

export interface RecordsClient {
  fetchAll(limit: number): Promise<RawRecord[]>;
}

export function createRecordsClient(baseUrl: string, fetchFn: typeof fetch = fetch): RecordsClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async fetchAll(limit: number): Promise<RawRecord[]> {
      const out: RawRecord[] = [];
      let offset = 0;
      const pageSize = Math.min(limit, 100);
      while (out.length < limit) {
        const res = await fetchFn(`${base}/api/v1/records?limit=${pageSize}&offset=${offset}`);
        if (!res.ok) throw new Error(`GET records failed: ${res.status} ${res.statusText}`);
        const page = (await res.json()) as RecordsPage;
        out.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || out.length >= page.total) break;
      }
      return out.slice(0, limit);
    },
  };
}
