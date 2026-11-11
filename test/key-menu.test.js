// Trading script 0.8.16 — "Set Torn API key" in the Tampermonkey menu (Xnappum, 2026-11-11:
// setting the key should not need a trip to a trade first). jsdom page, fake server.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function page({ reject = null, menu = true } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id='root'></div></body></html>", { url: "https://www.torn.com/gym.php", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const gm = new Map();
  const menus = [];
  const calls = [];
  w.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
  w.GM_setValue = (k, v) => gm.set(k, v);
  if (menu) w.GM_registerMenuCommand = (label, fn) => menus.push({ label, fn });
  w.GM_xmlhttpRequest = (opts) => {
    const body = opts.data ? JSON.parse(opts.data) : {};
    calls.push({ url: opts.url, body });
    const connect = /connect-torn-key/.test(opts.url);
    const status = connect && reject ? 400 : 200;
    const answer = connect ? (reject ? { error: reject } : { sessionToken: "fresh-session" }) : { items: [], watched: [], deals: [] };
    setTimeout(() => opts.onload({ status, responseText: JSON.stringify(answer) }), 0);
  };
  w.eval(SOURCE);
  return { w, doc: w.document, gm, menus, calls };
}

const typeKey = (doc, key) => {
  const input = doc.querySelector("#totr-keydlg .totr-keyinput");
  input.value = key;
  [...doc.querySelectorAll("#totr-keydlg button")].find((b) => b.textContent === "Save").click();
};

test("menu: one 'Set Torn API key' entry; Save stores the key and checks it with Overseer", async () => {
  const { doc, gm, menus, calls, w } = page();
  await tick();
  assert.deepEqual(menus.map((m) => m.label), ["Set Torn API key"]);
  menus[0].fn();
  assert.match(doc.getElementById("totr-keydlg").textContent, /No key saved yet/);
  typeKey(doc, "  abcdEFGH12345678 ");
  await tick();
  assert.equal(gm.get("totr_torn_key"), "abcdEFGH12345678");
  assert.equal(gm.get("totr_session_token"), "fresh-session");
  const c = calls.find((x) => /connect-torn-key/.test(x.url));
  assert.equal(c.body.persist, false);
  const dlg = doc.getElementById("totr-keydlg");
  assert.match(dlg.textContent, /Connected/);
  assert.match(dlg.textContent, /ends …5678/);
  assert.equal(dlg.querySelector(".totr-keyinput").value, "", "the key box is cleared after saving");
  w.close();
});

test("menu: a key Torn refuses is forgotten and the reason shown; Remove key and Escape work", async () => {
  const { doc, gm, menus, w } = page({ reject: "Torn rejected that API key." });
  await tick();
  menus[0].fn();
  typeKey(doc, "badbadbadbadbad1");
  await tick();
  assert.equal(gm.get("totr_torn_key"), "");
  assert.match(doc.getElementById("totr-keydlg").textContent, /rejected that API key/);
  gm.set("totr_torn_key", "goodgoodgood9999");
  menus[0].fn(); // reopening replaces the dialog, never stacks a second
  assert.equal(doc.querySelectorAll("#totr-keydlg").length, 1);
  assert.match(doc.getElementById("totr-keydlg").textContent, /ends …9999/);
  [...doc.querySelectorAll("#totr-keydlg button")].find((b) => b.textContent === "Remove key").click();
  assert.equal(gm.get("totr_torn_key"), "");
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(doc.getElementById("totr-keydlg"), null);
  w.close();
});

test("menu: no script menu (Torn PDA) — nothing registered, nothing breaks", async () => {
  const { menus, w } = page({ menu: false });
  await tick();
  assert.equal(menus.length, 0);
  w.close();
});
