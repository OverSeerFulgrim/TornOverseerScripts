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

test("0.8.45 manageVerdict: red only when the listing costs you (plan step 8)", () => {
  const now = Date.parse("2026-11-27T20:00:00Z");
  const fresh = (cheapest) => ({ cheapest, listings: 30, bazaarAverage: cheapest, capturedAt: "2026-11-27T19:30:00Z" });
  // RS232 Cable: −1.97% is not red (0.8.44 rounded it to −2 and went red).
  assert.equal(tr.manageVerdict(298, { sellAt: 304 }, fresh(300), now).off, false);
  // Fertilizer: +7.8% over target, under the market's far band → gold.
  assert.equal(tr.manageVerdict(3233, { sellAt: 2998 }, fresh(3200), now).off, false);
  // Silver Coin: +12% over target AND >10% over the cheapest bazaar → red.
  const coin = tr.manageVerdict(36432, { sellAt: 32499 }, fresh(32000), now);
  assert.equal(coin.off, true);
  assert.match(coin.hint, /over the cheapest bazaar/);
  // Chopsticks: 14.3% under the sell-list price → red.
  assert.equal(tr.manageVerdict(25699, { sellAt: 29999 }, fresh(26000), now).off, true);
  // Under the floor is always red.
  assert.equal(tr.manageVerdict(900, { sellAt: 1000, floor: 950 }, null, now).off, true);
  // Within 2% → ≈, not red.
  assert.equal(tr.manageVerdict(1975, { sellAt: 1955 }, null, now).text, "≈");
  // No market read: >10% over your own sell price is still red.
  assert.equal(tr.manageVerdict(350, { sellAt: 300 }, null, now).off, true);
  assert.equal(tr.manageVerdict(320, { sellAt: 300 }, null, now).off, false);
  assert.equal(tr.MANAGE_OFF_PCT, 10);
});

