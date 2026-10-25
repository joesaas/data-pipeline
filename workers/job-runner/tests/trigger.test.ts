import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequest, resolveConfig, triggerOnce } from "../src/trigger.js";

const ENV = {
  CURSOR_WEBHOOK_URL: "https://api2.cursor.sh/automations/webhook/test-id",
  CURSOR_AUTOMATION_TOKEN: "crsr_test_token",
};

describe("resolveConfig", () => {
  it("defaults the interval to 60 minutes", () => {
    assert.equal(resolveConfig(ENV).intervalMinutes, 60);
  });
  it("honors CURSOR_TRIGGER_INTERVAL_MINUTES and clamps to >= 1", () => {
    assert.equal(resolveConfig({ ...ENV, CURSOR_TRIGGER_INTERVAL_MINUTES: "15" }).intervalMinutes, 15);
    assert.equal(resolveConfig({ ...ENV, CURSOR_TRIGGER_INTERVAL_MINUTES: "0" }).intervalMinutes, 60);
  });
  it("throws naming the missing variables, without any values", () => {
    assert.throws(() => resolveConfig({}), /CURSOR_WEBHOOK_URL.*CURSOR_AUTOMATION_TOKEN/);
    assert.throws(() => resolveConfig({ CURSOR_WEBHOOK_URL: ENV.CURSOR_WEBHOOK_URL }), /CURSOR_AUTOMATION_TOKEN/);
  });
  it("rejects a placeholder token with non-ASCII characters", () => {
    assert.throws(
      () => resolveConfig({ ...ENV, CURSOR_AUTOMATION_TOKEN: "<crsr_ placeholder>" }),
      /CURSOR_AUTOMATION_TOKEN is not a plain ASCII token/,
    );
  });
  it("rejects a malformed webhook URL", () => {
    assert.throws(() => resolveConfig({ ...ENV, CURSOR_WEBHOOK_URL: "not a url" }), /CURSOR_WEBHOOK_URL is not a valid/);
  });
});

describe("buildRequest", () => {
  it("builds a POST with Bearer auth and a JSON context body", () => {
    const req = buildRequest(resolveConfig(ENV), new Date("2026-10-24T02:00:00.000Z"));
    assert.equal(req.url, ENV.CURSOR_WEBHOOK_URL);
    assert.equal(req.method, "POST");
    assert.equal(req.headers.Authorization, "Bearer crsr_test_token");
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(req.body), {
      source: "data-pipeline/cursor-trigger",
      triggered_at: "2026-10-24T02:00:00.000Z",
    });
  });
});

describe("triggerOnce", () => {
  it("returns ok on a 2xx response and sends the built request", async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;
    const fake = async (url: string, init: Record<string, unknown>) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => "" };
    };
    const result = await triggerOnce(resolveConfig(ENV), new Date(), fake as never);
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(seen!.url, ENV.CURSOR_WEBHOOK_URL);
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer crsr_test_token");
  });
  it("throws with the status on a non-2xx response, never leaking the token", async () => {
    const fake = async () => ({ ok: false, status: 401, text: async () => "unauthenticated" });
    await assert.rejects(
      () => triggerOnce(resolveConfig(ENV), new Date(), fake as never),
      (err: Error) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes("crsr_test_token"));
        return true;
      },
    );
  });
});
