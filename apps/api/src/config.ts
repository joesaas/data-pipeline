export interface AppConfig {
  port: number;
  /** Project path prefix mounted before /api, e.g. "/data-pipeline". Empty string disables it. */
  basePath: string;
  dataDir: string;
  storage: "sqlite" | "file";
  authRequired: boolean;
  maxContentBytes: number;
  maxPromptBytes: number;
  rateLimitPerMin: number;
  /** Path of the cleaner's SQLite output, read-only for the cleaned endpoints. */
  cleanedDbFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const basePath = (env.BASE_PATH ?? "/data-pipeline").replace(/\/+$/, "");
  const cleanedDbFile =
    env.CLEANED_DB_FILE ??
    `${(env.CLEANED_DATA_DIR ?? "./workers/cleaner/data").replace(/\/+$/, "")}/cleaned.sqlite`;
  return {
    port: Number(env.PORT ?? 8080),
    basePath: basePath && !basePath.startsWith("/") ? `/${basePath}` : basePath,
    dataDir: env.DATA_DIR ?? "./data",
    storage: env.STORAGE === "file" ? "file" : "sqlite",
    authRequired: env.AUTH_REQUIRED === "true",
    maxContentBytes: Number(env.MAX_CONTENT_BYTES ?? 1_048_576),
    maxPromptBytes: Number(env.MAX_PROMPT_BYTES ?? 65_536),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 60),
    cleanedDbFile,
  };
}
