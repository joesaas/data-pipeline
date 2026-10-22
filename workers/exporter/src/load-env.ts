import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Same .env loading contract as the other services (see apps/api load-env). */
export function loadDefaultEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof process.loadEnvFile !== "function") return null;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(moduleDir, "../../../..");
  const candidates = [
    env.DOTENV_PATH,
    join(process.cwd(), ".env"),
    join(repoRoot, ".env"),
    join(moduleDir, "..", "..", ".env"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
  }
  return null;
}
