// Unit tests for the Overseer Trading beta's pure helpers. Run: node --test test/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tr = require("../Torn-Overseer-Trading-Beta.user.js");

const loc = (pathname, search = "", hash = "") => ({ pathname, search, hash });

test("routeFor picks the module for each page", () => {
  assert.equal(tr.routeFor(loc("/trade.php", "", "#step=view&ID=5")), "trade");
  assert.equal(tr.routeFor(loc("/bazaar.php", "", "#/add")), "bazaarOwn");
  assert.equal(tr.routeFor(loc("/bazaar.php", "", "#/manage")), "bazaarOwn");
  assert.equal(tr.routeFor(loc("/bazaar.php", "?userId=123", "")), "bazaarOther");
  assert.equal(tr.routeFor(loc("/page.php", "?sid=ItemMarket", "#/market/view=search")), "itemMarket");
  assert.equal(tr.routeFor(loc("/page.php", "?sid=ItemMarketX")), null);
  assert.equal(tr.routeFor(loc("/gym.php")), null);
});

test("parseTradeHash reads step and a positive trade id", () => {
  assert.deepEqual(tr.parseTradeHash("#step=view&ID=12345"), { step: "view", tradeId: 12345 });
  assert.deepEqual(tr.parseTradeHash("#/step=addmoney&ID=7"), { step: "addmoney", tradeId: 7 });
  assert.deepEqual(tr.parseTradeHash("#step=view&ID=abc"), { step: "view", tradeId: null });
  assert.deepEqual(tr.parseTradeHash(""), { step: "", tradeId: null });
});

test("parseItemLine splits name and quantity", () => {
  assert.deepEqual(tr.parseItemLine("Xanax x40"), { name: "Xanax", qty: 40 });
  assert.deepEqual(tr.parseItemLine("  Pair of Ice Skates \n"), { name: "Pair of Ice Skates", qty: 1 });
  assert.deepEqual(tr.parseItemLine("Box of x Things x3"), { name: "Box of x Things", qty: 3 });
  assert.equal(tr.parseItemLine(""), null);
  assert.equal(tr.parseItemLine("Xanax x0"), null);
});

test("parseMoney reads Torn money text", () => {
  assert.equal(tr.parseMoney("$48,212,000"), 48212000);
  assert.equal(tr.parseMoney("Money: $ 1,500"), 1500);
  assert.equal(tr.parseMoney("no money"), null);
});

test("fillTarget is market value plus a markup that may go below MV, within limits", () => {
  assert.equal(tr.fillTarget(828000, 0), 828000);
  assert.equal(tr.fillTarget(828000, 2), 844560);
  assert.equal(tr.fillTarget(828000, -5), 786600, "negative fill sits under market value");
  assert.equal(tr.fillTarget(828000, -95), 414000, "floored at -50% so a typo can't give stock away");
  assert.equal(tr.fillTarget(828000, 500), 1656000, "capped at +100%");
  assert.equal(tr.fillTarget(null, 2), null);
  assert.equal(tr.fillTarget(0, 2), null);
});

test("driftPct measures distance from the target", () => {
  assert.equal(tr.driftPct(1910, 1836), 4);
  assert.equal(tr.driftPct(1836, 1836), 0);
  assert.equal(tr.driftPct(1700, 1836), -7);
  assert.equal(tr.driftPct(1700, null), null);
});

test("moneyGuard states", () => {
  assert.deepEqual(tr.moneyGuard(0, 0), { state: "empty", diff: 0 });
  assert.deepEqual(tr.moneyGuard(100, 0), { state: "short", diff: 100 });
  assert.deepEqual(tr.moneyGuard(100, 100), { state: "ready", diff: 0 });
  assert.deepEqual(tr.moneyGuard(100, 150), { state: "over", diff: 50 });
});

