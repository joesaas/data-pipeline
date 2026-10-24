import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRecordsClient } from "../src/client.js";

function fakeFetch(calls: { url: string; init?: RequestInit }[]) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
    };
  };
}

describe("createRecordsClient", () => {
  it("sends no auth header when no API key is configured", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createRecordsClient("https://example.test/dp", fakeFetch(calls) as never);
    await client.fetchSince(null, 10);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init, undefined);
  });

  it("sends X-API-Key when a key is configured (admin reader for auth-on mode)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createRecordsClient("https://example.test/dp", fakeFetch(calls) as never, "secret-key");
    await client.fetchSince(null, 10);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].init?.headers, { "X-API-Key": "secret-key" });
    assert.match(calls[0].url, /order=updated_asc/);
  });
});
