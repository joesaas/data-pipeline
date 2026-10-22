import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawRecord } from "@data-pipeline/shared";
import { createLlmProvider, MockProvider, OpenAiCompatibleProvider } from "../src/providers.js";

function record(content: string): RawRecord {
  return {
    id: "r1", external_id: null, title: "简报", prompt: "p", content,
    content_format: "markdown", content_hash: "h", source_agent: "test",
    skill_version: null, tags: [], metadata: {}, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z",
  };
}

const BRIEF = `## A. Web3 DeFi

### 1. Solana 升级 Alpenglow
Solana 主网切换新共识。来源：[Solana](https://solana.com/upgrades)

### 2. Aave 提交 V3.8
Aave 提出重入加固提案。

## B. AI Agent

### 1. 某框架发布 2.0
发布了新版本。`;

describe("MockProvider", () => {
  it("splits a brief into items with categories and sources", async () => {
    const items = await new MockProvider().clean(record(BRIEF));
    assert.equal(items.length, 3);
    assert.equal(items[0].title, "Solana 升级 Alpenglow");
    assert.equal(items[0].category, "Web3 DeFi");
    assert.equal(items[0].sources[0].url, "https://solana.com/upgrades");
    assert.equal(items[2].category, "AI Agent");
  });
  it("falls back to one item when there are no headings", async () => {
    const items = await new MockProvider().clean(record("一段没有标题的正文内容。"));
    assert.equal(items.length, 1);
  });
});

describe("createLlmProvider", () => {
  it("returns mock without a key, openai-compatible with one", () => {
    assert.equal(createLlmProvider({}).name, "mock");
    assert.equal(createLlmProvider({ LLM_API_KEY: "k" }).name, "openai-compatible");
  });
});

describe("OpenAiCompatibleProvider", () => {
  it("parses items from a chat completion", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items":[{"title":"T","summary":"S","category":"AI Agent","importance":"high"}]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }, fakeFetch as typeof fetch);
    const items = await provider.clean(record("正文"), "系统提示词");
    assert.equal(items.length, 1);
    assert.equal(items[0].importance, "high");
  });
  it("retries once when the endpoint errors", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("bad request", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[{"title":"T","summary":"S"}]}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }, fakeFetch as typeof fetch);
    const items = await provider.clean(record("正文"), "系统提示词");
    assert.equal(calls, 2);
    assert.equal(items.length, 1);
  });
});
