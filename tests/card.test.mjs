import assert from "node:assert/strict";
import test from "node:test";
import { fakeHass, loadCard } from "./harness.mjs";

const card = loadCard(new URL("../sentinel-banner-card.js", import.meta.url).pathname);
const matchesFilter = card.evaluate("matchesFilter");

test("registers new and legacy element names", () => {
  for (const tag of ["sentinel-banner-card", "sentinel-banner-card-editor", "k93-ans-banner-card", "k93-ans-banner-card-editor"]) {
    assert.ok(card.defined.has(tag), tag);
  }
  assert.equal(card.context.window.customCards[0].type, "sentinel-banner-card");
});

test("filters by channel and per-channel labels", () => {
  const record = { channel: "security", channels: ["security"], labels: ["front_door"], importance: "normal" };
  const other = { ...record, labels: ["garage"] };
  const filter = { channels: ["security"], mode: "include", channelLabels: { security: ["front_door"] } };
  assert.ok(matchesFilter(record, filter));
  assert.ok(!matchesFilter(other, filter));
  assert.ok(matchesFilter(other, { channels: ["security"], mode: "include" }));
  assert.ok(!matchesFilter(record, { channels: ["security"], mode: "exclude" }));
  assert.ok(!matchesFilter({ ...record, show_in_history: false }, {}));
  assert.ok(!matchesFilter(record, { minImportance: "high" }));
});

test("falls back to the legacy k93_ans websocket prefix", async () => {
  card.evaluate("wsPrefix = null");
  const api = new (card.evaluate("SentinelApi"))();
  api.hass = fakeHass((msg) => {
    if (msg.type.startsWith("sentinel/")) throw { code: "unknown_command" };
    return { notifications: [] };
  });
  await api.call("list", { limit: 1 });
  assert.deepEqual(api.hass.calls, ["sentinel/list", "k93_ans/list"]);
  assert.ok(api.legacy);
  await api.call("list");
  assert.equal(api.hass.calls.at(-1), "k93_ans/list");
});
