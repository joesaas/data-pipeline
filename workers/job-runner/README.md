# job-runner：多定时 job 常驻进程

一个 pm2 进程（`data-job-runner`）托管多个定时 job，代替过去「一个定时任务起一个 pm2 进程」的做法（每个 Node 进程约 70MB）。

## 为什么用 Bree

调研结论（2026-10-24，bree 9.2.9，2026-02-17 仍在更新）：

| 方案 | job 相互独立 | 异常自动恢复 | 结论 |
| Bree（worker 线程） | 是：每 job 独立线程，崩只死自己 | 是：下个 tick 重试；超 `maxRunMs` 被强杀后下个 tick 重试 | 采用 |
| Toad Scheduler / croner / node-cron（进程内） | 否：同事件循环，崩与阻塞互相影响 | 仅靠 try/catch，无线程级隔离 | 不采用 |
| BullMQ | 是 | 是（重试 + 死信） | 不采用：要新增 Redis，EC2 多一套运维负担 |

Bree 只被包在 `src/main.ts` 一处：调度器接口与 Bree 解耦，日后换框架只改这一个文件。

## 保证（设计上，非口头）

1. **相互独立**：每 job 在自己的 worker 线程跑。测试 `tests/scheduler.test.ts` 用真实 Bree 证明：一个 job 抛错、一个 job 死循环时，第三个 job 照常 tick，调度器不死。
2. **异常自动恢复**：抛错 → errorHandler 只记日志，调度器继续，下个 tick 重跑；死循环 → 超 `maxRunMs` 被 Bree 强杀，下个 tick 重跑。
3. **不重叠**：job 脚本应短平快；长任务不进这个 worker（cleaner 那种 LLM 长批次继续单独跑）。
4. **进程级兜底**：runner 本身挂了由 pm2 拉起；调度是纯间隔、无状态，重启不丢东西。

注意一个易错点：Bree 的 `timeout` 是**首次运行延迟**，不是杀死开关。杀死开关是 `closeWorkerAfterMs`，本项目用注册表 `maxRunMs` 映射过去，不要混用。

## 新增一个 job（两步）

1. 在 `src/jobs/<名字>.ts` 写脚本：跑完自己退出，不要常驻、不要打日志以外的副作用、不要写密钥。
2. 在 `src/registry.ts` 的 `JOBS` 里加一行：`{ name, interval, maxRunMs, description }`。

注册表是显式列表，不扫描目录：多余文件永远不会在生产跑起来。

## 运行

```bash
npm run build -w @data-pipeline/job-runner
node workers/job-runner/dist/src/main.js            # 调度模式（pm2 用这个）
node workers/job-runner/dist/src/main.js --run <job> # 单跑一个 job 一次（调试用）
```

EC2 上线：`./deploy.sh start runner`（首次）或随 `deploy.sh deploy` 一起重启。

## 迁移说明

- `cursor-trigger` 已于 2026-10-25 迁入本 worker：`src/jobs/cursor-trigger.ts`（每 1 分钟 tick、按 `cursor-state` 自我门控触发）。旧 `data-cursor-trigger` 进程已于同日下线，源码随清理提交删除。触发地址只取数据库 `webhooks` 表里标为定时的那行（含 payload 字段），没有定时行时当轮跳过、不发请求；测试一次按 id 取行，绕开门控、不写状态文件。
- `cursor-trigger` 的 cron（2026-10-25，plan A）：每条 webhook 行自带可选 cron，解析与命中在 `packages/shared`（`parseCron` / `isCronDue`，API 校验与本 job 共用同一份）。有 cron 的定时行按 cron 发：仅当当前北京时间分钟命中、且该分钟没发过才发，错过的分钟不补发；没 cron 的走老间隔门控。cron 时间固定按 Asia/Shanghai 算，不跟服务器时区走。非法 cron（只能手动改库写进去，API 会拦）当轮跳过并记日志，不发请求、不炸 runner。
- `cleaner` 不迁入：LLM 长批次、失败画像不同，混进来会拖住轻量 job。
