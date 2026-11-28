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

function page(url, html, answer, { hold = false, gmExtra = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const gm = new Map([["totr_torn_key", "KEYAAAAAAAAAAAAA"], ["totr_session_token", "sess"], ["totr_sell_mode", "market"], ["totr_strip_height", 168], ...gmExtra]);
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

test("Add page: the last Jemmy is kept; the keep 1 switch lists it; Show chips filter rows", async () => {
  const { doc, gm } = page("https://www.torn.com/bazaar.php#/add", ADD_HTML, addAnswer);
  await tick(400);
  const [jemmy, weight] = doc.querySelectorAll("li");
  // 0.8.25: keep 1 and the colour squares sit under the item name, not in the price row.
  const under = jemmy.querySelector(".name-wrap .totr-under");
  assert.ok(under, "keep 1 line under the name");
  assert.match(under.textContent, /keep 1 · not listed/);
  assert.equal(under.querySelectorAll(".totr-sq--oc, .totr-sq--crime").length, 2);
  assert.doesNotMatch(jemmy.textContent, /Crime tool|List anyway/);
  // FILL ALL: the Jemmy stays empty, the Paper Weight is filled.
  [...doc.querySelectorAll("#totr-hlinks button")].find((b) => b.textContent === "FILL ALL").click();
  await tick(250);
  assert.equal(jemmy.querySelector("input[name='amount']").value, "");
  assert.equal(weight.querySelector("input[name='amount']").value, "4");
  // Switching keep 1 off strikes it through, is saved per item, and Fill then lists the last one.
  jemmy.querySelector(".totr-keep").click();
  const off = jemmy.querySelector(".totr-keep");
  assert.ok(off.classList.contains("totr-keep--off"));
  assert.equal(off.textContent, "keep 1");
  assert.deepEqual([...gm.get("totr_keep_off")], [568]);
  [...jemmy.querySelectorAll("button")].find((b) => b.textContent.startsWith("Fill")).click();
  await tick(250);
  assert.equal(jemmy.querySelector("input[name='amount']").value, "1");
  // Clicking again turns it back on.
  jemmy.querySelector(".totr-keep").click();
  assert.deepEqual([...gm.get("totr_keep_off")], []);
  assert.ok(!jemmy.querySelector(".totr-keep").classList.contains("totr-keep--off"));
  // Show: the chips carry the colour key; No use hides the Jemmy row.
  const bar = doc.getElementById("totr-usebar");
  assert.ok(bar);
  assert.ok(bar.querySelector(".totr-sq--crime"), "the key's colour squares are on the chips");
  [...bar.querySelectorAll("button")].find((b) => b.textContent.startsWith("No use")).click();
  assert.equal(jemmy.style.display, "none");
  assert.equal(weight.style.display, "");
  [...doc.getElementById("totr-usebar").querySelectorAll("button")].find((b) => b.textContent === "All").click();
  assert.equal(jemmy.style.display, "");
});

const MANAGE_HTML = `<div><span>Manage your Bazaar</span></div><ul>
  <li class="row___a"><img src="/images/items/568/small.png"><div class="name"><span>Jemmy</span></div><div class="details"></div><div class="rrp">$7,100</div><div><input placeholder="Price" class="input-money" value="7000"></div></li>
  <li class="row___b"><img src="/images/items/10/small.png"><div class="name"><span>Paper Weight</span></div><div class="details"></div><div class="rrp">$310</div><div><input placeholder="Price" class="input-money" value="350"></div></li>
</ul>`;

test("Manage (0.8.25, 0.8.36): a price that already matches hides Fill; an off price turns the $ red", async () => {
  const { doc } = page("https://www.torn.com/bazaar.php#/manage", MANAGE_HTML, addAnswer, { gmExtra: [["totr_autofill", false]] });
  await tick(400);
  const [jemmy, weight] = doc.querySelectorAll("li");
  const fillOf = (li) => li.querySelector("[data-totr-fill]");
  const stateOf = (li) => li.querySelector("[data-totr-state]");
  assert.ok(fillOf(jemmy).hidden, "$7,000 listed = sell list: no Fill");
  assert.equal(stateOf(jemmy).textContent, "");
  assert.ok(!fillOf(weight).hidden, "$350 listed vs $300: Fill shows");
  assert.equal(stateOf(weight).textContent, "", "0.8.36: no status pill on Manage");
  const dollarOf = (li) => li.querySelector(".totr-dollar");
  assert.ok(dollarOf(weight).classList.contains("totr-dollar--alert"), "$350 vs $300: the $ is red");
  assert.match(dollarOf(weight).title, /17% over/);
  assert.ok(!dollarOf(jemmy).classList.contains("totr-dollar--alert"));
  // The use squares replace the words on the muted line.
  assert.ok(jemmy.querySelector(".totr-bz-sub .totr-sq--crime"));
  assert.doesNotMatch(jemmy.querySelector(".totr-bz-sub").textContent, /crime tool/);
  // Filling the Paper Weight makes it match: Fill and the pill go away.
  fillOf(weight).click();
  await tick(250);
  assert.equal(weight.querySelector("input").value, "300");
  assert.ok(fillOf(weight).hidden);
  assert.equal(stateOf(weight).textContent, "");
  assert.ok(!dollarOf(weight).classList.contains("totr-dollar--alert"), "fixed: the $ goes back to normal");
});

test("Manage $ popup (0.8.36): the issue and its fix, a trader paying more with a profile link and Remove from bazaar — no stray \"null\"", async () => {
  const html = MANAGE_HTML.replace('<div class="rrp">$310</div>', '<div class="rrp">$310</div><div><input class="remove" value=""></div>');
  const answer = (body) => {
    if (body.action === "price_check") {
      return { buyingNow: { w3bRows: [{ name: "w", playerId: 5, price: 320, isYou: false }], otherBuyers: [{ name: "Masime", playerId: null, price: 340, source: "te" }, { name: "Old", playerId: 9, price: 330, source: "overseer" }] } };
    }
    return addAnswer(body);
  };
  const { doc } = page("https://www.torn.com/bazaar.php#/manage", html, answer, { gmExtra: [["totr_autofill", false]] });
  await tick(400);
  const weight = doc.querySelectorAll("li")[1];
  weight.querySelector(".totr-dollar").click();
  await tick(50);
  const pop = doc.querySelector(".totr-pick-pop");
  assert.match(pop.querySelector(".totr-pick-issue").textContent, /Off your sell-list price/);
  const line = pop.querySelector(".totr-pick-trader");
  assert.ok(!line.hidden);
  assert.match(line.textContent, /Masime pays \$340 \(Torn Exchange\) — \$40 more than your sell price/);
  assert.doesNotMatch(line.textContent, /null/);
  // 0.8.41: no Torn id for the TE name → the name still links, to Torn's look-up-by-name profile.
  // Start trade needs the id, so it is not offered — but Remove from bazaar still is.
  assert.equal(line.querySelector("a[href*='profiles.php']").getAttribute("href"), "https://www.torn.com/profiles.php?NID=Masime");
  assert.equal(line.querySelector("a[href*='trade.php']"), null);
  const removeBtn = [...line.querySelectorAll("button")].find((b) => /Remove from bazaar/.test(b.textContent));
  removeBtn.click();
  assert.equal(weight.querySelector("input.remove").value, "1");
  assert.equal(doc.querySelector(".totr-pick-pop"), null, "the popup closes");
});

test("0.8.38: only changes in the page itself wake a pass — not the sidebar, chat, header or our own UI", () => {
  const { JSDOM } = require("jsdom");
  const tr = require("../Torn-Overseer-Trading-Beta.user.js");
  const dom = new JSDOM(`<body>
    <div id="header-root"><span id="clock">12:00</span></div>
    <div id="sidebarroot"><div class="bar"><p id="energy">150/150</p></div></div>
    <div id="chatRoot"><div class="msgs"><p id="msg">hi</p></div></div>
    <div id="mainContainer"><ul id="list"><li id="row" data-testid="item"><span id="chip" data-totr-ui="1">resell</span></li></ul></div>
    <div id="tocw"><b id="cw">chain</b></div>
  </body>`);
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal(tr.changeKind($("energy")), "noise");
  assert.equal(tr.changeKind($("msg")), "noise");
  assert.equal(tr.changeKind($("clock")), "noise");
  assert.equal(tr.changeKind($("chip")), "ours");
  assert.equal(tr.changeKind($("cw")), "ours");
  assert.equal(tr.changeKind($("row")), "page");
  assert.equal(tr.changeKind($("list")), "page");
  // The body itself (Torn swapping a whole region) and anything we can't place still count.
  assert.equal(tr.changeKind(dom.window.document.body), "page");
  assert.equal(tr.changeKind(null), "page");
  // A batch wakes a pass if ANY of its changes is in the page.
  assert.equal(tr.passWorthy([{ target: $("energy") }, { target: $("msg") }, { target: $("chip") }]), false);
  assert.equal(tr.passWorthy([{ target: $("energy") }, { target: $("row") }]), true);
  assert.equal(tr.passWorthy([]), false);
  dom.window.close();
});

test("Manage (0.8.51): auto-fill on open, green box, UNDO FILL, red box over the cheapest bazaar", async () => {
  const at = new Date(Date.now() - 10 * 60000).toISOString();
  const answer = (body) => {
    if (body.action === "sell_prices") {
      return { items: [
        { itemId: 568, sellAt: 7000, ruleLabel: "Default", uses: ["oc"], market: { cheapest: 7200, listings: 5, bazaarAverage: 7200, capturedAt: at } },
        { itemId: 10, sellAt: 300, ruleLabel: "Default", uses: ["none"], market: { cheapest: 280, listings: 5, bazaarAverage: 290, capturedAt: at } },
      ] };
    }
    return { items: [], watched: [], deals: [] };
  };
  const { doc, gm } = page("https://www.torn.com/bazaar.php#/manage", MANAGE_HTML, answer);
  await tick(400);
  const [jemmy, weight] = doc.querySelectorAll("li");
  const input = (li) => li.querySelector("input");
  assert.equal(input(weight).value, "300", "the off price was filled on open");
  assert.equal(input(jemmy).value, "7000", "already right: untouched");
  assert.equal(input(jemmy).dataset.totrPrice, undefined);
  // $300 is still over the $280 cheapest: red wins over green.
  assert.equal(input(weight).dataset.totrPrice, "over");
  assert.match(input(weight).title, /probably won't sell/);
  const undo = [...doc.querySelectorAll("#totr-hlinks button")].find((b) => /UNDO FILL 1/.test(b.textContent));
  assert.ok(undo, "UNDO FILL 1 in the header");
  undo.click();
  await tick(250);
  assert.equal(input(weight).value, "350", "undo puts the old price back");
  assert.ok(![...doc.querySelectorAll("#totr-hlinks button")].some((b) => /UNDO FILL/.test(b.textContent)));
  // The switch turns it off (saved).
  const sw = [...doc.querySelectorAll("#totr-hlinks button")].find((b) => /AUTO-FILL ON/.test(b.textContent));
  sw.click();
  await tick(100);
  assert.equal(gm.get("totr_autofill"), false);
  assert.ok([...doc.querySelectorAll("#totr-hlinks button")].some((b) => /AUTO-FILL OFF/.test(b.textContent)));
});
