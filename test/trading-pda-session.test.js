// Trading script 0.7.15 — Torn PDA keeps the Overseer session between pages (same fix as
// Chain Watch v0.32.1; see pda-session.test.js).
//
// PDA's GM storage doesn't survive a page load, so the script signed in again on every
// Torn page. In PDA only, the session token is mirrored to page localStorage, tagged with
// the key it was minted from. Here GM storage is wiped between "pages" to model that.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const gm = new Map();
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

const tr = require("../Torn-Overseer-Trading-Beta.user.js");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://www.torn.com/index.php" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

function newPage() {
  gm.clear(); // what PDA does to GM storage between page loads
}

function asPda(on) {
  if (on) window.PDA_httpGet = () => {};
  else delete window.PDA_httpGet;
}

test.beforeEach(() => {
  gm.clear();
  localStorage.clear();
  asPda(false);
});

test("in PDA the session survives a page load", () => {
  asPda(true);
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  newPage();
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(tr.prefs().sessionToken, "sess-1");
});

test("the mirror never holds the Torn key", () => {
  asPda(true);
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  const raw = localStorage.getItem("totr_pda_session");
  assert.ok(raw);
  assert.ok(!raw.includes("KEYAAAAAAAAAAAAA"));
});

test("a different PDA account does not pick up the session", () => {
  asPda(true);
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  newPage();
  gm.set("totr_torn_key", "KEYBBBBBBBBBBBBB");
  assert.equal(tr.prefs().sessionToken, "");
});

test("clearing the session clears the mirror", () => {
  asPda(true);
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  tr.saveSessionToken("");
  assert.equal(localStorage.getItem("totr_pda_session"), null);
  newPage();
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(tr.prefs().sessionToken, "");
});

test("desktop never writes or reads the mirror", () => {
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  assert.equal(localStorage.getItem("totr_pda_session"), null);
  localStorage.setItem("totr_pda_session", JSON.stringify({ t: "planted", k: tr.keyTag("KEYAAAAAAAAAAAAA") }));
  newPage();
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(tr.prefs().sessionToken, "");
});

test("GM storage still wins when it does persist", () => {
  asPda(true);
  gm.set("totr_torn_key", "KEYAAAAAAAAAAAAA");
  tr.saveSessionToken("sess-1");
  gm.set("totr_session_token", "sess-gm");
  assert.equal(tr.prefs().sessionToken, "sess-gm");
});
