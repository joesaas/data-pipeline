import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a .env file at startup (Node's built-in process.loadEnvFile).
 *
 * Real environment variables always win: loadEnvFile never overwrites a
 * variable that is already set, so .env only fills gaps. Candidate paths,
 * in priority order:
 *   1. $DOTENV_PATH (explicit override)
 *   2. the repo root, resolved from this module (dist/src -> ../../../../)
 *   3. ../../.env from cwd (repo root, when started from an app dir)
 *   4. ./.env in the current working directory
 *   5. the app directory, resolved from this module (dist/src -> ../..)
 * The repo-root .env is the single source of truth and beats any .env
 * sitting in an app directory. Every existing candidate is loaded;
 * earlier ones take precedence. Returns the first file that was loaded,
 * or null when none exists.
 */
export function loadDefaultEnv(candidates?: string[]): string | null {
  if (typeof process.loadEnvFile !== "function") return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = candidates ?? [
    ...(process.env.DOTENV_PATH ? [process.env.DOTENV_PATH] : []),
    join(here, "../../../../.env"),
    join(process.cwd(), "../../.env"),
    join(process.cwd(), ".env"),
    join(here, "../../.env"),
  ];
  let firstLoaded: string | null = null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      firstLoaded ??= path;
    } catch {
      // An unreadable or malformed file must not stop the service.
    }
  }
  return firstLoaded;
}