test("compareVersions", () => {
  assert.equal(tr.compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(tr.compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(tr.compareVersions("1.0", "0.9.9"), 1);
});

test("tradeSignature ignores order and is empty for no items", () => {
  assert.equal(tr.tradeSignature([]), "");
  assert.equal(tr.tradeSignature([{ name: "Xanax", qty: 2 }, { name: "Lollipop", qty: 1 }]),
    tr.tradeSignature([{ name: "lollipop", qty: 1 }, { name: "Xanax", qty: 2 }]));
  assert.notEqual(tr.tradeSignature([{ name: "Xanax", qty: 2 }]), tr.tradeSignature([{ name: "Xanax", qty: 3 }]));
});

test("stockSnapshotItems sums per item and only claims complete when it read the page", () => {
  assert.deepEqual(tr.stockSnapshotItems([{ itemId: 206, count: 9 }, { itemId: 180, count: null }, { itemId: 206, count: 3 }]),
    { items: [{ itemId: 180, qty: 1 }, { itemId: 206, qty: 12 }], complete: true }, "no printed count is one");
  assert.deepEqual(tr.stockSnapshotItems([]), { items: [], complete: false }, "empty page is not 'you own nothing'");
  assert.equal(tr.stockSnapshotItems([{ itemId: null, count: 4 }, { itemId: 206, count: 2 }]).complete, false, "an unnamed row");
  const five = [1, 2, 3, 4, 5].map((itemId) => ({ itemId, count: null }));
  assert.equal(tr.stockSnapshotItems(five).complete, false, "five rows and no count read: our selectors, not a page of singles");
  assert.equal(tr.stockSnapshotItems([...five, { itemId: 6, count: 2 }]).complete, true);
});

test("snapshotDue sends at most once per window per page", () => {
  const every = 600000;
  assert.equal(tr.snapshotDue({}, "add", 1000000, every), true);
  assert.equal(tr.snapshotDue({ add: 900000 }, "add", 1000000, every), false);
  assert.equal(tr.snapshotDue({ add: 900000 }, "manage", 1000000, every), true);
  assert.equal(tr.snapshotDue({ add: 300000 }, "add", 1000000, every), true);
  assert.equal(tr.snapshotDue({ add: 2000000 }, "add", 1000000, every), true, "a clock that went backwards");
  assert.equal(tr.snapshotDue(null, "add", 1000000, every), true);
});

test("addFillEvent (WO-50 E): one pass's fills, validated, deduped, capped — the caller flushes once", () => {
  let list = tr.addFillEvent([], 206, 830000, "bazaar");
  assert.deepEqual(list, [{ itemId: 206, price: 830000, kind: "bazaar" }]);
  const same = tr.addFillEvent(list, 206, 830000, "bazaar");
  assert.equal(same, list, "a duplicate returns the same list");
  list = tr.addFillEvent(list, 206, 830000.4, "bazaar");
  assert.equal(list.length, 1, "whole dollars: the rounded price is the same fill");
  list = tr.addFillEvent(list, 186, 1000, "trade", 777);
  assert.deepEqual(list[1], { itemId: 186, price: 1000, kind: "trade", tradeId: 777 });
  list = tr.addFillEvent(list, 186, 1000, "trade", 778);
  assert.equal(list.length, 3, "a different trade is a different fill");
  for (const bad of [[0, 1, "bazaar"], [206, 0, "bazaar"], [206, -5, "bazaar"], [206, NaN, "bazaar"], ["x", 1, "bazaar"], [206, 1, "market"], [206, 1, "trade", -1], [206, 1, "trade", "7x"]]) {
    assert.equal(tr.addFillEvent(list, ...bad), list, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(tr.addFillEvent(null, 206, 1, "bazaar"), [{ itemId: 206, price: 1, kind: "bazaar" }], "null-safe");
  let full = [];
  for (let i = 1; i <= tr.FILL_EVENT_CAP + 5; i += 1) full = tr.addFillEvent(full, i, 100, "bazaar");
  assert.equal(full.length, tr.FILL_EVENT_CAP, "capped at the server's limit");
});

test("tradeFillEvents (WO-50 E): one Fill money = every priced line of the trade, at its price each", () => {
  const lines = [
    { itemId: 206, name: "Xanax", qty: 40, priceEach: 830000, lineTotal: 33200000 },
    { itemId: 367, name: "Coupon", qty: 1, priceEach: null, lineTotal: null },
    { itemId: null, name: "Unknown", qty: 1, priceEach: 5, lineTotal: 5 },
    { itemId: 206, name: "Xanax", qty: 2, priceEach: 830000, lineTotal: 1660000 },
  ];
  assert.deepEqual(tr.tradeFillEvents(lines, 12345), [{ itemId: 206, price: 830000, kind: "trade", tradeId: 12345 }]);
  assert.deepEqual(tr.tradeFillEvents(lines, null), [{ itemId: 206, price: 830000, kind: "trade" }], "no trade id yet: still a trade fill");
  assert.deepEqual(tr.tradeFillEvents(undefined, 1), []);
});

test("netAfterFee takes Torn's 5% item market fee off a sale", () => {
  assert.equal(tr.netAfterFee(840000), 798000);
  assert.equal(tr.netAfterFee(999), 949, "rounds down — Torn never pays out a fraction");
  assert.equal(tr.netAfterFee(0), null);
  assert.equal(tr.netAfterFee(null), null);
  assert.equal(tr.netAfterFee("abc"), null);
});

test("flipAtMarket only calls a flip when resale at MV clears the fee by 1.5%", () => {
  const f = tr.flipAtMarket(700000, 840000);
  assert.equal(f.profit, 98000);
  assert.ok(Math.abs(f.pct - 14) < 1e-9);
  assert.equal(tr.flipAtMarket(798000, 840000), null, "exactly break-even is not a flip");
  assert.equal(tr.flipAtMarket(790000, 840000), null, "+1.0% after fee is under the bar");
  assert.equal(tr.flipAtMarket(785000, 840000).profit, 13000, "+1.66% clears it");
  assert.equal(tr.flipAtMarket(1, 840000), null, "$1 dollar-bazaar listings are ignored");
  assert.equal(tr.flipAtMarket(700000, null), null, "no market value, no flip");
});

// ---- WO-48 stocks: every expected number below is Torn's own or from Fulgrim's 2026-10-28 screens ----

const MCS = {
  id: 29,
  shares: 56881,
  transactions: [
    { id: 40286532, shares: 51695, price: 846.97, timestamp: 1793189024 },
    { id: 40286462, shares: 5186, price: 846.76, timestamp: 1793188976 },
  ],
  bonus: { available: false, increment: 0, progress: 0, frequency: 0 },
};
const SYM = {
  id: 16,
  shares: 500000,
  transactions: [{ id: 39184345, shares: 500000, price: 740.31, timestamp: 1791595582 }],
  bonus: { available: false, increment: 1, progress: 2, frequency: 7 },
};

test("stock sale fee and payout match Torn's sell confirmation exactly", () => {
  // "sell 1,217 shares at $825.23 … total of $1,003,299 after the 0.1% fee of $1,005"
  assert.equal(tr.stockSaleFee(1217 * 82523), 1005, "0.1% rounded UP, not to nearest ($1,004)");
  assert.equal(tr.stockPayout(1217, 825.23), 1003299);
  // The logged MCS sale: 3,901 × $846.87 → fees 3,304, worth 3,300,335.
  assert.equal(tr.stockPayout(3901, 846.87), 3300335);
  assert.equal(tr.stockSaleFee(1000 * 100400), 1004, "an exact whole-dollar fee is not bumped by float error");
});

test("stockLotNet: Torn's +$363 lot really loses after the fee", () => {
  assert.equal(tr.stockLotNet(5186, 846.76, 846.83), -4029);
  assert.equal(tr.stockLotNet(51695, 846.97, 846.83), -51015);
});

test("stockBreakeven: the lowest price that loses nothing after the fee", () => {
  assert.equal(tr.stockBreakeven(5186, 846.76), 847.61);
  assert.equal(tr.stockBreakeven(51695, 846.97), 847.82);
  assert.ok(tr.stockLotNet(5186, 846.76, 847.61) >= 0 && tr.stockLotNet(5186, 846.76, 847.60) < 0);
  assert.equal(tr.stockBreakeven(1, 800), 801, "one share still pays a whole-dollar fee");
});

test("stockVerdict: MCS at $847.32 — nothing in profit, nearest breakeven $847.61", () => {
  const v = tr.stockVerdict(MCS, 847.32);
  assert.equal(v.perk, false);
  assert.equal(v.profitableLots, 0);
  assert.equal(v.netIfSoldAll, -27201);
  assert.equal(v.nearestBreakeven, 847.61);
  assert.equal(v.newestFirstCount, null);
  assert.deepEqual(v.lots.map((l) => l.id), [40286532, 40286462], "newest first");
});

test("stockVerdict: the Fill count only when the profitable lots are the newest ones", () => {
  const both = tr.stockVerdict(MCS, 849);
  assert.equal(both.profitableLots, 2);
  assert.equal(both.newestFirstCount, 56881);
  // Older lot (5,186 @ 846.76) in profit, newest (846.97) not → typing a count would sell the loser.
  const olderOnly = tr.stockVerdict(MCS, 847.70);
  assert.equal(olderOnly.profitableLots, 1);
  assert.equal(olderOnly.newestFirstCount, null);
  const newestOnly = tr.stockVerdict({ ...MCS, transactions: [{ id: 2, shares: 10, price: 800, timestamp: 2 }, { id: 1, shares: 10, price: 900, timestamp: 1 }] }, 850);
  assert.equal(newestOnly.newestFirstCount, 10);
});

test("stockVerdict: a held perk is never checked", () => {
  const v = tr.stockVerdict(SYM, 900);
  assert.equal(v.perk, true);
});

test("perkWarning: SYM 500,000 at its 500,000 requirement — any sale loses the Drug Pack", () => {
  assert.deepEqual(tr.perkWarning(SYM, 500000, 100000), { held: 1, after: 0, left: 400000, needed: 500000 });
  assert.equal(tr.perkWarning(SYM, 500000, 0), null);
  assert.equal(tr.perkWarning(MCS, 350000, 1000), null, "no perk held, nothing to lose");
  // 2 increments need 500k + 1M = 1.5M; selling down to 1.2M drops to increment 1.
  const two = { ...SYM, shares: 1600000, bonus: { ...SYM.bonus, increment: 2 } };
  assert.equal(tr.perkSharesFor(500000, 2), 1500000);
  assert.deepEqual(tr.perkWarning(two, 500000, 400000), { held: 2, after: 1, left: 1200000, needed: 1500000 });
  assert.equal(tr.perkWarning(two, 500000, 100000), null, "1,500,000 left still holds both");
});

test("sellPreview: Torn's newest-lot-first, after the fee", () => {
  assert.deepEqual(tr.sellPreview(SYM, 739.56, 100000), { qty: 100000, payout: 73882044, fee: 73956, net: -148956 });
  // 51,695 newest @ 846.97 first, then 305 of the 846.76 lot.
  const p = tr.sellPreview(MCS, 846.83, 52000);
  assert.equal(p.qty, 52000);
  assert.equal(p.payout, tr.stockPayout(52000, 846.83));
  assert.equal(tr.sellPreview(MCS, 846.83, 999999).qty, 56881, "never more than you hold");
});

test("portfolioSummary: sold-all-now, closest, perks, 24h move", () => {
  const prices = new Map([[29, 847.32], [16, 739.56]]);
  const torn = new Map([[16, { id: 16, acronym: "SYM", bonus: { description: "1x Drug Pack" } }]]);
  const s = tr.portfolioSummary([MCS, SYM], prices, torn, new Map([[29, -2.71], [16, 3.44]]));
  assert.equal(s.owned, 2);
  assert.equal(s.soldAllNow, -27201 + tr.stockVerdict(SYM, 739.56).netIfSoldAll);
  assert.deepEqual(s.closest, { id: 29, price: 847.32, target: 847.61, gap: 847.61 - 847.32 });
  assert.equal(s.perksReady, 0);
  assert.deepEqual(s.nextPerk, { id: 16, days: 5, description: "1x Drug Pack" });
  assert.equal(s.priceMove, Math.round(56881 * -2.71 + 500000 * 3.44));
  assert.equal(s.priceMoveComplete, true);
  assert.equal(tr.portfolioSummary([MCS], prices, torn, new Map()).priceMove, null);
});

test("routeFor: the stock market page", () => {
  assert.equal(tr.routeFor(loc("/page.php", "?sid=stocks")), "stocks");
  assert.equal(tr.routeFor(loc("/page.php", "?sid=stocksX")), null);
});

// ── 0.7.4: assessment slice 3 — money-fill guards ─────────────────────────────

test("parseItemNode reads a quantity from a later OWN text node of the cell", () => {
  // First text node "Xanax", the count in a second direct text node.
  assert.deepEqual(tr.parseItemNode("Xanax ", "Xanax  x40"), { name: "Xanax", qty: 40 });
  assert.deepEqual(tr.parseItemNode("Xanax", "Xanax x40 $33,600,000"), { name: "Xanax", qty: 40 });
  // Inline count still wins as before.
  assert.deepEqual(tr.parseItemNode("Xanax x3", "Xanax x3 $2,520,000"), { name: "Xanax", qty: 3 });
  // No count anywhere: one.
  assert.deepEqual(tr.parseItemNode("Pair of Ice Skates", "Pair of Ice Skates $1,000"), { name: "Pair of Ice Skates", qty: 1 });
  // A digit-less "x" in a name is never a count.
  assert.deepEqual(tr.parseItemNode("Box of x Things", "Box of x Things"), { name: "Box of x Things", qty: 1 });
  assert.equal(tr.parseItemNode("", "Xanax x40"), null);
});

test("rarityFromClasses picks up Torn's rarity glow and nothing else", () => {
  assert.equal(tr.rarityFromClasses("item glow-yellow"), "yellow");
  assert.equal(tr.rarityFromClasses("glow-RED x"), "red");
  assert.equal(tr.rarityFromClasses("item glowing"), null);
  assert.equal(tr.rarityFromClasses(""), null);
});

test("tradeSignature changes when a line's rarity does", () => {
  const plain = tr.tradeSignature([{ name: "Kodachi", qty: 1 }]);
  const ranked = tr.tradeSignature([{ name: "Kodachi", qty: 1, rarity: "yellow" }]);
  assert.notEqual(plain, ranked);
});

test("pendingMoneyFor only offers the remembered total for the same trade", () => {
  const now = 1_800_000_000_000;
  const pending = { tradeId: 55, total: 1_000_000, at: now - 60_000, fills: [] };
  assert.equal(tr.pendingMoneyFor(pending, 55, now), pending);
  // The view URL named no trade but add-money does: the short window applies.
  assert.equal(tr.pendingMoneyFor({ ...pending, tradeId: null }, 55, now)?.total, pending.total);
  assert.equal(tr.pendingMoneyFor({ ...pending, tradeId: null, at: now - 6 * 60_000 }, 55, now), null);
  assert.equal(tr.pendingMoneyFor(pending, 56, now), null); // the NEXT trade
  // No id in the URL: only a fresh total (under 5 min) is offered.
  assert.equal(tr.pendingMoneyFor(pending, null, now), pending);
  assert.equal(tr.pendingMoneyFor({ ...pending, at: now - 6 * 60_000 }, null, now), null);
  // Stale or junk never.
  assert.equal(tr.pendingMoneyFor({ ...pending, at: now - 31 * 60_000 }, 55, now), null);
  assert.equal(tr.pendingMoneyFor({ ...pending, total: 0 }, 55, now), null);
  assert.equal(tr.pendingMoneyFor(null, 55, now), null);
});

test("fillMoneyBlocked: no Fill while pricing, after a FAILED re-price, or once the items differ", () => {
  assert.equal(tr.fillMoneyBlocked({ loading: true, resultSig: "a" }, "a"), true);
  assert.equal(tr.fillMoneyBlocked({ loading: false, resultSig: "a" }, "a"), false);
  assert.equal(tr.fillMoneyBlocked({ loading: false, resultSig: "a" }, "b"), true);
  // Review must-fix: items swapped A→B, re-price errored, the old A total is still on screen.
  assert.equal(tr.fillMoneyBlocked({ loading: false, error: "HTTP 500", resultSig: "a" }, "a"), true);
  assert.equal(tr.fillMoneyBlocked({ loading: false, error: "HTTP 500", resultSig: "a" }, "b"), true);
  // Nothing priced yet.
  assert.equal(tr.fillMoneyBlocked({ loading: false, resultSig: null }, "b"), true);
});

test("parseStock reads Torn's '(11 in stock)'", () => {
  assert.equal(tr.parseStock("Bag of Bloody Eyeballs $49,988 (11 in stock)"), 11);
  assert.equal(tr.parseStock("(1,250 in stock)"), 1250);
  assert.equal(tr.parseStock("no count here"), null);
});

test("maxAffordable: all in stock if the money covers it, else as many as it does", () => {
  assert.equal(tr.maxAffordable(49988, 11, 1006644), 11);
  assert.equal(tr.maxAffordable(49988, 30, 1006644), 20);
  assert.equal(tr.maxAffordable(49988, 11, 40000), 0);
  assert.equal(tr.maxAffordable(49988, null, 200000), 4);
  assert.equal(tr.maxAffordable(0, 5, 1000), 0);
  assert.equal(tr.maxAffordable(100, 5, NaN), 0);
});

test("notSellingLine: held 30+ days and nothing sold in 30 days (WO-53, same rule as the site)", () => {
  const now = Date.parse("2026-10-31T21:00:00.000Z");
  const ago = (d) => new Date(now - d * 86400000).toISOString();
  assert.equal(tr.notSellingLine({ onHand: 1046, oldestLotAt: ago(54), sold30d: 0 }, now), "You already hold 1,046 · none sold in 30 days");
  assert.equal(tr.notSellingLine({ onHand: 46, oldestLotAt: ago(54), sold30d: 2 }, now), "");
  assert.equal(tr.notSellingLine({ onHand: 46, oldestLotAt: ago(10), sold30d: 0 }, now), "");
  assert.equal(tr.notSellingLine({ onHand: 0, oldestLotAt: ago(54), sold30d: 0 }, now), "");
  assert.equal(tr.notSellingLine({ onHand: 3, oldestLotAt: "garbage", sold30d: 0 }, now), "");
  assert.equal(tr.notSellingLine({ onHand: 3, oldestLotAt: null, sold30d: 0 }, now), "");
  assert.equal(tr.notSellingLine(null, now), "");
  assert.equal(tr.notSellingLine(undefined, now), "");
});

test("isMaxLabel: spots an existing max control so the script doesn't stack a second one", () => {
  for (const t of ["Max", "max", " fill max ", "Fill  Max", "FILL MAX"]) assert.equal(tr.isMaxLabel(t), true, t);
  for (const t of ["Maximum", "fill", "Max 5", "", null, undefined, "Buy"]) assert.equal(tr.isMaxLabel(t), false, String(t));
});

test("vsCheapest: the site's bands, staleness and $1 guard (WO-53 MC-3)", () => {
  const now = Date.parse("2026-10-31T23:30:00Z");
  const fresh = (cheapest, extra = {}) => ({ cheapest, bazaarAverage: 1_000_000, listings: 40, capturedAt: "2026-10-31T23:00:00Z", ...extra });
  assert.equal(tr.vsCheapest(1_010_000, fresh(1_000_000), now).band, "competitive"); // +1%
  assert.equal(tr.vsCheapest(950_000, fresh(1_000_000), now).band, "competitive"); // under
  assert.equal(tr.vsCheapest(1_050_000, fresh(1_000_000), now).band, "above"); // +5%
  const far = tr.vsCheapest(1_126_000, fresh(1_000_000), now);
  assert.equal(far.band, "far_above");
  assert.equal(far.label, "+12.6%");
  assert.match(far.title, /vs cheapest bazaar \$1,000,000 · 40 listings · checked 30 min ago/);
  assert.equal(tr.vsCheapest(1_000_000, fresh(900_000, { capturedAt: "2026-10-31T19:00:00Z" }), now).band, "stale");
  assert.equal(tr.vsCheapest(1_000_000, fresh(null, { listings: 0 }), now).band, "nobody");
  assert.equal(tr.vsCheapest(1_000_000, fresh(1), now).band, "unclear"); // $1 display listing
  assert.equal(tr.vsCheapest(1_000_000, fresh(1, { listings: 5 }), now).band, "far_above"); // thin market: a real price
  assert.equal(tr.vsCheapest(1_000_000, null, now).label, "");
  assert.equal(tr.vsCheapest(null, fresh(1_000_000), now).label, "");
  assert.equal(tr.vsCheapest(1_000_000, fresh(1_000_000, { capturedAt: "nope" }), now).label, "");
  // One day is not a market: a one-day dip compares with the week; two days running compares with today.
  const dip = tr.vsCheapest(1_000_000, fresh(800_000, { weekCheapest: 1_000_000, yesterdayCheapest: 980_000 }), now);
  assert.equal(dip.band, "competitive");
  assert.match(dip.title, /vs the week's cheapest \$1,000,000 .* dipped today to \$800,000/);
  const falling = tr.vsCheapest(1_000_000, fresh(800_000, { weekCheapest: 1_000_000, yesterdayCheapest: 820_000 }), now);
  assert.equal(falling.band, "far_above");
  assert.match(falling.title, /vs cheapest bazaar \$800,000 .* falling/);
  assert.match(tr.vsCheapest(1_300_000, fresh(1_200_000, { weekCheapest: 1_000_000 }), now).title, /rising/);
});

test("targetsAge says how old the bazaar Fill targets are, and when a reload is worth it", () => {
  const now = Date.parse("2026-11-01T06:00:00Z");
  const min = 60000;
  assert.deepEqual(tr.targetsAge({}, now), { text: "", title: "", stale: false });

  const fresh = tr.targetsAge({ loadedAt: now - 20 * 1000, refsAt: now - 30 * 1000, marketAt: now - 10 * min }, now);
  assert.equal(fresh.text, "TARGETS FRESH");
  assert.equal(fresh.stale, false);
  assert.match(fresh.title, /Cheapest-listing scan 10m ago/);

  // The headline is the older of load time and market values.
  const mid = tr.targetsAge({ loadedAt: now - 5 * min, refsAt: now - 47 * min }, now);
  assert.equal(mid.text, "TARGETS 47M OLD");
  assert.equal(mid.stale, false);

  const old = tr.targetsAge({ loadedAt: now - 95 * min, refsAt: now - 150 * min, marketAt: now - 4 * 60 * min }, now);
  assert.equal(old.text, "TARGETS 2H 30M OLD");
  assert.equal(old.stale, true);
  assert.match(old.title, /^Worth a reload: loaded a while ago.*market values are old; cheapest-listing scan is old\./);

  const noRefs = tr.targetsAge({ loadedAt: now - 2 * 60 * min }, now);
  assert.equal(noRefs.text, "TARGETS 2H OLD");
  assert.match(noRefs.title, /Market value age unknown/);
});

test("sellModeOf keeps the three modes and nothing else", () => {
  assert.equal(tr.sellModeOf("bazaar"), "bazaar");
  assert.equal(tr.sellModeOf("market"), "market");
  assert.equal(tr.sellModeOf("trade"), "trade");
  assert.equal(tr.sellModeOf("Bazaar"), null);
  assert.equal(tr.sellModeOf(null), null);
});

test("showsMarketPct: only item-market sellers (and not-yet-chosen) see % of market", () => {
  assert.equal(tr.showsMarketPct("market"), true);
  assert.equal(tr.showsMarketPct(null), true);
  assert.equal(tr.showsMarketPct("bazaar"), false);
  assert.equal(tr.showsMarketPct("trade"), false);
});

test("resaleFor: market = flip after the 5% fee; bazaar = your sell-list price, no fee; trade = none", () => {
  // MV 1,000 nets 950; buying at 900 = +50 (5.6%).
  assert.deepEqual(tr.resaleFor("market", 900, 1000, null), { profit: 50, pct: (50 / 900) * 100, via: "market" });
  assert.deepEqual(tr.resaleFor(null, 900, 1000, null), { profit: 50, pct: (50 / 900) * 100, via: "market" });
  // Bazaar ignores MV: sell list 1,000 against 900 = +100, no fee.
  assert.deepEqual(tr.resaleFor("bazaar", 900, 5000, 1000), { profit: 100, pct: (100 / 900) * 100, via: "bazaar" });
  assert.equal(tr.resaleFor("bazaar", 900, 5000, null), null);       // no sell-list price
  assert.equal(tr.resaleFor("bazaar", 1000, null, 1010), null);       // +1.0% is under the 1.5% bar
  assert.equal(tr.resaleFor("bazaar", 1, null, 1000), null);          // $1 display listing
  assert.equal(tr.resaleFor("trade", 100, 1000, 1000), null);
});

test("resaleVerdict (WO-80): a sell-list price far over the cheapest bazaar is not a resale", () => {
  // Spray Paint : Red, 2026-11-07: ask $399, sell list $510, cheapest bazaar $369.
  const now = Date.parse("2026-11-07T23:00:00Z");
  const market = { cheapest: 369, bazaarAverage: 380, listings: 12, capturedAt: "2026-11-07T22:40:00Z", weekCheapest: 372, yesterdayCheapest: 370 };
  const v = tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: 510, market, stock: null }, now);
  assert.equal(v.kind, "target_high");
  assert.equal(v.label, "+38% over market");
  assert.match(v.title, /sell-list price \$510/);
  assert.match(v.title, /Bazaar tab/);
  // Within 10% of the cheapest: the green resale stays.
  const near = tr.resaleVerdict({ mode: "bazaar", ask: 340, marketValue: 383, sellAt: 395, market, stock: null }, now);
  assert.equal(near.kind, "resale");
  assert.equal(near.label, "resell +$55 (16.2%)");
  assert.match(near.title, /\+7\.0% vs cheapest bazaar \$369/);
  // No verdict possible (stale snapshot): still green, but says the cheapest listing is unchecked.
  const stale = tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: 510, market: { ...market, capturedAt: "2026-11-07T10:00:00Z" }, stock: null }, now);
  assert.equal(stale.kind, "resale");
  assert.match(stale.title, /sell-list price \$510/);
  // Market mode never looks at the sell list.
  const mk = tr.resaleVerdict({ mode: "market", ask: 300, marketValue: 383, sellAt: 510, market, stock: null }, now);
  assert.equal(mk.kind, "resale");
  assert.equal(mk.resale.via, "market");
  assert.equal(tr.resaleVerdict({ mode: "trade", ask: 300, marketValue: 383, sellAt: 510, market, stock: null }, now), null);
});

test("resaleVerdict (WO-80): stock you hold that isn't selling beats any resale, in every mode", () => {
  const now = Date.parse("2026-11-07T23:00:00Z");
  const ago = (d) => new Date(now - d * 86400000).toISOString();
  const stuck = { onHand: 28, oldestLotAt: ago(54), sold30d: 0 };
  const market = { cheapest: 369, bazaarAverage: 380, listings: 12, capturedAt: "2026-11-07T22:40:00Z", weekCheapest: 372, yesterdayCheapest: 370 };
  const v = tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: 510, market, stock: stuck }, now);
  assert.equal(v.kind, "hold");
  assert.equal(v.label, "HOLD 28 · NOT SELLING");
  assert.match(v.title, /^You already hold 28 · none sold in 30 days/);
  assert.match(v.title, /sell-list price \$510/);
  // Even with a real resale on offer.
  const m = tr.resaleVerdict({ mode: "market", ask: 300, marketValue: 383, sellAt: null, market: null, stock: stuck }, now);
  assert.equal(m.kind, "hold");
  assert.match(m.title, /flip \+\$63/);
  // Recently bought or still selling: no hold.
  assert.equal(tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: null, market: null, stock: { onHand: 28, oldestLotAt: ago(54), sold30d: 3 } }, now), null);
  assert.equal(tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: null, market: null, stock: { onHand: 28, oldestLotAt: ago(5), sold30d: 0 } }, now), null);
});

