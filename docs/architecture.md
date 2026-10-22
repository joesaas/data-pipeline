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

## cleaner 管线与未定项

管线形状与 agentic-news 的 workers/cleaner 对齐：
取原始条目 → 质量门（quality.ts，太短/营销直接拒）→ LLM 清洗
（providers.ts，只依赖接口不绑厂商）→ 校验 → 输出。幂等靠原始记录 id：
同一条记录重复跑不产出两份结果（落地时以 source_record_id 唯一约束保证）。

未定项（2026-10-22，均待逐项定版后再实现）：

1. 结构化输出的最终 schema（packages/shared 里是 v0 草案）与清洗结果存哪。
2. 用哪个 LLM / provider（providers.ts 目前返回 null，cleaner 只做质量门与待洗统计）。
3. 触发方式：手动跑批、定时，还是记录入库后自动触发。

## 部署影响

线上 EC2 的操作不变：在仓库根目录 `git pull` → `npm install` → `npm run build`
→ `npm start`（根脚本转发到 apps/api）。Docker 路径同样保留：
根目录 `docker compose up -d`（构建上下文已改为 apps/api）。
