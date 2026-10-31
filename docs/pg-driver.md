# PostgreSQL drivers

The data-pipeline stores can run on SQLite (default) or PostgreSQL.
This document covers the PG drivers added by the driver rewrite, how
to enable them, how their semantics align with the SQLite versions,
and how to run the driver contract against a real PG database.

**Scope rule: nothing here switches live operation.** EC2 sets none
of the switches below, so deploying this code changes no behaviour.
The PG drivers exist so the migration can be rehearsed (dry-run load,
then a stop-window cutover) without a second code change. No code in
this rewrite creates tables: the 16 tables must already exist per
`~/workspace/goals/data-pipeline-data-collection-project/files/pg-ddl-draft-v1.sql`
(the migration DDL), and the drivers never write to a database they
did not explicitly get selected for.

## Enablement (one switch per domain, consistent naming)

| Domain | Switch | Values | Default | Code |
| --- | --- | --- | --- | --- |
| API records/tokens/site/webhooks/pull/chat | `STORAGE_DRIVER` | `sqlite` \| `file` \| `pg` | `sqlite` | `apps/api/src/config.ts`, `apps/api/src/app.ts` |
| Cleaner cache | `CLEANER_STORAGE_DRIVER` | `sqlite` \| `pg` | `sqlite` | `workers/cleaner/src/main.ts` |
| News-detail pair (cleaned reader + detail store, one switch) | `NEWS_DETAIL_STORAGE_DRIVER` | `sqlite` \| `pg` | `sqlite` | `apps/api/src/config.ts`, `apps/api/src/http/routes.ts` |
| Static site export, standalone CLI only | `EXPORTER_STORAGE_DRIVER` | `sqlite` \| `pg` | `sqlite` | `workers/exporter/src/main.ts`, `storage.ts`, `pg-pool.ts`, `reader.ts`, `export.ts` |

Rules shared by all three switches:

- An **explicit** switch value wins over legacy flags (API: `STORAGE=file`
  is ignored once `STORAGE_DRIVER` is set).
- An **unknown non-empty value throws at startup** instead of silently
  falling back — a mistyped env must not serve the wrong database.
- The news-detail switch covers **both** the cleaned reader and the
  detail store as one pair, and the same reader instance serves
  `/cleaned/*`. A split backend would let the pending queue join a PG
  reader against a stale SQLite store, so it is not offered.
- The exporter switch governs **only the standalone exporter CLI**
  (`node dist/src/main.js`). A cleaner-triggered export never reads
  `EXPORTER_STORAGE_DRIVER`: the cleaner passes its own mode
  (`CLEANER_STORAGE_DRIVER`) explicitly to `exportSite`, so a PG-mode
  cleaner can never silently export from a stale SQLite file. In PG
  mode the cleaner reuses a lazily-created export pool (same IAM
  token-callback factory as the store pool, separate instance).

Connection parameters (all four drivers, same defaults):

- `PG_HOST` (default `database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com`)
- `PG_PORT` (default `5432`)
- `PG_DATABASE` (default `data_pipeline`)
- `PG_USER` (default `data_pipeline_app`)
- `PG_REGION` (default `ap-southeast-1`)
- SSL is encryption-required (`ssl: { rejectUnauthorized: false }` —
  same documented caveat as the verify endpoint: the service carries
  no RDS CA bundle yet, so this proves connectivity + auth, not the
  CA chain; tightening it is a later step).

Authentication is IAM database auth, reusing the verify endpoint's
pattern (`apps/api/src/pg/verify.ts` `resolvePgConfig`, and
`apps/api/src/pg/pool.ts` / `workers/cleaner/src/pg-pool.ts`):
the pool's `password` is a **callback**, so every new connection asks
rds-signer for a fresh token (tokens live 15 minutes and are checked
only at connect time). The token is never logged, never returned,
and never stored. The drivers use a **resident pool** (`max: 10` API,
`max: 5` cleaner) — never the verify probe's per-call max:1
create-and-close pattern.

## Semantic alignment with SQLite (how each item is guaranteed)

- **Timestamps.** SQLite stores ISO text; PG stores TIMESTAMPTZ.
  Every PG read maps through `toIso` (Date → `toISOString()`,
  string passthrough) and every PG write accepts ISO strings, so
  callers always see ISO strings. One spelling difference is
  accepted: a non-Z ISO input normalizes to UTC Z form on read —
  same instant, different spelling; all writers use `toISOString()`.