test("resaleLabel names the route", () => {
  assert.equal(tr.resaleLabel({ profit: 100, pct: 11.11, via: "bazaar" }), "resell +$100 (11.1%)");
  assert.equal(tr.resaleLabel({ profit: 50, pct: 5.55, via: "market" }), "flip +$50 (5.5%)");
});

// ---- 0.8.0 (WO-66): deal alerts ----------------------------------------------------------

test("isTradingPage: trading modules only on their pages; alerts everywhere else", () => {
  assert.equal(tr.isTradingPage(loc("/trade.php")), true);
  assert.equal(tr.isTradingPage(loc("/item.php")), true);
  assert.equal(tr.isTradingPage(loc("/page.php", "?sid=ItemMarket")), true);
  assert.equal(tr.isTradingPage(loc("/gym.php")), false);
  assert.equal(tr.isTradingPage(loc("/index.php")), false);
});

test("itemMarketDealFor: cheapest listing at/under the buy price, $1 listings ignored", () => {
  const item = { itemId: 206, name: "Xanax", buyPrice: 800000 };
  const deal = tr.itemMarketDealFor(item, [{ price: 1, amount: 1 }, { price: 790000, amount: 2 }, { price: 800000, quantity: 3 }, { price: 820000, amount: 5 }]);
  assert.deepEqual(deal, { source: "market", itemId: 206, name: "Xanax", buyPrice: 800000, price: 790000, qtyUnder: 5, sellerId: null, sellerName: null, underPct: 1.3 });
  assert.equal(tr.itemMarketDealFor(item, [{ price: 900000, amount: 1 }]), null);
  assert.equal(tr.itemMarketDealFor({ ...item, buyPrice: 0 }, [{ price: 5, amount: 1 }]), null);
  assert.equal(tr.itemMarketDealFor(item, undefined), null);
});

