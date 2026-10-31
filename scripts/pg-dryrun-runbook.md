# 演练导数 runbook：SQLite → 演练库 data_pipeline_practice

目标：把 EC2 上三份 SQLite 快照导进演练库，并自校验，全程不动生产库 `data_pipeline`、不停线上服务、不改任何环境变量。

前置与分工：

- Step 1、Step 2 在 Mac 上跑（用 Mac 上的 li-admin 凭证签令牌）。
- Step 3 在 EC2 上跑（`/home/ec2-user/app/data-pipeline`；EC2 实例角色提供 IAM 凭证，不用在 EC2 上配 AWS 密钥）。
- loader 脚本在项目 `scripts/pg-load-dryrun.cjs`（本文件同目录），传到 EC2 的 `/tmp/pg-load-dryrun.cjs`，不要改脚本内容（护栏写死在里面）。
- 基线（21:05 快照）：三份文件总量约 23M，共 4753 行（主库 948、详情库 1643、清洗库 2162）。若快照重拷，行数可能变多，校验标准是源与目标行数相等 + id 哈希一致，不是绝对数字。

## Step 1：Mac，postgres 令牌会话，建演练库与三个 schema

首次执行。若提示数据库已存在，说明之前建过，直接用 Step 3 里的重建段（DROP + 重建）代替本步。

```bash
TOKEN=$(aws rds generate-db-auth-token --hostname database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com --port 5432 --region ap-southeast-1 --username postgres)
PGPASSWORD="$TOKEN" psql "host=database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com port=5432 dbname=postgres user=postgres sslmode=require" <<'SQL'
CREATE DATABASE data_pipeline_practice;
\c data_pipeline_practice
CREATE SCHEMA app;
CREATE SCHEMA cleaner;
CREATE SCHEMA news_detail;
ALTER SCHEMA app OWNER TO data_pipeline_app;
ALTER SCHEMA cleaner OWNER TO data_pipeline_app;
ALTER SCHEMA news_detail OWNER TO data_pipeline_app;
GRANT CONNECT ON DATABASE data_pipeline_practice TO data_pipeline_app;
SQL
```

预期：`CREATE DATABASE`、`CREATE SCHEMA` ×3、`ALTER SCHEMA` ×3、`GRANT` 各一行成功。令牌 15 分钟有效，超时重签一次即可。

## Step 2：Mac，data_pipeline_app 令牌会话，对演练库跑 DDL

在 `db.sql` 所在的目录跑（`db.sql` 就是 `pg-ddl-draft-v1.sql`；若不确定手头的 `db.sql` 是不是最新版，先找我要一份，存回同一位置再跑）。

```bash
TOKEN=$(aws rds generate-db-auth-token --hostname database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com --port 5432 --region ap-southeast-1 --username data_pipeline_app)
PGPASSWORD="$TOKEN" psql "host=database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com port=5432 dbname=data_pipeline_practice user=data_pipeline_app sslmode=require" -f ./db.sql
```

预期：16 张表 + 6 个索引全部 `CREATE` 成功。以下 3 条报错是已知无害的，不用管（与生产库建表时一样：三个 schema 已在 Step 1 建好且属主就是 `data_pipeline_app`，它在库上没有 CREATE 权限，所以这 3 条被拒，但建表不受影响）：

```text
ERROR:  permission denied for database data_pipeline_practice（3 条，CREATE SCHEMA 行）
```

除此 3 条外若有其他报错，先停下来，把报错贴给我，不要继续。

同一终端里接着跑一行验证（16 张表都在）：

```bash
PGPASSWORD="$TOKEN" psql "host=database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com port=5432 dbname=data_pipeline_practice user=data_pipeline_app sslmode=require" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('app', 'cleaner', 'news_detail')"
```

预期：`count = 16`。

## Step 3：EC2，真实 PG contract → DROP 重建 → loader 导数

### 3a：真实 PG contract（空表跑）

在 EC2 上跑。注意：contract 测试会在演练库里写测试行，所以跑完必须做 3b 的 DROP + 重建，loader 才能面对空表。

```bash
cd /home/ec2-user/app/data-pipeline
PG_CONTRACT_TEST=1 PG_DATABASE=data_pipeline_practice npm run test -w @data-pipeline/api
```

预期：API 测试全绿，且输出里含 PG contract 用例。若 contract 失败，先停下来，把失败用例贴给我，不要继续。环境变量只加在当条命令前，不写入 shell 配置、不进 pm2。

