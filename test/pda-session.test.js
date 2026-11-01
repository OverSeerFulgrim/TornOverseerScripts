// v0.32.1 — Torn PDA keeps the Overseer session between pages.
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

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

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
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  newPage();
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(cw.settings().sessionToken, "sess-1");
});

test("the mirror never holds the Torn key", () => {
  asPda(true);
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  const raw = localStorage.getItem("tocw_pda_session");
  assert.ok(raw);
  assert.ok(!raw.includes("KEYAAAAAAAAAAAAA"));
});

test("a different PDA account does not pick up the session", () => {
  asPda(true);
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  newPage();
  gm.set("tocw_torn_key", "KEYBBBBBBBBBBBBB");
  assert.equal(cw.settings().sessionToken, "");
});

test("clearing the session clears the mirror", () => {
  asPda(true);
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  cw.saveSessionToken("");
  assert.equal(localStorage.getItem("tocw_pda_session"), null);
  newPage();
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(cw.settings().sessionToken, "");
});

test("desktop never writes or reads the mirror", () => {
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  assert.equal(localStorage.getItem("tocw_pda_session"), null);
  localStorage.setItem("tocw_pda_session", JSON.stringify({ t: "planted", k: cw.keyTag("KEYAAAAAAAAAAAAA") }));
  newPage();
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  assert.equal(cw.settings().sessionToken, "");
});

test("GM storage still wins when it does persist", () => {
  asPda(true);
  gm.set("tocw_torn_key", "KEYAAAAAAAAAAAAA");
  cw.saveSessionToken("sess-1");
  gm.set("tocw_session_token", "sess-gm");
  assert.equal(cw.settings().sessionToken, "sess-gm");
});
