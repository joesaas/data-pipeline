import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDefaultEnv } from "./load-env.js";
import { setupFileLogging } from "./log.js";

const envFile = loadDefaultEnv();
if (envFile) console.log(`data-pipeline: loaded env from ${envFile}`);
const logFile = setupFileLogging("data-pipeline");
if (logFile) console.log(`data-pipeline: logging to ${logFile}`);
const config = loadConfig();
const { app } = createApp(config);
app.listen(config.port, () => {
  console.log(
    `data-pipeline listening on :${config.port} (storage=${config.storage}, auth_required=${config.authRequired})`,
  );
});
