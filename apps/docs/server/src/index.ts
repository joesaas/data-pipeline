import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { CATEGORIES, isCategoryId, suggestCategory } from "../../shared/categories.js";
import type { CategoryId, DocMeta } from "../../shared/types.js";
import { parseHtml, isAnswerMeWithHtml } from "./parse.js";
import { listDocs, getDoc, addDoc, updateDoc, removeDoc, docFilePath } from "./store.js";
import { aiRouter, requireApiKey } from "./ai.js";

// 启动时加载 .env：真实进程环境变量优先，.env 只补缺（loadEnvFile 不覆盖已存在的变量）。
// 候选路径覆盖服务工作目录、源码布局（server/src 上两级）与构建布局（dist/server/src 上三级）。
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(moduleDir, "../../.env"),
  path.resolve(moduleDir, "../../../.env"),
]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    // 该候选不存在就试下一个
  }
}

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors());
// AI 接口要收整篇 HTML 的 JSON，单独放宽到 15mb；其余接口保持 1mb
app.use("/api/ai", express.json({ limit: "15mb" }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/ai", aiRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (/\.html?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("只接受 .html / .htm 文件"));
  },
});

/** 搜索用的全文文本不进 index.json，单独按需从文件解析太慢 —— 这里缓存 id->text */
const textCache = new Map<string, string>();
async function docText(doc: DocMeta): Promise<string> {
  const hit = textCache.get(doc.id);
  if (hit !== undefined) return hit;
  try {
    const html = await fs.readFile(docFilePath(doc), "utf8");
    const text = parseHtml(html, doc.title).text;
    textCache.set(doc.id, text);
    return text;
  } catch {
    return "";
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "doc-reader" });
});

app.get("/api/categories", async (_req, res) => {
  const docs = await listDocs();
  const counts = new Map<CategoryId, number>();
  for (const d of docs) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  res.json({
    total: docs.length,
    categories: CATEGORIES.map((c) => ({ ...c, count: counts.get(c.id) ?? 0 })),
  });
});

app.get("/api/docs", async (req, res) => {
  const category = req.query.category as string | undefined;
  const q = ((req.query.q as string) ?? "").trim().toLowerCase();
  const sort = (req.query.sort as string) ?? "newest";
  let docs = await listDocs();
  if (category && isCategoryId(category)) docs = docs.filter((d) => d.category === category);
  if (q) {
    const matched: DocMeta[] = [];
    for (const d of docs) {
      const inMeta =
        d.title.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q));
      if (inMeta || (await docText(d)).toLowerCase().includes(q)) matched.push(d);
    }
    docs = matched;
  }
  if (sort === "oldest") docs.reverse();
  if (sort === "title") docs.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  res.json(docs);
});

app.get("/api/docs/:id", async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: "文档不存在" });
  res.json(doc);
});

/**
 * 原始文档：单独路径 + sandbox CSP。
 * answer-me-with-html 的页面带内联脚本（交互布局），需要 allow-scripts；
 * allow-same-origin 让文档与主站同源、Clipboard API 可用（文档内复制按钮）。
 * 注意：iframe 的 sandbox 属性与这里的 CSP 同时生效、取交集，
 * 只改一处的话另一处仍会把文档锁在不透明源。
 */
app.get("/api/docs/:id/raw", async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).send("not found");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-same-origin");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(docFilePath(doc));
});

app.get("/api/docs/:id/download", async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).send("not found");
  res.download(docFilePath(doc), doc.originalName);
});

/** 上传前预览：只解析不落盘，返回标题/简介/建议分类，前端确认后再真正上传 */
app.post("/api/docs/parse", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "没有收到文件" });
  const html = req.file.buffer.toString("utf8");
  if (!/<html[\s>]/i.test(html)) return res.status(400).json({ error: "不是有效的 HTML 文件" });
  const parsed = parseHtml(html, req.file.originalname.replace(/\.html?$/i, ""));
  const { category, scores } = suggestCategory(parsed.title, parsed.text);
  res.json({
    originalName: req.file.originalname,
    size: req.file.size,
    title: parsed.title,
    description: parsed.description,
    generator: parsed.generator,
    suggestedCategory: category,
    scores,
  });
});

interface UploadMetaItem {
  originalName: string;
  title?: string;
  category?: string;
  tags?: string[];
}

/** 正式上传：可多文件。meta 是与文件同序的 JSON 数组（表单字段 meta）。 */
app.post("/api/docs", requireApiKey, upload.array("files", 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "没有收到文件" });
  let meta: UploadMetaItem[] = [];
  try {
    meta = JSON.parse((req.body?.meta as string) ?? "[]");
  } catch {
    return res.status(400).json({ error: "meta 字段不是合法 JSON" });
  }
  const created: DocMeta[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const html = file.buffer.toString("utf8");
    if (!/<html[\s>]/i.test(html)) continue;
    const m = meta.find((x) => x.originalName === file.originalname) ?? meta[i] ?? {};
    const parsed = parseHtml(html, file.originalname.replace(/\.html?$/i, ""));
    const category: CategoryId = isCategoryId(m.category)
      ? m.category
      : suggestCategory(parsed.title, parsed.text).category;
    const doc = await addDoc(
      {
        title: m.title?.trim() || parsed.title,
        description: parsed.description,
        category,
        tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string").slice(0, 10) : [],
        source: isAnswerMeWithHtml(parsed) ? "answer-me-with-html" : "upload",
        generator: parsed.generator,
        originalName: file.originalname,
        size: file.size,
      },
      html,
    );
    created.push(doc);
  }
  if (created.length === 0) return res.status(400).json({ error: "没有有效的 HTML 文件" });
  res.status(201).json(created);
});

app.patch("/api/docs/:id", requireApiKey, async (req, res) => {
  const { title, description, category, tags } = req.body ?? {};
  const patch: Parameters<typeof updateDoc>[1] = {};
  if (typeof title === "string" && title.trim()) patch.title = title.trim();
  if (typeof description === "string") patch.description = description;
  if (isCategoryId(category)) patch.category = category;
  if (Array.isArray(tags)) patch.tags = tags.filter((t) => typeof t === "string").slice(0, 10);
  const doc = await updateDoc(req.params.id, patch);
  if (!doc) return res.status(404).json({ error: "文档不存在" });
  textCache.delete(doc.id);
  res.json(doc);
});

app.delete("/api/docs/:id", requireApiKey, async (req, res) => {
  const ok = await removeDoc(req.params.id);
  if (!ok) return res.status(404).json({ error: "文档不存在" });
  textCache.delete(req.params.id);
  res.status(204).end();
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: err.message || "请求处理失败" });
});

// 生产模式：同进程托管前端构建产物
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.resolve(process.cwd(), "client/dist");
app.use(express.static(CLIENT_DIST));
app.get(/^(?!\/api\/).*/, async (req, res, next) => {
  try {
    await fs.access(path.join(CLIENT_DIST, "index.html"));
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  } catch {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`doc-reader server listening on http://localhost:${PORT}`);
});
