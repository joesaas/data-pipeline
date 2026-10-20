# data-pipeline 设计文档

- 状态：已于 2026-10-20 经确认并实现 v0.1.0；待定项按建议默认落地，处理结果见仓库 README 的「决策记录」
- 仓库：https://github.com/joesaas/data-pipeline
- 日期：2026-10-20

## 0. 一句话方案

一个单体 API 服务负责收数和落库；每个主流 Agent 运行时配一份自包含的 skill 变体，用户手动唤起 skill、输入提示词，Agent 生成内容后由 skill 把「原始提示词 + 生成内容」成对 push 到 API 入库。去重和更新靠 `external_id` + 内容哈希，重复推送不产生重复数据。

核心链路：

```
用户安装 skill → 手动唤起 skill 并输入提示词 → Agent 生成内容
→ skill 组装 payload → POST API → 鉴权/校验/去重 → 落库 → 返回 id 与状态给用户
```

## 设计原则（六大，总纲）

本设计遵循六大设计原则；「高内聚、低耦合」是这六条共同达成的总目标，不单独成条。每条原则在本项目中的落地如下，实现阶段逐条对照验收：

| 原则 | 含义 | 在本项目中的落地 |
|---|---|---|
| 单一职责 | 一个模块只做一件事 | API 单体内部分模块：路由层只管 HTTP、ingest 服务只管校验与去重、存储层只管落库、auth 模块只管鉴权（见 1.1） |
| 开闭原则 | 对扩展开放、对修改关闭 | 新增运行时只加一份 skill 变体，不改核心与服务端；新增存储只加一个驱动实现；payload 字段扩展靠 `metadata` 与 `schema_version`，不改接口形状 |
| 里氏替换 | 实现可互换且行为一致 | SQLite 与文件两种存储实现共用同一接口、同一套 upsert 与去重语义，可直接互换并用同一套契约测试验 |
| 接口隔离 | 接口按使用方拆细，不强迫依赖用不上的方法 | skill 只依赖推送接口；查询与删除是另一组接口；令牌管理不进 skill 的接口面 |
| 依赖倒置 | 高层逻辑依赖抽象，不依赖具体实现 | ingest 服务只依赖存储接口，不认识 SQLite 还是文件；skill 发送逻辑只依赖 adapter 接口，不认识凭证从哪来 |
| 迪米特法则 | 只和直接朋友通信 | skill 与服务端只经 API 契约通信，不共享代码与数据库；API 各模块只经接口调用，不跨层直达 |

## 1. 系统架构

### 1.1 组件

| 组件 | 职责 | 说明 |
|---|---|---|
| API 服务（单体） | 接收推送、鉴权、校验、去重、落库、查询 | 一个进程对外，不拆微服务；一期规模不需要 |
| 存储层 | 存记录与令牌 | SQLite 或文件存储，见第 4 节（待定） |
| Skill 变体包（每运行时一份） | 在各 Agent 里承接唤起、组装 payload、取凭证、发请求、回报结果 | 见第 3 节 |
| 凭证 adapter（每运行时一种取法） | 给 skill 提供 API 鉴权头 | 核心逻辑不感知凭证来源（沿用 answer-me-with-html 的 adapter 模型） |

API 单体内部按单一职责分四个模块，模块间只经接口调用：

| 模块 | 只做这一件事 |
|---|---|
| 路由层 | 解析 HTTP 请求与响应，不含业务规则 |
| ingest 服务 | 校验 payload、执行去重与 upsert 语义，不关心存到哪 |
| 存储层 | 按存储接口落库与查询，不关心业务语义 |
| auth 模块 | 按配置决定是否校验令牌，只向路由层回「过 / 不过」 |

### 1.2 架构原则

1. **服务端无状态**：状态只在存储层，API 进程可随时重启。
2. **skill 端薄、服务端厚**：去重、校验、限流全在服务端做；skill 只负责组装和发送，任何一个运行时的 skill 写错也不会污染数据。
3. **核心不依赖单一运行时**：skill 的组装与发送逻辑用一份便携实现，各运行时只换「触发方式、凭证取法、安装路径」三处外壳（沿用 agent-skills 仓库的变体约定）。
4. **先单机、留扩展位**：存储层藏在接口后，SQLite 换 Postgres、单机换多机都不动 API 与 skill。

### 1.3 部署形态（建议，待确认）

- 一个 Docker 容器跑 API 服务 + 一个数据卷存数据库文件，Docker Compose 部署到一台服务器。
- 对外只暴露 HTTPS（反向代理或平台自带域名）。服务器地址与域名属部署期信息，列入待定项。

## 2. API 设计