- **JSONB.** `records.tags`/`metadata`, `cleaned_items.tags`/`sources`
  arrive as native arrays/objects from pg and are used directly;
  a JSON string row is parsed (parity with the SQLite TEXT-JSON
  path). Values are never double-wrapped. Tested in
  `pg-driver.test.ts`, `pg-store.test.ts`, `pg-news-detail.test.ts`.
- **Tag filter.** SQLite `json_each(tags)` becomes PG `tags ? $n`
  (JSONB array contains the string), with identical semantics:
  the item matches iff its tag array contains exactly that string.
  The SQL shape and parameter order are pinned by a stub-pool test.
- **Chat atomicity.** `completeChatMessage` takes one pooled client
  and runs BEGIN → conditional UPDATE (only when
  `status = 'processing'`) → conditional INSERT → COMMIT, with
  ROLLBACK + rethrow on error and `release()` in `finally`. The
  not-processing path still COMMITs and inserts nothing. The
  post-commit re-read returns the same human/muse pair shape as the
  SQLite version. Commit, rollback, and not-processing paths are all
  stub-tested, including the exact statement order.
- **translation_zh (cleaner) stays TEXT, three states.** NULL =
  untranslated, `''` = checked Chinese (no translation needed),
  JSON text = `{title, summary}`. The PG store writes exactly these
  three forms and `listUntranslated` selects `IS NULL` only; `''`
  and NULL are never merged. Stub-tested.
- **0/1 flags are BOOLEAN in PG.** `is_active`, `ok`,
  `body_truncated` are read as booleans and written as booleans.
  Call-site check: the API's callers treat them as booleans already
  (truthiness checks and JSON output), so no caller mapping was
  needed; the driver additionally tolerates `1`/`0` at the boundary.
- **Autoincrement.** The DDL uses IDENTITY. The drivers keep the
  explicit-id insert path (upserts by id) and the default-generation
  path (`RETURNING id`) identical to SQLite. `setval` past max after
  a data load is a migration step, not driver work.
- **Uniqueness.** `records (token_id, external_id)` partial unique
  index and `pending_tasks UNIQUE(pull_task_id, due_at)` are DDL
  constraints; the drivers do not bypass them. A PG unique violation
  propagates as an error (message contains `duplicate key value
  violates unique constraint`), and the existing admin catch regex
  `/UNIQUE|duplicate/i` maps it to a conflict exactly as before.
  The `savePendingTask` id ≤ 0 path uses a plain INSERT (no
  ON CONFLICT on `(pull_task_id, due_at)`) so duplicates throw,
  like SQLite. Upsert column lists mirror SQLite exactly — notably
  `savePendingTask` conflict updates only
  status/result_external_id/result_record_id/error/updated_at, and
  `saveWebhook`/`savePullTask` never overwrite `created_at`.
- **BIGINT.** pg returns int8 as strings by default; the drivers
  `Number()` every id and COUNT at the mapping boundary, and the
  pool factory additionally registers an int8 → number parser.
  Stub tests feed string ids/counts and assert numeric results.
- **SQLite LIKE vs PG ILIKE.** The cleaned reader's text search
  uses `ILIKE` and the category filter `ILIKE ANY(...)` over the
  same alias list the SQLite path feeds to `COLLATE NOCASE IN (...)`.
  Both are case-insensitive equality for ASCII; PG ILIKE additionally
  folds per locale, which only widens matches for non-ASCII
  spellings — categories here are ASCII. The `stats()` category
  folding stays JS-side via `canonicalCategory`, identical to
  SQLite.
- **PG reader error behaviour (deliberate difference).** The SQLite
  cleaned reader degrades to empty results when its file is missing.
  The PG reader **throws** on connection errors: the tables are
  pre-created, so a silent empty on a DB outage would break the
  pending queue silently and mask the outage. Stub-tested.
- **Exporter PG read (same deliberate difference).** The exporter's
  PG read (`workers/exporter/src/reader.ts` `readExportDataPg`) runs
  the same JOIN, ORDER BY and COUNT/MAX aggregates as the SQLite
  path through one shared row mapper, so identical rows render a
  byte-identical site (pinned by a parity test comparing
  index/items.json/sitemap/item pages). A PG read failure throws
  before any directory is created, so a failed export never flips
  `current` and never writes a half-finished release — unlike the
  SQLite path's missing-file degradation to an empty site, which is
  kept for the SQLite path only.