注意：contract 不是幂等的——它假设表是空的，跑完还会留行（records、tokens、trigger history、webhook payloads 的 p1 等测试都不删行）。所以每次重跑 3a 之前都必须先做 3b（DROP + 重建 + 重跑 DDL），否则残留行会让 creates 变 deduped、主键冲突、计数翻倍。

### 3b：DROP + 重建演练库并重跑 DDL（Mac）

先跑 postgres 会话（DROP + 建库 + schema + 授权，与 Step 1 相同，只多一行 DROP）：

```bash
TOKEN=$(aws rds generate-db-auth-token --hostname database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com --port 5432 --region ap-southeast-1 --username postgres)
PGPASSWORD="$TOKEN" psql "host=database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com port=5432 dbname=postgres user=postgres sslmode=require" <<'SQL'
DROP DATABASE IF EXISTS data_pipeline_practice;
CREATE DATABASE data_pipeline_practice;
\c data_pipeline_practice
CREATE SCHEMA app;
CREATE SCHEMA cleaner;
CREATE SCHEMA news_detail;
ALTER SCHEMA app OWNER TO data_pipeline_app;
ALTER SCHEMA cleaner OWNER TO data_pipeline_app;
ALTER SCHEMA news_detail OWNER TO data_pipeline_app;
GRANT CONNECT ON DATABASE data_pipeline_practice TO data_pipeline_app;
SQL
```

再跑一遍 Step 2 的命令（data_pipeline_app 令牌会话 + `-f ./db.sql`），同样只接受那 3 条无害的 CREATE SCHEMA 报错。

### 3c：快照确认（EC2）

快照一律放在 `/tmp/step0`。若 `/tmp/step0` 还在（21:05 那份），直接用；若已丢（EC2 的 /tmp 会清、机器重启会丢），在 EC2 上重拷一份：

```bash
mkdir -p /tmp/step0
cp /home/ec2-user/app/data-pipeline/data/data.db /tmp/step0/
cp /home/ec2-user/app/data-pipeline/data/data.db-wal /tmp/step0/ 2>/dev/null
cp /home/ec2-user/app/data-pipeline/data/data.db-shm /tmp/step0/ 2>/dev/null
cp /home/ec2-user/app/data-pipeline/data/news-detail.sqlite /tmp/step0/
cp /home/ec2-user/app/data-pipeline/workers/cleaner/data/cleaned.sqlite /tmp/step0/
ls -lh /tmp/step0/
```

注意：主库是 WAL 模式，`-wal` 必须一起拷，否则新行会漏。重拷后快照时间变了，行数可能比 21:05 基线多，这是正常的，校验标准不变（源与目标一致）。

### 3d：跑 loader（EC2）

```bash
cd /home/ec2-user/app/data-pipeline
NODE_PATH=/home/ec2-user/app/data-pipeline/node_modules node /tmp/pg-load-dryrun.cjs
```

快照目录默认就是 `/tmp/step0`，不用加任何参数。loader 默认连演练库 `data_pipeline_practice`；`PG_DATABASE=data_pipeline` 会被脚本硬拒绝，没有任何放行办法。

预期输出样例（数字以 21:05 基线为准，重拷快照后数字会变，关键是每行 MATCH、每条 setval 带 OK、最后 LOAD OK、退出码 0）：

