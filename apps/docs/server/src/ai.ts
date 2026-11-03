/**
 * AI 专用 API（/api/ai/*）
 *
 * 设计目标：让 AI agent 不用拼 multipart 表单，只用 JSON 就能完成
 * 发现能力 → 上传 → 去重/覆盖 → 搜索 → 读纯文本 的完整闭环。
 *
 * 鉴权：设置环境变量 DOC_READER_API_KEY 后，所有写操作（POST）必须带
 *   X-API-Key: <key>  或  Authorization: Bearer <key>
 * 未设置时写操作开放（仅建议本地/可信网络使用）。读操作与能力发现不鉴权。
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { promises as fs } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { CATEGORIES, CATEGORY_IDS, isCategoryId, suggestCategory } from "../../shared/categories.js";
import type { CategoryId, DocMeta } from "../../shared/types.js";
import { parseHtml, isAnswerMeWithHtml } from "./parse.js";
import {
  listDocs, getDoc, addDoc, findByContentHash, findByExternalId, attachExternalId,
  replaceDoc, hashHtml, docFilePath,
} from "./store.js";

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const API_VERSION = "1";

function apiError(res: Response, status: number, code: string, message: string, extra?: object) {
  return res.status(status).json({ error: message, code, ...extra });
}

function checkApiKey(req: Request): boolean {
  const expected = process.env.DOC_READER_API_KEY;
  if (!expected) return true; // 未配置 key = 开放模式
  const given =
    (req.header("x-api-key") ?? "") ||
    (req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  if (checkApiKey(req)) return next();
  return apiError(res, 401, "unauthorized", "需要 API Key：请求头带 X-API-Key 或 Authorization: Bearer <key>");
}

/** 供主路由（网页端写接口）复用同一把 DOC_READER_API_KEY 的鉴权中间件 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  return requireKey(req, res, next);
}

function docView(doc: DocMeta, base: string) {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    category: doc.category,
    tags: doc.tags,
    source: doc.source,
    externalId: doc.externalId,
    size: doc.size,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    urls: {
      read: `${base}/#/doc/${doc.id}`,
      raw: `${base}/api/docs/${doc.id}/raw`,
      text: `${base}/api/ai/docs/${doc.id}/text`,
    },
  };
}

function baseOf(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

interface IngestInput {
  html: string;
  fileName?: string;
  title?: string;
  category?: string;
  tags?: unknown;
  externalId?: string;
  source?: string;
}

interface IngestResult {
  status: "created" | "deduped" | "replaced";
  doc: DocMeta;
}

/**
 * AI 入库的核心：三层幂等
 * 1) 带 externalId 且已存在 → 覆盖内容（replaced）
 * 2) 内容哈希已存在 → 不重复存（deduped）
 * 3) 否则新建（created）
 */
export async function ingestHtml(input: IngestInput): Promise<IngestResult> {
  const html = input.html;
  const fallbackName = input.fileName?.trim() || "ai-upload.html";
  const parsed = parseHtml(html, fallbackName.replace(/\.html?$/i, ""));
  const category: CategoryId = isCategoryId(input.category)
    ? input.category
    : suggestCategory(parsed.title, parsed.text).category;
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === "string").slice(0, 10)
    : [];
  const meta = {
    title: input.title?.trim() || parsed.title,
    description: parsed.description,
    category,
    tags,
    source: (isAnswerMeWithHtml(parsed)
      ? "answer-me-with-html"
      : "upload") as DocMeta["source"],
    generator: parsed.generator,
    originalName: fallbackName,
    size: Buffer.byteLength(html, "utf8"),
  };

  if (input.externalId) {
    const existing = await findByExternalId(input.externalId);
    if (existing) {
      if (existing.contentHash === hashHtml(html)) {
        return { status: "deduped", doc: existing };
      }
      const doc = await replaceDoc(existing.id, meta, html);
      return { status: "replaced", doc: doc! };
    }
    // externalId 是新的，但内容可能已由网页端/import:am 等无 externalId 的路径入库：
    // 先查内容哈希，命中则去重（并给已有文档补绑这个 externalId），不能绕过去重直接新建。
    const dup = await findByContentHash(hashHtml(html));
    if (dup) {
      const bound = dup.externalId ? dup : (await attachExternalId(dup.id, input.externalId)) ?? dup;
      return { status: "deduped", doc: bound };
    }
    const doc = await addDoc({ ...meta, externalId: input.externalId }, html);
    return { status: "created", doc };
  }

  const dup = await findByContentHash(hashHtml(html));
  if (dup) return { status: "deduped", doc: dup };
  const doc = await addDoc(meta, html);
  return { status: "created", doc };
}

