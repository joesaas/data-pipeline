# Docs · 文档阅读平台（Agent 101 界面）

> 2026-11-03 由 [joesaas/doc-reader](https://github.com/joesaas/doc-reader) 原样迁入 data-pipeline `apps/docs`，界面与 API 不变（agent101.uk 的 Agent 101 样式即本应用原貌）。历史数据不迁移：`data/` 只带 `.gitkeep`，上线后从空库开始；旧 doc-reader 服务在新站验通过前不动。

按分类管理、阅读 HTML 文档的平台。为 [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html) 这类 skill 生成的自包含 HTML 页面而设计：上传即自动抽标题、识别来源、按关键词建议分类；也可以一条命令把已生成的页面整批导入。

## 功能

- **分类展示（稳定列表）**：分类与顺序写死在 `shared/categories.ts`，前后端共用一份定义，不随数据漂移。内置 Agent / DeFi / Blockchain / 协议 / 安全 / 网络 / 工程 / 其他。
- **上传 HTML**：拖拽多文件上传。上传前先解析预览——标题、简介、generator，并按关键词打分给出**建议分类**，确认/改选后才落盘。
- **全文搜索**：标题、简介、标签 + 正文全文。
- **阅读**：文档在 sandboxed iframe 中渲染。页面自带的内联脚本可运行（交互排版），但运行在不透明源里，碰不到平台页面；原始文件接口同时带 `Content-Security-Policy: sandbox allow-scripts`。
- **管理**：改标题/分类、下载原文件、删除；网格/列表视图；最新/最早/标题排序；深浅色主题。
- **一键导入**：`npm run import:am` 扫描 `~/.answer-me-with-html/pages`（或指定目录）整批导入，同名文件自动跳过，可重复运行。

## 技术栈

- Node.js 20+ / TypeScript（前后端同仓、同语言）
- 后端：Express + Multer，元数据存 `data/index.json`（原子写），文件存 `data/files/`，零数据库依赖
- 前端：React 19 + Vite + Tailwind CSS 4 + lucide-react，界面布局参考主流文档站（侧边栏分类 + 卡片列表 + 全屏阅读）
- 分类/类型定义在 `shared/`，服务端与前端共用

## 快速开始

```bash
npm install

# 开发模式（前端 5173，后端 3001，/api 自动代理）
npm run dev

# 导入你已有的 answer-me-with-html 页面（可选）
npm run import:am
# 或指定目录：npm run import:am -- ~/some/dir

# 生产模式：构建后单进程跑（默认 3001）
npm run build
npm start
```

打开 http://localhost:5173 （开发）或 http://localhost:3001 （生产）。

环境变量：`PORT`（默认 3001）、`DATA_DIR`（默认 `./data`）、`DOC_READER_API_KEY`（设置后 AI 写接口需带 Key）、`DOC_READER_ALLOW_PRIVATE_URLS`（`1` 放行 from-url 抓内网地址）。

## 运维脚本（data-pipeline 仓库根 deploy.sh）

迁移后不再用旧 doc-reader 仓库的 deploy.sh，统一走 data-pipeline 仓库根的 `./deploy.sh`，服务名 `docs`：`./deploy.sh deploy docs`（拉代码→构建→重启→状态）、`./deploy.sh restart docs`、`./deploy.sh logs docs 100`、`./deploy.sh status`。pm2 进程名 `data-docs`，端口 3001，入口 `apps/docs/dist/server/src/index.js`。从仓库根启动时须配 `DATA_DIR=apps/docs/data` 与 `CLIENT_DIST=apps/docs/client/dist`（ecosystem.config.cjs 已配好）；在本目录内直接跑时默认值即正确。

## 给 AI 用（AI API）

除了网页上传，平台提供一套纯 JSON 的 AI 专用接口：能力发现、JSON 上传（内容去重 + `externalId` 覆盖更新）、批量上传、URL 导入、紧凑搜索、纯文本读取，并附 OpenAPI 规范。见 [docs/AI_API.md](docs/AI_API.md)。

```bash
curl http://localhost:3001/api/ai   # 能力发现：分类枚举 + 接口清单
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/categories` | 分类列表（含每类计数，顺序稳定） |
| GET | `/api/docs?category=&q=&sort=newest\|oldest\|title` | 文档列表，q 为全文搜索 |
| GET | `/api/docs/:id` | 单篇元数据 |
| GET | `/api/docs/:id/raw` | 原始 HTML（sandbox CSP） |
| GET | `/api/docs/:id/download` | 下载原文件 |
| POST | `/api/docs/parse` | 上传前解析预览（multipart: file） |
| POST | `/api/docs` | 正式上传（multipart: files[] + meta JSON） |
| PATCH | `/api/docs/:id` | 改标题/分类/标签/简介 |
| DELETE | `/api/docs/:id` | 删除 |

## 目录结构

```
shared/            前后端共用的类型与分类定义（含自动分类关键词）
server/src/        Express API：index.ts（路由）/ store.ts（JSON 索引存储）/ parse.ts（HTML 解析）
client/src/        React 前端：App.tsx（列表+阅读）/ components/UploadModal.tsx / lib/api.ts
scripts/           import-am.ts（一键导入）/ smoke.mjs（全链路冒烟自检）
data/              运行时数据（index.json + files/，已 gitignore）
```

## 自检

服务启动后运行 `npm run smoke`，自动验证：上传 → 标题解析 → 自动分类 → 分类列表 → 原文服务 → 全文搜索 → 删除 全链路。

`npm run smoke:ai` 是自包含的 AI API 自检（自己拉起带 Key 的临时实例）：发现 → 鉴权 → JSON 上传 → 去重 → externalId 覆盖 → 批量 → 搜索 → 纯文本 → URL 导入 → SSRF 拦截。