test("mergeDeals: bazaar + item market, off-list item-market leftovers dropped, biggest discount first", () => {
  const watched = [{ itemId: 1 }, { itemId: 2 }];
  const merged = tr.mergeDeals(
    [{ itemId: 1, price: 90, underPct: 10 }],
    [{ source: "market", itemId: 2, price: 95, underPct: 20 }, { source: "market", itemId: 3, price: 1, underPct: 99 }, null],
    watched,
  );
  assert.deepEqual(merged.map((d) => [d.source, d.itemId]), [["market", 2], ["bazaar", 1]]);
});

test("unseenDeals / dealKey: a seen deal stays seen until its price changes", () => {
  const d = { source: "bazaar", itemId: 1, price: 90 };
  assert.equal(tr.dealKey(d), "bazaar:1:90");
  assert.equal(tr.unseenDeals([d], ["bazaar:1:90"]).length, 0);
  assert.equal(tr.unseenDeals([{ ...d, price: 85 }], ["bazaar:1:90"]).length, 1);
  assert.equal(tr.unseenDeals([d], undefined).length, 1);
});

test("pickMarketChecks rotates through the buy list", () => {
  const w = [1, 2, 3, 4, 5].map((itemId) => ({ itemId }));
  assert.deepEqual(tr.pickMarketChecks(w, 0, 2).map((x) => x.itemId), [1, 2]);
  assert.deepEqual(tr.pickMarketChecks(w, 1, 2).map((x) => x.itemId), [3, 4]);
  assert.deepEqual(tr.pickMarketChecks(w, 2, 2).map((x) => x.itemId), [5, 1]);
  assert.deepEqual(tr.pickMarketChecks(w.slice(0, 2), 7, 4).map((x) => x.itemId), [1, 2]);
});

