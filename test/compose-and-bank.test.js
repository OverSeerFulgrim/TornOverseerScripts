// Compose fill (the site's "Open in Torn" warning fill) and the Bank tab.
// v0.34.0 (WO-74) removed the Leadership tab, its pill, the Send/Resume hand-off
// and the compose-page template picker; this file keeps the tests for what stayed
// and pins that leaders no longer get the tab.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://www.torn.com/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });

const html = () => document.getElementById("tocw")?.innerHTML ?? "";

function reset(viewer) {
  Object.assign(cw.state, {
    loading: false, error: null, notice: null,
    watch: viewer ? { event: null, shifts: [], absences: [], viewer } : null,
    signup: null, chain: null, attacks: null,
    liveSource: null, settingsOpen: false, focus: false, hidden: false, collapsed: false,
    chainConfirmedAt: null, scheduleConfirmedAt: Date.now(),
    tornRoster: null, rosterAt: null, slotAction: null, scheduleOpen: false,
    tornFailCount: 0, chainSummary: null,
    tab: "chain",
  });
}

const TOKEN = "3f1c2b8e-1d2a-4c1b-9a7e-123456789abc.Ab-_x9yz";

test("parseOvwToken reads the draft id after XID, and rejects junk", () => {
  assert.equal(cw.parseOvwToken(`#/p=compose&XID=4340722&ovw=${TOKEN}`), TOKEN);
  assert.equal(cw.parseOvwToken(`#/p=compose&ovw=${encodeURIComponent(TOKEN)}&XID=1`), TOKEN);
  assert.equal(cw.parseOvwToken("#/p=compose&XID=1"), null);
  assert.equal(cw.parseOvwToken("#/p=compose&XID=1&ovw=short"), null);
  assert.equal(cw.parseOvwToken("#/p=compose&ovw=%3Cscript%3Ealert(1)%3C%2Fscript%3Exxxxx"), null);
  assert.equal(cw.parseOvwToken("#/p=compose&ovw=%E0%A4%A"), null);
  assert.equal(cw.parseOvwToken(undefined), null);
});

test("stripOvw removes only the draft id", () => {
  assert.equal(cw.stripOvw(`#/p=compose&XID=4340722&ovw=${TOKEN}`), "#/p=compose&XID=4340722");
  assert.equal(cw.stripOvw(`#/p=compose&ovw=${TOKEN}&XID=1`), "#/p=compose&XID=1");
  assert.equal(cw.stripOvw("#/p=compose&XID=1"), "#/p=compose&XID=1");
});

test("recipientMatches needs the exact [id]", () => {
  assert.equal(cw.recipientMatches("callihan [4340722]", 4340722), true);
  assert.equal(cw.recipientMatches("Fulgrim2 [1737122]", 4340722), false);
  assert.equal(cw.recipientMatches("x [43407220]", 4340722), false);
  assert.equal(cw.recipientMatches("", 1), false);
});

test("bodyLines keeps blank lines (paragraph breaks)", () => {
  assert.deepEqual(cw.bodyLines("Hi\r\n\n• a"), ["Hi", "", "• a"]);
});

test("agoText", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(cw.agoText("2026-10-10T11:59:40Z", now), "just now");
  assert.equal(cw.agoText("2026-10-10T11:56:00Z", now), "4m ago");
  assert.equal(cw.agoText("2026-10-10T09:00:00Z", now), "3h ago");
  assert.equal(cw.agoText("2026-10-04T12:00:00Z", now), "6d ago");
  assert.equal(cw.agoText("nope", now), "");
});

test("no Leadership tab or pill, even for leaders (WO-74)", () => {
  for (const viewer of [{ player_id: 1, can_lead: false }, { player_id: 1, can_manage: true, can_lead: true }]) {
    reset(viewer);
    cw.render();
    assert.ok(!html().includes("READ-ONLY"));
    assert.ok(!html().includes("LEADERSHIP"));
    assert.ok(!html().includes('data-tocw-tab="leadership"'));
  }
});

test("a remembered leadership tab falls back to chain", () => {
  reset({ player_id: 1, can_lead: true });
  cw.state.tab = "leadership";
  assert.equal(cw.activeTab(), "chain");
});