function readHtmlFromBody(body: Record<string, unknown>): { html?: string; error?: string } {
  if (typeof body.html === "string" && body.html) return { html: body.html };
  if (typeof body.htmlBase64 === "string" && body.htmlBase64) {
    try {
      return { html: Buffer.from(body.htmlBase64, "base64").toString("utf8") };
    } catch {
      return { error: "htmlBase64 解码失败" };
    }
  }
  return { error: "请求体需要 html（字符串）或 htmlBase64（二选一）" };
}

function validateHtml(html: string): string | null {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return "HTML 超过 10MB 上限";
  if (!/<html[\s>]/i.test(html)) return "内容不是有效的 HTML（缺少 <html> 标签）";
  return null;
}

function validateCategory(body: Record<string, unknown>, res: Response): boolean {
  if (body.category !== undefined && !isCategoryId(body.category)) {
    apiError(res, 400, "invalid_category", `category 不合法，必须是以下之一`, {
      validCategories: CATEGORY_IDS,
    });
    return false;
  }
  return true;
}

/* ---------- SSRF 防护：拦内网/元数据地址 ---------- */
function isBlockedHost(hostname: string): "always" | "private" | null {
  const h = hostname.toLowerCase();
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return "always"; // 云元数据，永远拦
  if (h === "localhost" || h === "::1" || h === "[::1]") return "private";
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return "private";
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return "private";
  if (/^fc00:/.test(h) || /^fe80:/.test(h)) return "private";
  return null;
}

async function fetchHtml(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("url 不合法");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 http/https 的 url");
  const blocked = isBlockedHost(url.hostname);
  if (blocked === "always") throw new Error("该地址被禁止（云元数据地址）");
  if (blocked === "private" && process.env.DOC_READER_ALLOW_PRIVATE_URLS !== "1") {
    throw new Error("该地址是内网/本机地址；如确需抓取本地页面，在服务端设置 DOC_READER_ALLOW_PRIVATE_URLS=1");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "doc-reader-ai-import/1.0" },
    });
    if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) throw new Error("页面超过 10MB 上限");
    return buf.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 路由 ---------- */
export const aiRouter = Router();

/** 能力发现：AI 先调这个，拿到分类枚举、接口清单、鉴权要求，再决定怎么调用 */
aiRouter.get("/", (req, res) => {
  res.json({
    name: "doc-reader AI API",
    version: API_VERSION,
    auth: {
      required: Boolean(process.env.DOC_READER_API_KEY),
      header: "X-API-Key 或 Authorization: Bearer <key>",
      scope: "仅写操作（POST）需要",
    },
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, description: c.description })),
    limits: { maxHtmlBytes: MAX_HTML_BYTES, maxBatch: 20 },
    endpoints: [
      { method: "GET", path: "/api/ai", description: "能力发现（本接口）" },
      { method: "GET", path: "/api/ai/openapi.json", description: "OpenAPI 3.1 规范" },
      { method: "POST", path: "/api/ai/docs", description: "JSON 上传一篇 HTML（自动解析标题/分类，按内容去重，带 externalId 则覆盖更新）" },
      { method: "POST", path: "/api/ai/docs/batch", description: "批量 JSON 上传（documents 数组，最多 20）" },
      { method: "POST", path: "/api/ai/docs/from-url", description: "从 URL 抓取 HTML 入库" },
      { method: "GET", path: "/api/ai/docs/search", description: "紧凑搜索（q/category/limit/offset），结果带命中片段" },
      { method: "GET", path: "/api/ai/docs/:id/text", description: "取纯文本（maxChars 可截断），省 token 阅读" },
    ],
  });
});

