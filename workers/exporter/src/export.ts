import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExportData } from "./reader.js";
import { renderIndex, renderItem } from "./render.js";

export interface ExportResult {
  items: number;
  releaseDir: string;
  currentLink: string;
}

const KEEP_RELEASES = 3;

function stylesPath(): string {
  // dist/src/export.js -> ../../assets/styles.css (assets live next to src in the package)
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/styles.css");
}

/**
 * Render the whole site into a fresh release directory, then flip the
 * `current` symlink to it atomically (single rename). nginx points at
 * <outDir>/current, so it always sees a complete generation. Old releases
 * are pruned to the newest few. A failure mid-export leaves `current`
 * untouched.
 */
export function exportSite(options: {
  dbFile: string;
  outDir: string;
  publicApiPath?: string;
  now?: Date;
}): ExportResult {
  const { dbFile, outDir } = options;
  const publicApiPath = (options.publicApiPath ?? "/data-pipeline").replace(/\/$/, "");
  const now = options.now ?? new Date();
  const data = readExportData(dbFile);

  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const releaseName = `${stamp}-${process.pid}`;
  const releasesDir = join(outDir, "releases");
  const releaseDir = join(releasesDir, releaseName);
  mkdirSync(join(releaseDir, "item"), { recursive: true });

  writeFileSync(join(releaseDir, "index.html"), renderIndex(data, now.toISOString()), "utf8");
  writeFileSync(join(releaseDir, "items.json"), JSON.stringify({ generated_at: now.toISOString(), ...data }, null, 2), "utf8");
  copyFileSync(stylesPath(), join(releaseDir, "styles.css"));
  for (const item of data.items) {
    const dir = join(releaseDir, "item", item.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderItem(item, publicApiPath), "utf8");
  }

  // Flip `current` atomically: build a temp symlink, then rename over.
  const currentLink = join(outDir, "current");
  const tmpLink = join(outDir, `.current-${process.pid}`);
  rmSync(tmpLink, { force: true });
  symlinkSync(join("releases", releaseName), tmpLink);
  renameSync(tmpLink, currentLink);

  // Prune older releases.
  const releases = readdirSync(releasesDir).sort().reverse();
  for (const old of releases.slice(KEEP_RELEASES)) {
    rmSync(join(releasesDir, old), { recursive: true, force: true });
  }

  return { items: data.items.length, releaseDir, currentLink };
}
