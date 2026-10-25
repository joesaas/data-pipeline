# console：Web 管理控制台

Vue 3 + Vite 单页应用，构建产物由 API 进程静态托管（`/console` 与
`<basePath>/console` 两个前缀），**不新增 pm2 进程**。

## 功能

- Tokens：列表（id、名字、角色、创建时间、吊销时间）、新建、吊销。
- Webhooks：列表（名字、URL、定时、更新时间、操作：详情、编辑、测试一次、
  设为定时/取消定时、删除），表格下方是创建行（名字 + URL + token + 可选
  payload 模板 + 新建），点行或点详情进详情页（URL、token 状态、payload
  模板、操作按钮），行内编辑打开编辑表单（URL 与 token 留空不改、模板是
  完整值），行内删除带确认框。定时触发只发标为“定时”的那条 webhook；
  测试一次只发这一条，不改定时设置、不动触发节奏（测试不写触发状态文件）。
  列表操作即时生效。没有标为定时的行时，定时触发当轮跳过。
- Records：数据库 records 表的列表（标题、来源、桶、external_id、标签、
  内容字数、更新时间；每页 20 条，支持按来源与标签筛选、上一页/下一页），
  点行或点详情进详情页（id、桶、external_id、来源、skill_version、
  content_format、标签、创建/更新时间、metadata、prompt、content 全文），
  列表与详情均可删除（带确认框）。记录只能从 push 接口进来，控制台不新
  建、不编辑。这一页没有新增 admin 接口：它直接调已有的
  `GET /api/v1/records` 与 `DELETE /api/v1/records/:id`，admin 钥匙本来就
  跨桶读全部记录、删任意一条；桶名按 token_id 对应 Tokens 页的名字显示。
  刷新：点刷新时按钮变“⟳ 刷新中…”并禁用（防重复点导致旧页覆盖新页），
  成功后“上次刷新”时间戳必变——即使没有新记录，也能一眼看出这次刷新
  真跑了；切进 Records 页时也会自动重拉一次。控制台所有请求都带
  `cache: no-store`：API 不发 Cache-Control，普通 GET 可能被浏览器启发
  式缓存，导致刷新看起来像没点、一直显示旧数据，no-store 强制每次走网络。

后台定时触发（job-runner 里的 cursor-trigger 任务，每 1 分钟 tick、按状态
文件自我门控）仍在跑：触发地址取 webhooks 表里标为定时的那行，区间与
prompt 仍读触发状态文件（此前在控制台上改过的值继续生效），只是控制台
不再提供改它们的入口。

## 鉴权与安全红线

- 控制台没有独立账号：登录就是粘贴一把 admin 钥匙，存在浏览器 localStorage，
  每次请求以 `X-API-Key` 头带上。非 admin 钥匙进不来（403），无钥匙 401。
- 明文钥匙只在创建那一刻返回一次，之后谁也查不回来（库里只存哈希）。
  列表接口不返回 `key_hash`，也不返回明文。
- webhook 存在数据库 `webhooks` 表里（唯一的一张 webhook 表，含 payload
  字段）：URL 与 payload 会回显到表单里（token 永不回显：只填要改的项，
  空着不动）；token 明文存库是必需的（每次触发都要拿它发 Bearer），但
  任何接口都不返回它，页面只显示已配置与更新时间。触发任务每次尝试时
  都从库里现读，所以保存后下次触发即生效，无需重启 job-runner。
- body 规则：定时 payload（`webhook_payloads` 表里标为定时的那条，如有）→
  webhook 行上的单个 payload 模板 → 状态文件里的单个 prompt → 只发 ping。
  body 里可用占位符 `{{triggered_at}}` 与 `{{source}}`，发送时替换为本次触发
  的值。`webhook_payloads` 表仍在库里、触发仍读它，但控制台不再管理它。
- 测试一次走 API 路由 spawn 的 job 单次模式（`--run cursor-trigger`），与定时
  走同一份代码；并发第二次触发返回 409，不会双发 webhook。

## 本地开发与构建

```bash
npm run build -w @data-pipeline/console   # 产物在 apps/console/dist/
npm run dev -w @data-pipeline/console     # 仅调界面；API 请求需同源或代理
```

API 在启动时检查 `apps/console/dist/` 是否存在：存在才挂载 `/console`，
不存在则静默跳过（CLI、旧部署都不受影响）。部署顺序保证构建先于重启，
所以 `deploy.sh deploy` 后控制台即随 API 一起上线。

## 路由与反向代理注意事项

- 构建产物用绝对资源基址 `/data-pipeline/console/`（见 vite.config.js），
  而不用相对路径：控制台必须在带尾斜杠与不带尾斜杠两种 URL 下都能用，
  相对基址在无斜杠 URL 下会把资源解析到父目录而 404。
- API 挂载静态资源时关掉了重定向（`redirect: false`，见 routes.ts）：
  nginx 代理会剥掉 `/data-pipeline` 前缀，默认重定向会发出不带前缀的
  `Location: /console/`，浏览器会被带到别的站点（2026-10-25 实测：落到
  doc 站）。关掉重定向后，无斜杠地址直接返回首页，不再发出 Location。
