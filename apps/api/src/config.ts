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
  /** Public news site that owns the original item pages, e.g. https://agent101.uk/news.
   *  Only used to build original_url for news-detail items; it never
   *  changes where the exporter writes news/item/<id>/ pages. */
  newsSiteUrl: string;
  /** Directory the news-detail push endpoint writes single HTML files
   *  into. Configurable so EC2 can point it at the docs tree while
   *  local runs and tests point it at a temp directory. */
  newsDetailDir: string;
  /** SQLite file that owns news-detail status (detail_pages). It is
   *  deliberately NOT the cleaner's database: the API never writes
   *  there, and it is NOT the records database either, so adding this
   *  feature does not touch the StorageDriver contract (sqlite/file
   *  dual implementation) or the cleaner. */
  newsDetailDbFile: string;
  /** Fixed base directory the resource upload endpoint writes into.
   *  The client only supplies a relative sub-path + file name; it can
   *  never change this base. Configurable so local runs and tests
   *  point it at a temp directory. */
  resourceDir?: string;
  /** Public base URL used to build the returned `url` for an uploaded
   *  file, e.g. https://agent101.uk/resource. It never changes where
   *  the file is written. */
  resourceSiteUrl?: string;
  /** Max decoded bytes for one resource upload, independent of
   *  maxContentBytes (records/news-detail stay on their own limit). */
  resourceMaxBytes?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const basePath = (env.BASE_PATH ?? "/data-pipeline").replace(/\/+$/, "");
  const cleanedDbFile =
    env.CLEANED_DB_FILE ??
    `${(env.CLEANED_DATA_DIR ?? "./workers/cleaner/data").replace(/\/+$/, "")}/cleaned.sqlite`;
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    port: Number(env.PORT ?? 8080),
    basePath: basePath && !basePath.startsWith("/") ? `/${basePath}` : basePath,
    dataDir,
    storage: env.STORAGE === "file" ? "file" : "sqlite",
    authRequired: env.AUTH_REQUIRED === "true",
    maxContentBytes: Number(env.MAX_CONTENT_BYTES ?? 1_048_576),
    maxPromptBytes: Number(env.MAX_PROMPT_BYTES ?? 65_536),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 60),
    cleanedDbFile,
    newsSiteUrl: (env.NEWS_SITE_URL ?? "https://agent101.uk/news").replace(/\/+$/, ""),
    newsDetailDir: env.NEWS_DETAIL_DIR ?? "/home/ec2-user/app/docs/news",
    newsDetailDbFile:
      env.NEWS_DETAIL_DB_FILE ?? `${dataDir.replace(/\/+$/, "")}/news-detail.sqlite`,
    resourceDir: env.RESOURCE_DIR ?? "/home/ec2-user/app/resource",
    resourceSiteUrl: (env.RESOURCE_SITE_URL ?? "https://agent101.uk/resource").replace(
      /\/+$/,
      "",
    ),
    resourceMaxBytes: Number(env.RESOURCE_MAX_BYTES ?? 10_485_760),
  };
}
