# DocReader AI API

给 AI agent 用的接口：不用拼 multipart 表单，**纯 JSON** 就能把 HTML 文档入库、更新、搜索和读取。所有接口挂在 `/api/ai` 下。

## 快速上手（给 AI 的三步）

1. **发现能力**：`GET /api/ai` — 返回分类枚举（category 只能取这些值）、接口清单、限额、是否需要 API Key。不知道分类/参数时先调它，或者直接读 `GET /api/ai/openapi.json`（OpenAPI 3.1）。
2. **上传**：`POST /api/ai/docs`，body 里给 `html` 全文即可。标题不给则自动取 `<title>`，分类不给则按关键词自动判断。
3. **读回**：搜索用 `GET /api/ai/docs/search?q=`（只回元数据+命中片段，省 token），读全文纯文本用 `GET /api/ai/docs/:id/text`。

## 鉴权

服务端设置环境变量 `DOC_READER_API_KEY` 后，所有写操作（POST）必须带请求头（二选一）：

```
X-API-Key: <key>
Authorization: Bearer <key>
```

未设置该变量时写操作开放（仅适合本地/可信网络）。读操作与能力发现不鉴权。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai` | 能力发现：分类枚举、接口清单、限额、鉴权要求 |
| GET | `/api/ai/openapi.json` | OpenAPI 3.1 规范，可直接喂给支持 OpenAPI 的 agent 框架 |
| POST | `/api/ai/docs` | 上传一篇（JSON） |
| POST | `/api/ai/docs/batch` | 批量上传，`documents` 数组 ≤20，逐条返回结果 |
| POST | `/api/ai/docs/from-url` | 从 URL 抓取 HTML 入库（带 SSRF 防护） |
| GET | `/api/ai/docs/search` | 紧凑搜索：`q` / `category` / `limit` / `offset` |
| GET | `/api/ai/docs/:id/text` | 纯文本读取：`maxChars`（默认 20000，上限 200000） |

管理操作（改分类、删除）沿用网页端接口：`PATCH /api/docs/:id`、`DELETE /api/docs/:id`。

## 上传一篇

```bash
curl -X POST http://localhost:3001/api/ai/docs \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_KEY' \
  -d '{
    "html": "<!doctype html><html><head><title>AP2 协议笔记</title></head><body>...</body></html>",
    "category": "agent",
    "tags": ["AP2", "支付协议"],
    "externalId": "notes-ap2-v1"
  }'
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `html` | 二选一 | 完整 HTML 字符串 |
| `htmlBase64` | 二选一 | HTML 的 base64（内容不便直接放 JSON 时用） |
| `title` | 否 | 不给则取 `<title>` |
| `category` | 否 | 枚举见 `GET /api/ai`；不给则自动分类；给错返回 400 并附 `validCategories` |
| `tags` | 否 | 字符串数组，≤10 |
| `fileName` | 否 | 原始文件名（仅记录） |
| `externalId` | 否 | **AI 侧的稳定标识**，见下方幂等规则 |

成功响应（201 新建 / 200 去重或覆盖）：

```json
{
  "status": "created",
  "doc": {
    "id": "a1b2c3d4e5f6",
    "title": "AP2 协议笔记",
    "category": "agent",
    "urls": {
      "read": "http://localhost:3001/#/doc/a1b2c3d4e5f6",
      "raw": "http://localhost:3001/api/docs/a1b2c3d4e5f6/raw",
      "text": "http://localhost:3001/api/ai/docs/a1b2c3d4e5f6/text"
    }
  }
}
```

## 幂等规则（agent 重试安全）

三层去重，按顺序判定：

1. **带 `externalId` 且已存在** → 内容变了则**覆盖更新**（`status: "replaced"`，id 不变）；内容没变 → `deduped`。
2. **内容 SHA-256 已存在** → 不重复存，返回已有文档（`status: "deduped"`）。
3. 其余 → 新建（`status: "created"`）。

所以 agent 生成/修正同一篇文档时，固定用同一个 `externalId` 反复提交即可，不会攒出一堆重复文档。

## 批量上传

```bash
curl -X POST http://localhost:3001/api/ai/docs/batch \
  -H 'Content-Type: application/json' -H 'X-API-Key: YOUR_KEY' \
  -d '{ "documents": [ { "html": "...", "category": "defi" }, { "html": "..." } ] }'
```

返回 `{ "results": [...] }` 与请求同序；单条失败是 `{ "status": "error", "code": "..." }`，不影响其他条目。

## 从 URL 导入

`POST /api/ai/docs/from-url`，body：`{ "url": "https://...", "category"?, "tags"?, "externalId"? }`。

SSRF 防护：云元数据地址（169.254.0.0/16）永远拦截；内网/本机地址默认拦截，服务端显式设置 `DOC_READER_ALLOW_PRIVATE_URLS=1` 才放行（用于抓取本机生成的页面）。超时 15 秒，上限 10MB。

## 错误格式

所有错误统一为 `{ "error": "人类可读信息", "code": "机器可读代码" }`，常见 code：`unauthorized`（401）、`missing_html`、`invalid_html`、`invalid_category`（附 `validCategories`）、`missing_url`、`fetch_failed`、`not_found`。

## TypeScript 客户端示例

```ts
const BASE = "http://localhost:3001";
const KEY = process.env.DOC_READER_API_KEY ?? "";

export async function uploadHtml(html: string, opts: {
  title?: string; category?: string; tags?: string[]; externalId?: string;
} = {}) {
  const res = await fetch(`${BASE}/api/ai/docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify({ html, ...opts }),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json(); // { status: "created" | "deduped" | "replaced", doc }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOC_READER_API_KEY` | 未设置（开放） | 设置后 AI 写接口需要带 Key |
| `DOC_READER_ALLOW_PRIVATE_URLS` | 未设置 | `1` = from-url 允许内网/本机地址（元数据地址仍拦） |

## 自检

```bash
npm run smoke:ai
```

自包含脚本：拉起一个带 Key 的临时实例，跑完 发现→鉴权→上传→去重→覆盖→批量→搜索→纯文本→URL 导入→SSRF 拦截 全链路。
