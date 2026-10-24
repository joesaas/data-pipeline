import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

/** Repo root, resolved from this module (compiled: <root>/<app>/dist/src). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/**
 * Resolve the log file for a service.
 * Directory: $LOG_DIR (absolute as-is; relative resolved against the repo
 * root), defaulting to <repo root>/logs. File name: $<SERVICE>_LOG_FILE,
 * defaulting to <service>.log — e.g. LOG_DIR + data-cleaner.log.
 */
export function resolveLogFile(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  root: string = repoRoot(),
): string {
  const dirEnv = env.LOG_DIR?.trim();
  const dir = dirEnv
    ? isAbsolute(dirEnv)
      ? dirEnv
      : resolve(root, dirEnv)
    : join(root, "logs");
  const fileEnv = env[`${service.replace(/-/g, "_").toUpperCase()}_LOG_FILE`]?.trim();
  return join(dir, fileEnv || `${service}.log`);
}

type LogTarget = Pick<Console, "log" | "info" | "warn" | "error">;

let stream: WriteStream | null = null;

/**
 * Tee console output into the service log file (append mode, one ISO
 * timestamp per line in the file; the console keeps its plain format, so
 * pm2 logs keep working as before). Logging must never crash the service:
 * any failure here downgrades to console-only.
 */
export function setupFileLogging(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  target: LogTarget = console,
): string | null {
  try {
    const file = resolveLogFile(service, env);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, ""); // create eagerly so the file is visible at startup
    stream = createWriteStream(file, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
    const wrap =
      (original: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        original(...args);
        try {
          stream?.write(`${new Date().toISOString()} ${format(...args)}\n`);
        } catch {
          /* never let logging break the service */
        }
      };
    target.log = wrap(target.log.bind(target));
    target.info = wrap(target.info.bind(target));
    target.warn = wrap(target.warn.bind(target));
    target.error = wrap(target.error.bind(target));
    return file;
  } catch {
    return null;
  }
}
