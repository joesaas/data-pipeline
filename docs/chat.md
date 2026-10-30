# 控制台对话（chat）

控制台新增「对话」页：单流消息，不走 records 推送，不走 review 把关。

## 表

`chat_messages`（与 tokens / pull_tasks 同一个 API 库）：

- `id` 自增；`source`：`human`（控制台输入）或 `muse`（worker 回复）；
- `content`：提示词原文或执行结果全文；
- `status`：只对 human 行有流转，`pending` → `processing` → `done` / `failed`；
  muse 行建出来就是 `done`；
- `in_reply_to`：muse 行指向它回答的 human 行，human 行为空；
- `error`：失败原因短文本。

## 接口（全部要 admin 钥匙）

- `GET /api/v1/admin/chat/messages?limit=200`：最新 N 条，按时间升序返回，
  另带 `total`。控制台刷新用这个。
- `POST /api/v1/admin/chat/messages` `{content}`：新建 human 行，`pending`，201。
- `GET /api/v1/admin/chat/messages/pending?limit=10`：最旧的待处理 human 行，
  队首优先。worker 轮询用这个。
- `POST /api/v1/admin/chat/messages/:id/claim`：`pending` → `processing`，
  非 pending 返回 409（两个 worker 抢同一行时只有一个成功）。
- `POST /api/v1/admin/chat/messages/:id/complete` `{content}`：原子操作——
  human 行 → `done`，同时插入一行 `source=muse`、`in_reply_to` 指向它的回复。
  行不是 `processing` 时返回 409。
- `POST /api/v1/admin/chat/messages/:id/fail` `{error?}`：`processing` → `failed`。
- `POST /api/v1/admin/chat/messages/:id/reset`：`processing` → `pending`，
  给中途死掉的 worker 留的恢复口（只复位 processing 行，不动 done 行）。

## Muse 侧定时任务

- 每 1 分钟一轮，与 `news-detail-generate` 同款抢锁（锁目录 + 3600 秒残锁口径）。
- 每轮取 `pending` 队首最多 3 条，逐条 claim → 执行提示词 → complete；
  执行失败则 fail 并写明原因，该条留在流里不自动重试。
- 钥匙走现有 admin 钥匙文件，不新发钥匙；空轮次不发 chat 消息。
