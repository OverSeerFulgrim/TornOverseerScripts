// v0.32.0 — the War tab: when it shows, what it renders, the attack-page strip, and the
// small parsers it lives on (scoreboard, FF Scouter, peek merging, launcher alert).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const gm = new Map([["tocw_session_token", "sess"], ["tocw_torn_key", "key"]]);
global.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
global.GM_setValue = (k, v) => gm.set(k, v);

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://www.torn.com/factions.php",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });

const NOW = Math.floor(Date.now() / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const enemy = (id, o = {}) => ({
  id, name: `E${id}`, level: 60, state: "Okay", description: "Okay", until: 0, lastAction: "Offline", lastActionAt: 0,
  planeImageType: null, departedAt: null, flightSeenAt: null, flight: null, idleSince: null, ...o,
});

function roomState(o = {}) {
  return {
    room: { warKey: "rw:7", source: "ranked", opponentId: 900, opponentName: "Foe" },
    manualOpponentId: null,
    enemy: { members: [enemy(1), enemy(2, { lastAction: "Online" }), enemy(3, { state: "Hospital", until: NOW + 300 })], fetchedAt: iso(NOW), stale: false, error: null },
    attacks: { fetchedAt: iso(NOW), error: null },
    retals: [],
    fights: [],
    reservations: [
      { targetId: 1, targetName: "E1", attackerId: 100, attackerName: "Me", assigned: false, expiresAt: iso(NOW + 200) },
      { targetId: 2, targetName: "E2", attackerId: 77, attackerName: "Bob", assigned: false, expiresAt: iso(NOW + 100) },
    ],
    orders: [{ targetId: 3, priority: "priority", note: "" }],
    me: { playerId: 100, status: "ready", pledge: null, targetId: 1, heldCount: 1, releasedBy: null, jumped: null, jumpedSomeone: null },
    pledges: { counts: { start: 0, shortly: 0, later: 0, away: 0 }, answered: 0, total: 5 },
    isCommand: false,
    canRelease: false,
    settings: { reserveOnAttack: false, memberTeamView: 1 },
    limits: { reservationsPerMember: 2 },
    team: null,
    serverTime: iso(NOW),
    ...o,
  };
}

function reset(st) {
  Object.assign(cw.state.war, cw.freshWarState());
  cw.state.war.st = st;
}

test("no room → no War tab; a room → War sits right after Chain", () => {
  reset(null);
  assert.deepEqual(cw.availableTabs().includes("war"), false);
  reset(roomState());
  const tabs = cw.availableTabs();
  assert.equal(tabs[0], "chain");
  assert.equal(tabs[1], "war");
  reset(roomState({ room: null }));
  assert.equal(cw.availableTabs().includes("war"), false);
});

test("the War tab renders the header, my target, status and the board", () => {
  reset(roomState());
  cw.state.war.score = { start: NOW - 3600, end: null, target: 3000, us: { id: 1, name: "Us", score: 2184 }, them: { id: 900, name: "Foe", score: 1772 } };
  const html = cw.renderWarTab();
  assert.match(html, /vs Foe/);
  assert.match(html, /Leading \+412/);
  assert.match(html, /My target/);
  assert.match(html, /data-tocw-war-release="1"/); // my claim: Release
  assert.match(html, /Held by <strong>Bob<\/strong>/); // someone else's claim
  assert.doesNotMatch(html, /data-tocw-war-unreserve/); // no release rights
  assert.match(html, /data-tocw-war-reserve="3"/); // free target
  assert.match(html, /When can you fight\?/);
  assert.match(html, /Add your FF Scouter key/);
});

test("release rights add Unreserve on someone else's claim", () => {
  reset(roomState({ canRelease: true }));
  assert.match(cw.renderWarTab(), /data-tocw-war-unreserve="2"/);
});

test("an announced war shows the countdown, not a score", () => {
  reset(roomState());
  cw.state.war.score = { start: NOW + 3 * 3600, end: null, target: 3000, us: { id: 1, name: "Us", score: 0 }, them: { id: 900, name: "Foe", score: 0 } };
  const html = cw.renderWarTab();
  assert.match(html, /Announced/);
  assert.match(html, /Starts in/);
});

test("Priority view keeps only priority targets", () => {
  reset(roomState());
  cw.state.war.view = "priority";
  const html = cw.renderWarTab();
  assert.match(html, /data-tocw-war-reserve="3"/);
  assert.doesNotMatch(html, /\[2\] · lvl/);
});

test("the Chain tab gets a war pill only while a room is open", () => {
  reset(null);
  assert.equal(cw.renderWarPill(), "");
  reset(roomState());
  cw.state.war.score = { start: NOW - 60, end: null, target: null, us: { id: 1, name: "Us", score: 10 }, them: { id: 900, name: "Foe", score: 25 } };
  assert.match(cw.renderWarPill(), /War -15 · 10–25/);
});

test("warScoreFromWars: our side is whichever isn't the opponent", () => {
  const raw = { wars: { ranked: { war_id: 5, start: 1000, end: 0, target: 3000, factions: [{ id: 900, name: "Foe", score: 40 }, { id: 1, name: "Us", score: 55 }] } } };
  assert.deepEqual(cw.warScoreFromWars(raw, 900), {
    start: 1000, end: null, target: 3000, us: { id: 1, name: "Us", score: 55 }, them: { id: 900, name: "Foe", score: 40 },
  });
  assert.equal(cw.warScoreFromWars(raw, 123), null); // a different (manual) opponent
  assert.equal(cw.warScoreFromWars({ wars: { ranked: null } }, 900), null);
  const keyed = { wars: { ranked: { start: 9, factions: { 900: { name: "Foe", score: 1 }, 1: { name: "Us", score: 2 } } } } };
  assert.equal(cw.warScoreFromWars(keyed, 900).us.score, 2);
});

test("parseFfStats reads FF Scouter's rows and skips junk", () => {
  const out = cw.parseFfStats([
    { player_id: 5, fair_fight: 2.4, bs_estimate: 1200000000, bs_estimate_human: "1.2b" },
    { player_id: 6, fair_fight: null, bs_estimate: null, bs_estimate_human: null },
    { id: 0 },
    null,
  ]);
  assert.deepEqual(out, {
    5: { fairFight: 2.4, battleEstimate: 1200000000, battleEstimateHuman: "1.2b" },
    6: { fairFight: null, battleEstimate: null, battleEstimateHuman: null },
  });
  assert.deepEqual(cw.parseFfStats({ error: "bad key" }), {});
});

test("a peek keeps the last enemy roster for the same war", () => {
  reset(roomState());
  const peek = roomState({ enemy: { members: [], fetchedAt: null, stale: false, error: null }, reservations: [] });
  cw.warAdopt(peek, true);
  assert.equal(cw.state.war.st.enemy.members.length, 3);
  assert.equal(cw.state.war.st.reservations.length, 0);
  cw.warAdopt(roomState({ room: { warKey: "rw:8", source: "ranked", opponentId: 901, opponentName: "Other" }, enemy: { members: [], fetchedAt: null, stale: false, error: null } }), true);
  assert.equal(cw.state.war.st.enemy.members.length, 0); // a different war: nothing carried over
});

test("the room closing sends an open War tab back to Chain", () => {
  reset(roomState());
  cw.state.tab = "war";
  cw.warAdopt(roomState({ room: null }), true);
  assert.equal(cw.state.tab, "chain");
});

test("attack-page strip: mine, held, free, stop", () => {
  const nowMs = NOW * 1000;
  const st = roomState();
  assert.equal(cw.warBannerFor(st, 1, nowMs).kind, "mine");
  const held = cw.warBannerFor(st, 2, nowMs);
  assert.equal(held.kind, "held");
  assert.match(held.text, /Held by Bob/);
  const free = cw.warBannerFor(st, 3, nowMs);
  assert.equal(free.kind, "free");
  assert.equal(free.reason, null);
  assert.equal(cw.warBannerFor(roomState({ limits: { reservationsPerMember: 1 } }), 3, nowMs).reason, "You already hold 1 — the leader's limit");
  assert.equal(cw.warBannerFor(st, 999, nowMs).kind, "free"); // not on the roster we know — still say who holds it
  assert.equal(cw.warBannerFor(roomState({ room: null }), 1, nowMs), null);
  const stop = roomState({ rules: { offlineOnly: false, idleCountsOffline: false, stopAt: 100, score: 120, scoreAvailable: true, reached: true, close: false, toGo: 0, stoppedAt: null, setByName: null, setAt: null, canEdit: false } });
  assert.equal(cw.warBannerFor(stop, 3, nowMs).kind, "stop");
});

test("launcher alert: a claim jump, a release, the stop — and dismissals clear it", () => {
  reset(roomState());
  assert.equal(cw.warAlert(), null);
  reset(roomState({ me: { ...roomState().me, jumped: { id: 4, targetId: 1, targetName: "E1", byName: "Bob", retal: false, at: iso(NOW) } } }));
  assert.match(cw.warAlert(), /taken by Bob/);
  cw.state.war.dismissedJump = 4;
  assert.equal(cw.warAlert(), null);
  reset(roomState({ me: { ...roomState().me, releasedBy: { targetId: 1, targetName: "E1", byName: "Lead", at: iso(NOW) } } }));
  assert.match(cw.warAlert(), /Lead released your reservation/);
});
