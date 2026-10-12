// WO-36 — Leadership tab + Overseer compose fill. v0.30: Leadership tab v2.
// Pure helpers plus the render rules that keep the tab leadership-only.
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
    leadership: { ...cw.freshLeadershipState(), loadedAt: Date.now() },
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

test("READ-ONLY is gone; LEADERSHIP pill and tabs only for can_lead", () => {
  reset({ player_id: 1, can_manage: true, can_lead: false });
  cw.render();
  assert.ok(!html().includes("READ-ONLY"));
  assert.ok(!html().includes("LEADERSHIP"), "chain_watch managers without Command access get no pill");
  assert.ok(!html().includes('data-tocw-tab="leadership"'));

  reset({ player_id: 1, can_manage: true, can_lead: true });
  cw.render();
  assert.ok(html().includes("LEADERSHIP"));
  assert.ok(html().includes('data-tocw-tab="leadership"'));
});

test("a remembered leadership tab falls back to chain without can_lead", () => {
  reset({ player_id: 1, can_lead: false });
  cw.state.tab = "leadership";
  assert.equal(cw.activeTab(), "chain");
  reset(null);
  cw.state.tab = "leadership";
  assert.equal(cw.canLead(), false);
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

test("tabs: Bank needs a site session; Leadership needs can_lead", () => {
  reset({ player_id: 1, can_lead: false });
  assert.deepEqual(cw.availableTabs(), ["chain"]);
  reset({ player_id: 1, can_lead: true });
  assert.deepEqual(cw.availableTabs(), ["chain", "leadership"]);
});

test("recipientId reads Torn's 'Name [id]' To box", () => {
  assert.equal(cw.recipientId("callihan [4340722]"), 4340722);
  assert.equal(cw.recipientId(" Fulgrim2 [1737122] "), 1737122);
  assert.equal(cw.recipientId("callihan"), null);
  assert.equal(cw.recipientId(""), null);
});

test("editorText turns the editor's paragraphs back into lines", () => {
  document.body.innerHTML = '<div id="ed"><p>Hi callihan,</p><p><br></p><p>• No login</p></div>';
  assert.equal(cw.editorText(document.getElementById("ed")), "Hi callihan,\n\n• No login");
  document.body.innerHTML = '<div id="ed2">plain</div>';
  assert.equal(cw.editorText(document.getElementById("ed2")), "plain");
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

// ---- v0.30.0: Leadership tab v2 (to-do list, excuse / not excused, hand-off) ----------

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

function todo(o = {}) {
  return {
    drafts: [{ id: 5, member_id: 4, member_name: "Pot", template: "final", created_at: iso(50), created_by_name: "Fulgrim2" }],
    members: [
      { member_id: 1, member_name: "<i>Faithwolf</i>", flags: ["Inactive 52h", "Missed OC 3×", "<b>x</b>"], flag_count: 3, tier: "critical",
        last_warning: { template: "formal", status: "sent", at: iso(360) }, last_sent: { template: "formal", at: iso(360) }, next_template: "final" },
      { member_id: 3, member_name: "Vexa", flags: ["Inactive 30h"], flag_count: 1, tier: "minor", last_warning: null, last_sent: null, next_template: "checkin" },
    ],
    history: [
      { member_id: 2, member_name: "callihan", steps: [
        { id: 9, template: "formal", status: "sent", at: iso(360), by: "Fulgrim2" },
        { id: 8, template: "checkin", status: "sent", at: iso(540), by: "Fulgrim2" },
      ] },
    ],
    flags_as_of: iso(120),
    count: 3,
    ...o,
  };
}

function leadTab(t = todo(), extra = {}) {
  reset({ player_id: 1737122, can_lead: true });
  cw.state.tab = "leadership";
  Object.assign(cw.state.leadership, { todo: t }, extra);
}

test("ladderDots fill to the last SENT step", () => {
  const on = (h) => (h.match(/class="on"/g) || []).length;
  assert.equal(on(cw.ladderDots(null)), 0);
  assert.equal(on(cw.ladderDots("checkin")), 1);
  assert.equal(on(cw.ladderDots("formal")), 2);
  assert.equal(on(cw.ladderDots("final")), 3);
  assert.equal(on(cw.ladderDots("bogus")), 0);
});

test("lastWarningText says never / when / not sent", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(cw.lastWarningText({ last_warning: null }, now), "never messaged");
  assert.equal(cw.lastWarningText({ last_warning: { template: "formal", status: "sent", at: "2026-10-10T06:00:00Z" } }, now), "Formal warning 6h ago");
  assert.equal(cw.lastWarningText({ last_warning: { template: "final", status: "prepared", at: "2026-10-10T11:10:00Z" } }, now), "Final warning 50m ago (not sent)");
});

test("the tab: unsent drafts, members worst-first with ladder + next step, all escaped", () => {
  leadTab();
  cw.render();
  const out = html();
  assert.ok(out.includes("Not sent yet"));
  assert.ok(out.includes("Needs a message"));
  assert.ok(out.includes("flags as of 2h ago"));
  assert.ok(out.includes("&lt;i&gt;Faithwolf&lt;/i&gt;"), "names are escaped");
  assert.ok(!out.includes("<i>Faithwolf</i>"));
  assert.ok(out.includes("Critical · 3"));
  assert.ok(out.includes("next: Final warning"));
  assert.ok(out.includes("never messaged · next: Friendly check-in"));
  assert.ok(out.includes('data-tocw-lead-resume="5"'));
  assert.ok(out.includes("messages.php#/p=compose&amp;XID=4"), "Resume is a plain link to Torn compose");
  assert.ok(!out.includes("Are these flags excused?"), "rows start collapsed");
  assert.ok(!out.includes("tocw-shifts"), "the chain body is not rendered on the leadership tab");
});

test("the tab badge counts drafts + members", () => {
  leadTab();
  cw.render();
  assert.match(html(), /data-tocw-tab="leadership">Leadership <span class="tocw-tab-count">3<\/span>/);
  leadTab(todo({ count: 0 }));
  cw.render();
  assert.ok(!/data-tocw-tab="leadership">Leadership <span/.test(html()));
});

test("an empty list says so, and History is collapsed until opened", () => {
  leadTab(todo({ drafts: [], members: [], count: 0 }));
  let out = cw.renderLeadershipTab();
  assert.ok(out.includes("Nobody needs a message right now"));
  assert.ok(!out.includes("Not sent yet"), "no drafts → no drafts card");
  assert.ok(out.includes("History · 2 messages, 1 member · 7 days"));
  assert.ok(!out.includes("Formal warning ← Friendly check-in"));
  cw.state.leadership.historyOpen = true;
  out = cw.renderLeadershipTab();
  assert.ok(out.includes("Formal warning ← Friendly check-in"));
});

test("an expanded member asks excused / not excused, with an escaped note box", () => {
  leadTab(todo(), { openMember: 1, note: '"><script>' });
  const out = cw.renderLeadershipTab();
  assert.ok(out.includes("Are these flags excused?"));
  assert.ok(out.includes('data-tocw-lead-choose="excused"'));
  assert.ok(out.includes('data-tocw-lead-choose="not_excused"'));
  assert.ok(out.includes('data-tocw-lead-submit="1"'));
  assert.ok(out.includes("Nothing is saved until you press Submit."));
  assert.ok(out.includes('aria-pressed="false"') && !out.includes('aria-pressed="true"'), "nothing is pre-picked");
  assert.ok(out.includes("&lt;b&gt;x&lt;/b&gt;"), "flag labels are escaped");
  assert.ok(out.includes('value="&quot;&gt;&lt;script&gt;"'), "the note is escaped into the input");
  assert.ok(out.includes("/faction/members/1"));
  assert.equal((out.match(/Are these flags excused\?/g) || []).length, 1, "only the open row expands");
});

test("after Not excused, a Send card links to compose for that member", () => {
  leadTab(todo(), { decided: { member_id: 1, member_name: "<i>Faithwolf</i>", batch_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", next_template: "final" } });
  const out = cw.renderLeadershipTab();
  assert.ok(out.includes("Send Final warning on Torn"));
  assert.ok(out.includes("messages.php#/p=compose&amp;XID=1"));
  assert.ok(out.includes("&lt;i&gt;Faithwolf&lt;/i&gt;"));
});

test("discarding a draft asks first, inline", () => {
  leadTab(todo(), { confirmDismiss: 5 });
  const out = cw.renderLeadershipTab();
  assert.ok(out.includes('data-tocw-lead-dismiss="5"'));
  assert.ok(out.includes("Keep"));
  assert.ok(!out.includes('data-tocw-lead-resume="5"'));
});

test("loading and error states", () => {
  leadTab(null, { loading: true });
  assert.ok(cw.renderLeadershipTab().includes("Loading…"));
  leadTab(null, { error: "<b>boom</b>" });
  assert.ok(cw.renderLeadershipTab().includes("&lt;b&gt;boom&lt;/b&gt;"));
});

test("the compose hand-off is for one member, once, and goes stale", () => {
  cw.stashComposeHandoff({ member_id: 7, template: "final", batch_id: "abc" });
  assert.equal(cw.takeComposeHandoff(8), null, "another member doesn't consume it");
  assert.deepEqual(cw.takeComposeHandoff(7), { member_id: 7, template: "final", batch_id: "abc" });
  assert.equal(cw.takeComposeHandoff(7), null, "one-shot");

  cw.stashComposeHandoff({ member_id: 7, template: "<x>", batch_id: 5 });
  assert.deepEqual(cw.takeComposeHandoff(7), { member_id: 7, template: null, batch_id: null }, "junk is dropped");

  cw.stashComposeHandoff({ member_id: 7, template: "formal", batch_id: null });
  assert.equal(cw.takeComposeHandoff(7, Date.now() + 11 * 60 * 1000), null, "older than 10 minutes");
});

test("composeUrl targets Torn's compose page for the member", () => {
  assert.equal(cw.composeUrl(4340722), "https://www.torn.com/messages.php#/p=compose&XID=4340722");
});

test("picking a choice only selects it; Submit names what it will save", () => {
  leadTab(todo(), { openMember: 1, choice: "not_excused" });
  let out = cw.renderLeadershipTab();
  assert.ok(out.includes("Submit — not excused"));
  assert.ok(out.includes("✓ Not excused"));
  assert.ok(out.includes("After it's saved you can send the final warning."));
  leadTab(todo(), { openMember: 1, choice: "excused" });
  out = cw.renderLeadershipTab();
  assert.ok(out.includes("Submit — excused"));
  assert.ok(out.includes("No message is sent."));
});

test("Submit without a choice shows an inline error, escaped", () => {
  leadTab(todo(), { openMember: 1, choiceError: "Pick Excused or Not excused first." });
  const out = cw.renderLeadershipTab();
  assert.ok(out.includes('role="alert">Pick Excused or Not excused first.'));
});

test("clicking Excused / Not excused selects without saving; Submit with no pick warns", () => {
  leadTab(todo(), { openMember: 1 });
  cw.render();
  const box = document.getElementById("tocw");
  box.querySelector('[data-tocw-lead-submit]').click();
  assert.equal(cw.state.leadership.choiceError, "Pick Excused or Not excused first.");
  assert.equal(cw.state.leadership.busy, false, "nothing was sent");
  document.getElementById("tocw").querySelector('[data-tocw-lead-choose="not_excused"]').click();
  assert.equal(cw.state.leadership.choice, "not_excused");
  assert.equal(cw.state.leadership.choiceError, null);
  assert.equal(cw.state.leadership.busy, false, "picking alone saves nothing");
  assert.ok(html().includes("Submit — not excused"));
});
