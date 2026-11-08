// Trading script 0.8.0 (WO-66) — deal alerts: the Overseer eye in Torn's Information icons,
// the "$" button while there are new deals, the panel, and the locked panel for a
// non-subscriber. The script runs in a jsdom page with GM_xmlhttpRequest answered by a fake
// server; nothing touches the network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const windows = [];
test.afterEach(async () => {
  await new Promise((r) => setTimeout(r, 1100)); // let the 1 s debounced re-scan run before closing
  while (windows.length) windows.pop().close();
});

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");

const DEALS = {
  watched: [{ itemId: 206, name: "Xanax", buyPrice: 800000 }, { itemId: 186, name: "Lion Plushie", buyPrice: 56000 }],
  deals: [{ itemId: 206, name: "Xanax", buyPrice: 800000, price: 774000, sellerId: 9, sellerName: "A", qtyUnder: 4, listingsUnder: 1, underPct: 3.3 }],
  checked: 2,
  checkedAt: new Date().toISOString(),
};

function page({ status = 200, body = DEALS, url = "https://www.torn.com/gym.php" } = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id='sidebar'><ul class='status-icons___abc'><li></li><li></li></ul></div></body></html>",
    { url, runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  windows.push(w);
  const gm = new Map([["totr_torn_key", "KEYAAAAAAAAAAAAA"], ["totr_session_token", "sess"]]);
  const calls = [];
  w.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
  w.GM_setValue = (k, v) => gm.set(k, v);
  w.GM_xmlhttpRequest = (opts) => {
    calls.push(opts.url + (opts.data ? " " + opts.data : ""));
    const isTorn = opts.url.startsWith("https://api.torn.com/");
    const cheapest = opts.url.includes("/market/186/") ? 55000 : 900000;
    const payload = isTorn ? { itemmarket: { listings: [{ price: cheapest, amount: 2 }] } } : body;
    setTimeout(() => opts.onload({ status: isTorn ? 200 : status, responseText: JSON.stringify(payload) }), 0);
  };
  w.eval(SOURCE);
  return { w, doc: w.document, calls };
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("a subscriber gets the eye with a count and the $ button on any page", async () => {
  const { doc, calls } = page();
  await tick();
  const eye = doc.getElementById("totr-eye");
  assert.ok(eye, "eye added to the Information icons");
  assert.equal(eye.parentElement.className, "status-icons___abc");
  // One bazaar deal from the server + one item-market deal read with the player's key.
  assert.equal(eye.querySelector(".totr-badge").textContent, "2");
  assert.equal(doc.getElementById("totr-fab").querySelector(".totr-badge").textContent, "2");
  assert.ok(calls.some((c) => c.includes("trader-script") && c.includes('"action":"deals"')));
  assert.ok(calls.some((c) => c.startsWith("https://api.torn.com/v2/market/")));
  // Gym is not a trading page: no strips, no Price check.
  assert.equal(doc.getElementById("totr-strip"), null);
});

test("opening the panel lists the deals and clears the count", async () => {
  const { doc } = page();
  await tick();
  doc.querySelector("#totr-eye button").click();
  await tick();
  const sheet = doc.getElementById("totr-sheet");
  assert.ok(sheet);
  const cards = sheet.querySelectorAll(".totr-deal-card");
  assert.equal(cards.length, 2);
  assert.match(sheet.textContent, /Lion Plushie/);
  assert.match(sheet.textContent, /Xanax/);
  assert.equal(doc.querySelector("#totr-eye .totr-badge"), null);
  assert.equal(doc.getElementById("totr-fab"), null);
});

test("the panel's ↻ asks the server again right away, inside the poll window (0.8.4)", async () => {
  const { doc, calls } = page();
  await tick();
  doc.querySelector("#totr-eye button").click();
  await tick();
  const before = calls.filter((c) => c.includes('"action":"deals"')).length;
  assert.equal(before, 1, "opening inside the poll window does not re-ask");
  const btn = doc.querySelector("#totr-sheet .totr-sheet-refresh");
  assert.ok(btn, "refresh button in the panel header");
  assert.equal(btn.getAttribute("aria-label"), "Check now");
  btn.click();
  // Re-rendered while busy: the button is disabled and says so.
  const spinning = doc.querySelector("#totr-sheet .totr-sheet-refresh");
  assert.ok(spinning.hasAttribute("disabled"));
  await tick();
  assert.equal(calls.filter((c) => c.includes('"action":"deals"')).length, before + 1);
  assert.ok(!doc.querySelector("#totr-sheet .totr-sheet-refresh").hasAttribute("disabled"));
  assert.match(doc.querySelector("#totr-sheet .totr-sheet-foot").textContent, /Checked/);
});

test("a non-subscriber gets only the eye, opening a locked panel", async () => {
  const { doc, calls } = page({ status: 402, body: { error: "Trading needs a subscription." } });
  await tick();
  assert.ok(doc.getElementById("totr-eye"));
  assert.equal(doc.querySelector("#totr-eye .totr-badge"), null);
  assert.equal(doc.getElementById("totr-fab"), null);
  assert.ok(!calls.some((c) => c.startsWith("https://api.torn.com/")), "no item-market reads when locked");
  doc.querySelector("#totr-eye button").click();
  await tick();
  const sheet = doc.getElementById("totr-sheet");
  assert.match(sheet.textContent, /Why it's separate from your faction/);
  assert.match(sheet.textContent, /Get Trading/);
  assert.equal(sheet.querySelector(".totr-sheet-refresh"), null, "no refresh on the locked panel");
});

test("a page load inside the poll window reuses the cached deals", async () => {
  const first = page();
  await tick();
  const cache = first.w.localStorage.getItem("totr_alerts_v1");
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><ul class='status-icons___abc'></ul></body></html>",
    { url: "https://www.torn.com/city.php", runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  windows.push(w);
  w.localStorage.setItem("totr_alerts_v1", cache);
  const calls = [];
  w.GM_getValue = (k, d) => (k === "totr_torn_key" ? "KEYAAAAAAAAAAAAA" : k === "totr_session_token" ? "sess" : d);
  w.GM_setValue = () => {};
  w.GM_xmlhttpRequest = (opts) => calls.push(opts.url);
  w.eval(SOURCE);
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(w.document.querySelector("#totr-eye .totr-badge").textContent, "2");
});

test("no Torn key: nothing is drawn and nothing is asked", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><ul class='status-icons___abc'></ul></body></html>", {
    url: "https://www.torn.com/gym.php", runScripts: "outside-only",
  });
  const w = dom.window;
  windows.push(w);
  const calls = [];
  w.GM_getValue = (k, d) => d;
  w.GM_setValue = () => {};
  w.GM_xmlhttpRequest = (opts) => calls.push(opts.url);
  w.eval(SOURCE);
  await tick();
  assert.equal(w.document.getElementById("totr-eye"), null);
  assert.equal(calls.length, 0);
});

test("0.8.1: finds the Information icons by their heading when the class name differs", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id='sidebarroot'><div class='block___x'><h2 class='header___y'>Information</h2>"
    + "<div class='content___z'><ul class='icons___q'><li class='icon1___a'><a href='#'></a></li><li class='icon2___a'><a href='#'></a></li><li class='icon3___a'><a href='#'></a></li></ul>"
    + "<ul class='other'><li>Name: x</li></ul></div></div></div></body></html>",
    { url: "https://www.torn.com/profiles.php?XID=1", runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  windows.push(w);
  w.GM_getValue = (k, d) => (k === "totr_torn_key" ? "KEYAAAAAAAAAAAAA" : k === "totr_session_token" ? "sess" : d);
  w.GM_setValue = () => {};
  w.GM_xmlhttpRequest = (opts) => setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify({ watched: [], deals: [] }) }), 0);
  w.eval(SOURCE);
  await tick();
  const eye = w.document.getElementById("totr-eye");
  assert.ok(eye, "eye added");
  assert.equal(eye.parentElement.className, "icons___q");
});

test("0.8.2: the eye comes back when the sidebar loads late or Torn redraws it", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id='sidebarroot'></div></body></html>", {
    url: "https://www.torn.com/index.php", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  windows.push(w);
  w.GM_getValue = (k, d) => (k === "totr_torn_key" ? "KEYAAAAAAAAAAAAA" : k === "totr_session_token" ? "sess" : d);
  w.GM_setValue = () => {};
  w.GM_xmlhttpRequest = (opts) => setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify({ watched: [], deals: [] }) }), 0);
  w.eval(SOURCE);
  await tick();
  assert.equal(w.document.getElementById("totr-eye"), null, "no sidebar yet");
  // The sidebar arrives, then gets replaced wholesale (a React redraw).
  w.document.getElementById("sidebarroot").innerHTML = "<ul class='status-icons___n'><li></li><li></li></ul>";
  await tick(2300);
  assert.ok(w.document.getElementById("totr-eye"), "eye added once the sidebar exists");
  w.document.getElementById("sidebarroot").innerHTML = "<ul class='status-icons___n'><li></li><li></li></ul>";
  await tick(2300);
  assert.ok(w.document.getElementById("totr-eye"), "eye put back after the redraw");
});
