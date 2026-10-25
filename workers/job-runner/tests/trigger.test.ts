import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequest, resolveConfig, resolveWebhookConfig, triggerOnce } from "../src/trigger.js";

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

describe("resolveWebhookConfig", () => {
  it("prefers the database config per field, falls back to env", () => {
    const db = { url: "https://db.example/hook", token: "db-token", payload: '{"prompt":"db"}' };
    const cfg = resolveWebhookConfig(ENV, db);
    assert.equal(cfg.url, "https://db.example/hook");
    assert.equal(cfg.token, "db-token");
    assert.equal(cfg.payload, '{"prompt":"db"}');
    const mixed = resolveWebhookConfig(ENV, { url: "https://db.example/hook", token: "", payload: null });
    assert.equal(mixed.url, "https://db.example/hook");
    assert.equal(mixed.token, "crsr_test_token");
    assert.equal(mixed.payload, null);
    const envOnly = resolveWebhookConfig(ENV, null);
    assert.equal(envOnly.url, ENV.CURSOR_WEBHOOK_URL);
    assert.equal(envOnly.payload, null);
  });
  it("throws when neither source has the values", () => {
    assert.throws(() => resolveWebhookConfig({}, null), /missing webhook config/);
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
  it("carries prompt in the body when set, omits it when blank", () => {
    const withPrompt = buildRequest(
      { ...resolveConfig(ENV), prompt: "run the news brief" },
      new Date("2026-10-24T02:00:00.000Z"),
    );
    assert.equal(
      (JSON.parse(withPrompt.body) as { prompt: string }).prompt,
      "run the news brief",
    );
    const blank = buildRequest(
      { ...resolveConfig(ENV), prompt: "   " },
      new Date("2026-10-24T02:00:00.000Z"),
    );
    assert.equal("prompt" in JSON.parse(blank.body), false);
    const unset = buildRequest(resolveConfig(ENV), new Date("2026-10-24T02:00:00.000Z"));
    assert.equal("prompt" in JSON.parse(unset.body), false);
  });
  it("payload template is the body verbatim (placeholders replaced), prompt ignored", () => {
    const req = buildRequest(
      {
        ...resolveConfig(ENV),
        prompt: "ignored when payload is set",
        payload: JSON.stringify({ prompt: "template prompt", at: "{{triggered_at}}", from: "{{source}}", other: "{{unknown}}" }),
      },
      new Date("2026-10-24T02:00:00.000Z"),
    );
    assert.deepEqual(JSON.parse(req.body), {
      prompt: "template prompt",
      at: "2026-10-24T02:00:00.000Z",
      from: "data-pipeline/cursor-trigger",
      other: "{{unknown}}",
    });
  });
  it("payload template must be valid JSON and an object", () => {
    const now = new Date("2026-10-24T02:00:00.000Z");
    assert.throws(
      () => buildRequest({ ...resolveConfig(ENV), payload: "{not json" }, now),
      /not valid JSON/,
    );
    assert.throws(
      () => buildRequest({ ...resolveConfig(ENV), payload: '["array"]' }, now),
      /must be a JSON object/,
    );
    // Blank template falls back to the built-in body shape.
    const blank = buildRequest({ ...resolveConfig(ENV), payload: "   " }, now);
    assert.equal((JSON.parse(blank.body) as { source: string }).source, "data-pipeline/cursor-trigger");
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