test("priceLineIndex counts the cheapest-first rows at or under the price", () => {
  assert.equal(tr.priceLineIndex([774000, 790500, 801000, 810000], 798000), 2);
  assert.equal(tr.priceLineIndex([810000], 798000), 0);
  assert.equal(tr.priceLineIndex([700, 800], 900), 2);
  assert.equal(tr.priceLineIndex([700], null), -1);
});

test("minutesAgo reads like a person", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(tr.minutesAgo("2026-11-06T11:59:40Z", now), "just now");
  assert.equal(tr.minutesAgo("2026-11-06T11:55:00Z", now), "5 min ago");
  assert.equal(tr.minutesAgo("nope", now), "");
});

// ---- 0.8.5 (WO-85): free stock on Manage rows ---------------------------------------------

test("prefillQty (WO-83): fills an empty box with what you can afford, never a typed one", () => {
  assert.deepEqual(tr.prefillQty(300, 4, 1_000_000, ""), { qty: 4, line: "max · $1,200 total" });
  assert.deepEqual(tr.prefillQty(300, 4, 700, ""), { qty: 2, line: "max · $600 total" });
  assert.deepEqual(tr.prefillQty(300, null, 700, ""), { qty: 2, line: "max · $600 total" });
  assert.deepEqual(tr.prefillQty(22_000, 6, 5_000, ""), { qty: 0, line: "can't afford one" });
  assert.equal(tr.prefillQty(300, 4, 1_000_000, "1"), null);
  assert.equal(tr.prefillQty(300, 4, null, ""), null);
  assert.equal(tr.prefillQty(null, 4, 1_000, ""), null);
});

