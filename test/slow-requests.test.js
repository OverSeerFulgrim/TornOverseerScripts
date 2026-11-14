// Trading script 0.8.18 — lost or slow calls (Xnappum, 2026-11-12: "Timed out calling …/trader-script
// — retrying shortly" on his bazaar). Reads give up after 10 s and ask once more straight away,
// every call is pinned to the database's region, and your bazaar page shows the last sell-list
// prices it saw while Overseer doesn't answer — but won't type ones over 10 minutes old.
// jsdom page, fake server; nothing touches the network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const tr = require("../Torn-Overseer-Trading-Beta.user.js");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");
const windows = [];
test.afterEach(async () => {
  await new Promise((r) => setTimeout(r, 1100));
  while (windows.length) windows.pop().close();
});
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers ---------------------------------------------------------------------------

test("isTimeoutError: only our own timeout message", () => {
  assert.equal(tr.isTimeoutError(new Error("Timed out calling https://x/functions/v1/trader-script")), true);
  assert.equal(tr.isTimeoutError(new Error("Network error calling https://x")), false);
  assert.equal(tr.isTimeoutError(Object.assign(new Error("Server error"), { status: 500 })), false);
  assert.equal(tr.isTimeoutError(null), false);
});

test("withRegion: Overseer functions get x-region, other hosts don't", () => {
  const h = { a: "1" };
  assert.deepEqual(tr.withRegion("https://ijolgywtybadfuvyopeg.supabase.co/functions/v1/trader-script", h), { a: "1", "x-region": "us-west-2" });
  assert.equal(tr.withRegion("https://api.torn.com/v2/user", h), h);
  assert.equal(tr.withRegion("https://tornexchange.com/api", h), h);
});

test("RETRY_READS: reads only — nothing that writes is sent twice", () => {
  for (const a of ["sell_prices", "quote", "price_check", "deals"]) assert.ok(tr.RETRY_READS.has(a), a);
  for (const a of ["fill_event", "record_receipt", "create_w3b_receipt", "stock_snapshot", "sell_mode"]) assert.ok(!tr.RETRY_READS.has(a), a);
});

test("sellCachePut / sellCacheGet: newest wins, capped, a day at most, marked cached", () => {
  let c = tr.sellCachePut({}, [{ itemId: 1, sellAt: 10 }, { itemId: 2, sellAt: 20 }], 1000);
  c = tr.sellCachePut(c, [{ itemId: 1, sellAt: 11 }, { itemId: 0, sellAt: 5 }, null], 2000);
  assert.deepEqual(Object.keys(c).sort(), ["1", "2"]);
  assert.equal(c[1].item.sellAt, 11);
  const got = tr.sellCacheGet(c, [1, 2, 3], 5000);
  assert.equal(got.size, 2);
  assert.equal(got.get(1).cachedAt, 2000);
  assert.equal(got.get(1).sellAt, 11);
  assert.equal(tr.sellCacheGet(c, [1], 2000 + 24 * 3600000 + 1).size, 0, "over a day old is dropped");
  // cap: the oldest go first
  const capped = tr.sellCachePut(c, [{ itemId: 3, sellAt: 30 }], 3000, 2);
  assert.deepEqual(Object.keys(capped).sort(), ["1", "3"]);
  assert.equal(tr.sellCacheGet(null, [1], 0).size, 0);
});

test("canFillFrom: fresh always, cached for 10 minutes, never without a price", () => {
  const now = 10_000_000;
  assert.equal(tr.canFillFrom({ sellAt: 5 }, now), true);
  assert.equal(tr.canFillFrom({ sellAt: 5, cachedAt: now - tr.SELL_CACHE_FILL_MS }, now), true);
  assert.equal(tr.canFillFrom({ sellAt: 5, cachedAt: now - tr.SELL_CACHE_FILL_MS - 1 }, now), false);
  assert.equal(tr.canFillFrom({ sellAt: null }, now), false);
  assert.equal(tr.canFillFrom(null, now), false);
});

// ---- in a page --------------------------------------------------------------------------------

/**
 * `lose(body, n)`: return true to drop the n-th call of that action — the fake manager then
 * fires ontimeout after a moment (the real one would after `timeout` ms).
 */
function page(url, html, answer, { lose = () => false, gmExtra = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const gm = new Map([["totr_torn_key", "KEYAAAAAAAAAAAAA"], ["totr_session_token", "sess"], ["totr_sell_mode", "market"], ...gmExtra]);
  const calls = [];
  const seen = new Map();
  w.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
  w.GM_setValue = (k, v) => gm.set(k, v);
  w.GM_xmlhttpRequest = (opts) => {
    const body = opts.data ? JSON.parse(opts.data) : {};
    const n = (seen.get(body.action) || 0) + 1;
    seen.set(body.action, n);
    calls.push({ action: body.action, timeout: opts.timeout, region: opts.headers && opts.headers["x-region"] });
    if (lose(body, n)) { setTimeout(() => opts.ontimeout(), 20); return; }
    setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify(answer(body)) }), 0);
  };
  w.eval(SOURCE);
  return { w, doc: w.document, calls, gm };
}