test("0.8.45 fixPrice: never fills above the cheapest bazaar + 2%, never under the floor", () => {
  const now = Date.parse("2026-11-27T20:00:00Z");
  const market = { cheapest: 1530, listings: 72, bazaarAverage: 1987, capturedAt: "2026-11-27T19:30:00Z" };
  // Microwave: sell list $2,224 vs cheapest $1,530 → filled at 1,561, not 2,224.
  assert.equal(tr.fixPrice({ sellAt: 2224 }, market, now), 1561);
  assert.equal(tr.fixPrice({ sellAt: 2224, floor: 1600 }, market, now), 1600);
  assert.equal(tr.fixPrice({ sellAt: 1500 }, market, now), 1500);
  assert.equal(tr.fixPrice({ sellAt: 2224 }, null, now), 2224);
  assert.equal(tr.fixPrice(null, market, now), null);
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

test("resaleVerdict (WO-80, 0.8.28): a sell-list price far over the cheapest bazaar is not a resale — and no chip", () => {
  // Spray Paint : Red, 2026-11-07: ask $399, sell list $510, cheapest bazaar $369.
  const now = Date.parse("2026-11-07T23:00:00Z");
  const market = { cheapest: 369, bazaarAverage: 380, listings: 12, capturedAt: "2026-11-07T22:40:00Z", weekCheapest: 372, yesterdayCheapest: 370 };
  const v = tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: 510, market, stock: null }, now);
  assert.equal(v, null);
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

test("resaleVerdict (WO-80, 0.8.28): stock you hold that isn't selling gets no chip, in every mode", () => {
  const now = Date.parse("2026-11-07T23:00:00Z");
  const ago = (d) => new Date(now - d * 86400000).toISOString();
  const stuck = { onHand: 28, oldestLotAt: ago(54), sold30d: 0 };
  const market = { cheapest: 369, bazaarAverage: 380, listings: 12, capturedAt: "2026-11-07T22:40:00Z", weekCheapest: 372, yesterdayCheapest: 370 };
  const v = tr.resaleVerdict({ mode: "bazaar", ask: 399, marketValue: 383, sellAt: 510, market, stock: stuck }, now);
  assert.equal(v, null);
  // Even with a real resale on offer: no green on stuck stock.
  assert.equal(tr.resaleVerdict({ mode: "market", ask: 300, marketValue: 383, sellAt: null, market: null, stock: stuck }, now), null);
  assert.equal(tr.resaleVerdict({ mode: "market", ask: 300, marketValue: 383, sellAt: null, market: null, stock: null }, now).kind, "resale");
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

test("realisticResale (WO-89): the market's own exits, not your target", () => {
  const now = Date.parse("2026-11-08T22:00:00Z");
  const market = { cheapest: 250, bazaarAverage: 270, listings: 10, capturedAt: "2026-11-08T21:50:00Z", weekCheapest: 255, yesterdayCheapest: 252 };
  // Dozen Roses, 2026-11-08: ask $255 vs bazaar low $250 — nothing realistic, however cheap vs MV ($286).
  assert.equal(tr.realisticResale(255, { market, itemMarketLow: null }, now), null);
  // Funeral Wreath: ask $200, bazaar low $200, but the item market's low is $369 → $350 after fee.
  const wreath = tr.realisticResale(200, { market: { ...market, cheapest: 200 }, itemMarketLow: 369 }, now);
  assert.equal(wreath.via, "item_market");
  assert.equal(wreath.net, 350);
  assert.equal(wreath.profit, 150);
  // Matching the bazaar low counts when it clears 5%: ask $230 vs low $250 = 8.7%.
  const bz = tr.realisticResale(230, { market, itemMarketLow: null }, now);
  assert.equal(bz.via, "bazaar_low");
  assert.equal(bz.profit, 20);
  // Under 5% is not called: ask $240 vs $250 = 4.2%.
  assert.equal(tr.realisticResale(240, { market, itemMarketLow: null }, now), null);
  // The better of the two wins; a stale snapshot, a $1 display low or a listing-less market drop out.
  assert.equal(tr.realisticResale(200, { market, itemMarketLow: 369 }, now).via, "item_market");
  assert.equal(tr.realisticResale(200, { market: { ...market, capturedAt: "2026-11-08T10:00:00Z" }, itemMarketLow: null }, now), null);
  assert.equal(tr.realisticResale(200, { market: { ...market, cheapest: 1, listings: 30 }, itemMarketLow: null }, now), null);
  assert.equal(tr.realisticResale(200, { market: { ...market, listings: 0 }, itemMarketLow: null }, now), null);
  assert.equal(tr.realisticResale(1, { market, itemMarketLow: 369 }, now), null);
});

test("resaleVerdict (WO-89): a stale high target no longer hides a real resale; below-cost prompts a buy", () => {
  const now = Date.parse("2026-11-08T22:00:00Z");
  const market = { cheapest: 250, bazaarAverage: 270, listings: 10, capturedAt: "2026-11-08T21:50:00Z", weekCheapest: 255, yesterdayCheapest: 252 };
  // Roses: target $280 is +12% over the $250 low and no market exit beats $255 → no chip (0.8.28).
  assert.equal(tr.resaleVerdict({ mode: "bazaar", ask: 255, marketValue: 286, sellAt: 280, market, stock: null, quote: { avgCost: null, avgCostQty: 0 } }, now), null);
  // Wreath: same stale target, but the item market pays $350 after fee → green, says where.
  const wreath = tr.resaleVerdict({ mode: "bazaar", ask: 200, marketValue: 246, sellAt: 240, market: { ...market, cheapest: 200, weekCheapest: 205, yesterdayCheapest: 203 }, stock: null, quote: null, itemMarketLow: 369 }, now);
  assert.equal(wreath.kind, "resale");
  assert.equal(wreath.label, "resell +$150 (75.0%)");
  assert.match(wreath.title, /item market at its low \$369/);
  assert.match(wreath.title, /sell-list price \$240/);
  assert.equal(tr.verdictIsGreen(wreath), true);
  // Below your cost: you hold 12 at $265, listing $230 (13% under) → green buy prompt, before any target warning.
  const cost = tr.resaleVerdict({ mode: "bazaar", ask: 230, marketValue: 286, sellAt: 300, market: { ...market, cheapest: 235 }, stock: null, quote: { avgCost: 265, avgCostQty: 12 } }, now);
  assert.equal(cost.kind, "below_cost");
  assert.equal(cost.label, "BELOW YOUR COST $265");
  assert.match(cost.title, /average down to \$248/);
  assert.equal(tr.verdictIsGreen(cost), true);
  // …but stuck stock still beats everything: no chip at all.
  const stuck = { onHand: 12, oldestLotAt: "2026-09-01T00:00:00Z", sold30d: 0 };
  assert.equal(tr.resaleVerdict({ mode: "bazaar", ask: 230, marketValue: 286, sellAt: 300, market, stock: stuck, quote: { avgCost: 265, avgCostQty: 12 }, itemMarketLow: 500 }, now), null);
  // A realistic resale clears before below-cost does.
  const both = tr.resaleVerdict({ mode: "bazaar", ask: 200, marketValue: 286, sellAt: 300, market, stock: null, quote: { avgCost: 265, avgCostQty: 12 } }, now);
  assert.equal(both.kind, "resale");
  assert.match(both.title, /matching the cheapest bazaar \$250/);
  // Market mode is untouched by all of it.
  const mk = tr.resaleVerdict({ mode: "market", ask: 230, marketValue: 286, sellAt: 300, market, stock: null, quote: { avgCost: 265, avgCostQty: 12 } }, now);
  assert.equal(mk.kind, "resale");
  assert.equal(mk.resale.via, "market");
});

test("belowCost / itemMarketLowFrom (WO-89)", () => {
  assert.equal(tr.belowCost(230, { avgCost: 265, avgCostQty: 12 }).after, 248);
  assert.equal(tr.belowCost(262, { avgCost: 265, avgCostQty: 12 }), null);   // only 1.1% under
  assert.equal(tr.belowCost(230, { avgCost: 265, avgCostQty: 0 }), null);    // nothing held
  assert.equal(tr.belowCost(230, { avgCost: null, avgCostQty: 3 }), null);   // no known cost
  assert.equal(tr.belowCost(1, { avgCost: 265, avgCostQty: 12 }), null);     // $1 display listing
  assert.equal(tr.belowCost(230, null), null);
  assert.equal(tr.itemMarketLowFrom([{ price: 400 }, { price: 369, amount: 2 }, { price: 1 }, { price: "x" }]), 369);
  assert.equal(tr.itemMarketLowFrom([]), null);
  assert.equal(tr.itemMarketLowFrom(null), null);
});

test("bazaarWorth (0.8.11): listed × stock, paid and profit when the ledger knows the cost", () => {
  const w = tr.bazaarWorth([
    { listed: 84_999, held: 1, costEach: 68_555, sellAt: 84_998 },
    { listed: 36_968, held: 12, costEach: 33_500, sellAt: 36_968 },
    { listed: null, held: 2, costEach: 100, sellAt: 2_730 },       // no price typed
    { listed: 1, held: 1, costEach: null, sellAt: null },           // Torn's $1 placeholder
  ]);
  assert.equal(w.items, 4);
  assert.equal(w.listed, 84_999 + 36_968 * 12);
  assert.equal(w.unpriced, 2);
  assert.equal(w.paid, 68_555 + 33_500 * 12 + 200);
  assert.equal(w.profit, (84_999 - 68_555) + (36_968 - 33_500) * 12);
  assert.equal(w.atTargets, 84_998 + 36_968 * 12 + 2_730 * 2);
  // No cost anywhere → paid/profit unknown, not zero.
  const nc = tr.bazaarWorth([{ listed: 500, held: 3, costEach: null, sellAt: null }]);
  assert.equal(nc.listed, 1500); assert.equal(nc.paid, null); assert.equal(nc.profit, null);
  assert.equal(tr.bazaarWorth([]), null);
  assert.equal(tr.bazaarWorth(null), null);
});

test("pickMarketChecks re-checks the items showing a deal first, then rotates (0.8.12)", () => {
  const w = Array.from({ length: 10 }, (_, i) => ({ itemId: i + 1 }));
  // Item 9 shows a deal read 20 min ago, item 7 one read 10 min ago; 3 had none.
  const market = { 9: { at: 1_000, deal: { itemId: 9 } }, 7: { at: 2_000, deal: { itemId: 7 } }, 3: { at: 500, deal: null } };
  assert.deepEqual(tr.pickMarketChecks(w, 0, 4, market).map((x) => x.itemId), [9, 7, 1, 2]);
  // No duplicates when the rotation reaches a deal item.
  assert.deepEqual(tr.pickMarketChecks(w, 2, 4, market).map((x) => x.itemId), [9, 7, 10, 1]);
  // More deals than slots: oldest reads win.
  const busy = { 1: { at: 50, deal: {} }, 2: { at: 40, deal: {} }, 3: { at: 30, deal: {} }, 4: { at: 20, deal: {} }, 5: { at: 10, deal: {} } };
  assert.deepEqual(tr.pickMarketChecks(w, 0, 4, busy).map((x) => x.itemId), [5, 4, 3, 2]);
  // Old signature unchanged.
  assert.deepEqual(tr.pickMarketChecks(w, 1, 2).map((x) => x.itemId), [3, 4]);
});

test("liveMarketDeals hides item-market deals older than 15 minutes (0.8.12)", () => {
  const now = 10_000_000;
  const market = {
    1: { at: now - 14 * 60_000, deal: { itemId: 1 } },
    2: { at: now - 16 * 60_000, deal: { itemId: 2 } }, // the stale Resupply Box
    3: { at: now, deal: null },
  };
  assert.deepEqual(tr.liveMarketDeals(market, now).map((d) => d.itemId), [1]);
  assert.deepEqual(tr.liveMarketDeals(market, now, 20 * 60_000).map((d) => d.itemId), [1, 2]);
  assert.deepEqual(tr.liveMarketDeals(undefined, now), []);
});

test("dealMinOf keeps only the offered minimums (0.8.13)", () => {
  assert.equal(tr.dealMinOf(5), 5);
  assert.equal(tr.dealMinOf("10"), 10);
  assert.equal(tr.dealMinOf(20), 20);
  assert.equal(tr.dealMinOf(8), 0);
  assert.equal(tr.dealMinOf(null), 0);
  assert.equal(tr.dealMinOf("junk"), 0);
});

test("splitDealsByMin hides deals under the minimum and counts them (0.8.13)", () => {
  const kit = { itemId: 1, underPct: 16.3 };
  const morph = { itemId: 2, underPct: 3.2 };
  const at = { itemId: 3, underPct: 0 };
  const all = tr.splitDealsByMin([kit, morph, at], 0);
  assert.deepEqual(all.shown, [kit, morph, at]);
  assert.deepEqual(all.hidden, []);
  const five = tr.splitDealsByMin([kit, morph, at], 5);
  assert.deepEqual(five.shown, [kit]);
  assert.deepEqual(five.hidden, [morph, at]);
  const twenty = tr.splitDealsByMin([kit, morph], 20);
  assert.deepEqual(twenty.shown, []);
  assert.equal(twenty.hidden.length, 2);
  assert.deepEqual(tr.splitDealsByMin([{ itemId: 4, underPct: 5 }], 5).shown.length, 1);
  assert.deepEqual(tr.splitDealsByMin(null, 5), { shown: [], hidden: [] });
  // An unknown saved value acts as "Any".
  assert.equal(tr.splitDealsByMin([morph], 7).shown.length, 1);
});

test("dealBadge says the % is under your price (0.8.13)", () => {
  assert.equal(tr.dealBadge(16.3), "16% under your price");
  assert.equal(tr.dealBadge(3.2), "3.2% under your price");
  assert.equal(tr.dealBadge(0.3), "0.3% under your price");
  assert.equal(tr.dealBadge(0), "at your price");
  assert.equal(tr.dealBadge(undefined), "at your price");
});

test("WO-93 stripCards: five by default, all once opened", () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ price: 100 + i }));
  const folded = tr.stripCards(list, false);
  assert.equal(folded.shown.length, tr.STRIP_SHOW);
  assert.equal(folded.hidden, 7);
  assert.deepEqual(tr.stripCards(list, true), { shown: list, hidden: 0 });
  assert.deepEqual(tr.stripCards(list.slice(0, 3), false), { shown: list.slice(0, 3), hidden: 0 });
  assert.deepEqual(tr.stripCards(undefined, false), { shown: [], hidden: 0 });
});

