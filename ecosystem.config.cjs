// pm2 process file: start everything with `pm2 start ecosystem.config.cjs`,
// or only the cleaner with `pm2 start ecosystem.config.cjs --only data-cleaner`.
const path = require("node:path");
const root = __dirname;
module.exports = {
  apps: [
    {
      name: "data-pipeline",
      cwd: root,
      script: "apps/api/dist/src/server.js",
      autorestart: true,
      // Same crash-loop protection as the other apps (see below): stop
      // after 10 crashes within 10s of start, instead of restarting forever.
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 3000,
      max_memory_restart: "300M",
      env: {
        PORT: 8080,
        DATA_DIR: path.join(root, "data"),
      },
    },
    {
      name: "data-cleaner",
      cwd: root,
      script: "workers/cleaner/dist/src/main.js",
      autorestart: true,
      // Crash-loop protection (2026-10-25): a process that cannot stay up
      // is stopped instead of restarted forever. After max_restarts crashes
      // within min_uptime, pm2 marks it "errored" and leaves it alone —
      // a human looks, instead of the box churning CPU/memory/logs until
      // it hangs. A process that runs longer than min_uptime before crashing
      // still restarts normally (transient failures keep recovering).
      // restart_delay spaces restarts out; max_memory_restart restarts a
      // leaking process before it can OOM the box.
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 3000,
      max_memory_restart: "300M",
      env: {
        DATA_PIPELINE_BASE_URL: "https://agent101.uk/data-pipeline",
        CLEANER_DATA_DIR: path.join(root, "workers/cleaner/data"),
        // CLEANER_INTERVAL_MINUTES intentionally NOT set here: pm2 env beats
        // .env (real env wins by design), so the interval lives in the repo
        // root .env only. In-code default is 60 when neither sets it.
        // LLM_API_KEY: "...",            // set on the server; without it the cleaner runs the mock provider
        // LLM_BASE_URL: "https://openrouter.ai/api/v1",
        // LLM_MODEL: "openai/gpt-4o-mini",
      },
    },
    {
      name: "data-job-runner",
      cwd: root,
      script: "workers/job-runner/dist/src/main.js",
      autorestart: true,
      // Crash-loop protection (2026-10-25): a process that cannot stay up
      // is stopped instead of restarted forever. After max_restarts crashes
      // within min_uptime, pm2 marks it "errored" and leaves it alone —
      // a human looks, instead of the box churning CPU/memory/logs until
      // it hangs. A process that runs longer than min_uptime before crashing
      // still restarts normally (transient failures keep recovering).
      // restart_delay spaces restarts out; max_memory_restart restarts a
      // leaking process before it can OOM the box.
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 3000,
      max_memory_restart: "300M",
      env: {
        // Job-specific secrets (if a future job needs any) live in the repo
        // root .env only, never here and never in code. The runner itself
        // needs no secrets: it only schedules jobs.
      },
    },
  ],
};
