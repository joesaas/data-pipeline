import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createApp(config);
app.listen(config.port, () => {
  console.log(
    `data-pipeline listening on :${config.port} (storage=${config.storage}, auth_required=${config.authRequired})`,
  );
});
