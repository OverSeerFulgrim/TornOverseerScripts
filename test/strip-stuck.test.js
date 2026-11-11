// Trading script 0.8.15 — the item-market Bazaars strip can no longer sit on its loading cards
// for good (Xnappum, 2026-11-11: "keeps loading on desktop, content doesn't appear"): a quote that
// never answers turns into "taking longer than usual… Retry", and a copy of the strip left in a
// second seller list (a node Torn cloned or a list it replaced) is removed.
// jsdom page, fake server; nothing touches the network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");
const windows = [];
test.afterEach(async () => {
  await new Promise((r) => setTimeout(r, 1100));
  while (windows.length) windows.pop().close();
});
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const URL = "https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=568";
const LIST = "<div class='sellerListWrapper___x'><ul><li>Torn seller row <button>Buy</button></li></ul></div>";
const bazaars = Array.from({ length: 3 }, (_, i) => ({ playerId: 100 + i, name: `S${i}`, qty: 1, price: 350 + i }));

/** `dropFirstQuote`: the first strip quote never gets any callback (a stalled script manager). */
function page({ dropFirstQuote = false, holdQuote = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id='root'>${LIST}</div></body></html>`, { url: URL, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const gm = new Map([["totr_session_token", "sess"], ["totr_sell_mode", "market"]]);
  let quotes = 0;
  const held = [];
  w.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
  w.GM_setValue = (k, v) => gm.set(k, v);
  w.GM_xmlhttpRequest = (opts) => {
    const body = opts.data ? JSON.parse(opts.data) : {};
    const quote = body.action === "quote" && body.bazaars !== false;
    const answer = quote
      ? { items: [{ itemId: 568, name: "Jemmy", marketValue: 379, buyPrice: null, bazaars, uses: [] }], errors: [] }
      : { items: [], watched: [], deals: [] };
    const send = () => opts.onload({ status: 200, responseText: JSON.stringify(answer) });
    if (quote && dropFirstQuote && ++quotes === 1) return;
    if (quote && holdQuote) held.push(send);
    else setTimeout(send, 0);
  };
  w.eval(SOURCE);
  return { doc: w.document, quotes: () => quotes, release: () => held.splice(0).forEach((f) => f()) };
}

test("strip: a quote that never answers offers Retry, and Retry loads it", async () => {
  const { doc } = page({ dropFirstQuote: true });
  await tick();
  const strip = doc.getElementById("totr-strip");
  assert.equal(strip.querySelectorAll(".totr-card--skel").length, 5);
  assert.doesNotMatch(strip.textContent, /Retry/);
  await tick(8200);
  assert.match(strip.textContent, /taking longer than usual/);
  const retry = [...strip.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  assert.ok(retry, "Retry is offered");
  retry.click();
  await tick(250);
  assert.equal(strip.querySelectorAll(".totr-card--skel").length, 0);
  assert.equal(strip.querySelectorAll("a.totr-card").length, 3);
});

test("strip: a loading copy left in a second seller list is removed, the shown one fills in", async () => {
  const { doc, release } = page({ holdQuote: true });
  await tick();
  const first = doc.getElementById("totr-strip");
  assert.equal(first.querySelectorAll(".totr-card--skel").length, 5);
  // Torn swaps in a new list carrying a clone of the loading strip; the old list stays in the page.
  const root = doc.getElementById("root");
  const fresh = root.firstElementChild.cloneNode(true);
  root.append(fresh);
  assert.equal(doc.querySelectorAll("#totr-strip").length, 2);
  release();
  await tick(400);
  const strips = doc.querySelectorAll("#totr-strip");
  assert.equal(strips.length, 1, "one strip left");
  assert.equal(strips[0].querySelectorAll(".totr-card--skel").length, 0);
  assert.equal(strips[0].querySelectorAll("a.totr-card").length, 3);
});