test("WO-93 stripCountLabel and stripMinHeight", () => {
  assert.equal(tr.stripCountLabel(5, 20), "· cheapest bazaars 5 of 20");
  assert.equal(tr.stripCountLabel(4, 4), "· 4 cheapest bazaars");
  assert.equal(tr.stripCountLabel(1, 1), "· 1 cheapest bazaar");
  assert.equal(tr.stripMinHeight(168.4), 168);
  for (const bad of [null, undefined, "x", 10, 5000]) assert.equal(tr.stripMinHeight(bad), null);
});

test("WO-93 C keep 1: OC and crime items list one fewer on Add", () => {
  assert.deepEqual(tr.usesOf(["crime", "oc", "x"]), ["oc", "crime"]);
  assert.equal(tr.keepsOne(["oc", "crime"]), true);
  assert.equal(tr.keepsOne(["use"]), false);
  assert.equal(tr.keepQty(1, ["crime"]), 0); // the last Jemmy stays
  assert.equal(tr.keepQty(3, ["oc"]), 2);
  assert.equal(tr.keepQty(12, ["use"]), 12);
  assert.equal(tr.keepQty(5, undefined), 5);
  // 0.8.44 (WO-106): a Sell-list keep count (the insurance reserve) caps what is listed.
  assert.equal(tr.keepQty(322, ["use"], 300), 22);
  assert.equal(tr.keepQty(250, ["use"], 300), 0);
  assert.equal(tr.keepQty(3, ["oc"], 1), 2);
  assert.equal(tr.reserveQty(322, 300), 22);
  assert.equal(tr.reserveQty(322, null), 322);
  assert.equal(tr.reserveQty(10, "x"), 10);
});