```text
precheck: 16 tables present in data_pipeline_practice, all empty
setval app.webhooks: next=2 OK
setval app.webhook_trigger_history: next=134 OK
setval app.pull_tasks: next=2 OK
setval app.pending_tasks: next=299 OK
setval app.chat_messages: next=9 OK
MATCH app.records | sqlite_count=496 | pg_count=496 | id_hash=<64 位 hex>
MATCH app.tokens | sqlite_count=9 | pg_count=9 | id_hash=<64 位 hex>
MATCH app.webhooks | sqlite_count=1 | pg_count=1 | id_hash=<64 位 hex>
MATCH app.webhook_payloads | sqlite_count=0 | pg_count=0 | id_hash=<64 位 hex>
MATCH app.webhook_trigger_history | sqlite_count=133 | pg_count=133 | id_hash=<64 位 hex>
MATCH app.pull_tasks | sqlite_count=1 | pg_count=1 | id_hash=<64 位 hex>
MATCH app.pending_tasks | sqlite_count=298 | pg_count=298 | id_hash=<64 位 hex>
MATCH app.chat_messages | sqlite_count=8 | pg_count=8 | id_hash=<64 位 hex>
MATCH app.site_nonces | sqlite_count=0 | pg_count=0 | id_hash=<64 位 hex>
MATCH app.site_sessions | sqlite_count=1 | pg_count=1 | id_hash=<64 位 hex>
MATCH app.site_favorites | sqlite_count=1 | pg_count=1 | id_hash=<64 位 hex>
MATCH news_detail.detail_pages | sqlite_count=1643 | pg_count=1643 | id_hash=<64 位 hex>
MATCH cleaner.cleaned_records | sqlite_count=439 | pg_count=439 | id_hash=<64 位 hex>
MATCH cleaner.cleaned_items | sqlite_count=1645 | pg_count=1645 | id_hash=<64 位 hex>
MATCH cleaner.cleaner_meta | sqlite_count=1 | pg_count=1 | id_hash=-
MATCH cleaner.llm_calls | sqlite_count=77 | pg_count=77 | id_hash=-
LOAD OK: 16 tables, 4753 rows, all counts and id sets match
```

说明：`id_hash=-` 的两张表（cleaner_meta、llm_calls）没有单 id 列，只比行数；site_favorites 用 address + item_id 组合键比哈希。输出里只有行数与哈希，没有任何行内容（webhooks.token 是明文，loader 不打印它）。

### 3e：失败处理（退出码非 0 时）

先看报错属于哪一种，不要直接重跑：

- 报错是 `target table not empty`：表里已有数据（例如 contract 残留，或上一次 loader 已提交）。必须回到 3b（DROP + 重建 + 重跑 DDL）才能再跑 loader。
- 报错是导数中途失败（例如类型非法、连接失败）：事务已回滚，表仍为空。修好原因后可直接重跑 loader。
- 输出里有 `MISMATCH` 的表：事务已回滚，表仍为空。把那张表的两行输出贴给我，不要自己改数据。
- 报错是 `target table missing`：DDL 没跑完或跑错了库，回到 Step 2 检查。

## 全程禁区（再确认一遍）

- 不动生产库 `data_pipeline`：loader 对它有硬护栏；contract 与 loader 的 `PG_DATABASE` 只写 `data_pipeline_practice`。
- 不停线上服务：演练期间 API、清洗器、job-runner 照常跑；快照是拷出来的副本，loader 不碰线上文件。
- 不改任何环境变量：所有 `PG_*`、`SQLITE_DIR` 只加在当条命令前，不写入 `~/.zshrc`、不进 pm2、不改 EC2 配置。
- 不打印行内容：loader 输出只有行数与哈希；演练库里虽然有真实数据（含 webhooks 明文 token），但不要把任何查询结果贴进对话。

## 生产导数（切换窗口内，演练通过后才做）

前置（缺一不可）：

- 演练已通过（3a 全绿 + loader LOAD OK）。
- EC2 服务已停（`pm2 stop data-pipeline data-cleaner data-job-runner`，`pm2 list` 确认三者都停）。
- 停服务后重拷的最终快照在 `/tmp/step0`（停服务后 WAL 已落盘，仍按 3c 的命令连 `-wal` 一起拷）。
- 生产库 16 张表全空（loader 的 precheck 会再验一遍，非空直接拒绝）。

命令（EC2；开关只加在当条命令前，不写进任何配置文件）：

```bash
cd /home/ec2-user/app/data-pipeline
cp /home/ec2-user/app/data-pipeline/scripts/pg-load-dryrun.cjs /tmp/pg-load-dryrun.cjs
PG_DATABASE=data_pipeline PG_ALLOW_PRODUCTION=1 NODE_PATH=/home/ec2-user/app/data-pipeline/node_modules node /tmp/pg-load-dryrun.cjs
```

预期：与演练相同（precheck 全空、setval 全 OK、16 行 MATCH、LOAD OK、退出码 0），行数以最终快照为准。

失败处理：与 3e 相同；MISMATCH 或非 0 时事务已回滚、表仍为空，不要重跑覆盖，先把输出贴给 Muse。生产导数失败不影响线上 SQLite（服务停着、开关未切），修好原因后可直接重跑。

注意：不打 `PG_ALLOW_PRODUCTION=1` 时生产库永远拒绝；开关值必须是精确的 `1`，空、`yes`、`true` 一律视为未放行。
