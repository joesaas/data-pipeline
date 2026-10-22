import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDefaultEnv } from "./load-env.js";

const envFile = loadDefaultEnv();
if (envFile) console.log(`data-pipeline: loaded env from ${envFile}`);
const config = loadConfig();
const { app } = createApp(config);
app.listen(config.port, () => {
  console.log(
    `data-pipeline listening on :${config.port} (storage=${config.storage}, auth_required=${config.authRequired})`,
  );
});