test("WO-93 C matchesUse: All, a tag, and rows still loading", () => {
  assert.equal(tr.matchesUse(["oc"], null), true);
  assert.equal(tr.matchesUse(["oc"], "oc"), true);
  assert.equal(tr.matchesUse(["use"], "none"), false);
  assert.equal(tr.matchesUse(null, "none"), true);
});

test("keyStatusLabel says which key the script holds, never the whole key", () => {
  assert.equal(tr.keyStatusLabel("abcdEFGH12345678", ""), "A key is saved (ends …5678).");
  assert.equal(tr.keyStatusLabel("  abcdEFGH12345678 ", "pdaKEY"), "A key is saved (ends …5678).");
  assert.equal(tr.keyStatusLabel("", "pdaKEY"), "Using the key Torn PDA provides.");
  assert.equal(tr.keyStatusLabel("", ""), "No key saved yet.");
  assert.equal(tr.keyStatusLabel(null, undefined), "No key saved yet.");
});

// ---- 0.8.25: keep 1 switch + matching Manage rows ------------------------------------------

test("toggleKeepOff / keepOffIds: one saved list of item ids, toggled one at a time", () => {
  assert.deepEqual(tr.toggleKeepOff(undefined, 568), [568]);
  assert.deepEqual(tr.toggleKeepOff([568, 10], 568), [10]);
  assert.deepEqual(tr.toggleKeepOff(["junk", 10], "4"), [4, 10]);
  assert.equal(tr.keepOffIds([568]).has(568), true);
  assert.equal(tr.keepOffIds(null).size, 0);
});

