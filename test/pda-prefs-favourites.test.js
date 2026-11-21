// v0.36.0 — Torn PDA keeps settings and the FF Scouter key between pages; favourites.
//
// PDA wipes GM storage on every page load, which reset the hit list, its position and
// every preference (Xnappum, 2026-11-21). GM storage is cleared between "pages" here.
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

const asPda = (on) => {
  if (on) window.PDA_httpGet = () => {};
  else delete window.PDA_httpGet;
};
const newPage = () => gm.clear();
const KEY_A = "KEYAAAAAAAAAAAAA";
const KEY_B = "KEYBBBBBBBBBBBBB";

test.beforeEach(() => {
  gm.clear();
  localStorage.clear();
  asPda(false);
  cw.state.targetIds.length = 0;
  cw.state.targetIndex = 0;
});

test("PDA: a setting survives a page load", () => {
  asPda(true);
  cw.gmSet(cw.STORE.alarmTone, "siren");
  newPage();
  assert.equal(cw.gmGet(cw.STORE.alarmTone, "beep"), "siren");
});

test("desktop: nothing is mirrored to page storage", () => {
  cw.gmSet(cw.STORE.alarmTone, "siren");
  assert.equal(localStorage.getItem("tocw_pda_prefs"), null);
});

test("PDA: secrets never land in the settings mirror", () => {
  asPda(true);
  cw.gmSet(cw.STORE.tornKey, KEY_A);
  cw.gmSet(cw.STORE.ffKey, KEY_B);
  const raw = localStorage.getItem("tocw_pda_prefs") || "";
  assert.ok(!raw.includes(KEY_A) && !raw.includes(KEY_B));
});

test("PDA: the hit list and its names survive a page load", () => {
  asPda(true);
  assert.equal(cw.toggleTarget(111, "Alpha"), "added");
  assert.equal(cw.toggleTarget(222, "Bravo"), "added");
  newPage();
  assert.equal(cw.gmGet(cw.STORE.targetIds, ""), "111,222");
  assert.deepEqual(cw.readTargetNames(), { 111: "Alpha", 222: "Bravo" });
});

test("star toggles a player on and off, keeping the HIT position sane", () => {
  cw.toggleTarget(1, "A");
  cw.toggleTarget(2, "B");
  cw.toggleTarget(3, "C");
  cw.state.targetIndex = 2; // next up: 3
  assert.equal(cw.toggleTarget(1), "removed"); // removing one before it shifts the index
  assert.deepEqual(cw.state.targetIds, [2, 3]);
  assert.equal(cw.state.targetIds[cw.state.targetIndex], 3);
  assert.deepEqual(cw.readTargetNames(), { 2: "B", 3: "C" });
});

test("the hit list stops at the cap", () => {
  for (let i = 1; i <= cw.MAX_TARGETS; i += 1) cw.toggleTarget(i);
  assert.equal(cw.toggleTarget(999999), "full");
  assert.equal(cw.state.targetIds.length, cw.MAX_TARGETS);
});

test("add by ID takes pasted lists and skips duplicates", () => {
  cw.toggleTarget(5, "E");
  assert.equal(cw.addTargetIds("5, 6\n7 abc 7"), 2);
  assert.deepEqual(cw.state.targetIds, [5, 6, 7]);
  assert.equal(cw.toggleTarget(-3), "invalid");
});

test("PDA: a remembered FF key survives a page load for the same account only", () => {
  asPda(true);
  gm.set("tocw_torn_key", KEY_A);
  assert.equal(cw.rememberPdaFfKey("FFKEYFFKEYFFKEY1"), true);
  newPage();
  gm.set("tocw_torn_key", KEY_A);
  assert.equal(cw.savedFfKey(), "FFKEYFFKEYFFKEY1");
  newPage();
  gm.set("tocw_torn_key", KEY_B); // another account on the same phone
  assert.equal(cw.savedFfKey(), "");
});

test("desktop never writes the FF mirror; Clear removes it everywhere", () => {
  gm.set("tocw_torn_key", KEY_A);
  assert.equal(cw.rememberPdaFfKey("FFKEYFFKEYFFKEY1"), false);
  asPda(true);
  cw.rememberPdaFfKey("FFKEYFFKEYFFKEY1");
  cw.gmSet(cw.STORE.ffKey, "FFKEYFFKEYFFKEY1");
  cw.forgetFfKey();
  assert.equal(cw.savedFfKey(), "");
  assert.equal(localStorage.getItem("tocw_pda_ff"), null);
});

test("Full-access keys are recognised from Torn's key/info", () => {
  assert.equal(cw.keyInfoIsFull({ info: { access: { level: 4, type: "Full Access" } } }), true);
  assert.equal(cw.keyInfoIsFull({ info: { access: { level: 3, type: "Limited Access" } } }), false);
  assert.equal(cw.keyInfoIsFull({ access_level: 4 }), true);
  assert.equal(cw.keyInfoIsFull({ info: { access: { type: "Custom" } } }), false);
});