aiRouter.get("/openapi.json", (req, res) => {
  const base = baseOf(req);
  res.json({
    openapi: "3.1.0",
    info: {
      title: "DocReader AI API",
      version: API_VERSION,
      description: "给 AI agent 用的文档入库与读取接口：JSON 上传、内容去重、externalId 覆盖、全文搜索、纯文本读取。",
    },
    servers: [{ url: base }],
    paths: {
      "/api/ai/docs": {
        post: {
          summary: "上传一篇 HTML 文档（JSON）",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/IngestDoc" },
                example: {
                  html: "<!doctype html><html><head><title>示例</title></head><body>…</body></html>",
                  category: "agent",
                  tags: ["示例"],
                  externalId: "my-doc-001",
                },
              },
            },
          },
          responses: {
            "201": { description: "新建成功" },
            "200": { description: "命中去重（deduped）或覆盖更新（replaced），body.status 说明" },
            "400": { description: "参数错误，body.code 给机器可读原因" },
            "401": { description: "缺少或错误的 API Key" },
          },
        },
      },
      "/api/ai/docs/batch": {
        post: {
          summary: "批量上传（documents 数组 ≤20），逐条返回结果，单条失败不影响其他",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["documents"],
                  properties: {
                    documents: { type: "array", maxItems: 20, items: { $ref: "#/components/schemas/IngestDoc" } },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "results 数组与请求同序" } },
        },
      },
      "/api/ai/docs/from-url": {
        post: {
          summary: "从 URL 抓取 HTML 入库（带 SSRF 防护）",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: { type: "string", format: "uri" },
                    title: { type: "string" },
                    category: { type: "string", enum: CATEGORY_IDS },
                    tags: { type: "array", items: { type: "string" } },
                    externalId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "新建" }, "200": { description: "去重/覆盖" }, "400": { description: "URL 不合法或被 SSRF 规则拦截" } },
        },
      },
      "/api/ai/docs/search": {
        get: {
          summary: "紧凑搜索：只回元数据 + 命中片段，省 token",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string", enum: CATEGORY_IDS } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "{ total, results: [{ id, title, category, tags, snippet, urls }] }" } },
        },
      },
      "/api/ai/docs/{id}/text": {
        get: {
          summary: "读取纯文本（去掉全部标签/脚本/样式）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "maxChars", in: "query", schema: { type: "integer", default: 20000, maximum: 200000 } },
          ],
          responses: { "200": { description: "{ id, title, text, truncated, totalChars }" }, "404": { description: "文档不存在" } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        IngestDoc: {
          type: "object",
          properties: {
            html: { type: "string", description: "完整 HTML（与 htmlBase64 二选一）" },
            htmlBase64: { type: "string", description: "HTML 的 base64（与 html 二选一）" },
            title: { type: "string", description: "可选；不给则取 HTML 的 <title>" },
            category: { type: "string", enum: CATEGORY_IDS, description: "可选；不给则按关键词自动分类" },
            tags: { type: "array", items: { type: "string" }, maxItems: 10 },
            fileName: { type: "string", description: "可选；原始文件名" },
            externalId: { type: "string", description: "可选；AI 侧稳定标识，同 id 再提交 = 覆盖更新" },
          },
        },
      },
    },
  });
});

aiRouter.post("/docs", requireKey, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!validateCategory(body, res)) return;
  const { html, error } = readHtmlFromBody(body);
  if (!html) return apiError(res, 400, "missing_html", error!);
  const invalid = validateHtml(html);
  if (invalid) return apiError(res, 400, "invalid_html", invalid);
  const result = await ingestHtml({
    html,
    fileName: body.fileName as string | undefined,
    title: body.title as string | undefined,
    category: body.category as string | undefined,
    tags: body.tags,
    externalId: typeof body.externalId === "string" ? body.externalId : undefined,
  });
  const status = result.status === "created" ? 201 : 200;
  res.status(status).json({ status: result.status, doc: docView(result.doc, baseOf(req)) });
});