test("priceMatches: only an exact match (Torn's $1 placeholder never counts)", () => {
  assert.equal(tr.priceMatches(25363, 25363), true);
  assert.equal(tr.priceMatches(4898, 4855), false);
  assert.equal(tr.priceMatches(1, 1), false);
  assert.equal(tr.priceMatches(null, 300), false);
  assert.equal(tr.priceMatches(300, null), false);
});

test("resaleVerdict (0.8.31): a bazaar resale is judged against the live floor, not only the snapshot", () => {
  // Hydrogen Tank, 2026-11-26: bazaar $23,000, snapshot cheapest $26,984, item market low $22,278,
  // sell list $22,650. Used to read "resell +$3,984 (17.3%)".
  const now = Date.parse("2026-11-26T12:20:00Z");
  const market = { cheapest: 26984, bazaarAverage: 28000, listings: 20, capturedAt: "2026-11-26T11:00:00Z", weekCheapest: 26500, yesterdayCheapest: 26800 };
  const base = { mode: "bazaar", ask: 23000, marketValue: 22278, sellAt: 22650, market, stock: null, quote: null };
  assert.equal(tr.resaleVerdict(base, now).kind, "resale"); // snapshot alone: the old answer
  assert.equal(tr.resaleVerdict({ ...base, itemMarketLow: 22278, bazaarLow: 27200 }, now), null);
  // The cap: a bazaar exit never sits above the item-market low.
  const r = tr.realisticResale(20000, { market, itemMarketLow: 22278, bazaarLow: 27200 }, now);
  assert.equal(r.via, "bazaar_low");
  assert.equal(r.at, 22278);
  assert.equal(r.capped, "item_market");
  // A live bazaar cheaper than the snapshot wins too.
  assert.equal(tr.realisticResale(20000, { market, bazaarLow: 24000 }, now).at, 24000);
  // A sell-list price >10% over the live item-market low is no resale either.
  assert.equal(tr.resaleVerdict({ ...base, ask: 20000, sellAt: 26000, market: null, itemMarketLow: 22278 }, now).label, "resell +$1,164 (5.8%)"); // the item market after fee, not $26,000
  assert.match(tr.resaleVerdict({ ...base, ask: 20000, sellAt: 26000, market: null, itemMarketLow: 22278 }, now).title, /item market at its low \$22,278/);
});

test("0.8.32: Item Market sellers get no green % OF MARKET mark on stock that isn't selling", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const stuck = { onHand: 12, oldestLotAt: "2026-09-01T00:00:00Z", sold30d: 0 };
  const selling = { onHand: 12, oldestLotAt: "2026-09-01T00:00:00Z", sold30d: 3 };
  // $850 on a $1,000 item with a 90% deal line → 85% OF MARKET.
  assert.equal(tr.marketPctDeal("market", 850, 1000, 90, null, now), 85);
  assert.equal(tr.marketPctDeal("market", 850, 1000, 90, selling, now), 85);
  assert.equal(tr.marketPctDeal("market", 850, 1000, 90, stuck, now), null);
  // Not a deal, a $1 display listing, or a sell mode that doesn't use this mark → nothing.
  assert.equal(tr.marketPctDeal("market", 950, 1000, 90, null, now), null);
  assert.equal(tr.marketPctDeal("market", 1, 1000, 90, null, now), null);
  assert.equal(tr.marketPctDeal("bazaar", 850, 1000, 90, null, now), null);
  assert.equal(tr.marketPctDeal("trade", 850, 1000, 90, null, now), null);
});

