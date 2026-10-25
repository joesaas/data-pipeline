# console：Web 管理控制台

Vue 3 + Vite 单页应用，构建产物由 API 进程静态托管（`/console` 与
`<basePath>/console` 两个前缀），**不新增 pm2 进程**。

## 功能

- Tokens：列表（id、名字、角色、创建时间、吊销时间）、新建、吊销。
- Cursor 定时触发：状态（上次触发、当前区间、下次触发约、webhook 是否已配置）、
  改区间、手动触发一次。

## 鉴权与安全红线

- 控制台没有独立账号：登录就是粘贴一把 admin 钥匙，存在浏览器 localStorage，
  每次请求以 `X-API-Key` 头带上。非 admin 钥匙进不来（403），无钥匙 401。
- 明文钥匙只在创建那一刻返回一次，之后谁也查不回来（库里只存哈希）。
  列表接口不返回 `key_hash`，也不返回明文。
- webhook 地址与 token 只存在服务器根 `.env`，控制台只显示「已配置 / 未配置」，
  不读、不显示它们的值。
- webhook 配置可以在控制台上设置（Cursor 页的表单）：只写不回显——
  只填要改的项，空着不动；保存是原子写盘（临时文件 + 改名），其余行原样保留；
  状态接口读文件，所以保存后立即反映。注意生效时序：手动触发会立即用新配置
  （触发子进程先 scrub 掉继承的旧变量、再从磁盘 .env 重载）；定时任务跑在
  常驻的 job-runner 进程里，它启动时才读环境，所以改完要点「重启 job-runner」
  才对定时任务生效——重启不会导致重复触发（状态文件还在，门控继续算）。
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