aiRouter.post("/docs/batch", requireKey, async (req, res) => {
  const docsIn = (req.body as { documents?: unknown })?.documents;
  if (!Array.isArray(docsIn) || docsIn.length === 0) {
    return apiError(res, 400, "missing_documents", "请求体需要 documents 数组（1-20 篇）");
  }
  if (docsIn.length > 20) {
    return apiError(res, 400, "too_many", "单次批量最多 20 篇");
  }
  const results = [];
  for (const item of docsIn as Record<string, unknown>[]) {
    try {
      if (item.category !== undefined && !isCategoryId(item.category)) {
        results.push({ status: "error", code: "invalid_category", validCategories: CATEGORY_IDS });
        continue;
      }
      const { html, error } = readHtmlFromBody(item);
      if (!html) {
        results.push({ status: "error", code: "missing_html", error });
        continue;
      }
      const invalid = validateHtml(html);
      if (invalid) {
        results.push({ status: "error", code: "invalid_html", error: invalid });
        continue;
      }
      const r = await ingestHtml({
        html,
        fileName: item.fileName as string | undefined,
        title: item.title as string | undefined,
        category: item.category as string | undefined,
        tags: item.tags,
        externalId: typeof item.externalId === "string" ? item.externalId : undefined,
      });
      results.push({ status: r.status, doc: docView(r.doc, baseOf(req)) });
    } catch (e) {
      results.push({ status: "error", code: "internal", error: (e as Error).message });
    }
  }
  res.json({ results });
});

aiRouter.post("/docs/from-url", requireKey, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!validateCategory(body, res)) return;
  const url = body.url;
  if (typeof url !== "string" || !url) return apiError(res, 400, "missing_url", "请求体需要 url");
  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return apiError(res, 400, "fetch_failed", (e as Error).message);
  }
  const invalid = validateHtml(html);
  if (invalid) return apiError(res, 400, "invalid_html", invalid);
  const result = await ingestHtml({
    html,
    fileName: typeof body.fileName === "string" ? body.fileName : url.split("/").pop() || "from-url.html",
    title: body.title as string | undefined,
    category: body.category as string | undefined,
    tags: body.tags,
    externalId: typeof body.externalId === "string" ? body.externalId : undefined,
  });
  res.status(result.status === "created" ? 201 : 200).json({
    status: result.status,
    sourceUrl: url,
    doc: docView(result.doc, baseOf(req)),
  });
});

aiRouter.get("/docs/search", async (req, res) => {
  const q = ((req.query.q as string) ?? "").trim().toLowerCase();
  const category = req.query.category as string | undefined;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  let docs = await listDocs();
  if (category && isCategoryId(category)) docs = docs.filter((d) => d.category === category);
  const results: { doc: DocMeta; text: string }[] = [];
  for (const doc of docs) {
    let text = "";
    try {
      text = parseHtml(await fs.readFile(docFilePath(doc), "utf8"), doc.title).text;
    } catch { /* ignore */ }
    if (
      !q ||
      doc.title.toLowerCase().includes(q) ||
      doc.description.toLowerCase().includes(q) ||
      doc.tags.some((t) => t.toLowerCase().includes(q)) ||
      text.toLowerCase().includes(q)
    ) {
      results.push({ doc, text });
    }
  }
  const page = results.slice(offset, offset + limit).map(({ doc, text }) => {
    let snippet = doc.description;
    if (q) {
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) snippet = text.slice(Math.max(0, idx - 60), idx + q.length + 120);
    }
    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      tags: doc.tags,
      snippet,
      urls: docView(doc, baseOf(req)).urls,
    };
  });
  res.json({ total: results.length, limit, offset, results: page });
});

aiRouter.get("/docs/:id/text", async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return apiError(res, 404, "not_found", "文档不存在");
  const maxChars = Math.min(Math.max(Number(req.query.maxChars ?? 20000) || 20000, 100), 200000);
  let text = "";
  try {
    text = parseHtml(await fs.readFile(docFilePath(doc), "utf8"), doc.title).text;
  } catch {
    return apiError(res, 404, "file_missing", "文档文件不存在");
  }
  res.json({
    id: doc.id,
    title: doc.title,
    category: doc.category,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    totalChars: text.length,
  });
});