test("0.8.33: the Bazaars strip's % vs MV chip stays grey on stock that isn't selling", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const stuck = { onHand: 12, oldestLotAt: "2026-09-01T00:00:00Z", sold30d: 0 };
  assert.deepEqual(tr.stripPctLook(-15, 90, null, now), { cls: "totr-chip--ok", title: "85% of Torn's market value: at or under your deal line (90%)" });
  const grey = tr.stripPctLook(-15, 90, stuck, now);
  assert.equal(grey.cls, "totr-chip--dim");
  assert.match(grey.title, /You already hold 12 · none sold in 30 days/);
  // Unchanged: under MV but not a deal is grey, over MV is amber — stuck or not.
  assert.equal(tr.stripPctLook(-0.6, 90, null, now).cls, "totr-chip--dim");
  assert.match(tr.stripPctLook(-0.6, 90, stuck, now).title, /not at your deal line/);
  assert.equal(tr.stripPctLook(4, 90, stuck, now).cls, "totr-chip--warn");
});

test("traderOver (0.8.34): the best other trader paying more than your sell price", () => {
  const b = (price, extra = {}) => ({ name: "T", playerId: 7, price, isYou: false, lastTradeAt: null, ...extra });
  const t = tr.traderOver([b(2250, { name: "A" }), b(2300, { name: "B" }), b(9999, { isYou: true })], 2217);
  assert.equal(t.buyer.name, "B");
  assert.equal(t.gap, 83);
  assert.equal(tr.traderOver([b(2200)], 2217), null);
  assert.equal(tr.traderOver([b(2217)], 2217), null);
  assert.equal(tr.traderOver([b(3000)], null), null);
  assert.equal(tr.traderOver(null, 2217), null);
});

test("traderOver (0.8.35): TE and Overseer traders count too", () => {
  const t = tr.traderOver([{ name: "W", playerId: 1, price: 2250, isYou: false }], 2217, [{ name: "OldGoat", playerId: 11, price: 2400, source: "te" }]);
  assert.equal(t.buyer.name, "OldGoat");
  assert.equal(t.source, "te");
  assert.equal(t.gap, 183);
  assert.equal(tr.traderOver(null, 2217, [{ name: "B", playerId: 2, price: 2300, source: "overseer" }]).source, "overseer");
  assert.equal(tr.traderOver([{ name: "W", playerId: 1, price: 2300, isYou: false }], 2217, null).source, "w3b");
});

test("0.8.37: a deal check is skipped when another tab just did one, or is doing one", () => {
  const now = 1_800_000_000_000;
  const LOCKED = 6 * 3600_000;
  // Never checked → due. Checked 4 minutes ago by any tab → not yet. 5 minutes → due.
  assert.equal(tr.dealsPollDue({}, now, false, LOCKED), true);
  assert.equal(tr.dealsPollDue({ at: now - 4 * 60_000 }, now, false, LOCKED), false);
  assert.equal(tr.dealsPollDue({ at: now - 5 * 60_000 }, now, false, LOCKED), true);
  // Another tab started asking 10 s ago → wait; a claim left behind by a closed tab expires.
  assert.equal(tr.dealsPollDue({ at: now - 10 * 60_000, claimAt: now - 10_000 }, now, false, LOCKED), false);
  assert.equal(tr.dealsPollDue({ at: now - 10 * 60_000, claimAt: now - tr.DEALS_CLAIM_MS }, now, false, LOCKED), true);
  // Locked accounts re-check every 6 hours; the ↻ button always asks.
  assert.equal(tr.dealsPollDue({ locked: true, at: now - 3600_000 }, now, false, LOCKED), false);
  assert.equal(tr.dealsPollDue({ locked: true, at: now - LOCKED }, now, false, LOCKED), true);
  assert.equal(tr.dealsPollDue({ at: now - 1000, claimAt: now - 1000 }, now, true, LOCKED), true);
});

test("0.8.37: the page watcher waits 150 ms after a change, but never more than 1 s in all", () => {
  // A single change: the usual wait.
  assert.equal(tr.passDelay(1000, 1000, 150, 1000), 150);
  // Changes keep coming: 900 ms after the first, only 100 ms is left.
  assert.equal(tr.passDelay(1900, 1000, 150, 1000), 100);
  // Past the cap → run now, never a negative delay.
  assert.equal(tr.passDelay(2400, 1000, 150, 1000), 0);
  // Off the trading pages the wait is 1 s, which the cap leaves alone for the first change.
  assert.equal(tr.passDelay(5000, 5000, 1000, 1000), 1000);
});

