// Trading script 0.8.30 — Torn's opened bazaar listing (markup captured live 2026-11-26): the
// price is React's `$${price}`, i.e. TWO text nodes, and the quantity box opens holding 1. The
// box must fill with the max you can afford on open, and Max must work. jsdom; no network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");
const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));

function bazaarPage() {
  const html = `<span id="user-money" data-money="3252745">$3,252,745</span>
<div data-testid="bazaar-items"><div data-testid="bazaar-items-row"><div data-testid="row-items">
<div data-testid="item"><div data-testid="buy-menu"><div><p><span data-testid="buy-item-name">ATM Key</span><span data-testid="buy-item-price" id="pp"></span><span data-testid="buy-item-amount">(1412 in stock)</span></p></div>
<div><input type="text" value="1" id="qty"><button>Buy</button></div></div></div></div></div></div>`;
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://www.torn.com/bazaar.php?userId=1#/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const pp = w.document.getElementById("pp");
  pp.append(w.document.createTextNode("$"), w.document.createTextNode("212,000"));
  w.GM_getValue = (k, d) => d;
  w.GM_setValue = () => {};
  w.GM_xmlhttpRequest = (o) => setTimeout(() => o.onload({ status: 200, responseText: "{}" }), 0);
  w.eval(SOURCE);
  return w;
}

test("bazaar: a split $-price still fills the box with the max on open, and Max works", async () => {
  const w = bazaarPage();
  await tick(1200);
  const doc = w.document;
  const qty = doc.getElementById("qty");
  assert.equal(qty.value, "15", "3,252,745 / 212,000 → 15 (Torn's default 1 is replaced)");
  assert.match(doc.querySelector(".totr-maxline").textContent, /max · \$3,180,000 total/);
  const btn = doc.querySelector(".totr-max");
  assert.ok(btn, "Max is placed");
  assert.notEqual(btn.tagName, "BUTTON", "not a <button> — Torn turns those into its ? icon there");
  qty.value = "2";
  btn.click();
  assert.equal(qty.value, "15");
  assert.equal(btn.textContent, "Max");
  w.close();
});
