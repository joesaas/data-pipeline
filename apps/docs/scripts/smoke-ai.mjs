/**
 * AI API 冒烟自检（自包含）：自己拉起一个带 API Key 的服务实例（临时数据目录），
 * 跑完 发现→鉴权→JSON上传→去重→externalId覆盖→批量→搜索→纯文本→URL导入→SSRF拦截 全链路。
 * 用法：npm run smoke:ai（需要先 npm install；用 tsx 跑源码，无需 build）
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3102;
const PAGE_PORT = 3103;
const BASE = `http://localhost:${PORT}`;
const KEY = "smoke-test-key";
const dataDir = mkdtempSync(path.join(tmpdir(), "doc-reader-ai-smoke-"));

function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("✓", msg);
}

async function waitHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not come up");
}

const pageServer = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>URL 导入样本 DeFi</title></head><body><p>defi liquidity pool 样本正文 xyz789</p></body></html>`);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, r));

const server = spawn("./node_modules/.bin/tsx", ["server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    DOC_READER_API_KEY: KEY,
    DOC_READER_ALLOW_PRIVATE_URLS: "1",
  },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const H = { "Content-Type": "application/json", "X-API-Key": KEY };
const post = (p, body, headers = H) =>
  fetch(`${BASE}${p}`, { method: "POST", headers, body: JSON.stringify(body) });

try {
  await waitHealth();

  // 1) 能力发现
  const cap = await (await fetch(`${BASE}/api/ai`)).json();
  assert(cap.auth.required === true, "capabilities: auth.required = true");
  assert(cap.categories.some((c) => c.id === "agent"), "capabilities: categories include agent");

  // 2) OpenAPI
  const spec = await (await fetch(`${BASE}/api/ai/openapi.json`)).json();
  assert(spec.paths["/api/ai/docs"]?.post, "openapi: POST /api/ai/docs present");

  // 3) 无 key 写 → 401
  const noKey = await post("/api/ai/docs", { html: "<html></html>" }, { "Content-Type": "application/json" });
  assert(noKey.status === 401, "write without key -> 401");

  // 4) JSON 上传（不给分类 → 自动 Agent）
  const html1 = `<!doctype html><html><head><title>AI上传测试 Agent</title></head><body><p>agent a2a mcp 协议正文 abc123</p></body></html>`;
  const up1 = await post("/api/ai/docs", { html: html1 });
  assert(up1.status === 201, `json upload -> 201 (got ${up1.status})`);
  const body1 = await up1.json();
  assert(body1.status === "created" && body1.doc.category === "agent", `auto category agent (got ${body1.doc.category})`);
  assert(body1.doc.urls.raw.includes("/raw"), "response includes urls.raw");
  const id1 = body1.doc.id;

  // 5) 同内容再传 → deduped，同 id
  const up2 = await post("/api/ai/docs", { html: html1 });
  const body2 = await up2.json();
  assert(up2.status === 200 && body2.status === "deduped" && body2.doc.id === id1, "same html -> deduped, same id");

  // 5b) 回归：同内容 + 全新 externalId → 仍应命中内容去重（不得绕过哈希新建重复），
  //     且 externalId 被补绑到已有文档上，之后用它提交新内容应走 replaced 且 id 不变
  const up2b = await post("/api/ai/docs", { html: html1, externalId: "smoke-ext-bind" });
  const body2b = await up2b.json();
  assert(up2b.status === 200 && body2b.status === "deduped" && body2b.doc.id === id1, "same html + new externalId -> deduped, same id (no hash-dedup bypass)");
  const up2c = await post("/api/ai/docs", {
    html: `<!doctype html><html><head><title>AI上传测试 Agent 改版</title></head><body><p>agent a2a mcp 协议正文 abc123 def456</p></body></html>`,
    externalId: "smoke-ext-bind",
  });
  const body2c = await up2c.json();
  assert(up2c.status === 200 && body2c.status === "replaced" && body2c.doc.id === id1, "bound externalId + new content -> replaced, same id");

  // 6) externalId upsert：v1 建，v2 覆盖
  const v1 = await post("/api/ai/docs", {
    html: `<!doctype html><html><head><title>版本一</title></head><body><p>v1 marker111</p></body></html>`,
    externalId: "smoke-ext-1",
  });
  assert(v1.status === 201, "externalId v1 -> 201");
  const v2 = await post("/api/ai/docs", {
    html: `<!doctype html><html><head><title>版本二</title></head><body><p>v2 marker222</p></body></html>`,
    externalId: "smoke-ext-1",
  });
  const bodyV2 = await v2.json();
  assert(v2.status === 200 && bodyV2.status === "replaced" && bodyV2.doc.title === "版本二", "externalId v2 -> replaced + new title");
  const textV2 = await (await fetch(`${BASE}/api/ai/docs/${bodyV2.doc.id}/text`)).json();
  assert(textV2.text.includes("marker222") && !textV2.text.includes("marker111"), "text endpoint returns v2 content");

  // 7) 批量：1 好 1 坏（坏分类）→ 逐条结果
  const batch = await post("/api/ai/docs/batch", {
    documents: [
      { html: `<!doctype html><html><head><title>批量 DeFi</title></head><body><p>defi amm liquidity</p></body></html>` },
      { html: `<!doctype html><html><head><title>坏分类</title></head><body>x</body></html>`, category: "nope" },
    ],
  });
  const batchBody = await batch.json();
  assert(batchBody.results[0].status === "created", "batch[0] created");
  assert(batchBody.results[1].status === "error" && batchBody.results[1].code === "invalid_category", "batch[1] invalid_category error, not fatal");

  // 8) 非法分类单传 → 400 带合法列表
  const badCat = await post("/api/ai/docs", { html: html1, category: "nope" });
  const badCatBody = await badCat.json();
  assert(badCat.status === 400 && Array.isArray(badCatBody.validCategories), "invalid category -> 400 + validCategories");

  // 9) 搜索带片段
  const search = await (await fetch(`${BASE}/api/ai/docs/search?q=abc123`)).json();
  assert(search.total >= 1 && search.results[0].snippet.includes("abc123"), "search returns snippet");

  // 10) from-url（本地页面服务器，靠 ALLOW_PRIVATE_URLS 放行）
  const fromUrl = await post("/api/ai/docs/from-url", { url: `http://127.0.0.1:${PAGE_PORT}/sample.html` });
  const fromUrlBody = await fromUrl.json();
  assert(fromUrl.status === 201 && fromUrlBody.doc.category === "defi", `from-url -> 201 defi (got ${fromUrl.status}/${fromUrlBody.doc?.category})`);

  // 11) 元数据地址永远拦（即使开了 ALLOW_PRIVATE_URLS）
  const meta = await post("/api/ai/docs/from-url", { url: "http://169.254.169.254/latest/meta-data/" });
  assert(meta.status === 400, "metadata address -> 400 (always blocked)");

  console.log("\nAI API 全部通过 ✅");
} finally {
  server.kill("SIGTERM");
  pageServer.close();
  rmSync(dataDir, { recursive: true, force: true });
}