test("0.8.39: the deals panel opens beside the sidebar eye, not over the chat corner", () => {
  const eye = { left: 540, top: 310, right: 558, bottom: 328, width: 18, height: 18 };
  // Desktop: just right of the eye, level with it, and never taller than the window.
  assert.deepEqual(tr.sheetSpot(eye, 1920, 1000, 360), { left: 566, top: 310, maxHeight: 682 });
  // No room on the right → opens to the left of the eye.
  assert.equal(tr.sheetSpot({ ...eye, left: 1700, right: 1718 }, 1920, 1000, 360).left, 1332);
  // An eye near the bottom still leaves the panel's header on screen.
  assert.equal(tr.sheetSpot({ ...eye, top: 950, bottom: 968 }, 1920, 1000, 360).top, 800);
  // Eye not on screen (hidden sidebar, or no layout at all), or a phone-sized window →
  // keep the stylesheet's spot (top-right, or the bottom sheet on phones).
  assert.equal(tr.sheetSpot(null, 1920, 1000, 360), null);
  assert.equal(tr.sheetSpot({ ...eye, width: 0, height: 0 }, 1920, 1000, 360), null);
  assert.equal(tr.sheetSpot(eye, 420, 800, 360), null);
});

test("0.8.40: light quotes are reused for 5 minutes, then asked for again", () => {
  const now = 1_800_000_000_000;
  const q = { itemId: 206, marketValue: 850000, buyPrice: 800000 };
  const cache = tr.sellCachePut({}, [q, { itemId: 0 }, null], now, 600);
  assert.deepEqual(Object.keys(cache), ["206"]);
  // 4 minutes later: still good, and the quote comes back as it was stored.
  const hit = tr.sellCacheGet(cache, [206, 207], now + 4 * 60_000, tr.QUOTE_CACHE_MS);
  assert.equal(hit.size, 1);
  assert.equal(hit.get(206).buyPrice, 800000);
  // Past 5 minutes: not used.
  assert.equal(tr.sellCacheGet(cache, [206], now + tr.QUOTE_CACHE_MS + 1, tr.QUOTE_CACHE_MS).size, 0);
});

test("0.8.40: one item-market low cache, shared by chips, Price check and deal alerts", () => {
  const now = 1_800_000_000_000;
  const TTL = 30 * 60_000;
  let cache = tr.lowCachePut({}, 180, 22278, now);
  // "Asked, nothing listed" is remembered too, so it isn't asked again at once.
  cache = tr.lowCachePut(cache, 181, null, now);
  cache = tr.lowCachePut(cache, "x", 5, now); // junk id ignored
  assert.deepEqual(tr.lowCacheGet(cache, 180, now + 60_000, TTL), { at: now, low: 22278 });
  assert.deepEqual(tr.lowCacheGet(cache, 181, now + 60_000, TTL), { at: now, low: null });
  assert.equal(tr.lowCacheGet(cache, 999, now, TTL), null);
  assert.equal(tr.lowCacheGet(cache, 180, now + TTL, TTL), null); // 30 minutes → ask again
  // A $1 display listing is not a low.
  assert.equal(tr.lowCacheGet(tr.lowCachePut({}, 5, 1, now), 5, now, TTL).low, null);
  // The cap drops the oldest entries first.
  let big = {};
  for (let i = 1; i <= 5; i += 1) big = tr.lowCachePut(big, i, 100 + i, now + i, 3);
  assert.deepEqual(Object.keys(big).map(Number).sort((a, b) => a - b), [3, 4, 5]);
});

test("0.8.41: a trader's name always links to a Torn profile — by id, or by name without one", () => {
  assert.equal(tr.traderProfileUrl({ playerId: 4353249, name: "VintageTorno" }), "https://www.torn.com/profiles.php?XID=4353249");
  // No id (the server has never seen this Torn Exchange trader): look them up by name.
  assert.equal(tr.traderProfileUrl({ playerId: null, name: "VintageTorno" }), "https://www.torn.com/profiles.php?NID=VintageTorno");
  assert.equal(tr.traderProfileUrl({ name: " Old_Goat-2 " }), "https://www.torn.com/profiles.php?NID=Old_Goat-2");
  // Nothing usable → no link, and nothing odd is ever put in a URL.
  assert.equal(tr.traderProfileUrl({ name: "" }), null);
  assert.equal(tr.traderProfileUrl({ name: "a b&c=d" }), null);
  assert.equal(tr.traderProfileUrl(null), null);
});

