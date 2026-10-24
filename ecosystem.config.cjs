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
      name: "data-cursor-trigger",
      cwd: root,
      script: "workers/cursor-trigger/dist/src/main.js",
      autorestart: true,
      env: {
        // CURSOR_WEBHOOK_URL / CURSOR_AUTOMATION_TOKEN / CURSOR_TRIGGER_INTERVAL_MINUTES
        // intentionally NOT set here: pm2 env beats .env (real env wins by
        // design), so all three live in the repo root .env only. In-code
        // default interval is 60 minutes when neither sets it. The token
        // must never be hard-coded anywhere in this repo.
      },
    },
    {
      name: "data-job-runner",
      cwd: root,
      script: "workers/job-runner/dist/src/main.js",
      autorestart: true,
      env: {
        // Job-specific secrets (if a future job needs any) live in the repo
        // root .env only, never here and never in code. The runner itself
        // needs no secrets: it only schedules jobs.
      },
    },
  ],
};
