'use strict';
/**
 * pg-load-dryrun.cjs — data-pipeline SQLite -> RDS PG 演练导数 loader.
 *
 * 用途：把 EC2 上三份 SQLite 快照导进演练库 data_pipeline_practice，并自校验。
 * 只用于演练，绝不用于生产库。跑在 EC2 上（node:sqlite 读源 + pg 写目标）。
 *
 * 安全规则（写死在代码里，没有任何放行开关）：
 *  1. PG_DATABASE 绝不允许为 data_pipeline：命中直接退出。
 *  2. 启动先查目标库 16 张表：缺表直接退出；任一表行数非 0 直接退出
 *     （不静默截断、不覆盖；要重跑先 DROP + 重建演练库 + 重跑 DDL）。
 *  3. 源文件三份缺一直接退出。
 *  4. 整批导数 + setval 在一个事务内完成；自校验不一致则回滚，退出码非 0。
 *  5. 全程只输出行数与 id 集合哈希，绝不输出、不记录任何字段值。
 *     webhooks.token 是明文（业务必需），loader 不打印它，也不打印任何行内容。
 *     报错信息只含表名/列名，不含字段值。
 *
 * 依赖：pg、@aws-sdk/rds-signer（走 NODE_PATH，不打进脚本），例如：
 *   NODE_PATH=/home/ec2-user/app/data-pipeline/node_modules node pg-load-dryrun.cjs
 * node:sqlite 是 Node 内置模块，无需额外依赖。
 *
 * 环境变量（显式空值视为缺失配置，直接报错，与驱动 resolvePgConfig 同款语义）：
 *   SQLITE_DIR   源快照目录，默认 /tmp/step0
 *   PG_HOST      默认 database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com
 *   PG_PORT      默认 5432
 *   PG_DATABASE  默认 data_pipeline_practice（绝不允许 data_pipeline）
 *   PG_USER      默认 data_pipeline_app
 *   PG_REGION    默认 ap-southeast-1
 * 鉴权：@aws-sdk/rds-signer 现场签 IAM 令牌（与驱动同款模式），令牌绝不打印。
 * SSL：加密要求、CA 链不校验（与驱动同款 caveat：sslmode=require 等价）。
 *
 * 类型映射（与三驱动严格一致；列名在 SQLite 与 PG 两侧相同）：
 *   text     原样字符串（NULL 原样）
 *   verbatim 原样字符串，专用于 cleaner.cleaned_items.translation_zh：
 *            NULL / '' / JSON 文本三态绝不合并、绝不转 JSONB
 *   int      数值（INTEGER 列）
 *   bigint   数值（BIGINT / IDENTITY 列；显式写 id，IDENTITY 为 BY DEFAULT 允许）
 *   bool     0/1 转布尔（BOOLEAN 列：is_active、ok、body_truncated）
 *   ts       ISO 字符串原样喂 TIMESTAMPTZ（非法时间值直接报错，不猜测转换）
 *   json     TEXT 先 JSON.parse 再喂 JSONB（tags / metadata / sources；
 *            解析失败直接报错，不写脏数据）
 */

const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Signer } = require('@aws-sdk/rds-signer');
const { Pool, types } = require('pg');

// node-postgres 默认把 int8 返成字符串；与驱动 pool.ts 同款处理：统一解析为数值。
types.setTypeParser(20, (value) => parseInt(value, 10));

