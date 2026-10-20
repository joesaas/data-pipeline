#!/usr/bin/env node
/**
 * pipe-push sender: assemble the payload, obtain auth headers (adapter model),
 * POST to the data-pipeline API, print the result. Deterministic work lives
 * here, not in model-generated code.
 *
 * Usage:
 *   node push.mjs --prompt "<the user's prompt>" --content-file <path> [--title T]
 *                 [--external-id ID] [--format markdown|text|html|json]
 *                 [--tags a,b] [--source claude-code]
 * Content can also come from stdin when --content-file is "-".
 *
 * Config (env):
 *   DATA_PIPELINE_BASE_URL   default https://agent101.uk/data-pipeline
 *   DATA_PIPELINE_API_KEY    used when no adapter is configured
 *   DATA_PIPELINE_ADAPTER    path to a credential adapter executable
 *                            (stdin/stdout JSON: {} -> {"headers": {...}})
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function readContent(file) {
  if (!file) throw new Error("--content-file is required (use - for stdin)");
  if (file === "-") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFileSync(file, "utf8");
}

function adapterHeaders() {
  const adapter = process.env.DATA_PIPELINE_ADAPTER;
  if (!adapter) return {};
  const raw = execFileSync(adapter, [], { input: "{}", encoding: "utf8" });
  const parsed = JSON.parse(raw);
  return parsed.headers ?? {};
}

const args = parseArgs(process.argv.slice(2));
if (!args.prompt) {
  console.error(JSON.stringify({ ok: false, error: "--prompt is required" }));
  process.exit(2);
}

const content = await readContent(args["content-file"]);
const base = (process.env.DATA_PIPELINE_BASE_URL ?? "https://agent101.uk/data-pipeline").replace(/\/$/, "");

const headers = { "content-type": "application/json", ...adapterHeaders() };
if (!headers["x-api-key"] && process.env.DATA_PIPELINE_API_KEY) {
  headers["x-api-key"] = process.env.DATA_PIPELINE_API_KEY;
}

const payload = {
  schema_version: 1,
  prompt: args.prompt,
  content,
  content_format: args.format ?? "markdown",
  source_agent: args.source ?? "other",
  skill_version: "0.1.0",
};
if (args.title) payload.title = args.title;
if (args["external-id"]) payload.external_id = args["external-id"];
if (args.tags) payload.tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean);

const res = await fetch(`${base}/api/v1/records`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(JSON.stringify({ ok: false, http_status: res.status, ...body }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, ...body }));
