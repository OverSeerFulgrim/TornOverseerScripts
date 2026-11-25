// v0.36.1 — a War Room that says no (403/401) is not asked again every second.
// Before: a refused peek never stamped a time, so the 1s loop re-asked at once; one
// install made 64,000 refused calls in 15 hours (2026-11-21). Fake server, no network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const gm = new Map([["tocw_session_token", "sess"], ["tocw_torn_key", "key"]]);
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

let calls = 0;
let answer = { status: 403, body: { error: "Couldn't confirm you're still in the faction. Try again in a minute." } };
global.GM_xmlhttpRequest = (opts) => {
  if (String(opts.url).endsWith("/war-room")) calls++;
  setTimeout(() => opts.onload({ status: answer.status, responseText: JSON.stringify(answer.body) }), 0);
};

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://www.torn.com/factions.php",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(() => {
  Object.assign(cw.state.war, cw.freshWarState());
  calls = 0;
  answer = { status: 403, body: { error: "Couldn't confirm you're still in the faction. Try again in a minute." } };
});

test("a refused peek stops the loop asking for 10 minutes", async () => {
  await cw.warPoll({ peek: true });
  assert.equal(calls, 1);
  assert.ok(cw.state.war.blockedUntil - Date.now() > 9 * 60000, "backs off ~10 minutes");
  for (let i = 0; i < 5; i++) {
    cw.warLoop();
    await tick();
  }
  await cw.warPoll({ peek: true });
  assert.equal(calls, 1, "nothing more asked while refused");
});

test("any failed poll waits its turn instead of retrying every second", async () => {
  answer = { status: 500, body: { error: "The War Room could not load." } };
  await cw.warPoll({ peek: true });
  assert.equal(calls, 1);
  assert.equal(cw.state.war.blockedUntil, 0, "a 5xx is not a refusal");
  assert.ok(cw.state.war.triedAt > 0);
  for (let i = 0; i < 5; i++) {
    cw.warLoop();
    await tick();
  }
  assert.equal(calls, 1, "the 1s loop waits out the peek interval after a failure too");
});

test("a good peek still works and clears nothing it shouldn't", async () => {
  answer = { status: 200, body: { room: null, isCommand: false } };
  await cw.warPoll({ peek: true });
  assert.equal(calls, 1);
  assert.equal(cw.state.war.blockedUntil, 0);
  assert.ok(cw.state.war.peekAt > 0);
});
