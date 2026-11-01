// v0.31.0 — War Room Assist heartbeat: which page, when the fight is over, when to stop.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const gm = new Map();
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

// Required with no DOM: the script exports its pure helpers instead of booting.
const cw = require("../Torn-Overseer-Chain-Watch.user.js");

test("attackTargetFromUrl: Torn's attack page only", () => {
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/loader.php?sid=attack&user2ID=2041781"), 2041781);
  assert.equal(cw.attackTargetFromUrl("https://torn.com/loader.php?user2ID=55&sid=attack"), 55);
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/loader.php?sid=attack"), null);
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/loader.php?sid=attack&user2ID=abc"), null);
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/loader.php?sid=attack&user2ID=-3"), null);
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/profiles.php?XID=55"), null);
  assert.equal(cw.attackTargetFromUrl("https://www.torn.com/loader.php?sid=racing&user2ID=55"), null);
  assert.equal(cw.attackTargetFromUrl("https://evil.example/loader.php?sid=attack&user2ID=55"), null);
  assert.equal(cw.attackTargetFromUrl("not a url"), null);
});

test("fightLooksOver: Torn's end-of-fight wording", () => {
  for (const t of [
    "You hospitalized Brannoch for 43 minutes",
    "You mugged Brannoch and stole $1,234",
    "You lost to Brannoch",
    "Brannoch escaped",
    "Stalemate",
    "You left Brannoch on the street",
  ]) assert.equal(cw.fightLooksOver(t), true, t);
  for (const t of ["", null, "Start fight", "Brannoch · Level 41", "Use your Glock 17"]) {
    assert.equal(cw.fightLooksOver(t), false, String(t));
  }
});

test("shouldBeat: stops when stopped, over, or past Torn's 5 minutes", () => {
  const base = { stopped: false, over: false, startedMs: 0, nowMs: 60_000 };
  assert.equal(cw.shouldBeat(base), true);
  assert.equal(cw.shouldBeat({ ...base, stopped: true }), false);
  assert.equal(cw.shouldBeat({ ...base, over: true }), false);
  assert.equal(cw.shouldBeat({ ...base, nowMs: 5 * 60_000 + 29_000 }), true);
  assert.equal(cw.shouldBeat({ ...base, nowMs: 5 * 60_000 + 30_000 }), false);
});
