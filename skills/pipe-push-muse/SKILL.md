# pipe-push（Muse 变体）

仅手动唤起。把按用户提示词生成的内容通过 API push 到用户的 data-pipeline 服务器，原始提示词与生成内容成对存储。

## Workflow

1. 接收用户的提示词：唤起时跟随的内容即是；没给就简短问一句。
2. 按提示词正常生成内容，本 skill 不干预生成过程。
3. 把生成内容写入一个临时文件。
4. 运行本 skill 自带的发送脚本，不要手写 HTTP 请求：

```bash
node <本 skill 目录>/scripts/push.mjs \
  --prompt "<用户的原始提示词，逐字>" \
  --content-file <临时文件> \
  --source muse
```

只有用户想更新某条已有记录时才加 `--external-id <id>`；用户给了标题才加 `--title`。

5. 把结果回报用户：状态（created / replaced / deduped）与记录 id。失败时报 HTTP 状态与服务端原因，不要悄悄重发。

## 配置

- `DATA_PIPELINE_BASE_URL`：服务器地址（默认 `http://localhost:8080`）。
- 服务端鉴权可配置、默认关闭。开启时凭证走 `DATA_PIPELINE_ADAPTER`（返回鉴权头的可执行程序）或 `DATA_PIPELINE_API_KEY`；Muse 环境优先用连接器替身作 adapter。真 Key 不写进 skill 与推送内容。
- 字段与错误码速查：`references/api.md`。
