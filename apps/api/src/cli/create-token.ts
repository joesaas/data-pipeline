import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { loadDefaultEnv } from "../load-env.js";

loadDefaultEnv();

// Usage: npm run create-token -- [--admin] <name>
// --admin issues a cross-identity reader token (for the cleaner).
// Prints the plain API key once; only its hash is stored.
const args = process.argv.slice(2);
const isAdmin = args.includes("--admin");
const name = args.find((a) => !a.startsWith("--")) ?? "default";
const config = loadConfig();
const { auth, driver } = createApp(config);
const { token, plainKey } = auth.createToken(name, isAdmin ? "admin" : "user");
console.log(JSON.stringify({ id: token.id, name: token.name, role: token.role ?? "user", api_key: plainKey }));
driver.close();
