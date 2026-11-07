// v0.35.0 (WO-75): the panel docks as an "Overseer" bar above the Information block in
// Torn's sidebar; the pop-out button opens the full panel, whose Dock / ✕ put it back.
// No sidebar → the floating panel exactly as before.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const store = { tocw_torn_key: "test-key" };
global.GM_getValue = (k, f) => (k in store ? store[k] : f);
global.GM_setValue = (k, v) => { store[k] = v; };
global.GM_deleteValue = (k) => { delete store[k]; };

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const SIDEBAR = `<div id="sidebarroot"><div class="col">
  <div class="blk" id="info"><h2>Information</h2><div>Name: Someone</div></div>
  <div class="blk"><h2>Reminders</h2></div>
  <div class="blk"><h2>Areas</h2></div>
</div></div>`;

const dom = new JSDOM(`<!doctype html><html><head></head><body>${SIDEBAR}</body></html>`, {
  url: "https://www.torn.com/gym.php",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
// jsdom has no layout: give every element the sidebar's real width.
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 172, height: 100, left: 70, top: 0, right: 242, bottom: 100 };
};

const now = Date.now();
function reset() {
  cw.setDockMode("sidebar", { open: true });
  Object.assign(cw.state, {
    loading: false, error: null, notice: null, settingsOpen: false, focus: false, hidden: false, collapsed: false,
    tab: "chain", liveSource: "torn", chainConfirmedAt: Date.now(), chainSummary: null,
    chain: { active: true, current: 247, timeout: 221, fetchedAt: Date.now() },
    watch: {
      event: null, absences: [], viewer: { player_id: 1 },
      shifts: [
        { id: 1, shift_start: new Date(now - 3e5).toISOString(), shift_end: new Date(now + 3e6).toISOString(), watcher_id: 9, watcher_name: "Watcher", watcher_online_status: "Online" },
        { id: 2, shift_start: new Date(now + 3.3e6).toISOString(), shift_end: new Date(now + 6.9e6).toISOString(), watcher_id: 1, watcher_name: "Me", watcher_online_status: "Online" },
      ],
    },
  });
}

const box = () => document.getElementById("tocw");
const dock = () => document.getElementById("tocw-dock");
const click = (sel) => dock().querySelector(sel).click();

test("the bar mounts directly above Information and hides the floating panel", () => {
  reset();
  cw.render();
  assert.ok(dock(), "dock mounted");
  assert.equal(dock().nextElementSibling.id, "info");
  assert.equal(dock().querySelector(".tocw-d-name").textContent, "Overseer");
  assert.equal(box().style.display, "none");
  assert.equal(document.getElementById("tocw-launcher")?.style.display ?? "none", "none");
});

test("the chip and the expanded body show the live chain, the watcher and your shift", () => {
  reset();
  cw.render();
  assert.match(dock().querySelector("#tocw-d-chip").textContent, /^247 · /);
  const body = dock().querySelector(".tocw-d-body").textContent.replace(/\s+/g, " ");
  assert.match(body, /Hits\s*247 \/ 250/);
  assert.match(body, /Bonus in 3 hits/);
  assert.match(body, /On watch: Watcher/);
  assert.match(body, /Your shift:/);
});

test("the bar toggles open and closed", () => {
  reset();
  cw.render();
  click('[data-d="toggle"]');
  assert.equal(dock().querySelector(".tocw-d-body"), null);
  click('[data-d="toggle"]');
  assert.ok(dock().querySelector(".tocw-d-body"));
});

test("pop out shows the full panel with a Dock button; Dock and ✕ return to the sidebar", () => {
  reset();
  cw.render();
  click('[data-d="pop"]');
  assert.equal(box().style.display, "");
  assert.equal(dock().querySelector("#tocw-d-chip").textContent, "popped out");
  document.getElementById("tocw-dock-btn").click();
  assert.equal(box().style.display, "none");
  assert.ok(dock().querySelector(".tocw-d-body"), "docked open");
  click('[data-d="pop"]');
  document.getElementById("tocw-hide").click();
  assert.equal(box().style.display, "none");
  assert.equal(dock().querySelector(".tocw-d-body"), null, "✕ docks it collapsed");
  assert.equal(cw.state.hidden, false, "✕ never hides to the launcher while the bar is there");
});

test("no sidebar: not docked, the floating panel shows as before", () => {
  reset();
  document.getElementById("sidebarroot").remove();
  dock()?.remove();
  cw.render();
  assert.equal(cw.dockActive(), false);
  assert.equal(box().style.display, "");
});

// ---- v0.35.1: the Bank tab inline in the sidebar ------------------------------------

