import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Bree from "bree";
import { JOBS, parseDurationMs, validateJobs } from "./registry.js";
import { loadDefaultEnv } from "./load-env.js";
import { setupFileLogging } from "./log.js";

const SERVICE = "data-job-runner";

/**
 * Job runner entrypoint.
 *
 * One pm2 process hosts every scheduled job. Isolation and recovery come
 * from Bree's execution model, not from code in this file:
 *   - Each job runs in its own worker thread. A throwing job kills only
 *     its own thread; the scheduler and every other job survive. Bree
 *     reports the failure through errorHandler below (log only).
 *   - A hung job is terminated once it exceeds its registry `timeout`,
 *     and the next scheduled tick retries it. That is the automatic
 *     recovery for both failure modes; the runner itself never exits
 *     because of one job.
 *   - If the runner process itself dies, pm2 restarts it (autorestart);
 *     schedules are interval-based and stateless, so nothing is lost.
 *
 * Usage:
 *   node dist/src/main.js            start the scheduler (pm2 mode)
 *   node dist/src/main.js --run <job> run one registered job once, then exit
 */
async function main(): Promise<void> {
  loadDefaultEnv();
  setupFileLogging(SERVICE);

  const errors = validateJobs(JOBS);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[job-runner] invalid registry: ${e}`);
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  const runOnly = runIndex >= 0 ? args[runIndex + 1] : undefined;
  if (runIndex >= 0 && !runOnly) {
    console.error("[job-runner] usage: --run <job-name>");
    process.exitCode = 1;
    return;
  }
  if (runOnly && !JOBS.some((j) => j.name === runOnly)) {
    console.error(`[job-runner] unknown job "${runOnly}" (registered: ${JOBS.map((j) => j.name).join(", ") || "none"})`);
    process.exitCode = 1;
    return;
  }

  // Job scripts live in dist/src/jobs/ (compiled from src/jobs/).
  // closeWorkerAfterMs is the hung-job killer: Bree terminates a run
  // that exceeds it. (Bree's `timeout` is a first-run delay, NOT a
  // kill switch — never map maxRunMs onto it.)
  const jobsDir = join(dirname(fileURLToPath(import.meta.url)), "jobs");
  const bree = new Bree({
    root: jobsDir,
    logger: false,
    jobs: JOBS.map((j) => ({
      name: j.name,
      interval: j.interval,
      closeWorkerAfterMs: parseDurationMs(j.maxRunMs) ?? undefined,
    })),
    errorHandler: (error, data) => {
      // Logged, never rethrown: one job's failure must not kill the runner.
      // (Error text only; jobs must never log secrets themselves.)
      console.error(`[job-runner] job ${data.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    workerMessageHandler: (data) => {
      console.log(`[job-runner] job ${data.name} message: ${String(data.message)}`);
    },
  });

  if (runOnly) {
    await bree.run(runOnly);
    await bree.stop();
    console.log(`[job-runner] job ${runOnly} finished (single run)`);
    return;
  }

  for (const j of JOBS) {
    console.log(`[job-runner] registered job ${j.name}: every ${j.interval}, max run ${j.maxRunMs} — ${j.description}`);
  }
  await bree.start();
  console.log(`[job-runner] scheduler started with ${JOBS.length} job(s)`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[job-runner] ${signal} received, stopping scheduler…`);
    await bree.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(`[job-runner] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
