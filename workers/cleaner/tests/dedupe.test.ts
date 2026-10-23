import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CleanedItem } from "@data-pipeline/shared";
import { dedupeItems, normalizeTitle, normalizeUrl } from "../src/dedupe.js";

function item(title: string, urls: string[] = []): CleanedItem {
  return {
    title,
    summary: "s",
    category: "Web3 DeFi",
    tags: [],
    event_date: null,
    sources: urls.map((url) => ({ name: "src", url })),
  };
}

describe("normalizeTitle", () => {
  it("folds case, spaces and punctuation", () => {
    assert.equal(normalizeTitle("Aave Proposes V3.8 Upgrade!"), normalizeTitle("aave proposes v3.8 upgrade"));
    assert.equal(normalizeTitle("Uniswap 上线 Aggregator Hooks"), normalizeTitle("Uniswap 上线Aggregator Hooks"));
  });
});

describe("normalizeUrl", () => {
  it("strips utm params, fragments and trailing slashes", () => {
    assert.equal(
      normalizeUrl("https://Example.com/post/?utm_source=x#top"),
      normalizeUrl("https://example.com/post"),
    );
  });
});

describe("dedupeItems", () => {
  const existing = [{ title: "Aave proposes V3.8 upgrade", sourceUrls: ["https://blog.aave.com/v38"] }];

  it("drops a title match against another record's item", () => {
    const { kept, dropped } = dedupeItems([item("Aave proposes V3.8 upgrade!")], existing);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /title matches/);
  });

  it("drops a source-url match even with a different title", () => {
    const { kept, dropped } = dedupeItems(
      [item("Aave 提出 V3.8 升级", ["https://blog.aave.com/v38?utm_medium=x"])],
      existing,
    );
    assert.equal(kept.length, 0);
    assert.match(dropped[0].reason, /source url/);
  });

  it("keeps genuinely different items and dedupes within the batch", () => {
    const { kept, dropped } = dedupeItems(
      [item("Solana Alpenglow goes live"), item("Solana Alpenglow goes live"), item("Pendle expands looping")],
      existing,
    );
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 1);
  });

  it("never title-matches very short titles", () => {
    const { kept } = dedupeItems([item("v2 发布")], [{ title: "v2 发布", sourceUrls: [] }]);
    assert.equal(kept.length, 1);
  });
});
