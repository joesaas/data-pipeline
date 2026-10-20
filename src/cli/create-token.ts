import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

// Usage: npm run create-token -- <name>
// Prints the plain API key once; only its hash is stored.
const name = process.argv[2] ?? "default";
const config = loadConfig();
const { auth, driver } = createApp(config);
const { token, plainKey } = auth.createToken(name);
console.log(JSON.stringify({ id: token.id, name: token.name, api_key: plainKey }));
driver.close();