路径口径（定版补充）：全部接口挂在项目路径前缀之下，前缀可配置（`BASE_PATH`，默认 `/data-pipeline`），即形如 `/data-pipeline/api/v1/records`；无前缀的 `/api/v1/...` 同时保留可用。

### 2.1 约定

- Base：`/api/v1`，HTTPS，JSON。
- 鉴权：**可配置，默认不需要权限**。配置项 `AUTH_REQUIRED` 默认 `false`，此模式下任何请求免鉴权即可推送与查询；置为 `true` 后启用请求头 `X-API-Key: <token>`（沿用 Agent 101 的做法），令牌在服务端只存哈希。
- 版本：路径带版本 `v1`；payload 带 `schema_version` 字段，方便日后演进。

### 2.2 接口清单

| 方法与路径 | 用途 | 说明 |
|---|---|---|
| `POST /api/v1/records` | 推送一条记录（核心接口） | 按 `external_id` upsert，返回 created / replaced / deduped |
| `GET /api/v1/records` | 列表查询 | 分页 `limit`/`offset`，可按 `source_agent`、`tag` 过滤 |
| `GET /api/v1/records/:id` | 取单条 | 返回完整记录（含原始提示词与内容） |
| `DELETE /api/v1/records/:id` | 删除一条 | 鉴权开启时需同一令牌 |
| `GET /api/v1/health` | 健康检查 | 不鉴权，只回状态 |

### 2.3 推送 payload

```json
{
  "schema_version": 1,
  "external_id": "用户或 skill 生成的稳定标识，可空",
  "title": "标题，可空（服务端可从内容首行生成）",
  "prompt": "用户输入的原始提示词",
  "content": "Agent 生成的内容（正文）",
  "content_format": "markdown | text | html | json",
  "source_agent": "muse | grok | codex | claude-code | gemini | other",
  "skill_version": "skill 的版本号",
  "tags": ["可选标签"],
  "metadata": { "自由扩展键值": "如会话 id、来源链接" }
}
```

必填只有 `prompt` 与 `content`，其余可空。内容与提示词成对存，是本项目的核心数据形态：日后可按提示词检索、复现、评测生成质量。

### 2.4 去重与幂等（核心语义，沿用 DocReader 实测过的模型）

- 传了 `external_id`：同一身份下按 `external_id` upsert（身份 = 令牌；鉴权关闭时统一记为 `anonymous`）。内容哈希与已有记录相同 → 返回 `deduped`（不写库）；不同 → `replaced`（原地更新，id 与创建时间不变）。
- 没传 `external_id`：按（身份 + 内容哈希）查重，命中返回 `deduped`，否则 `created` 并生成 id。
- 响应统一形状：`{ "id": "...", "status": "created | replaced | deduped", "created_at": "..." }`。

### 2.5 校验与限流

- `content` 上限 1 MB，`prompt` 上限 64 KB（建议值，待确认）；超限回 413 并说明哪一项超了。
- 字段类型与枚举在服务端校验，错误回 400 并指出具体字段。
- 限流按令牌计（鉴权关闭时按来源 IP 计），建议 60 次/分钟，待确认，超限回 429。
- 鉴权开启时，令牌不存在或无权回 401/403，不区分细节，防探测。

## 3. 配套 Skill 设计

### 3.1 基本信息

- 名称：`pipe-push`（建议名，待确认）
- 触发：**仅手动唤起**（与使用流程一致）。各运行时都关掉隐式触发：Claude Code 靠 frontmatter `disable-model-invocation: true`，Codex 靠 `agents/openai.yaml` 的 `allow_implicit_invocation: false`。
- 输入：用户唤起后给出一段提示词（可直接跟在唤起命令后，作为参数传入）。

### 3.2 Skill 工作流（所有变体共用）

1. 接收用户的提示词（参数优先；没给参数就问一句）。
2. 按提示词正常生成内容（这是 Agent 本职，skill 不干预生成过程）。
3. 组装 payload：`prompt` 填原始提示词，`content` 填生成结果，`source_agent` 填本变体对应的运行时，`external_id` 在用户要求「更新同一条」时由用户或上下文给出，否则留空走哈希去重。
4. 取凭证：服务端鉴权关闭时跳过本步；开启时调用本运行时的 adapter 拿到鉴权头（见 3.4），拿不到凭证就明确报错并停，不要裸发请求。
5. `POST` 到配置的服务器地址（环境变量 `DATA_PIPELINE_BASE_URL` + `DATA_PIPELINE_API_KEY`，或 adapter 提供）。
6. 把结果回报给用户：状态（created / replaced / deduped）+ 记录 id；失败时报 HTTP 状态与服务端给的原因，不重试着闷头发第二次（去重语义保证用户手动重发是安全的）。