test("0.8.42: no \"fix\" down to a sell-list price the market is well above", () => {
  const now = Date.parse("2026-11-26T19:30:00Z");
  const market = { cheapest: 700, listings: 20, bazaarAverage: 760, weekCheapest: 400, capturedAt: "2026-11-26T19:00:00Z" };
  const s = { sellAt: 463, floor: 463, market };
  // Listed $999, sell list $463, cheapest bazaar $700 → fill $699, not $463.
  assert.deepEqual(tr.undersellAdvice(999, s, now), { cheapest: 700, target: 699 });
  // Listed $650: over the sell list but under the cheapest → same answer; the popup says "nothing to fix".
  assert.deepEqual(tr.undersellAdvice(650, s, now), { cheapest: 700, target: 699 });
  // Listed at or under the sell-list price → the ordinary fix (it raises the price).
  assert.equal(tr.undersellAdvice(463, s, now), null);
  assert.equal(tr.undersellAdvice(400, s, now), null);
  // The cheapest bazaar is not meaningfully above the sell list → ordinary fix.
  assert.equal(tr.undersellAdvice(999, { ...s, market: { ...market, cheapest: 470 } }, now), null);
  // Scan too old, nobody listing, or no market data → ordinary fix.
  assert.equal(tr.undersellAdvice(999, { ...s, market: { ...market, capturedAt: "2026-11-26T10:00:00Z" } }, now), null);
  assert.equal(tr.undersellAdvice(999, { ...s, market: { ...market, listings: 0 } }, now), null);
  assert.equal(tr.undersellAdvice(999, { sellAt: 463, floor: 463, market: null }, now), null);
  // Never under your floor.
  assert.equal(tr.undersellAdvice(999, { ...s, floor: 800 }, now), null);
});

test("0.8.46: every % of market value chip reads \"85% MV\", and its tooltip names Torn's market value (plan step 14)", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(tr.pctMvLabel(-15), "85% MV");
  assert.equal(tr.pctMvLabel(-0.6), "99% MV");
  assert.equal(tr.pctMvLabel(4.2), "104% MV");
  assert.match(tr.stripPctLook(4, 90, null, now).title, /^104% of Torn's market value: over it$/);
  assert.match(tr.stripPctLook(-5, 90, null, now).title, /95% of Torn's market value: under it, but not at your deal line \(90%\)/);
});

test("0.8.50: chip tooltips name the market value Overseer priced against (Your prices follow)", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(tr.mvName("te_mv"), "TE's market value");
  assert.equal(tr.mvName("torn_mv"), "Torn's market value");
  assert.equal(tr.mvName(undefined), "Torn's market value");
  assert.match(tr.stripPctLook(-15, 90, null, now, "te_mv").title, /^85% of TE's market value: at or under your deal line/);
});

test("0.8.51 overCheapest: red box only when over the trusted cheapest bazaar", () => {
  const now = Date.parse("2026-11-28T08:00:00Z");
  const mk = (cheapest, extra = {}) => ({ cheapest, listings: 5, bazaarAverage: cheapest, capturedAt: new Date(now - 10 * 60000).toISOString(), ...extra });
  assert.ok(tr.overCheapest(97999 + 1, mk(97999), now));
  assert.equal(tr.overCheapest(97999, mk(97999), now), null);
  assert.equal(tr.overCheapest(90000, mk(97999), now), null);
  assert.equal(tr.overCheapest(500, mk(400, { capturedAt: new Date(now - 4 * 3600000).toISOString() }), now), null, "stale market: no verdict");
  assert.equal(tr.overCheapest(500, mk(1, { listings: 30, bazaarAverage: 400 }), now), null, "display listing set aside");
  assert.equal(tr.overCheapest(500, null, now), null);
  assert.equal(tr.overCheapest(null, mk(400), now), null);
});

test("0.8.51 autoFillPicks: fresh, shown, not typed yet, once per visit", () => {
  const base = { shown: true, fresh: true, listed: 100, sellAt: 120 };
  const rows = [
    { ...base, itemId: 1 },
    { ...base, itemId: 2, listed: 120 },
    { ...base, itemId: 3, fresh: false },
    { ...base, itemId: 4, shown: false },
    { ...base, itemId: 5, sellAt: null },
    { ...base, itemId: 6 },
    { ...base, itemId: 7, listed: null },
  ];
  assert.deepEqual(tr.autoFillPicks(rows, new Map([[6, {}]])), [1, 7]);
});
