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
        CLEANER_INTERVAL_MINUTES: 60,
        // LLM_API_KEY: "...",            // set on the server; without it the cleaner runs the mock provider
        // LLM_BASE_URL: "https://openrouter.ai/api/v1",
        // LLM_MODEL: "openai/gpt-4o-mini",
      },
    },
  ],
};
