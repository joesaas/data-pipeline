# 仓库结构（2026-10-22 重组）

参考 joesaas/agentic-news 的顶层分法（apps / workers / packages），用 npm
workspaces 实现，不引入 pnpm / Turborepo。根目录只做一件事：把各工作区
组织起来（workspace 定义、统一的 build / test 入口），不放业务代码。

```
data-pipeline/
  apps/
    api/            收集服务（Express）：POST/GET/DELETE records、鉴权、存储双驱动
  workers/
    cleaner/        清洗进程（独立批处理）：拉原始记录 → 质量门 → LLM 清洗 → 结构化输出
  packages/
    shared/         共享契约（仅类型）：RawRecord 线格式、CleanedItem 草案 schema
  skills/           pipe-push 各运行时变体（给 Agent 安装的分发物，不属于上面三类）
  docs/             设计与结构文档
  docker-compose.yml  只编排 apps/api（cleaner 是批处理，不常驻）
```

## 各工作区命令

```bash
npm install        # 在根目录一次装齐所有工作区
npm run build      # 构建全部工作区
npm test           # 跑全部工作区的测试
npm start          # 启动 apps/api（根脚本转发）
npm run clean      # 构建并运行 workers/cleaner 一次
```

## cleaner 管线（2026-10-22 已实现）

管线形状与 agentic-news 的 workers/cleaner 对齐：
取原始条目 → 质量门（quality.ts，太短/营销直接拒）→ 幂等检查
（(记录 id, content_hash) 已洗则跳过）→ LLM 清洗（providers.ts 只依赖
接口不绑厂商，提示词 prompts/clean.md）→ 校验（validate.ts，坏条目丢弃
不拖垮整批）→ 落存。

实现定版（均为可改默认值，改法只动环境变量或对应小模块）：

1. 输出 schema v1：见 packages/shared 的 CleanedRecord / CleanedItem。
2. 落存：cleaner 自有 SQLite（CLEANER_DATA_DIR/cleaned.sqlite），不写 API 的库。
3. LLM：OpenAI 兼容接口，默认 OpenRouter + openai/gpt-4o-mini；
   无 LLM_API_KEY 时自动降级 mock provider（启发式拆条，结果带 mock 标记）。
4. 触发：服务模式（pm2）启动先跑一遍、之后按 CLEANER_INTERVAL_MINUTES
   定时重复；`--once` 单次模式保留给手动跑批与测试。
