import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveLogFile, setupFileLogging } from "../src/log.js";

describe("resolveLogFile", () => {
  it("defaults to <root>/logs/<service>.log", () => {
    assert.equal(resolveLogFile("data-cleaner", {}, "/repo"), "/repo/logs/data-cleaner.log");
  });
  it("honors an absolute LOG_DIR", () => {
    assert.equal(resolveLogFile("data-cleaner", { LOG_DIR: "/var/log/dp" }, "/repo"), "/var/log/dp/data-cleaner.log");
  });
  it("resolves a relative LOG_DIR against the repo root", () => {
    assert.equal(resolveLogFile("data-cleaner", { LOG_DIR: "logs" }, "/repo"), "/repo/logs/data-cleaner.log");
  });
  it("honors a per-service file name override", () => {
    assert.equal(
      resolveLogFile("data-cleaner", { LOG_DIR: "/x", DATA_CLEANER_LOG_FILE: "cleaner.log" }, "/repo"),
      "/x/cleaner.log",
    );
  });
});

describe("setupFileLogging", () => {
  const dir = mkdtempSync(join(tmpdir(), "logtest-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("tees console output into the log file", async () => {
    const lines: string[] = [];
    const fake = {
      log: (...args: unknown[]) => lines.push(args.join(" ")),
      info: (...args: unknown[]) => lines.push(args.join(" ")),
      warn: (...args: unknown[]) => lines.push(args.join(" ")),
      error: (...args: unknown[]) => lines.push(args.join(" ")),
    };
    const file = setupFileLogging("svc", { LOG_DIR: dir }, fake as never);
    assert.ok(file && existsSync(file));
    fake.log("hello", "file-log");
    await new Promise((r) => setTimeout(r, 50));
    const content = readFileSync(file!, "utf8");
    assert.match(content, /hello file-log/);
    assert.match(content, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(lines, ["hello file-log"]);
  });
});
