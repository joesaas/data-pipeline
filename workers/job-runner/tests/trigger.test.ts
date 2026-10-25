import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequest, resolveWebhookConfig, triggerOnce } from "../src/trigger.js";

const ENV = {
  CURSOR_WEBHOOK_URL: "https://api2.cursor.sh/automations/webhook/test-id",
  CURSOR_AUTOMATION_TOKEN: "crsr_test_token",
};

// A resolved database-row config (the job always resolves from the row).
const BASE = resolveWebhookConfig({
  url: ENV.CURSOR_WEBHOOK_URL,
  token: ENV.CURSOR_AUTOMATION_TOKEN,
  payload: null,
});

describe("resolveWebhookConfig", () => {
  it("resolves the database row, trimming values", () => {
    const cfg = resolveWebhookConfig({
      url: "  https://db.example/hook  ",
      token: "  db-token  ",
      payload: '{"prompt":"db"}',
    });
    assert.equal(cfg.url, "https://db.example/hook");
    assert.equal(cfg.token, "db-token");
    assert.equal(cfg.payload, '{"prompt":"db"}');
  });
  it("throws when no row is scheduled, or the row lacks url/token", () => {
    assert.throws(() => resolveWebhookConfig(null), /no active webhook/);
    assert.throws(
      () => resolveWebhookConfig({ url: "  ", token: "tok", payload: null }),
      /no active webhook/,
    );
    assert.throws(
      () => resolveWebhookConfig({ url: "https://db.example/hook", token: "", payload: null }),
      /no active webhook/,
    );
  });
  it("rejects a placeholder token with non-ASCII characters", () => {
    assert.throws(
      () =>
        resolveWebhookConfig({
          url: "https://db.example/hook",
          token: "crsr_é",
          payload: null,
        }),
      /CURSOR_AUTOMATION_TOKEN is not a plain ASCII token/,
    );
  });
  it("rejects a malformed webhook URL", () => {
    assert.throws(
      () => resolveWebhookConfig({ url: "not a url", token: "tok", payload: null }),
      /CURSOR_WEBHOOK_URL is not a valid/,
    );
  });
});

describe("buildRequest", () => {
  it("builds a POST with Bearer auth and a JSON context body", () => {
    const req = buildRequest(BASE, new Date("2026-10-24T02:00:00.000Z"));
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
      { ...BASE, prompt: "run the news brief" },
      new Date("2026-10-24T02:00:00.000Z"),
    );
    assert.equal(
      (JSON.parse(withPrompt.body) as { prompt: string }).prompt,
      "run the news brief",
    );
    const blank = buildRequest(
      { ...BASE, prompt: "   " },
      new Date("2026-10-24T02:00:00.000Z"),
    );
    assert.equal("prompt" in JSON.parse(blank.body), false);
    const unset = buildRequest(BASE, new Date("2026-10-24T02:00:00.000Z"));
    assert.equal("prompt" in JSON.parse(unset.body), false);
  });
  it("payload template is the body verbatim (placeholders replaced), prompt ignored", () => {
    const req = buildRequest(
      {
        ...BASE,
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
  it("payload template precedence: override beats active beats single, then prompt", () => {
    const now = new Date("2026-10-24T02:00:00.000Z");
    const base = { ...BASE, prompt: "state prompt", payload: '{"k":"single"}' };
    const active = buildRequest({ ...base, activePayload: '{"k":"active"}' }, now);
    assert.equal((JSON.parse(active.body) as { k: string }).k, "active");
    const override = buildRequest(
      { ...base, activePayload: '{"k":"active"}', payloadOverride: '{"k":"override"}' },
      now,
    );
    assert.equal((JSON.parse(override.body) as { k: string }).k, "override");
    const single = buildRequest(base, now);
    assert.equal((JSON.parse(single.body) as { k: string }).k, "single");
    // Blank override/active fall through to the next layer.
    const fall = buildRequest({ ...base, activePayload: "  ", payloadOverride: "" }, now);
    assert.equal((JSON.parse(fall.body) as { k: string }).k, "single");
  });
  it("plain-text template is sent verbatim as text/plain, placeholders substituted", () => {
    const now = new Date("2026-10-24T02:00:00.000Z");
    const req = buildRequest(
      { ...BASE, payload: "do the thing at {{triggered_at}} from {{source}}" },
      now,
    );
    assert.equal(req.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.equal(req.body, "do the thing at 2026-10-24T02:00:00.000Z from data-pipeline/cursor-trigger");
    // A JSON array is not an object, so it is text too, not an error.
    const arr = buildRequest({ ...BASE, payload: '["array"]' }, now);
    assert.equal(arr.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.equal(arr.body, '["array"]');
    // Blank template falls back to the built-in body shape.
    const blank = buildRequest({ ...BASE, payload: "   " }, now);
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
    const result = await triggerOnce(BASE, new Date(), fake as never);
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(seen!.url, ENV.CURSOR_WEBHOOK_URL);
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer crsr_test_token");
  });
  it("throws with the status on a non-2xx response, never leaking the token", async () => {
    const fake = async () => ({ ok: false, status: 401, text: async () => "unauthenticated" });
    await assert.rejects(
      () => triggerOnce(BASE, new Date(), fake as never),
      (err: Error) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes("crsr_test_token"));
        return true;
      },
    );
  });
});
