# DocReader 公网部署：诊断与修复（2026-10-10 实测）

## 诊断（2026-10-10 18:53 CST 从公网实测）

- `http://54.179.160.171/` → 200 OK，返回 DocReader 页面（Server: nginx/1.30.5，Express）。**公网 HTTP 是通的。**
- `https://54.179.160.171/` → 超时。实例上只有 0.0.0.0:80 在监听、没有 443 进程，所以 https 地址永远打不开——不是安全组玄学，是根本没服务在 443 上。**别再试 https，先用 http。**
- `GET /api/ai` 返回 `auth.required: false` → 实例上**没有设置 DOC_READER_API_KEY**，AI 写接口（POST 上传/批量/from-url）对全网开放。
- 更大的洞（代码级）：`server/src/index.ts` 里网页端写接口 `POST /api/docs`、`PATCH /api/docs/:id`、`DELETE /api/docs/:id` **完全没有鉴权中间件**——就算设了 API Key，这三个口仍然裸奔，任何人可删光全部文档。`DOC_READER_API_KEY` 原先只保护 `/api/ai` 的 POST。

## 立即止血（不改代码，AWS 控制台 2 分钟）

安全组把 80 端口的来源从 `0.0.0.0/0` 收紧为你自己的公网 IP /32。公网读者本来就只有你自己，收紧后风险立刻归零，HTTPS 和鉴权可以慢慢补。

## 代码修复（本地已改好并验证）

改动 2 个文件，让网页端写接口复用同一把 `DOC_READER_API_KEY`：

1. `server/src/ai.ts`：新增导出 `requireApiKey`（内部复用原 `requireKey`）。
2. `server/src/index.ts`：import 增加 `requireApiKey`，并给三条写路由加中间件：
   - `app.post("/api/docs", requireApiKey, upload.array(...), ...)`
   - `app.patch("/api/docs/:id", requireApiKey, ...)`
   - `app.delete("/api/docs/:id", requireApiKey, ...)`

行为：未设 Key 时与原来完全一致（本地开发不受影响）；设了 Key 后，无 Key 的写请求一律 401，读接口（GET）保持开放。

本地验证（2026-10-10，`DOC_READER_API_KEY=testkey123` 起临时实例）：
- 无 Key DELETE → 401 ✓；无 Key PATCH → 401 ✓
- 带 Key DELETE 不存在的 id → 404（已过鉴权）✓
- 无 Key GET /api/docs → 200（读不受影响）✓
- 无 Key POST /api/ai/docs → 401 ✓
- `tsc -p tsconfig.server.json --noEmit` 通过 ✓

注意取舍：设 Key 后，网页端 UI 的上传/删除/改分类也会被 401（前端不带 Key）——公网部署时这正是想要的只读效果，写入走带 Key 的 AI API。若以后要恢复 UI 写入，需给前端加 Key 输入框（另一件事）。

## 部署步骤（AWS 实例上）

```bash
# 1. 同步上面两个改过的文件到实例并 rebuild（按你现有部署方式）
npm run build
# 2. 带 Key 重启服务（Key 自己生成、自己保存，别写进仓库）
export DOC_READER_API_KEY='<生成一个长随机串>'
# 若用 systemd/pm2，把该环境变量写进对应的 unit / ecosystem 配置再重启
```

重启后自检：`curl http://54.179.160.171/api/ai` 应显示 `auth.required: true`；无 Key `curl -X DELETE http://54.179.160.171/api/docs/任意id` 应回 401。

## HTTPS（需要域名，IP 本身做不了正经 HTTPS）

Let's Encrypt 等常规证书签给域名、不签给裸 IP。想要 https：
1. 准备一个域名解析到 54.179.160.171；
2. 实例上 certbot / nginx 配置 443 + 证书自动续期；
3. 或走 CloudFront / ALB + ACM（更重，不推荐为这个小服务上）。
在有域名之前，http + 安全组限 IP 是更实际的组合。
