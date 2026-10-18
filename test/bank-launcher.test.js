// v0.30.2 — bank alerts on the TO launcher: count badge, pulse until seen, paid tick.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

// A userscript-manager store, so the panel has a session (the Bank tab needs one).
const gm = new Map();
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://www.torn.com/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });

const req = (id, status = "open") => ({ id, status, amount: 1000000, owed: 1000000, player_id: id, player_name: `P${id}` });

function bank(o = {}) {
  return {
    status: { enabled: true, balance: 1, open: null, lastPaid: null, history: [] },
    queue: { canView: true, banker: true, linked: true, requests: [] },
    loading: false, error: null, notice: null, loadedAt: Date.now(), amount: "", online: false, busy: false,
    seen: [], paidSeenAt: "2026-10-01T00:00:00Z",
    ...o,
  };
}

function launcher() {
  document.body.innerHTML = "";
  cw.createLauncher();
  return document.getElementById("tocw-launcher");
}

test("bankAlert: counts open requests only, fresh = not yet seen", () => {
  const b = bank({ queue: { canView: true, requests: [req(1), req(2), req(3, "claimed")] }, seen: [1] });
  assert.deepEqual(cw.bankAlert(b), { count: 2, fresh: 1, paid: false });
});

test("bankAlert: paid only when the last payment is newer than the one looked at", () => {
  const b = bank({ status: { enabled: true, lastPaid: { amount: 5, at: "2026-10-18T10:00:00Z" } } });
  assert.equal(cw.bankAlert(b).paid, true);
  b.paidSeenAt = "2026-10-18T10:00:00Z";
  assert.equal(cw.bankAlert(b).paid, false);
  b.paidSeenAt = ""; // no baseline yet: never tick
  assert.equal(cw.bankAlert(b).paid, false);
});

test("noteBankStatus sets the baseline once, from the existing last payment", () => {
  const b = bank({ paidSeenAt: "", status: { enabled: true, lastPaid: { amount: 5, at: "2026-10-02T00:00:00Z" } } });
  cw.noteBankStatus(b);
  assert.equal(b.paidSeenAt, "2026-10-02T00:00:00Z");
  b.status.lastPaid.at = "2026-10-03T00:00:00Z";
  cw.noteBankStatus(b);
  assert.equal(b.paidSeenAt, "2026-10-02T00:00:00Z", "baseline is not moved by later reads");
  assert.equal(cw.bankAlert(b).paid, true);

  const none = bank({ paidSeenAt: "", status: { enabled: true, lastPaid: null } });
  cw.noteBankStatus(none);
  assert.ok(none.paidSeenAt, "a member never paid still gets a baseline, so the first payment ticks");
});

test("markBankSeen keeps only open ids and catches up the paid time", () => {
  const b = bank({
    queue: { canView: true, requests: [req(4), req(5), req(6, "claimed")] },
    seen: [1, 4],
    status: { enabled: true, lastPaid: { amount: 5, at: "2026-10-18T10:00:00Z" } },
  });
  assert.equal(cw.markBankSeen(b), true);
  assert.deepEqual(b.seen, [4, 5]);
  assert.equal(b.paidSeenAt, "2026-10-18T10:00:00Z");
  assert.deepEqual(cw.bankAlert(b), { count: 2, fresh: 0, paid: false });
  assert.equal(cw.markBankSeen(b), false, "nothing new: no write");
});

test("launcher: plain when there's no session", () => {
  gm.clear();
  cw.state.bank = bank({ queue: { canView: true, requests: [req(1)] } });
  const el = launcher();
  const badge = el.querySelector(".tocw-l-badge");
  assert.equal(badge.className, "tocw-l-badge");
  assert.ok(!el.classList.contains("tocw-l-pulse"));
  assert.equal(el.getAttribute("aria-label"), "Open Torn Overseer");
});

test("launcher: count + pulse for unseen requests, pulse stops once seen", () => {
  gm.clear();
  gm.set("tocw_session_token", "sess");
  cw.state.bank = bank({ queue: { canView: true, requests: [req(1), req(2)] } });
  const el = launcher();
  const badge = el.querySelector(".tocw-l-badge");
  assert.equal(badge.textContent, "2");
  assert.ok(badge.classList.contains("on"));
  assert.ok(el.classList.contains("tocw-l-pulse"));
  assert.match(el.getAttribute("aria-label"), /2 bank requests waiting/);

  cw.markBankSeen(cw.state.bank);
  cw.updateLauncher();
  assert.equal(badge.textContent, "2", "the count stays while requests are open");
  assert.ok(!el.classList.contains("tocw-l-pulse"));
  assert.deepEqual(gm.get("tocw_bank_seen"), [1, 2], "seen ids persist");
});

test("launcher: green tick when your request was paid, count wins over the tick", () => {
  gm.clear();
  gm.set("tocw_session_token", "sess");
  cw.state.bank = bank({ queue: null, status: { enabled: true, lastPaid: { amount: 5, at: "2026-10-18T10:00:00Z" } } });
  const el = launcher();
  const badge = el.querySelector(".tocw-l-badge");
  assert.equal(badge.textContent, "✓");
  assert.ok(badge.classList.contains("paid"));
  assert.ok(el.classList.contains("tocw-l-pulse-paid"));
  assert.match(el.getAttribute("aria-label"), /was paid/);

  cw.state.bank.queue = { canView: true, requests: [req(7)] };
  cw.updateLauncher();
  assert.equal(badge.textContent, "1");
  assert.ok(!badge.classList.contains("paid"));

  cw.state.bank.queue = { canView: true, requests: Array.from({ length: 12 }, (_, i) => req(i + 10)) };
  cw.updateLauncher();
  assert.equal(badge.textContent, "9+");
});

test("Bank tab count still matches the launcher", () => {
  gm.clear();
  gm.set("tocw_session_token", "sess");
  cw.state.bank = bank({ queue: { canView: true, requests: [req(1), req(2), req(3, "claimed")] } });
  assert.equal(cw.bankOpenRequests(cw.state.bank).length, 2);
});

test("tapping a badged launcher opens the panel on the Bank tab and stops the pulse", () => {
  gm.clear();
  gm.set("tocw_session_token", "sess");
  Object.assign(cw.state, { hidden: true, collapsed: false, settingsOpen: false, focus: false, tab: "chain", watch: null });
  cw.state.bank = bank({ queue: { canView: true, requests: [req(1)] } });
  const el = launcher();
  cw.render();
  assert.ok(el.classList.contains("tocw-l-pulse"));
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(cw.state.hidden, false);
  assert.equal(cw.activeTab(), "bank");
  assert.ok(!el.classList.contains("tocw-l-pulse"), "the Bank tab on screen marks it seen");
  assert.equal(el.style.display, "none", "launcher hides while the panel is open");
});
