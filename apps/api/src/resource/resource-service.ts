import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AppConfig } from "../config.js";
import { ValidationError } from "../domain/types.js";

/**
 * Resource uploads: files written under a fixed server-side base
 * directory (RESOURCE_DIR, default /home/ec2-user/app/resource) so
 * nginx /resource/ can list and serve them. The client supplies only
 * a relative sub-path (e.g. muse/test) and a file name (e.g.
 * file.json / page.html / notes.md); it can never change the base.
 *
 * No database row is created: the file system is the record, like a
 * static site. Auth is handled by the route (same X-API-Key gate as
 * records / news-detail), not here.
 */

// Text formats may arrive as plain UTF-8 `content`; binary formats
// must arrive as base64, otherwise UTF-8 round-tripping would corrupt
// them. The allowlist is the whole gate: anything not listed here
// (sh, php, exe, env, …) is rejected, no matter how it is encoded.
export const TEXT_EXTENSIONS = new Set([
  "json",
  "md",
  "markdown",
  "html",
  "htm",
  "txt",
  "csv",
  "xml",
  "yaml",
  "yml",
  "css",
  "js",
  "mjs",
]);

export const BINARY_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "mp3",
  "mp4",
  "wav",
  "zip",
  "gz",
]);

const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]);

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateResourcePath(path: string): string[] {
  if (path === "") return [];
  const segments = path.split("/");
  if (segments.length > 10) {
    throw new ValidationError("path has too many segments (max 10)", "path");
  }
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new ValidationError(
        "path must be relative segments like muse/test (letters, digits, - and _ only, no .. or leading dot)",
        "path",
      );
    }
  }
  return segments;
}

export function validateResourceFilename(filename: string): string {
  if (!FILENAME_RE.test(filename) || filename.includes("..")) {
    throw new ValidationError(
      "filename must be a plain file name, e.g. file.json, page.html or notes.md",
      "filename",
    );
  }
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ValidationError(
      `file extension .${ext || "(none)"} is not allowed for resource uploads`,
      "filename",
    );
  }
  return ext;
}

export class ResourceService {
  constructor(private readonly config: AppConfig) {}

  saveFile(input: {
    path?: string;
    filename: string;
    content: string;
    encoding?: string;
  }): {
    status: "created" | "replaced";
    path: string;
    url: string;
    size: number;
    updated_at: string;
  } {
    const subPath = typeof input.path === "string" ? input.path.replace(/^\/+|\/+$/g, "") : "";
    const segments = validateResourcePath(subPath);
    const filename = typeof input.filename === "string" ? input.filename : "";
    const ext = validateResourceFilename(filename);
    const encoding = input.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new ValidationError('encoding must be "utf8" or "base64"', "encoding");
    }
    if (BINARY_EXTENSIONS.has(ext) && encoding !== "base64") {
      throw new ValidationError(
        `binary files (.${ext}) must be uploaded with encoding "base64"`,
        "encoding",
      );
    }
    if (typeof input.content !== "string" || input.content === "") {
      throw new ValidationError("content must be a non-empty string", "content");
    }

    let buffer: Buffer;
    if (encoding === "base64") {
      const compact = input.content.replace(/\s/g, "");
      if (!BASE64_RE.test(compact)) {
        throw new ValidationError("content is not valid base64", "content");
      }
      buffer = Buffer.from(compact, "base64");
    } else {
      buffer = Buffer.from(input.content, "utf8");
    }
    if (buffer.length > (this.config.resourceMaxBytes ?? 10_485_760)) {
      throw new ValidationError("file exceeds max resource size", "content", true);
    }

    const dir = resolve(this.config.resourceDir ?? "/home/ec2-user/app/resource");
    const targetDir = segments.length ? resolve(join(dir, ...segments)) : dir;
    const target = resolve(join(targetDir, filename));
    // Same containment check as news-detail: resolved target must stay
    // inside the fixed base, even if a segment somehow slipped past
    // the regex (defence in depth, not the only check).
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new ValidationError("path escapes the resource directory", "path");
    }

    mkdirSync(targetDir, { recursive: true });
    const existed = existsSync(target);
    // Atomic publish, same pattern as news-detail: temp file in the
    // same directory, then rename, so a reader never sees half a file.
    const tmp = join(targetDir, `.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmp, buffer);
    renameSync(tmp, target);

    const relativePath = segments.length ? `${segments.join("/")}/${filename}` : filename;
    return {
      status: existed ? "replaced" : "created",
      path: relativePath,
      url: `${this.config.resourceSiteUrl ?? "https://agent101.uk/resource"}/${relativePath}`,
      size: buffer.length,
      updated_at: new Date().toISOString(),
    };
  }
}