- **listUntranslated order (deliberate difference).** SQLite orders
  by `rowid DESC` (insertion order). PG has no rowid, so the PG
  version orders by `(cleaned_at DESC, idx ASC)` — newest record
  first, deterministic. Order only decides which untranslated items
  the sweep picks first, never correctness.

## Files

- API driver: `apps/api/src/storage/pg-driver.ts`,
  `apps/api/src/pg/pool.ts` (pool factory + narrow pool/client
  interfaces for stubbing). Interface + call sites:
  `apps/api/src/storage/storage-driver.ts`,
  `sqlite-driver.ts`, `file-driver.ts`,
  `apps/api/src/ingest/ingest-service.ts`,
  `apps/api/src/auth/auth.ts`,
  `apps/api/src/http/site.ts`, `admin.ts`, `routes.ts`,
  `apps/api/src/cli/create-token.ts`, `apps/api/src/config.ts`,
  `apps/api/src/app.ts`.
- Cleaner: `workers/cleaner/src/pg-store.ts`,
  `workers/cleaner/src/pg-pool.ts` (documented mirror of the API
  pool; the cleaner package cannot import from `apps/api`),
  `workers/cleaner/src/store.ts` (`CleanerStoreLike`),
  `batch.ts`, `ratelimit.ts`, `main.ts`,
  `workers/cleaner/package.json` (`pg`, `@aws-sdk/rds-signer`,
  `@types/pg`).
- News-detail: `apps/api/src/cleaned/pg-cleaned-reader.ts`,
  `apps/api/src/news-detail/pg-news-detail-store.ts`,
  `apps/api/src/cleaned/cleaned-reader.ts` (`CleanedReaderLike`,
  shared `toCleanedItemView` mapper),
  `apps/api/src/news-detail/news-detail-store.ts`
  (`NewsDetailStoreLike`), `news-detail-service.ts`, `routes.ts`.
- Tests: `apps/api/tests/pg-driver.test.ts`,
  `workers/cleaner/tests/pg-store.test.ts`,
  `apps/api/tests/pg-news-detail.test.ts`. All use stub pools;
  none touches a live database.
- Exporter PG support (added after the driver rewrite, closing the
  one functional gap below): `workers/exporter/src/pg-pool.ts`
  (documented mirror of the cleaner pool; the exporter package
  cannot import from the cleaner, which depends on the exporter),
  `workers/exporter/src/reader.ts` (`readExportDataPg` + shared row
  mapper), `workers/exporter/src/export.ts` (async `exportSite`,
  exactly one of `dbFile`/`pgPool`), `workers/exporter/src/main.ts`
  (`EXPORTER_STORAGE_DRIVER`), `workers/exporter/src/storage.ts`
  (switch parsing), `workers/cleaner/src/maybe-export.ts`
  (extracted `maybeExport`, PG mode exports from PG instead of
  skipping), `workers/exporter/tests/pg-export.test.ts`,
  `workers/cleaner/tests/maybe-export.test.ts`. All new tests use
  stub pools; none touches a live database.

## Running the contract against a real PG database (NOT done in this round)

