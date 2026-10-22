/**
 * Server-side data access for the web UI. Pages are server components, so
 * these fetches run in the web process and talk to the API service directly.
 * API base includes the project prefix, e.g. http://localhost:8080/data-pipeline
 */
const API_BASE = (process.env.DATA_PIPELINE_API_URL ?? "http://localhost:8080/data-pipeline").replace(/\/$/, "");

export interface CleanedSource {
  name: string;
  url: string;
}

export interface CleanedItem {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string[];
  event_date: string | null;
  sources: CleanedSource[];
  importance: "high" | "medium" | "low" | string;
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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return (await res.json()) as T;
}

export function fetchItems(params: { category?: string; importance?: string; q?: string; limit?: number }): Promise<{ items: CleanedItem[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.category) qs.set("category", params.category);
  if (params.importance) qs.set("importance", params.importance);
  if (params.q) qs.set("q", params.q);
  qs.set("limit", String(params.limit ?? 100));
  return getJson(`/api/v1/cleaned/items?${qs.toString()}`);
}

export function fetchItem(id: string): Promise<CleanedItem> {
  return getJson(`/api/v1/cleaned/items/${encodeURIComponent(id)}`);
}

export function fetchStats(): Promise<CleanedStats> {
  return getJson("/api/v1/cleaned/stats");
}

export const IMPORTANCE_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
