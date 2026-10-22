# data-pipeline

数据收集项目：主流 Agent 安装配套 skill 后，用户手动唤起 skill、输入一段提示词，生成的内容通过 API push 到服务器，**原始提示词与生成内容成对存储**。

设计文档：[docs/design.md](docs/design.md)（遵循单一职责、开闭、里氏替换、接口隔离、依赖倒置、迪米特六大原则）


## 仓库结构（2026-10-22 按 agentic-news 分法重组）

| 目录 | 内容 |
|---|---|
| `apps/api/` | 收集服务（原根目录 `src/` 整体搬入，逻辑未改） |
| `workers/cleaner/` | 清洗服务：拉记录 → 质量门 → LLM 清洗 → 结构化条目落自己的 SQLite；pm2 定时服务或单次跑批，见下节 |
| `packages/shared/` | 共享契约（仅类型）：`RawRecord` 线格式与 `CleanedItem` 草案 schema |
| `skills/` | pipe-push 各运行时变体（见下） |
| `docs/` | [设计文档](docs/design.md) 与 [结构说明](docs/architecture.md) |

根目录是 npm workspaces 入口：`npm install` / `npm run build` / `npm test` / `npm start` 都在根目录执行，与重组前用法一致。

## 快速开始

需要 **Node >= 22**（SQLite 驱动用内置 `node:sqlite`；仓库带 `.nvmrc`，`nvm use` 即可）。

```bash
npm install
npm run build
npm start            # http://localhost:8080/data-pipeline ，鉴权默认关闭
```

推送一条：

```bash
curl -X POST http://localhost:8080/data-pipeline/api/v1/records \
  -H 'content-type: application/json' \
  -d '{"prompt":"写一首关于秋天的短诗","content":"……生成的正文……","source_agent":"claude-code"}'
# {"id":"...","status":"created","created_at":"..."}
```

去重语义：带 `external_id` 时按它 upsert（内容不变 `deduped`、变了 `replaced` 且 id 不变）；不带时按内容哈希判重。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `BASE_PATH` | /data-pipeline | 项目路径前缀，挂在 `/api` 前面；API 同时也在无前缀路径可用，设为空字符串可关掉前缀 |
| `DATA_DIR` | ./data | 数据目录 |
| `STORAGE` | sqlite | `sqlite` 或 `file`，同一接口双实现，行为契约一致 |
| `AUTH_REQUIRED` | false | true 时启用 `X-API-Key` 鉴权，令牌只存哈希 |
| `MAX_CONTENT_BYTES` | 1048576 | content 上限 |
| `MAX_PROMPT_BYTES` | 65536 | prompt 上限 |
| `RATE_LIMIT_PER_MIN` | 60 | 每身份（关鉴权时每 IP）每分钟上限 |

开鉴权后发令牌：`npm run create-token -- <备注名>`（明文 Key 只打印一次）。

Docker：`docker compose up -d`。


## 清洗服务（workers/cleaner）

把 records（多为整篇简报）用 LLM 拆成结构化条目（schema v1 在 `packages/shared`：title / summary / detail / category / tags / event_date / sources / importance），存入 cleaner 自己的 SQLite（`CLEANER_DATA_DIR/cleaned.sqlite`，表 `cleaned_records` + `cleaned_items`）。幂等键是 (记录 id, content_hash)：内容没变不重复洗、不重复花钱。

运行方式（二选一）：

```bash
npm run clean        # 单次跑批：构建 + 清洗一遍 + 退出
pm2 start ecosystem.config.cjs --only data-cleaner   # 服务模式：启动先跑一遍，之后每 CLEANER_INTERVAL_MINUTES 分钟一轮
```

LLM 走 OpenAI 兼容接口，只认三个环境变量：`LLM_API_KEY`、`LLM_BASE_URL`（默认 OpenRouter）、`LLM_MODEL`（默认 openai/gpt-4o-mini）。**不设 Key 时自动用 mock provider**（按 markdown 标题启发式拆条）先跑通全链路，结果在库里标记 provider=mock，不得当作 LLM 产出。清洗提示词在 `workers/cleaner/prompts/clean.md`（clean-v1）。

查清洗结果：`sqlite3 workers/cleaner/data/cleaned.sqlite "SELECT COUNT(*) FROM cleaned_items;"`

## Skill 变体（skills/）

| 目录 | 运行时 | 说明 |
|---|---|---|
| `skills/pipe-push/` | Claude Code / Codex / Gemini CLI | 标准 SKILL.md（仅手动唤起）+ `agents/openai.yaml` + 发送脚本 |
| `skills/pipe-push-muse/` | Muse | 同一工作流，skill.yaml 元数据，凭证走 adapter |
| `skills/pipe-push-generic/` | Grok Bot 等无 SKILL.md 加载器的 Agent | `AGENT_INSTRUCTIONS.md` + `tool.json` 兜底（Grok 的 skill 格式待核实） |
| `skills/pipe-push-gemini/` | Gemini Apps（网页/移动/Mac 应用） | 在 Skills 页上传本目录（或其 zip）安装：根目录 `SKILL.md` + 纯文本 references，不含脚本。Gemini 平台禁止 skill 脚本联网，本变体只生成内容并组装推送载荷，实际 POST 由用户在 Gemini 外用随附的 curl 命令完成 |

安装：把对应目录复制到该运行时的 skills 目录，设好 `DATA_PIPELINE_BASE_URL`（形如 `https://agent101.uk/data-pipeline`（已部署实例），及开鉴权时的凭证），手动唤起后输入提示词即可。

## 决策记录（2026-10-20 定版时的待定项处理）

| 事项 | 落地 | 备注 |
|---|---|---|
| 技术栈 | Node + TypeScript | 已确认 |
| 鉴权 | 可配置，默认不需要权限 | 已确认 |
| 存储 | 双实现都已落地，默认 SQLite | 选型靠 `STORAGE` 切换，随时可改 |
| skill 名 | pipe-push | 按建议默认，可改名 |
| 限额 | 内容 1 MB、每分钟 60 次 | 按建议默认，环境变量可调 |
| Web 查看页 | 一期未做 | 用 API 查询 |
| 仓库结构 | 2026-10-22 按 agentic-news 分法重组为 apps/workers/packages + npm workspaces | li 定版；api 逻辑未改 |
| 清洗服务 | 2026-10-22 实现：schema v1、cleaner 自有 SQLite 落存、OpenAI 兼容 provider（默认 OpenRouter + gpt-4o-mini，无 Key 时 mock）、pm2 定时服务 | 实现默认项，模型与间隔均可经环境变量改 |

## 测试

```bash
npm test   # 构建 + 契约测试（双驱动各跑一遍）+ API 测试，共 18 项
```
