import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExportData } from "./reader.js";
import { DEFAULT_SITE_URL, esc, renderIndex, renderItem } from "./render.js";

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
  /** Public base URL of the news site, e.g. https://agent101.uk/news (no trailing slash). */
  publicSiteUrl?: string;
  now?: Date;
}): ExportResult {
  const { dbFile, outDir } = options;
  const publicApiPath = (options.publicApiPath ?? "/data-pipeline").replace(/\/$/, "");
  const siteUrl = (options.publicSiteUrl ?? DEFAULT_SITE_URL).replace(/\/$/, "");
  const now = options.now ?? new Date();
  const data = readExportData(dbFile);

  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const releaseName = `${stamp}-${process.pid}`;
  const releasesDir = join(outDir, "releases");
  const releaseDir = join(releasesDir, releaseName);
  mkdirSync(join(releaseDir, "item"), { recursive: true });

  // Version the stylesheet URL by content hash: CDN/browser caches happily
  // serve a stale styles.css for hours (Cloudflare defaults CSS to 4h),
  // which once shipped new markup with old styles. A new hash = a new URL.
  const cssVersion = createHash("md5").update(readFileSync(stylesPath())).digest("hex").slice(0, 8);
  writeFileSync(join(releaseDir, "index.html"), renderIndex(data, now.toISOString(), cssVersion, siteUrl), "utf8");
  writeFileSync(join(releaseDir, "items.json"), JSON.stringify({ generated_at: now.toISOString(), ...data }, null, 2), "utf8");
  copyFileSync(stylesPath(), join(releaseDir, "styles.css"));
  for (const item of data.items) {
    const dir = join(releaseDir, "item", item.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderItem(item, publicApiPath, cssVersion, siteUrl), "utf8");
  }
  // Sitemap for search engines (2026-10-25 SEO): homepage + every detail
  // page, lastmod from the cleaning time. It is served at
  // <siteUrl>/sitemap.xml by the same nginx location as the site; the
  // domain-root robots.txt (outside this repo) should point at it, and
  // it should be submitted in Search Console — a sitemap file under
  // /news/ alone does not make crawlers discover the site.
  const today = now.toISOString().slice(0, 10);
  const urlEntry = (loc: string, lastmod: string, changefreq: string, priority: string): string =>
    `  <url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const sitemap = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    urlEntry(`${siteUrl}/`, today, "daily", "1.0"),
    ...data.items.map((item) =>
      urlEntry(
        `${siteUrl}/item/${encodeURIComponent(item.id)}/`,
        item.cleaned_at.slice(0, 10),
        "weekly",
        "0.8",
      ),
    ),
    `</urlset>`,
    ``,
  ].join("\n");
  writeFileSync(join(releaseDir, "sitemap.xml"), sitemap, "utf8");

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