test("fillEditor writes text as paragraphs, never HTML (fallback path)", () => {
  document.body.innerHTML = '<div id="ed" contenteditable="true"><p>old</p></div>';
  const ed = document.getElementById("ed");
  // jsdom has no execCommand, so this exercises the fallback the script uses when
  // the editor ignores it.
  if (typeof document.execCommand !== "function") document.execCommand = () => false;
  cw.fillEditor(ed, "Hi <img src=x onerror=alert(1)>\n\n• No login");
  assert.equal(ed.querySelectorAll("p").length, 3);
  assert.equal(ed.querySelector("img"), null, "markup in the text stays text");
  assert.ok(ed.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.ok(ed.textContent.includes("• No login"));
});

test("setNativeValue sets the input and fires input/change", () => {
  document.body.innerHTML = '<input name="subject">';
  const input = document.querySelector("input");
  const seen = [];
  input.addEventListener("input", () => seen.push("input"));
  input.addEventListener("change", () => seen.push("change"));
  cw.setNativeValue(input, "Grim Reapers II: activity reminder");
  assert.equal(input.value, "Grim Reapers II: activity reminder");
  assert.deepEqual(seen, ["input", "change"]);
});

// ---- v0.29.0: Bank tab + compose picker ------------------------------------------

// ---- Bank tab ------------------------------------------------------------------

test("tabs: Chain for everyone; leaders get no extra tab", () => {
  reset({ player_id: 1, can_lead: false });
  assert.deepEqual(cw.availableTabs(), ["chain"]);
  reset({ player_id: 1, can_lead: true });
  assert.deepEqual(cw.availableTabs(), ["chain"]);
});

test("money formats whole dollars", () => {
  assert.equal(cw.money(25000000), "$25,000,000");
  assert.equal(cw.money("x"), "—");
});

function bankState(o = {}) {
  cw.state.bank = { status: null, queue: null, loading: false, error: null, notice: null, loadedAt: Date.now(), amount: "", online: false, busy: false, ...o };
}

test("bank tab: off when the faction hasn't turned banking on", () => {
  reset({ player_id: 1, can_lead: false });
  bankState({ status: { enabled: false, balance: null, open: null, lastPaid: null } });
  assert.ok(cw.renderBankTab().includes("hasn't turned on banking"));
});

test("bank tab: form when nothing is open; card with Cancel when it is", () => {
  reset({ player_id: 1, can_lead: false });
  bankState({ status: { enabled: true, balance: 184250000, open: null, lastPaid: null, history: [] } });
  let out = cw.renderBankTab();
  assert.ok(out.includes("$184,250,000"));
  assert.ok(out.includes('id="tocw-bank-request"'));
  assert.ok(out.includes("Only send while I'm online"));

  bankState({ status: { enabled: true, balance: 1, open: { id: 9, amount: 25000000, status: "open", mustBeOnline: true }, lastPaid: null, history: [
    { id: 1, amount: 40000000, paid_amount: 40000000, status: "fulfilled", claimed_by_name: "<i>FarmerJack</i>", source: "discord", created_at: new Date().toISOString() },
  ] } });
  out = cw.renderBankTab();
  assert.ok(out.includes('id="tocw-bank-cancel"'));
  assert.ok(out.includes("only while you're online"));
  assert.ok(out.includes("My recent requests"));
  assert.ok(out.includes("&lt;i&gt;FarmerJack&lt;/i&gt;"), "names are escaped");
  assert.ok(!out.includes('id="tocw-bank-request"'));
});

test("bank queue: hidden without access; Claim only for bankers; give link only for the claimer", () => {
  reset({ player_id: 1737122, can_lead: true });
  bankState({ queue: { canView: false, banker: false, requests: [] } });
  assert.equal(cw.renderBankQueue(), "");

  const rows = [
    { id: 1, player_id: 7, player_name: "turdmuffins", owed: 25000000, status: "open", online: true, must_be_online: true, source: "site", created_at: new Date().toISOString(), balance_at_request: 184250000, claimed_by_me: false, give_url: null },
    { id: 2, player_id: 8, player_name: "Pot", owed: 80000000, status: "open", online: false, must_be_online: true, source: "discord", created_at: new Date().toISOString(), balance_at_request: 41000000, claimed_by_me: false, give_url: null },
    { id: 3, player_id: 9, player_name: "JumpHigher", owed: 10000000, status: "claimed", claimed_by_name: "Kierano", online: true, must_be_online: false, source: "site", created_at: new Date().toISOString(), balance_at_request: null, claimed_by_me: false, give_url: null },
    { id: 4, player_id: 10, player_name: "Hex0r", owed: 5000000, status: "claimed", claimed_by_name: "Fulgrim2", online: true, must_be_online: false, source: "site", created_at: new Date().toISOString(), balance_at_request: null, claimed_by_me: true, give_url: "https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&giveMoneyTo=10&money=5000000" },
  ];
  bankState({ queue: { canView: true, banker: false, linked: true, requests: rows } });
  let out = cw.renderBankQueue();
  assert.ok(!out.includes("data-tocw-bank-claim"), "leadership without the banker role can't claim");
  assert.ok(out.includes("View only"));

  bankState({ queue: { canView: true, banker: true, linked: true, requests: rows } });
  out = cw.renderBankQueue();
  assert.ok(out.includes('data-tocw-bank-claim="1"'));
  assert.ok(out.includes('data-tocw-bank-claim="2"'));
  assert.ok(!out.includes('data-tocw-bank-claim="3"'));
  assert.ok(out.includes("Claimed by Kierano"));
  assert.ok(out.includes("short"), "Pot asked for more than their balance");
  assert.ok(out.includes("giveMoneyTo=10&amp;money=5000000"));
  assert.ok(out.includes("Give $5,000,000 on Torn"));
});