const MARKET_URL = "https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=568";
const MARKET_HTML = "<div class='sellerListWrapper___x'><ul><li>Torn seller row <button>Buy</button></li></ul></div>";
const bazaars = Array.from({ length: 3 }, (_, i) => ({ playerId: 100 + i, name: `S${i}`, qty: 1, price: 350 + i }));
function marketAnswer(body) {
  if (body.action === "quote") return { items: [{ itemId: 568, name: "Jemmy", marketValue: 379, buyPrice: null, bazaars, uses: [] }], errors: [] };
  return { items: [], watched: [], deals: [] };
}

test("a lost read is asked again at once (10 s, then 20 s), pinned to us-west-2", async () => {
  const { doc, calls } = page(MARKET_URL, MARKET_HTML, marketAnswer, { lose: (b, n) => b.action === "quote" && b.bazaars !== false && n === 1 });
  await tick(300);
  const strip = doc.getElementById("totr-strip");
  assert.equal(strip.querySelectorAll("a.totr-card").length, 3, "the strip filled in from the second try");
  assert.doesNotMatch(strip.textContent, /Retry|Timed out/);
  const quotes = calls.filter((c) => c.action === "quote");
  assert.equal(quotes[0].timeout, 10000);
  assert.equal(quotes[1].timeout, 20000);
  assert.ok(calls.every((c) => c.region === "us-west-2"), "every Overseer call carries x-region");
});

const MANAGE_URL = "https://www.torn.com/bazaar.php#/manage";
const MANAGE_HTML = `<div><span>Manage your Bazaar</span></div><ul>
  <li class="row___a"><img src="/images/items/568/small.png"><span class="name-wrap">Jemmy x 3</span><input placeholder="Price" class="input-money"></li>
</ul>`;
function manageAnswer(body) {
  if (body.action === "sell_prices") return { items: [{ itemId: 568, sellAt: 7000, ruleLabel: "Default", uses: [] }] };
  return { items: [], watched: [], deals: [] };
}
const cacheAt = (ageMs) => ["totr_sell_cache", { 568: { at: Date.now() - ageMs, item: { itemId: 568, sellAt: 6500, ruleLabel: "Default", uses: [] } } }];
const loseSell = (b) => b.action === "sell_prices";

test("bazaar: when sell_prices is lost twice, the last prices show, labelled, and still fill", async () => {
  const { doc, calls } = page(MANAGE_URL, MANAGE_HTML, manageAnswer, { lose: loseSell, gmExtra: [cacheAt(3 * 60000)] });
  await tick(400);
  assert.equal(calls.filter((c) => c.action === "sell_prices").length, 2, "one quick retry, then the pause");
  const fill = [...doc.querySelectorAll("li button")].find((b) => /^Fill /.test(b.textContent));
  assert.ok(fill, "Fill shown from the cache");
  assert.equal(fill.textContent, "Fill $6,500");
  assert.equal(fill.disabled, false);
  assert.match(fill.title, /Last loaded 3m ago/);
  assert.match(doc.getElementById("totr-bzline").textContent, /showing prices from 3m ago, refreshing…/);
  fill.click();
  await tick(250);
  assert.equal(doc.querySelector("li input.input-money").value.replace(/[^0-9]/g, ""), "6500");
});

test("bazaar: cached prices over 10 minutes old are shown but never typed", async () => {
  const { doc } = page(MANAGE_URL, MANAGE_HTML, manageAnswer, { lose: loseSell, gmExtra: [cacheAt(30 * 60000)] });
  await tick(400);
  const fill = [...doc.querySelectorAll("li button")].find((b) => /^Fill /.test(b.textContent));
  assert.ok(fill);
  assert.equal(fill.disabled, true);
  assert.match(fill.title, /Too old to fill/);
  // FIX N OFF TARGET goes through the same guard.
  const input = doc.querySelector("li input.input-money");
  for (const b of doc.querySelectorAll("#totr-hlinks button")) b.click();
  await tick(250);
  assert.equal(input.value, "");
});

test("bazaar: a fresh answer saves to the cache and replaces cached prices", async () => {
  const { doc, gm } = page(MANAGE_URL, MANAGE_HTML, manageAnswer, { gmExtra: [cacheAt(3 * 60000)] });
  await tick(400);
  const fill = [...doc.querySelectorAll("li button")].find((b) => /^Fill /.test(b.textContent));
  assert.equal(fill.textContent, "Fill $7,000");
  assert.doesNotMatch(doc.getElementById("totr-bzline")?.textContent || "", /showing prices from/);
  assert.equal(gm.get("totr_sell_cache")[568].item.sellAt, 7000);
});