### 3.3 变体矩阵

| 运行时 | 包名 | 形态 | 安装位置（惯例） | 触发 |
|---|---|---|---|---|
| Muse | `pipe-push-muse` | SKILL.md + skill.yaml | Muse 的 custom-skills 目录 | 用户点名 / 斜杠唤起 |
| Claude Code | `pipe-push` | SKILL.md（标准 frontmatter） | `~/.claude/skills/` 或项目 `.claude/skills/` | `/pipe-push` |
| Codex | `pipe-push` | SKILL.md + `agents/openai.yaml` | `~/.codex/skills/` 等 | `$pipe-push` 或 `/skills` 点选 |
| Gemini CLI | `pipe-push` | SKILL.md（开放标准格式） | `~/.gemini/skills/` | 按其 skill 唤起方式 |
| Grok Bot | `pipe-push`（generic 变体） | `AGENT_INSTRUCTIONS.md` + `tool.json` | 依 Grok Bot 的扩展目录（待核实） | 手动唤起 |

说明：Claude Code、Codex、Gemini 走 Agent Skills 开放标准（agentskills.io），同一份标准 SKILL.md 为底，差异只在各自的元数据文件。Grok Bot 的 skill 规范未见公开标准文档，先用 generic 变体兜底，**其格式与安装路径列为待核实项**，实现阶段第一步先验真。

扩展方式（开闭原则）：日后支持新运行时，只新增一个变体目录，核心发送脚本、API 与服务端一律不动；变体之间不互相引用（迪米特），只共同遵守 payload 契约。

### 3.4 凭证模型（adapter，沿用已验证的做法）

- 服务端鉴权默认关闭，此时不需要任何凭证；下面三路只在服务端开启鉴权时生效。
- 核心发送逻辑只认两样东西：服务器地址 + 鉴权头。它不关心头从哪来。
- 默认路：环境变量 `DATA_PIPELINE_API_KEY`。
- Muse 路：走连接器替身凭证（hsurr），由 adapter 向本机 authd 申请、出口处换真 Key，skill 本体不接触真 Key。
- 其他运行时：各自从本地密钥存储取 Key 的小程序实现同一 adapter 协议（stdin/stdout JSON，只回 headers）。
- 真 Key 永不写进 skill 包、代码仓库和日志。

### 3.5 Skill 包结构（以标准版为例）

```
pipe-push/
  SKILL.md            触发与工作流（正文保持精简）
  agents/openai.yaml  Codex 元数据与禁隐式触发
  scripts/push.mjs    便携发送脚本（Node）：组装 payload、调 adapter 取头、发请求、打印结果
  references/api.md   API 字段与错误码速查（按需加载）
```

发送动作做成脚本而不是让模型现写请求代码：确定性操作交给代码，是官方 skills 最佳实践的明确建议。

## 4. 数据存储设计

存储层对外只有一个接口（暂名 `StorageDriver`）：`upsert(record)`、`get(id)`、`list(filter, page)`、`delete(id)`、`findByIdentityAndHash(...)`。ingest 服务只依赖这个接口（依赖倒置）；SQLite 与文件两案各出一个实现，行为契约一致、可互换（里氏替换），用同一套契约测试对两个实现各跑一遍。换存储只换实现，不动 API 与业务代码（开闭原则）。

### 4.1 数据模型（两种存储共用同一逻辑模型）

记录（records）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text（uuid） | 主键，服务端生成 |
| token_id | text | 归属令牌（鉴权开启时多用户隔离靠它；鉴权关闭时统一记 `anonymous`） |
| external_id | text，可空 | 同一 token_id 下唯一 |
| title | text | 可空 |
| prompt | text | 原始提示词 |
| content | text | 生成内容 |
| content_format | text | markdown / text / html / json |
| content_hash | text | 内容哈希，去重用 |
| source_agent | text | 来源运行时 |
| skill_version | text | 推送方 skill 版本 |
| tags | json | 标签数组 |
| metadata | json | 扩展键值 |
| created_at / updated_at | timestamp | 创建后不变 / 每次 replaced 更新 |

令牌（tokens）：id、name（备注名）、key_hash（只存哈希）、created_at、revoked_at（吊销时间，可空）。

### 4.2 两案对比

