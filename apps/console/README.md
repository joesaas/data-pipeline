# console：Web 管理控制台

Vue 3 + Vite 单页应用，构建产物由 API 进程静态托管（`/console` 与
`<basePath>/console` 两个前缀），**不新增 pm2 进程**。

## 功能

- Tokens：列表（id、名字、角色、创建时间、吊销时间）、新建、吊销。
- Cursor 定时触发：状态（上次触发、当前区间、下次触发约、webhook 是否已配置
  及其来源）、改区间、手动触发一次、webhook 配置管理、prompt 编辑。

## 鉴权与安全红线

- 控制台没有独立账号：登录就是粘贴一把 admin 钥匙，存在浏览器 localStorage，
  每次请求以 `X-API-Key` 头带上。非 admin 钥匙进不来（403），无钥匙 401。
- 明文钥匙只在创建那一刻返回一次，之后谁也查不回来（库里只存哈希）。
  列表接口不返回 `key_hash`，也不返回明文。
- webhook 配置存在数据库 `webhook_configs` 表里（Cursor 页的表单管理）：
  只写不回显——只填要改的项，空着不动；token 明文存库是必需的（每次触发
  都要拿它发 Bearer），但任何接口都不返回它，页面只显示已配置、来源
  （数据库 / .env 回落）与更新时间。触发任务每次尝试时都从库里现读，
  所以保存后下次触发即生效，无需重启 job-runner。
- 旧部署的 `.env` 里如果已有 webhook 值，触发会先读库、读不到才回落 `.env`；
  控制台在来源是 `.env` 时会给出「从 .env 导入到数据库」按钮，点一下
  即完成迁移（值不经过浏览器），此后数据库优先、`.env` 的旧行可删可留；
  「清除数据库配置」则删掉库里的行，触发回到 `.env` 回落。
- 每次触发 body 里带的 `prompt` 也可以在控制台上改（Cursor 页的文本框）：
  它存在触发状态文件里（不是 .env——prompt 是多行长文本、不是密钥），页面上
  直接显示、可编辑；设了之后，每次触发（定时或手动）body 都会带上
  `prompt` 字段，接收方按它执行；清空保存即恢复只发 ping（body 只有
  `source` 与 `triggered_at`）。区间与 prompt 共用状态文件的读-改-写，
  两边保存都不会丢对方的值。
- 手动触发走 API 路由 spawn 的 job 单次模式（`--run cursor-trigger`），与定时
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
