/**
 * cursor-trigger worker — a pm2-managed scheduled service.
 *
 * Default (service) mode: call the Cursor automation webhook once on
 * start, then repeat every CURSOR_TRIGGER_INTERVAL_MINUTES (default 60).
 * Calls never overlap; SIGINT / SIGTERM finish the in-flight call, then
 * exit.
 *
 * One-shot mode: `node dist/src/main.js --once` calls once and exits
 * (exit code 1 when the call failed or the config is incomplete).
 *
 * The webhook URL and Bearer token come from the environment (repo root
 * .env on the server) — see .env.example. They are never logged.
 */
import { loadDefaultEnv } from "./load-env.js";

const envFile = loadDefaultEnv();
import { resolveConfig, triggerOnce } from "./trigger.js";
import { setupFileLogging } from "./log.js";

const logFile = setupFileLogging("data-cursor-trigger");
if (logFile) console.log(`[cursor-trigger] logging to ${logFile}`);
console.log(`[cursor-trigger] env file: ${envFile ?? "(none found)"}`);
const once = process.argv.includes("--once");

let stopping = false;
let inFlight: Promise<void> | null = null;

async function main(): Promise<void> {
  const config = resolveConfig(process.env);
  // Log the cadence and the webhook origin only — never the full URL or token.
  const origin = new URL(config.url).origin;
  console.log(
    `[cursor-trigger] start mode=${once ? "once" : "service"} target=${origin}/… interval=${config.intervalMinutes}m`,
  );

  const call = async (): Promise<boolean> => {
    inFlight = (async () => {
      const result = await triggerOnce(config);
      console.log(`[cursor-trigger] triggered ok (HTTP ${result.status}) at ${new Date().toISOString()}`);
    })();
    try {
      await inFlight;
      return true;
    } catch (err) {
      console.error(`[cursor-trigger] trigger failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      inFlight = null;
    }
  };

  if (once) {
    const ok = await call();
    process.exit(ok ? 0 : 1);
  }

  // service mode: run immediately, then schedule after each call finishes
  const tick = async () => {
    if (stopping) return;
    await call();
    if (!stopping) {
      // NOTE: the timer must stay ref'd — it is the only handle keeping the
      // daemon alive between calls.
      timer = setTimeout(tick, config.intervalMinutes * 60_000);
    }
  };
  let timer: NodeJS.Timeout | null = setTimeout(tick, 0);
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    console.log(`[cursor-trigger] ${signal}: finishing in-flight call, then exit`);
    try {
      await inFlight;
    } catch {
      /* already logged */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[cursor-trigger] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