`apps/api/tests/driver-contract.test.ts` has an env-gated third run:
with `PG_CONTRACT_TEST=1` it runs the same contract against
`PgDriver`, using `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/
`PG_REGION` from the environment.

Procedure for the dry-run phase (do not run against the migration
target — the contract writes and deletes rows):

1. Create a **scratch** database (any name except `data_pipeline`),
   e.g. `data_pipeline_scratch`, and build the 16 tables in it from
   the migration DDL, in schemas `app`/`cleaner`/`news_detail`
   owned by the app user.
2. From the repo root, run:
   `PG_CONTRACT_TEST=1 PG_DATABASE=data_pipeline_scratch npm run test -w @data-pipeline/api`
   (with `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_REGION` set to the
   scratch target; IAM token auth applies exactly as in production).
3. Expect the pg contract block green alongside sqlite/file.
4. Drop the scratch database afterwards.

The verify endpoint (`GET /api/v1/admin/pg/verify`) is untouched by
this rewrite and remains the pre-migration gate: it must pass
against the real target before any business migration begins.

## Leftover issues and next phases

- **Exporter PG support: DONE** (this round). The cleaner no longer
  skips the static export in PG mode, and the standalone exporter
  CLI runs on PG via `EXPORTER_STORAGE_DRIVER=pg`. The export chain
  is complete in PG mode; the remaining pre-cutover work is the
  dry-run load and the cutover window below.
- **SSL CA verification** is still off (`rejectUnauthorized: false`)
  on both the drivers and the verify endpoint; tightening needs an
  RDS CA bundle in the service.
- **Dry-run data load** (next phase): load a SQLite copy into a
  scratch PG per the DDL, verify per-table row counts + id-set
  checks, `setval` the 5 IDENTITY sequences past max, then run the
  env-gated contract above.
- **Cutover window** (after dry-run): stop pm2 (API, cleaner,
  job-runner), load production tables, smoke-test (pending lists,
  chat total, done count, claim/complete atomicity), keep the SQLite
  files untouched 1–2 weeks as rollback (rollback = flip the env
  switches back + restart), delete only on li's say-so.
- **EC2 step-0 measurements** (3 SQLite file sizes + per-table row
  counts) are still not done; do them before sizing the load.

## Job-runner PG support

The job-runner was the last SQLite holdout (it opens the API's
`data.db` directly from a separate process, so it could not reuse
the API's driver). It now has the same dual-implementation shape as
the other three switches:

- **Switch:** `JOB_RUNNER_STORAGE_DRIVER` (workers/job-runner/src/
  storage.ts). Default `sqlite` (previous behavior unchanged);
  `=pg` reads/writes PG. Unknown values throw at startup — main.ts
  validates before Bree starts, and each job file re-validates in
  its own worker thread (the DB functions themselves never throw, so
  without this a bad switch would silently skip every DB-backed
  tick). PG env validation (`assertJobRunnerPgConfig`) runs at the
  same point when the driver is pg.
- **Pool:** workers/job-runner/src/pg-pool.ts, a verbatim mirror of
  the exporter/cleaner pools (rds-signer token callback per new
  connection; `PG_HOST` default cluster endpoint, `PG_PORT` 5432,
  `PG_DATABASE` data_pipeline, `PG_USER` data_pipeline_app,
  `PG_REGION` ap-southeast-1; SSL encryption-required, CA chain
  unverified — same documented caveat). Defaults must stay in sync
  across all four pools.
- **Lifecycle:** jobs run in Bree worker threads, so the pool lives
  per worker thread, not in main.ts (main.ts holds no pool). The
  pool is created lazily on the first PG call of a tick and ended by
  the job file at tick end (`endJobRunnerPgPool`, no-op in SQLite
  mode and no-op when never created). A thread killed by Bree
  (throwing or hung job) takes its pool with it, so no pool can leak
  past a tick.
- **Modules** (SQLite paths kept verbatim as `*Sqlite` internals;
  public functions are now async, same first parameter):
  - `pull-task-scheduler.ts`: reads `app.pull_tasks` (`WHERE
    is_active`, BOOLEAN) and all `app.pending_tasks` due keys, and
    inserts pending rows (`kind='scheduled'`, `status='waiting'`).
    TIMESTAMPTZ arrives as a Date and MUST be rendered back to an
    ISO string before joining the `${id}|${dueAt}` key, or every
    existing row would miss and duplicate-schedule; BIGINT ids are
    Number()ed at the boundary.
  - `webhook-history.ts`: appends to `app.webhook_trigger_history`
    and prunes to the latest 1000 rows (same DELETE subquery as
    SQLite). `ok` / `body_truncated` are BOOLEAN in PG (no 1/0
    mapping). No DDL or migration runs on the PG path — the
    production DDL already creates the table with all columns.
  - `webhook-config.ts`: two read-only readers over `app.webhooks`
    (active row, by id) and one over `app.webhook_payloads`
    (active payload), same ordering and blank-content rules as
    SQLite. PG always has the `cron` column, so no hasCron check.
    Rows are returned to the caller but never logged (same secrets
    rule: no webhook token or URL in logs).
- **Never-throws contract preserved:** every public function still
  returns null/false on any failure (missing file/table, PG
  outage, unknown switch as a backstop) and never throws, so one
  bad tick cannot kill the runner. An unknown switch yields
  null/false rather than a guessed backend.
- **Switch correspondence:** `STORAGE_DRIVER` (API) /
  `CLEANER_STORAGE_DRIVER` (cleaner) / `NEWS_DETAIL_STORAGE_DRIVER`
  (news-detail) / `EXPORTER_STORAGE_DRIVER` (exporter) /
  `JOB_RUNNER_STORAGE_DRIVER` (job-runner). Cutover needs all five
  set to `pg`; rolling any one back to `sqlite` re-splits that
  writer's tables from the rest.