test("freeLabel: all-free stock says FREE and names the source; mixed says how many; a gift is unknown", () => {
  assert.deepEqual(tr.freeLabel({ freeUnits: 81, unknownUnits: 0, paidUnits: 0, freeWords: ["loot"] }).text, "FREE · LOOT");
  assert.equal(tr.freeLabel({ freeUnits: 81, unknownUnits: 0, paidUnits: 0, freeWords: ["loot"] }).kind, "free");
  assert.equal(tr.freeLabel({ freeUnits: 14, unknownUnits: 0, paidUnits: 4, freeWords: ["found"] }).text, "14 FREE");
  const gift = tr.freeLabel({ freeUnits: 0, unknownUnits: 1, paidUnits: 0, freeWords: [] });
  assert.equal(gift.text, "GIFT · COST UNKNOWN");
  assert.equal(gift.kind, "unknown");
});

test("freeLabel: bought stock, no stock and a pre-WO-85 server show nothing", () => {
  assert.equal(tr.freeLabel({ freeUnits: 0, unknownUnits: 0, paidUnits: 3, freeWords: [] }), null);
  assert.equal(tr.freeLabel({ freeUnits: 0, unknownUnits: 0, paidUnits: 0, freeWords: [] }), null);
  assert.equal(tr.freeLabel(null), null);
  assert.equal(tr.freeLabel(undefined), null);
});

test("settleOnce fires once after the first call, however often it is re-armed (0.8.7)", () => {
  // Torn's sidebar countdowns re-run the bazaar module every second; a debounce that
  // restarts on each run never fires, which is how the Add page stopped being sent.
  const queued = [];
  const arm = tr.settleOnce(3000, { set: (fn, ms) => queued.push({ fn, ms }) });
  let sent = 0;
  assert.equal(arm(() => { sent += 1; }), true);
  for (let i = 0; i < 10; i += 1) assert.equal(arm(() => { sent += 100; }), false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].ms, 3000);
  queued[0].fn();
  assert.equal(sent, 1);
  // After it fired, the next call arms a new one.
  assert.equal(arm(() => { sent += 1; }), true);
  assert.equal(queued.length, 2);
});