function bankReset(bank) {
  if (!document.getElementById("sidebarroot")) {
    document.body.insertAdjacentHTML("afterbegin", SIDEBAR);
    dock()?.remove();
  }
  reset();
  cw.state.chain = null;
  store.tocw_session_token = "sess";
  store.tocw_panel_mode = "session";
  cw.state.tab = "bank";
  cw.state.bank = {
    status: null, queue: null, loading: false, error: null, notice: null, loadedAt: Date.now(),
    amount: "", online: false, note: "", busy: false, seen: [], paidSeenAt: "1970-01-01T00:00:00Z",
    ...bank,
  };
}

const status = (extra = {}) => ({
  enabled: true, balance: 184250000, open: null, lastPaid: null,
  history: [{ id: 3, amount: 10000000, paid_amount: 10000000, status: "fulfilled", claimed_by_name: "Gliuck", source: "site", created_at: new Date(now - 2 * 86400e3).toISOString() }],
  bankers: { online: [{ name: "Gliuck", idle: false }, { name: "hyxeria", idle: true }], moreOnline: 0, lastOn: null },
  ...extra,
});

test("bank: a member without a request gets the form, balance, bankers on and recent", (t) => {
  bankReset({ status: status() });
  if (!cw.availableTabs().includes("bank")) return t.skip("no session in this harness");
  cw.render();
  const body = dock().querySelector(".tocw-d-body");
  assert.ok(body.querySelector("#tocw-d-bank-amount"), "amount box");
  assert.ok(body.querySelector('[data-d="bank-request"]'), "Request button");
  const text = body.textContent.replace(/\s+/g, " ");
  assert.match(text, /Vault balance\s*\$184,250,000/);
  assert.match(text, /Bankers on: Gliuck, hyxeria \(idle\)/);
  assert.match(text, /Recent/);
});

test("bank: quick amount and typing land in state; Request with no amount explains", (t) => {
  bankReset({ status: status() });
  if (!cw.availableTabs().includes("bank")) return t.skip("no session in this harness");
  cw.render();
  click('[data-d="bank-quick:50m"]');
  assert.equal(cw.state.bank.amount, "50m");
  assert.equal(dock().querySelector("#tocw-d-bank-amount").value, "50m");
  const note = dock().querySelector("#tocw-d-bank-note");
  note.value = "armor";
  note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(cw.state.bank.note, "armor");
  cw.state.bank.amount = "";
  cw.render();
  click('[data-d="bank-request"]');
  assert.match(dock().textContent, /Enter an amount/);
});

test("bank: a waiting request shows its amount, note and Cancel, and the chip says waiting", (t) => {
  bankReset({ status: status({ open: { id: 7, amount: 25000000, status: "open", claimedBy: null, createdAt: new Date(now - 240e3).toISOString(), mustBeOnline: true, note: "new armor" } }) });
  if (!cw.availableTabs().includes("bank")) return t.skip("no session in this harness");
  cw.render();
  const text = dock().querySelector(".tocw-d-body").textContent.replace(/\s+/g, " ");
  assert.match(text, /\$25,000,000/);
  assert.match(text, /WAITING/);
  assert.match(text, /new armor/);
  assert.ok(dock().querySelector('[data-d="bank-cancel"]'));
  assert.equal(dock().querySelector("#tocw-d-bank-amount"), null, "no form while a request is open");
  assert.equal(dock().querySelector("#tocw-d-chip").textContent, "waiting");
});

test("bank: a banker sees the queue with Claim / Give / Unclaim and their own form behind a button", (t) => {
  const reqs = [
    { id: 1, player_id: 5, player_name: "Peachesri", owed: 25000000, status: "claimed", claimed_by_me: true, give_url: "https://www.torn.com/factions.php?step=your#/tab=controls&giveMoneyTo=5&money=25000000", created_at: new Date(now - 360e3).toISOString(), source: "discord", online: true },
    { id: 2, player_id: 6, player_name: "Talak", owed: 8000000, status: "open", claimed_by_me: false, created_at: new Date(now - 120e3).toISOString(), source: "site", online: true, must_be_online: true },
    { id: 3, player_id: 7, player_name: "ynax", owed: 120000000, status: "open", claimed_by_me: false, balance_at_request: 90000000, created_at: new Date(now - 660e3).toISOString(), source: "discord", online: true },
  ];
  bankReset({ status: status(), queue: { canView: true, banker: true, linked: true, requests: reqs } });
  if (!cw.availableTabs().includes("bank")) return t.skip("no session in this harness");
  cw.render();
  const body = dock().querySelector(".tocw-d-body");
  assert.ok(body.querySelector('[data-d="bank-unclaim:1"]'));
  assert.match(body.querySelector("a.tocw-d-primary").textContent, /Give \$25,000,000/);
  assert.ok(body.querySelector('[data-d="bank-claim:2"]'));
  assert.match(body.textContent, /short/);
  assert.equal(body.querySelector("#tocw-d-bank-amount"), null, "own form folded away");
  click('[data-d="bank-form"]');
  assert.ok(dock().querySelector("#tocw-d-bank-amount"), "form after the button");
});
