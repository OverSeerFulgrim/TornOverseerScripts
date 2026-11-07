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
