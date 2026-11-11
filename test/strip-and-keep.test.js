// Trading script 0.8.14 (WO-93) — the item-market Bazaars strip keeps its height while it loads,
// shows 5 of up to 20 with "+N more", carries the item's use tag; and the bazaar Add page keeps
// one of an OC / crime item back. jsdom page, fake server; nothing touches the network.
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

function page(url, html, answer, { hold = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const gm = new Map([["totr_torn_key", "KEYAAAAAAAAAAAAA"], ["totr_session_token", "sess"], ["totr_sell_mode", "market"], ["totr_strip_height", 168]]);
  const calls = [];
  const held = [];
  w.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
  w.GM_setValue = (k, v) => gm.set(k, v);
  w.GM_xmlhttpRequest = (opts) => {
    calls.push(opts.url + (opts.data ? " " + opts.data : ""));
    const body = opts.data ? JSON.parse(opts.data) : {};
    const send = () => opts.onload({ status: 200, responseText: JSON.stringify(answer(body, opts.url)) });
    if (hold && body.action === "quote") held.push(send);
    else setTimeout(send, 0);
  };
  w.eval(SOURCE);
  return { w, doc: w.document, calls, gm, release: () => held.splice(0).forEach((f) => f()) };
}

const MARKET_HTML = "<div class='sellerListWrapper___x'><ul><li>Torn seller row <button>Buy</button></li></ul></div>";
const bazaars = Array.from({ length: 12 }, (_, i) => ({ playerId: 100 + i, name: `S${i}`, qty: 1, price: 350 + i }));
function marketAnswer(body) {
  if (body.action === "quote") return { items: [{ itemId: 568, name: "Jemmy", marketValue: 379, buyPrice: 345, bazaars, uses: ["oc", "crime"] }], errors: [] };
  return { items: [], watched: [], deals: [] };
}

test("strip: skeleton cards and the remembered height while the quote loads", async () => {
  const { doc, calls, release } = page("https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=568", MARKET_HTML, marketAnswer, { hold: true });
  await tick();
  const strip = doc.getElementById("totr-strip");
  assert.ok(strip, "strip placed in the seller list");
  assert.equal(strip.querySelectorAll(".totr-card--skel").length, 5);
  assert.equal(strip.style.minHeight, "168px");
  assert.match(strip.textContent, /Full page/);
  assert.match(strip.textContent, /Price check/);
  assert.ok(calls.some((c) => c.includes('"action":"quote"') && c.includes('"bazaarLimit":20')));
  release();
  await tick();
  assert.equal(strip.querySelectorAll(".totr-card--skel").length, 0);
  assert.equal(strip.style.minHeight, "");
});

test("strip: 5 of 12 with +7 more, the use tags, and Show fewer", async () => {
  const { doc } = page("https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=568", MARKET_HTML, marketAnswer);
  await tick(250);
  const strip = doc.getElementById("totr-strip");
  assert.equal(strip.querySelectorAll("a.totr-card, div.totr-card:not(.totr-card--skel)").length, 5);
  assert.match(strip.textContent, /cheapest bazaars 5 of 12/);
  assert.match(strip.textContent, /Used in OC/);
  assert.match(strip.textContent, /Crime tool/);
  const more = [...strip.querySelectorAll("button")].find((b) => b.textContent === "+7 more");
  assert.ok(more);
  more.click();
  const again = doc.getElementById("totr-strip");
  assert.equal(again.querySelectorAll("a.totr-card").length, 12);
  assert.ok([...again.querySelectorAll("button")].some((b) => b.textContent === "Show fewer"));
});

const ADD_HTML = `<div><span>Add items to your Bazaar</span></div><ul>
  <li class="row___a"><img src="/images/items/568/small.png"><span class="name-wrap">Jemmy</span><input name="amount"><input placeholder="Price" class="input-money"></li>
  <li class="row___b"><img src="/images/items/10/small.png"><span class="name-wrap">Paper Weight x 4</span><input name="amount"><input placeholder="Price" class="input-money"></li>
</ul>`;
function addAnswer(body) {
  if (body.action === "sell_prices") {
    return { items: [
      { itemId: 568, sellAt: 7000, ruleLabel: "Default", uses: ["oc", "crime"] },
      { itemId: 10, sellAt: 300, ruleLabel: "Default", uses: ["none"] },
    ] };
  }
  return { items: [], watched: [], deals: [] };
}

test("Add page: the last Jemmy is kept; List anyway lists it; Show chips filter rows", async () => {
  const { doc } = page("https://www.torn.com/bazaar.php#/add", ADD_HTML, addAnswer);
  await tick(400);
  const [jemmy, weight] = doc.querySelectorAll("li");
  assert.match(jemmy.textContent, /Keep 1 · not listed/);
  assert.match(jemmy.textContent, /Crime tool/);
  // FILL ALL: the Jemmy stays empty, the Paper Weight is filled.
  [...doc.querySelectorAll("#totr-hlinks button")].find((b) => b.textContent === "FILL ALL").click();
  await tick(250);
  assert.equal(jemmy.querySelector("input[name='amount']").value, "");
  assert.equal(weight.querySelector("input[name='amount']").value, "4");
  // List anyway is the explicit override.
  [...jemmy.querySelectorAll("button")].find((b) => b.textContent === "List anyway").click();
  await tick(250);
  assert.equal(jemmy.querySelector("input[name='amount']").value, "1");
  // Show: No use hides the Jemmy row.
  const bar = doc.getElementById("totr-usebar");
  assert.ok(bar);
  [...bar.querySelectorAll("button")].find((b) => b.textContent.startsWith("No use")).click();
  assert.equal(jemmy.style.display, "none");
  assert.equal(weight.style.display, "");
  [...doc.getElementById("totr-usebar").querySelectorAll("button")].find((b) => b.textContent === "All").click();
  assert.equal(jemmy.style.display, "");
});
