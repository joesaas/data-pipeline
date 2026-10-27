import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { AppConfig } from "../config.js";
import type { CleanedReader, CleanedItemView } from "../cleaned/cleaned-reader.js";
import { ValidationError } from "../domain/types.js";
import type { NewsDetailStore } from "./news-detail-store.js";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** A cleaned item that still needs a rich detail page, as the Muse
 *  cron job sees it. original_url is the pre-existing news/item page
 *  (step 5 of the design: that logic is retained, not replaced) —
 *  the cron job reads it to fetch the original article, and the new
 *  detail page is a separate file under NEWS_DETAIL_DIR. */
export interface PendingNewsDetailItem {
  id: string;
  title: string;
  title_zh: string | null;
  summary: string;
  summary_zh: string | null;
  detail: string | null;
  category: string;
  tags: string[];
  event_date: string | null;
  sources: { name: string; url: string }[];
  cleaned_at: string;
  original_url: string;
  detail_status: "pending" | "done";
  detail_path: string | null;
}

const DETAIL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;
const HTML_START_RE = /^\s*(<!doctype html|<html)/i;

/** Default file name for an item: its stable cleaned id. This keeps
 *  file names unique without inventing a slug from a title (titles
 *  contain spaces, punctuation and non-ASCII characters). */
export function defaultDetailPath(itemId: string): string {
  return `${itemId}.html`;
}

/** Reject anything that is not a plain file name in the detail
 *  directory: no slashes, no "..", no absolute paths, .html only.
 *  The caller also checks the resolved path stays inside the dir. */
export function validateDetailPath(detailPath: string): void {
  if (!DETAIL_PATH_RE.test(detailPath)) {
    throw new ValidationError(
      "detail_path must be a plain .html file name, e.g. <item-id>.html",
      "detail_path",
    );
  }
}

export class NewsDetailService {
  constructor(
    private readonly cleaned: CleanedReader,
    private readonly store: NewsDetailStore,
    private readonly config: AppConfig,
  ) {}

  originalUrl(itemId: string): string {
    return `${this.config.newsSiteUrl}/item/${encodeURIComponent(itemId)}/`;
  }

  private toPending(item: CleanedItemView, existing?: ReturnType<NewsDetailStore["get"]>): PendingNewsDetailItem {
    const row = existing ?? this.store.get(item.id);
    return {
      id: item.id,
      title: item.title,
      title_zh: item.title_zh,
      summary: item.summary,
      summary_zh: item.summary_zh,
      detail: item.detail,
      category: item.category,
      tags: item.tags,
      event_date: item.event_date,
      sources: item.sources,
      cleaned_at: item.cleaned_at,
      original_url: this.originalUrl(item.id),
      detail_status: row?.status ?? "pending",
      detail_path: row?.detail_path ?? null,
    };
  }

  /**
   * Items with no "done" detail page yet, oldest cleaned first, at
   * most `limit` (clamped to 1..10 by the caller and again here).
   * Scans cleaned items in pages of 50 and skips done ones; the scan
   * is bounded (at most 500 items per call) so a mostly-done backlog
   * cannot turn one pull into a full table walk on every cron tick.
   * When the store already reports at least as many done rows as there
   * are cleaned items, the scan is skipped entirely.
   */
  listPending(limitInput: number): { items: PendingNewsDetailItem[]; limit: number } {
    const limit = Math.min(Math.max(Math.floor(limitInput) || 10, 1), 10);
    const { total } = this.cleaned.listItems({ limit: 1, offset: 0 });
    if (total === 0) return { items: [], limit };
    if (this.store.countDone() >= total) return { items: [], limit };
    const items: PendingNewsDetailItem[] = [];
    const pageSize = 50;
    const maxScanned = 500;
    for (let offset = 0; offset < total && offset < maxScanned && items.length < limit; offset += pageSize) {
      const page = this.cleaned.listItems({
        limit: pageSize,
        offset,
        order: "cleaned_asc",
      });
      for (const item of page.items) {
        const existing = this.store.get(item.id);
        if (existing?.status === "done") continue;
        items.push(this.toPending(item, existing));
        if (items.length >= limit) break;
      }
      if (page.items.length < pageSize) break;
    }
    return { items, limit };
  }

  getPage(itemId: string): ReturnType<NewsDetailStore["get"]> {
    return this.store.get(itemId);
  }

  listDone(): { item_id: string; detail_path: string }[] {
    return this.store.listDone();
  }

  /**
   * Save a generated single-page HTML detail file and record it.
   * File first, then database: a failed write never marks an item
   * done, and a re-push overwrites the file and the row (status
   * "replaced", same item_id and same default file name).
   */
  savePage(input: {
    item_id: string;
    html: string;
    detail_path?: string;
  }): {
    item_id: string;
    detail_path: string;
    original_url: string;
    status: "created" | "replaced";
    updated_at: string;
  } {
    const item = this.cleaned.getItem(input.item_id);
    if (!item) {
      throw new NotFoundError(`cleaned item not found: ${input.item_id}`);
    }
    if (typeof input.html !== "string" || input.html.trim() === "") {
      throw new ValidationError("html must be a non-empty HTML document", "html");
    }
    if (Buffer.byteLength(input.html, "utf8") > this.config.maxContentBytes) {
      throw new ValidationError("html exceeds max content size", "html", true);
    }
    if (!HTML_START_RE.test(input.html)) {
      throw new ValidationError("html must start with <!doctype html or <html", "html");
    }
    const detailPath = input.detail_path ?? defaultDetailPath(input.item_id);
    validateDetailPath(detailPath);

    const dir = resolve(this.config.newsDetailDir);
    const target = resolve(join(dir, detailPath));
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new ValidationError("detail_path escapes the detail directory", "detail_path");
    }
    // basename() is redundant after the regex + prefix check, but it
    // keeps the intent obvious to the next reader: one flat file name.
    if (basename(target) !== detailPath) {
      throw new ValidationError("detail_path must be a plain file name", "detail_path");
    }
    mkdirSync(dir, { recursive: true });
    // Atomic publish: write a temp file in the same directory, then
    // rename over the target, so a reader never sees a half-written page.
    const tmp = join(dir, `.tmp-${input.item_id}-${process.pid}-${Date.now()}`);
    writeFileSync(tmp, input.html, "utf8");
    renameSync(tmp, target);

    const now = new Date().toISOString();
    const existing = this.store.get(input.item_id);
    const status = this.store.save({
      item_id: input.item_id,
      detail_path: detailPath,
      status: "done",
      original_url: this.originalUrl(input.item_id),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    return {
      item_id: input.item_id,
      detail_path: detailPath,
      original_url: this.originalUrl(input.item_id),
      status,
      updated_at: now,
    };
  }
}
