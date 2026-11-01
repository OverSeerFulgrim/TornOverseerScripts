// v0.30.3 — bankers can unclaim a request they claimed.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const gm = new Map();
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

// Required BEFORE the DOM exists: with no window the script exports instead of booting.
const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://www.torn.com/" });
global.window = dom.window;
global.document = dom.window.document;

const row = (o = {}) => ({
  id: 9, status: "claimed", amount: 124500000, owed: 124500000, player_id: 1, player_name: "Lasiras",
  claimed_by_me: true, claimed_by_name: "Fulgrim2", give_url: "https://www.torn.com/factions.php#x",
  created_at: new Date().toISOString(), source: "discord", ...o,
});

function html(requests, queue = {}) {
  cw.state.bank = { busy: false, queue: { canView: true, banker: true, linked: true, requests, ...queue } };
  const box = document.createElement("div");
  box.innerHTML = cw.renderBankQueue();
  return box;
}

test("my claimed request shows Give and Unclaim", () => {
  const box = html([row()]);
  assert.ok(box.querySelector(".tocw-give"));
  assert.equal(box.querySelector("[data-tocw-bank-unclaim]").getAttribute("data-tocw-bank-unclaim"), "9");
});

test("no Unclaim on someone else's claim, an open request, or a part-paid one", () => {
  assert.equal(html([row({ claimed_by_me: false, give_url: null })]).querySelector("[data-tocw-bank-unclaim]"), null);
  assert.equal(html([row({ status: "open", claimed_by_me: false, give_url: null })]).querySelector("[data-tocw-bank-unclaim]"), null);
  assert.equal(html([row({ status: "partial" })]).querySelector("[data-tocw-bank-unclaim]"), null);
});

test("no Unclaim once the viewer has lost the banker role", () => {
  assert.equal(html([row()], { banker: false }).querySelector("[data-tocw-bank-unclaim]"), null);
});
