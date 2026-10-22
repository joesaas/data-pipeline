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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const basePath = (env.BASE_PATH ?? "/data-pipeline").replace(/\/+$/, "");
  return {
    port: Number(env.PORT ?? 8080),
    basePath: basePath && !basePath.startsWith("/") ? `/${basePath}` : basePath,
    dataDir: env.DATA_DIR ?? "./data",
    storage: env.STORAGE === "file" ? "file" : "sqlite",
    authRequired: env.AUTH_REQUIRED === "true",
    maxContentBytes: Number(env.MAX_CONTENT_BYTES ?? 1_048_576),
    maxPromptBytes: Number(env.MAX_PROMPT_BYTES ?? 65_536),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 60),
  };
}