// ---------------------------------------------------------------------------
// 表定义：sqliteFile（快照里的文件名）、sqliteTable、pgTable、列（名 + 类型）、
// idKey（自校验用的 id 集合键；none 表示只比行数）。
// 列顺序即 INSERT 顺序；SQLite 与 PG 两侧列名相同（以 DDL 草稿为准）。
// ---------------------------------------------------------------------------
const TABLES = [
  {
    sqliteFile: 'data.db', sqliteTable: 'records', pgTable: 'app.records',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'text'], ['token_id', 'text'], ['external_id', 'text'], ['title', 'text'],
      ['prompt', 'text'], ['content', 'text'], ['content_format', 'text'],
      ['content_hash', 'text'], ['source_agent', 'text'], ['skill_version', 'text'],
      ['tags', 'json'], ['metadata', 'json'], ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'tokens', pgTable: 'app.tokens',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'text'], ['name', 'text'], ['key_hash', 'text'],
      ['created_at', 'ts'], ['revoked_at', 'ts'], ['role', 'text'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'webhooks', pgTable: 'app.webhooks',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'bigint'], ['name', 'text'], ['url', 'text'], ['token', 'text'],
      ['payload', 'text'], ['cron', 'text'], ['is_active', 'bool'],
      ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'webhook_payloads', pgTable: 'app.webhook_payloads',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'text'], ['name', 'text'], ['content', 'text'], ['is_active', 'bool'],
      ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'webhook_trigger_history', pgTable: 'app.webhook_trigger_history',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'bigint'], ['webhook_id', 'bigint'], ['webhook_name', 'text'], ['kind', 'text'],
      ['triggered_at', 'ts'], ['http_status', 'int'], ['ok', 'bool'], ['body_kind', 'text'],
      ['body', 'text'], ['body_truncated', 'bool'], ['error', 'text'], ['duration_ms', 'int'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'pull_tasks', pgTable: 'app.pull_tasks',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'bigint'], ['name', 'text'], ['prompt', 'text'], ['cron', 'text'],
      ['target', 'text'], ['is_active', 'bool'], ['last_run_at', 'ts'],
      ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'pending_tasks', pgTable: 'app.pending_tasks',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'bigint'], ['pull_task_id', 'bigint'], ['pull_task_name', 'text'],
      ['target', 'text'], ['prompt', 'text'], ['due_at', 'ts'], ['kind', 'text'],
      ['status', 'text'], ['result_external_id', 'text'], ['result_record_id', 'text'],
      ['error', 'text'], ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'chat_messages', pgTable: 'app.chat_messages',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'bigint'], ['source', 'text'], ['content', 'text'], ['status', 'text'],
      ['in_reply_to', 'bigint'], ['error', 'text'], ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'site_nonces', pgTable: 'app.site_nonces',
    idKey: { kind: 'col', name: 'address' },
    columns: [
      ['address', 'text'], ['nonce', 'text'], ['message', 'text'], ['expires_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'site_sessions', pgTable: 'app.site_sessions',
    idKey: { kind: 'col', name: 'token_hash' },
    columns: [
      ['token_hash', 'text'], ['address', 'text'], ['created_at', 'ts'], ['expires_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'data.db', sqliteTable: 'site_favorites', pgTable: 'app.site_favorites',
    idKey: { kind: 'composite', names: ['address', 'item_id'] },
    columns: [
      ['address', 'text'], ['item_id', 'text'], ['created_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'news-detail.sqlite', sqliteTable: 'detail_pages', pgTable: 'news_detail.detail_pages',
    idKey: { kind: 'col', name: 'item_id' },
    columns: [
      ['item_id', 'text'], ['detail_path', 'text'], ['status', 'text'],
      ['original_url', 'text'], ['created_at', 'ts'], ['updated_at', 'ts'],
    ],
  },
  {
    sqliteFile: 'cleaned.sqlite', sqliteTable: 'cleaned_records', pgTable: 'cleaner.cleaned_records',
    idKey: { kind: 'col', name: 'source_record_id' },
    columns: [
      ['source_record_id', 'text'], ['content_hash', 'text'], ['cleaned_at', 'ts'],
      ['provider', 'text'], ['model', 'text'], ['prompt_version', 'text'],
      ['item_count', 'int'], ['source_agent', 'text'],
    ],
  },
  {
    sqliteFile: 'cleaned.sqlite', sqliteTable: 'cleaned_items', pgTable: 'cleaner.cleaned_items',
    idKey: { kind: 'col', name: 'id' },
    columns: [
      ['id', 'text'], ['source_record_id', 'text'], ['idx', 'int'], ['title', 'text'],
      ['summary', 'text'], ['detail', 'text'], ['category', 'text'], ['tags', 'json'],
      // event_date 保持 TEXT（DDL 决议：值有日期也有不完整形式，DATE 会截断）。
      ['event_date', 'text'], ['sources', 'json'],
      // translation_zh 保持 TEXT 三态：NULL / '' / JSON 文本，绝不转 JSONB。
      ['translation_zh', 'verbatim'],
    ],
  },
  {
    sqliteFile: 'cleaned.sqlite', sqliteTable: 'cleaner_meta', pgTable: 'cleaner.cleaner_meta',
    idKey: { kind: 'none' },
    columns: [
      ['key', 'text'], ['value', 'text'],
    ],
  },
  {
    sqliteFile: 'cleaned.sqlite', sqliteTable: 'llm_calls', pgTable: 'cleaner.llm_calls',
    idKey: { kind: 'none' },
    columns: [
      // called_at 保持 BIGINT（epoch 毫秒，DDL 决议：驱动比较逻辑零改动）。
      ['called_at', 'bigint'],
    ],
  },
];

// 5 张 IDENTITY 表：导完后 setval 到 max(id)（空表则为 1）。
// 序列名不硬编码，用 pg_get_serial_sequence 现场解析（以实际建表结果为准）。
const IDENTITY_TABLES = [
  'app.webhooks',
  'app.webhook_trigger_history',
  'app.pull_tasks',
  'app.pending_tasks',
  'app.chat_messages',
];

const SOURCE_FILES = ['data.db', 'news-detail.sqlite', 'cleaned.sqlite'];

// ---------------------------------------------------------------------------
// 环境变量与护栏
// ---------------------------------------------------------------------------
function pick(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value.length === 0) throw new Error(`missing configuration: ${key} must be non-empty`);
  return value;
}

function resolveConfig() {
  const config = {
    sqliteDir: pick('SQLITE_DIR', '/tmp/step0'),
    host: pick('PG_HOST', 'database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com'),
    port: Number(pick('PG_PORT', '5432')),
    database: pick('PG_DATABASE', 'data_pipeline_practice'),
    user: pick('PG_USER', 'data_pipeline_app'),
    region: pick('PG_REGION', 'ap-southeast-1'),
  };
  // 护栏 1：绝不允许生产库。没有任何放行开关。
  if (config.database === 'data_pipeline') {
    throw new Error('refusing to run: PG_DATABASE must not be data_pipeline (production database)');
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error('invalid PG_PORT: expected an integer between 1 and 65535');
  }
  return config;
}

// ---------------------------------------------------------------------------
// 类型转换（与驱动一致；报错只含表名/列名，不含字段值）
// ---------------------------------------------------------------------------
function convert(table, col, type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'text':
    case 'verbatim':
      // verbatim 与 text 在转换上相同（原样字符串）；区别只在语义：
      // translation_zh 绝不做 JSON.parse、不合并 NULL 与 ''。
      return String(value);
    case 'int':
    case 'bigint': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`invalid number in ${table}.${col}`);
      return n;
    }
    case 'bool':
      if (value === 1 || value === true) return true;
      if (value === 0 || value === false) return false;
      throw new Error(`invalid boolean in ${table}.${col}`);
    case 'ts': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new Error(`invalid timestamp in ${table}.${col}`);
      }
      return value;
    }
    case 'json': {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          throw new Error(`invalid JSON in ${table}.${col}`);
        }
      }
      if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return value;
      throw new Error(`invalid JSON value in ${table}.${col}`);
    }
    default:
      throw new Error(`unknown column type ${type} in ${table}.${col}`);
  }
}

