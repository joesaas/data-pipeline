import type { CategoryWithCount, DocMeta } from "../../../shared/types";

export interface CategoriesResponse {
  total: number;
  categories: CategoryWithCount[];
}

export interface ParseResult {
  originalName: string;
  size: number;
  title: string;
  description: string;
  generator?: string;
  suggestedCategory: string;
  scores: Record<string, number>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  categories: () => fetch("/api/categories").then((r) => json<CategoriesResponse>(r)),
  docs: (params: { category?: string; q?: string; sort?: string }) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    if (params.sort) qs.set("sort", params.sort);
    return fetch(`/api/docs?${qs}`).then((r) => json<DocMeta[]>(r));
  },
  doc: (id: string) => fetch(`/api/docs/${id}`).then((r) => json<DocMeta>(r)),
  parse: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/docs/parse", { method: "POST", body: form }).then((r) =>
      json<ParseResult>(r),
    );
  },
  upload: (
    files: File[],
    meta: { originalName: string; title?: string; category?: string; tags?: string[] }[],
  ) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.append("meta", JSON.stringify(meta));
    return fetch("/api/docs", { method: "POST", body: form }).then((r) => json<DocMeta[]>(r));
  },
  update: (id: string, patch: Partial<Pick<DocMeta, "title" | "category" | "tags" | "description">>) =>
    fetch(`/api/docs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<DocMeta>(r)),
  remove: async (id: string) => {
    const res = await fetch(`/api/docs/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`删除失败 (${res.status})`);
  },
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