| 维度 | A：SQLite | B：文件存储 |
|---|---|---|
| 形态 | 一个 .db 文件，records/tokens 两张表 | 每条记录一个文件（如 `data/2026/10/<id>.md`，frontmatter 存元数据、正文存 content），外加一个索引文件 |
| 查询与过滤 | ok SQL 直接按来源、标签、时间查 | no 靠扫目录和索引文件，量大后明显吃力 |
| 去重与 upsert | ok 唯一约束 + 事务，原子完成 | warn 要自己加锁和索引维护，并发下易写花 |
| 并发推送 | ok 单机多连接可承受（WAL 模式） | no 多进程同时写索引有竞态 |
| 人类可读与备份 | warn 要用工具打开；备份就是拷一个文件，这点反而简单 | ok 直接打开就能看，天然适合 Git 管理 |
| 运维成本 | ok 零服务、零配置 | ok 零服务、零配置 |
| 规模上限 | 万级到十万级记录无压力 | 千级以内舒服，再大要重构 |

### 4.3 建议（待确认，不拍板）

建议选 **A：SQLite**。理由：本项目的核心语义是 upsert 与去重，靠约束和事务最稳；查询需求（按提示词、来源、标签找记录）也是 SQL 的主场。文件存储的人类可读优势，可以日后用一个导出命令补（把记录导出成 Markdown 文件），不必为此牺牲主存储。**最终选哪案，等你确认。**

## 5. 安全与边界

- 全程 HTTPS；启用令牌时只存哈希，明文只在创建时出现一次。
- 鉴权默认关闭的后果要写明：知道服务器地址的人即可推送、查询和删除记录。是否开启由部署者按使用场景决定（自用内网可关，公网部署建议开）。
- 服务端不执行用户推送的任何内容，content 一律当数据存、原样取。
- 鉴权开启时，每个令牌只能看、改、删自己的记录（靠 token_id 过滤，一期不做跨令牌共享）；鉴权关闭时无归属隔离。
- 日志只记 id、状态与字节数，不记 prompt 与 content 正文。

## 6. 决策与待定项清单

已确认 2 项，其余待你确认。

| # | 事项 | 结论 / 我的建议 | 影响面 |
|---|---|---|---|
| 1 | 数据存储选 SQLite 还是文件 | 待定。建议 SQLite（理由见 4.3） | 存储层实现 |
| 2 | 服务端技术栈 | **已确认：Node + TypeScript（首选）**；API 服务与 skill 发送脚本同用 Node 生态 | API 与脚本实现 |
| 3 | 鉴权模式 | **已确认：可配置，默认不需要权限**（`AUTH_REQUIRED` 默认 false，开启后走 X-API-Key） | API、skill 凭证步、安全边界 |
| 4 | skill 名称 | 待定。建议 `pipe-push` | 包名、唤起命令 |
| 5 | API 地址与部署服务器 | 待定。部署期再定，先用环境变量 `DATA_PIPELINE_BASE_URL` 占位 | 各变体配置 |
| 6 | 限额数值（内容 1 MB、限流 60 次/分） | 待定。先按建议值，上线后按真实用量调 | 服务端校验 |
| 7 | Grok Bot 的 skill 格式与安装路径 | 待定。无公开标准，实现阶段先验真再适配，先以 generic 变体兜底 | Grok 变体排期 |
| 8 | 是否需要一个简单的 Web 查看页 | 待定。建议一期不做，先用 API 查询；有真实需求再加 | 范围控制 |

## 7. 确认后的实施路线（供开工参考，本轮不执行）

1. 阶段 1：API 服务 + 存储层（按确认的选型）+ 健康检查与令牌发放脚本。
2. 阶段 2：标准版 skill（Claude Code / Codex / Gemini 共底）+ 发送脚本 + adapter 协议。
3. 阶段 3：Muse 变体（连接器鉴权）与 Grok 核实与适配。
4. 阶段 4：端到端验收——在每个运行时实测「唤起 → 生成 → push → 查回」全链路，重复推送验去重。

## 8. 自查（对照验收标准）

| 验收项 | 结果 |
|---|---|
| 系统架构齐全 | ok 第 1 节：组件、原则、部署形态 |
| API 设计齐全 | ok 第 2 节：接口、payload、去重语义、校验限流 |
| Skill 设计齐全 | ok 第 3 节：工作流、五运行时变体矩阵、凭证模型、包结构 |
| 数据存储齐全 | ok 第 4 节：逻辑模型、两案对比、建议 |
| 遵循六大设计原则 | ok 文首原则表逐条给出落地方式；模块划分、存储接口、变体扩展三处已按原则改实 |
| 待定项标清 | ok 第 6 节共 8 项：2 项已按你的决定确认（Node + TypeScript、鉴权可配置默认关），其余 6 项待定且均带建议与影响面 |
| 确认后能直接开工 | ok 第 7 节实施路线四阶段，顺序与依赖已排 |