function idOf(tableSpec, row) {
  const k = tableSpec.idKey;
  if (k.kind === 'col') return String(row[k.name]);
  if (k.kind === 'composite') return k.names.map((n) => String(row[n])).join('\x1f');
  return null;
}

function hashIds(ids) {
  return createHash('sha256').update(ids.map(String).sort().join('\n')).digest('hex');
}

// 报错信息截断（与验证入口同款做法），且绝不把行内容拼进报错。
function messageOf(err) {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 300);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const config = resolveConfig();

  // 护栏 2：源文件三份缺一直接退出。
  for (const f of SOURCE_FILES) {
    const p = join(config.sqliteDir, f);
    if (!existsSync(p)) throw new Error(`missing source file: ${p}`);
  }

  // 读源：只读打开（绝不改动快照），全量读进内存（总量约 23M，行数约 4 千）。
  const dbs = new Map();
  const open = (file) => {
    if (!dbs.has(file)) {
      dbs.set(file, new DatabaseSync(join(config.sqliteDir, file), { readOnly: true }));
    }
    return dbs.get(file);
  };
  const sqliteData = [];
  for (const t of TABLES) {
    const db = open(t.sqliteFile);
    const cols = t.columns.map(([name]) => `"${name}"`).join(', ');
    const rows = db.prepare(`SELECT ${cols} FROM "${t.sqliteTable}"`).all();
    const converted = rows.map((row) => t.columns.map(([name, type]) => convert(t.pgTable, name, type, row[name])));
    const ids = t.idKey.kind === 'none' ? null : rows.map((row) => idOf(t, row));
    sqliteData.push({
      spec: t,
      count: rows.length,
      values: converted,
      idHash: ids === null ? null : hashIds(ids),
    });
  }

  // 连目标库：IAM 令牌回调（每新连接现场签令牌，令牌绝不打印）。
  const signer = new Signer({
    hostname: config.host,
    port: config.port,
    username: config.user,
    region: config.region,
  });
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    max: 2,
    password: () => signer.getAuthToken(),
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    // 护栏 3：目标库 16 表必须存在且全为空，否则直接退出（不截断、不覆盖）。
    for (const t of TABLES) {
      let rows;
      try {
        ({ rows } = await client.query(`SELECT COUNT(*) AS n FROM ${t.pgTable}`));
      } catch {
        throw new Error(`target table missing: ${t.pgTable} (run DDL first)`);
      }
      const n = Number(rows[0].n);
      if (n !== 0) {
        throw new Error(`target table not empty: ${t.pgTable} has ${n} rows (refusing to overwrite; DROP + rebuild first)`);
      }
    }
    console.log(`precheck: 16 tables present in ${config.database}, all empty`);

    // 整批导数 + setval 在一个事务内完成。
    await client.query('BEGIN');
    try {
      for (const item of sqliteData) {
        const { spec, values } = item;
        const cols = spec.columns.map(([name]) => `"${name}"`).join(', ');
        const placeholders = spec.columns.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `INSERT INTO ${spec.pgTable} (${cols}) VALUES (${placeholders})`;
        for (const params of values) {
          await client.query(sql, params);
        }
      }

      // setval：5 张 IDENTITY 表推到 max(id)（空表则为 1），并验证 next 值。
      for (const pgTable of IDENTITY_TABLES) {
        const seqRows = await client.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [pgTable, 'id']);
        const seq = seqRows.rows[0] && seqRows.rows[0].seq;
        if (!seq) throw new Error(`cannot resolve sequence for ${pgTable}`);
        const maxRows = await client.query(`SELECT MAX(id) AS m FROM ${pgTable}`);
        const max = maxRows.rows[0].m === null ? null : Number(maxRows.rows[0].m);
        await client.query(`SELECT setval($1, $2)`, [seq, max === null ? 1 : max]);
        const stateRows = await client.query(`SELECT last_value, is_called FROM ${seq}`);
        const lastValue = Number(stateRows.rows[0].last_value);
        const isCalled = stateRows.rows[0].is_called === true;
        const next = isCalled ? lastValue + 1 : lastValue;
        // 非空表要求 next > max；空表要求 next >= 1（setval(seq, 1) 后 next 为 2，满足）。
        if (max !== null && !(next > max)) throw new Error(`setval verification failed for ${pgTable}`);
        if (max === null && !(next >= 1)) throw new Error(`setval verification failed for ${pgTable}`);
        console.log(`setval ${pgTable}: next=${next} OK`);
      }

      // 自校验（同一事务内读回，与源侧行数 + id 集合哈希逐表比对）。
      let mismatches = [];
      let totalRows = 0;
      for (const item of sqliteData) {
        const { spec, count, idHash } = item;
        totalRows += count;
        const pgCountRows = await client.query(`SELECT COUNT(*) AS n FROM ${spec.pgTable}`);
        const pgCount = Number(pgCountRows.rows[0].n);
        let pgHash = null;
        let match = pgCount === count;
        if (spec.idKey.kind !== 'none') {
          const keyExpr = spec.idKey.kind === 'col'
            ? `"${spec.idKey.name}"`
            : spec.idKey.names.map((n) => `"${n}"`).join(` || chr(31) || `);
          const idRows = await client.query(`SELECT ${keyExpr} AS k FROM ${spec.pgTable}`);
          pgHash = hashIds(idRows.rows.map((r) => String(r.k)));
          match = match && pgHash === idHash;
        }
        const flag = match ? 'MATCH' : 'MISMATCH';
        console.log(
          `${flag} ${spec.pgTable} | sqlite_count=${count} | pg_count=${pgCount} | id_hash=${pgHash === null ? '-' : pgHash}`,
        );
        if (!match) mismatches.push(spec.pgTable);
      }

      if (mismatches.length > 0) {
        await client.query('ROLLBACK');
        console.log(`LOAD FAILED: ${mismatches.length} table(s) mismatch, rolled back: ${mismatches.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      await client.query('COMMIT');
      console.log(`LOAD OK: 16 tables, ${totalRows} rows, all counts and id sets match`);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 已回滚或连接已断：无事可做。
      }
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
    for (const db of dbs.values()) db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`ERROR: ${messageOf(err)}`);
    process.exitCode = 1;
  });
}

// 供静态检查复用：列定义与 IDENTITY 表清单（直接 require 不会跑主流程）。
module.exports = { TABLES, IDENTITY_TABLES, SOURCE_FILES };
