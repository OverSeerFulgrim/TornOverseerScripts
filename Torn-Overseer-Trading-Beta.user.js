// ==UserScript==
// @name         Torn Overseer Trading (beta)
// @namespace    torn-overseer
// @version      0.8.2
// @description  Beta of the Overseer trading module: prices trades from your Overseer pricelist, fills your bazaar at market value +%, shows cheaper bazaars on the item market, a Price check on any item, after-fee profit on the stock market, and deal alerts for your buy list on every page. Fills boxes only — never presses a Torn button for you.
// @author       OverSeerFulgrim
// @license      All rights reserved
// @supportURL   https://github.com/OverSeerFulgrim/TornOverseerScripts/issues
// @antifeature  membership  Needs an Overseer Trading subscription (tornoverseer.com)
// @match        https://www.torn.com/trade.php*
// @match        https://www.torn.com/bazaar.php*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/page.php?sid=stocks*
// @match        https://www.torn.com/item.php*
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      ijolgywtybadfuvyopeg.supabase.co
// @connect      tornexchange.com
// @connect      api.torn.com
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/599500/Torn%20Overseer%20Trading%20%28beta%29.user.js
// @updateURL https://update.greasyfork.org/scripts/599500/Torn%20Overseer%20Trading%20%28beta%29.meta.js
// ==/UserScript==

// DRAFT (WO-29 TS-2 skeleton, written 2026-10-04 before TS-1 exists).
// Shape = the merged "Torn Overseer" script: a small core (storage, sign-in, requests, router,
// panel helpers) plus page modules. When the beta graduates (TS-6) the `modules.*` blocks move
// into the Chain Watch script unchanged and this file is retired.
//
// Ground rules (plan §5):
//  - One click = one action. The script fills inputs; the player presses Torn's own
//    Change / Accept / Buy / Confirm. Nothing is submitted on page load.
//  - Never hides Torn's own warnings.
//  - Every third-party string reaches the page as TEXT (textContent), never innerHTML.
//  - The Torn key lives in GM storage only (same rule as Chain Watch); the site keeps no copy
//    (connect-torn-key persist:false). PDA's injected key is used, never saved.
//
// Selectors marked VERIFY come from the five scripts this replaces and must be checked against
// Fulgrim's screenshots of the live pages before TS-2 ships (Claude does not test on torn.com).

(function () {
  "use strict";

  const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";
  if (IS_BROWSER) {
    if (window.__tornOverseerTradingBetaLoaded) return;
    window.__tornOverseerTradingBetaLoaded = true;
    // Graduation guard (TS-6): once Trading lives in the merged script, step aside.
    if (window.__tornOverseerTradingModuleLoaded) return;
    // WO-51: the Torn Overseer browser extension runs this same file (where __OVS_EXT__ is
    // defined) and marks the page at document_start. The userscript copy steps aside there,
    // so someone with both installed never gets two panels.
    if (typeof __OVS_EXT__ === "undefined" && document.documentElement.dataset.overseerExtension) return;
  }

  const VERSION =
    (typeof GM_info === "object" && GM_info && GM_info.script && typeof GM_info.script.version === "string"
      ? GM_info.script.version
      : "") || "0.7.6";
  const FUNCTIONS_URL = "https://ijolgywtybadfuvyopeg.supabase.co/functions/v1";
  const ANON_KEY = "sb_publishable_Kz_QcUJAD6wzEdCEr6FbSg_3TO5JXek";
  const SITE_URL = "https://tornoverseer.com";
  const PDA_API_KEY = "###PDA-APIKEY###";

  const STORE = {
    tornKey: "totr_torn_key",
    sessionToken: "totr_session_token",
    fillPct: "totr_fill_pct",
    dealPct: "totr_deal_pct",
    ignored: "totr_ignored",
    collapsed: "totr_collapsed",
    stockSentAt: "totr_stock_sent_at",
    sellMode: "totr_sell_mode",
  };
  const SECRET_KEYS = new Set([STORE.tornKey, STORE.sessionToken]);

  const DEFAULT_FILL_PCT = 0;
  const DEFAULT_DEAL_PCT = 90;
  const MAX_FILL_PCT = 100;
  /** Fill can go under market value, but not absurdly: a fat-fingered -95 would give stock away. */
  const MIN_FILL_PCT = -50;
  /** Torn's item market sales tax, paid by the seller at the moment of sale (wiki: 5% since
   *  2025-06-22; an anonymous listing pays a further 10%, which we don't assume). */
  const MARKET_FEE_RATE = 0.05;
  /** A resale has to clear at least this much after the fee before we call it a flip. */
  const MIN_FLIP_PCT = 1.5;
  /** Trades at or over this total get a "Big cash trade" pill (mug-risk reminder). */
  const BIG_TRADE_TOTAL = 25_000_000;

  // ---------------------------------------------------------------------------------------
  // Pure helpers (exported for node tests at the bottom)
  // ---------------------------------------------------------------------------------------

  /** Which module owns this page, or null. Order matters: own bazaar before someone else's. */
  function routeFor(loc) {
    const path = String(loc.pathname || "");
    const search = String(loc.search || "");
    const hash = String(loc.hash || "");
    if (path === "/trade.php") return "trade";
    if (path === "/bazaar.php") {
      const params = new URLSearchParams(search);
      if (params.get("userId") || params.get("userID")) return "bazaarOther";
      if (/^#\/(add|manage)?$/.test(hash) || hash === "" || hash === "#/") return "bazaarOwn";
      return "bazaarOwn";
    }
    if (path === "/page.php" && /(^|[?&])sid=ItemMarket(&|$)/.test(search.replace(/^\?/, "?"))) return "itemMarket";
    if (path === "/page.php" && /(^|[?&])sid=stocks(&|$)/i.test(search)) return "stocks";
    return null;
  }

  /** trade.php#step=view&ID=123 → { step: "view", tradeId: 123 } */
  function parseTradeHash(hash) {
    const raw = String(hash || "").replace(/^#\/?/, "");
    const params = new URLSearchParams(raw);
    const step = params.get("step") || "";
    const id = Number(params.get("ID") || params.get("id"));
    return { step, tradeId: Number.isSafeInteger(id) && id > 0 ? id : null };
  }

  /** "Xanax x40" → { name: "Xanax", qty: 40 }; "Pair of Ice Skates" → qty 1. */
  function parseItemLine(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return null;
    const m = clean.match(/^(.+?)(?:\s+x(\d{1,10}))?$/);
    if (!m) return null;
    const qty = m[2] ? Number(m[2]) : 1;
    if (!Number.isSafeInteger(qty) || qty <= 0) return null;
    return { name: m[1].trim(), qty };
  }

  /**
   * 0.7.4 (assessment slice 3): one trade line from its name cell. The NAME is the cell's first
   * text node; the QUANTITY may be in that node ("Xanax x40") or in a LATER text node of the same
   * cell. `ownText` must be the cell's DIRECT text nodes only — never descendants — because other
   * scripts (TornTools) inject child elements with their own numbers, and reading an injected
   * " x5" would inflate the total typed into a money box. If Torn renders the count inside a child
   * element this still reads 1, as before. VERIFY against a captured stacked-quantity trade page.
   */
  function parseItemNode(firstText, ownText) {
    const parsed = parseItemLine(firstText);
    if (!parsed) return null;
    if (/\sx\d{1,10}\s*$/.test(String(firstText || "").replace(/\s+/g, " ").trim())) return parsed;
    const rest = String(ownText || "").replace(/\s+/g, " ");
    const at = rest.indexOf(parsed.name);
    const after = at >= 0 ? rest.slice(at + parsed.name.length) : rest;
    const m = after.match(/(?:^|\s)x\s?(\d{1,10})(?=\s|\$|$)/);
    if (!m) return parsed;
    const qty = Number(m[1]);
    return Number.isSafeInteger(qty) && qty > 0 ? { name: parsed.name, qty } : parsed;
  }

  /**
   * 0.7.4: a ranked weapon/armour piece's rarity from its trade line, or null. The server never
   * prices a line that carries one (it would otherwise price a yellow-ranked weapon as the plain
   * item). Torn marks rarity with a coloured glow class; any such class counts. VERIFY against a
   * captured trade holding a ranked weapon — until then an RW with no glow class still prices as
   * the plain item, as before.
   */
  function rarityFromClasses(classNames) {
    const m = String(classNames || "").match(/\bglow-(yellow|orange|red)\b/i);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * 0.7.4: the add-money step only offers the remembered total for THE SAME trade. The pending
   * total used to be offered on any add-money page within 30 minutes, so the next trade's money
   * box could be filled with the previous trade's total. When the add-money URL names a trade,
   * it must match; when it names none, only a total remembered in the last 5 minutes is offered.
   */
  function pendingMoneyFor(pending, hashTradeId, nowMs) {
    if (!pending || !(Number(pending.total) > 0) || !Number.isFinite(pending.at)) return null;
    const age = nowMs - pending.at;
    if (age < 0 || age >= 30 * 60_000) return null;
    if (hashTradeId != null && pending.tradeId != null) {
      return Number(pending.tradeId) === Number(hashTradeId) ? pending : null;
    }
    // One side names no trade: only a total remembered moments ago is trusted.
    return age < 5 * 60_000 ? pending : null;
  }

  /**
   * 0.7.4: "Fill money" is only offered for a total that matches what is in the trade NOW:
   * never while a re-price runs, never after a re-price FAILED (the panel still shows the old
   * total), and never once the other player's items differ from the ones that total was priced
   * for. `resultSig` is the signature the shown result was actually priced from — set only when
   * a pricing request succeeds.
   */
  function fillMoneyBlocked(st, currentSig) {
    if (!st || st.loading || st.error) return true;
    return !st.resultSig || currentSig !== st.resultSig;
  }

  /** "$48,212,000" → 48212000; junk → null */
  function parseMoney(text) {
    const m = String(text || "").match(/\$\s*([0-9][0-9,]*)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isSafeInteger(n) ? n : null;
  }

  /** First "$1,234" in an element, read text node by text node so a badge another script
   *  puts inside it (TornTools' "↓21%") is never glued onto the number. */
  function moneyIn(node) {
    if (!node) return null;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest("input, .totr-chip, .totr-mini, [data-totr-ui]")) continue;
      const v = parseMoney(n.textContent);
      if (v != null) return { value: v, node: n };
    }
    return null;
  }

  function fmtMoney(n) {
    return n == null || !Number.isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
  }

  /** Markup over market value: 0% = exactly MV, never below, capped. */
  function clampPct(value, fallback, max, min = 0) {
    if (value === "" || value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** Bazaar fill target = market value × (1 + pct/100), whole dollars. Null without an MV. */
  function fillTarget(marketValue, pct) {
    const mv = Number(marketValue);
    if (!Number.isFinite(mv) || mv <= 0) return null;
    const p = clampPct(pct, DEFAULT_FILL_PCT, MAX_FILL_PCT, MIN_FILL_PCT);
    return Math.max(1, Math.round(mv * (1 + p / 100)));
  }

  /** How far a listed price sits from the fill target, in whole percent (+ = above). */
  /** "(11 in stock)" → 11. Null when the text has no stock count. */
  function parseStock(text) {
    const m = String(text || "").match(/\(\s*([\d,]+)\s+in stock\s*\)/i);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isSafeInteger(n) ? n : null;
  }

  /** A control that already fills the max ("Max", "fill max") — Torn's own or another script's. */
  function isMaxLabel(text) {
    return /^\s*(fill\s+)?max\s*$/i.test(String(text || ""));
  }

  /** How many you can buy: all in stock, or as many as the money on hand covers. 0 if not one. */
  function maxAffordable(price, stock, money) {
    const p = Number(price); const st = Number(stock); const m = Number(money);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(m) || m < 0) return 0;
    const canPay = Math.floor(m / p);
    return stock != null && Number.isFinite(st) && st >= 0 ? Math.min(st, canPay) : canPay;
  }

  function driftPct(listedPrice, target) {
    if (!target || !Number.isFinite(listedPrice)) return null;
    return Math.round(((listedPrice - target) / target) * 100);
  }

  /**
   * WO-53 MC-4 — "you already hold this and it isn't selling", the same rule as the site's
   * stockSignalModel.notSelling: held for 30+ days AND nothing of it sold in 30 days. `stock`
   * is the quote's { onHand, oldestLotAt, sold30d } (null from an older server). Returns the
   * line to add to a deal chip's tooltip, or "" when there is nothing to say.
   */
  const NOT_SELLING_DAYS = 30;
  function notSellingLine(stock, nowMs) {
    if (!stock || !(stock.onHand > 0) || stock.sold30d > 0 || !stock.oldestLotAt) return "";
    const at = Date.parse(stock.oldestLotAt);
    if (!Number.isFinite(at)) return "";
    if (Math.floor((nowMs - at) / 86400000) < NOT_SELLING_DAYS) return "";
    return `You already hold ${Number(stock.onHand).toLocaleString("en-US")} · none sold in ${NOT_SELLING_DAYS} days`;
  }

  /**
   * WO-53 MC-3: where a bazaar sell price sits against the cheapest bazaar listing — the same
   * rules as the site's Bazaar tab (web/src/features/trading/sellMarketModel.ts): within 2% (or
   * under) = competitive, 2–10% over = above, over 10% = far above. No verdict (grey) when the
   * snapshot is over 3 h old, nobody lists the item, or the cheapest is a $1 / display listing
   * (under half the bazaar average with 20+ listings — the resale advisor's own guard).
   * `market` is sell_prices' { cheapest, bazaarAverage, listings, capturedAt, weekCheapest, yesterdayCheapest } or null.
   * Returns { band, gapPct, label, title } — label is "" when there is nothing to show.
   */
  const VS_COMPETITIVE_PCT = 2;
  const VS_FAR_ABOVE_PCT = 10;
  const VS_STALE_MS = 3 * 3600000;
  const VS_TREND_PCT = 10;
  function vsCheapest(sellAt, market, nowMs) {
    const none = (band, title) => ({ band, gapPct: null, label: "", title });
    if (!(Number(sellAt) > 0) || !market) return none("none", "");
    const at = Date.parse(market.capturedAt || "");
    if (!Number.isFinite(at)) return none("none", "");
    const age = Math.max(0, Math.floor((nowMs - at) / 60000));
    const checked = age < 60 ? `${age} min ago` : `${Math.floor(age / 60)} h ago`;
    if (nowMs - at > VS_STALE_MS) return { band: "stale", gapPct: null, label: "vs cheapest ?", title: `Cheapest-listing data is stale (checked ${checked})` };
    const cheapest = Number(market.cheapest);
    if (!(cheapest > 0) || market.listings === 0) return { band: "nobody", gapPct: null, label: "no listings", title: "Nobody is listing this in a bazaar" };
    const avg = Number(market.bazaarAverage);
    if (avg > 0 && Number(market.listings) >= 20 && cheapest < avg * 0.5) {
      return { band: "unclear", gapPct: null, label: "vs cheapest ?", title: `Cheapest listing ${fmtMoney(cheapest)} looks like a display price — set aside` };
    }
    // One day is not a market (site rule, 2026-10-31): against the week's median cheapest,
    // a one-day dip (>10% under, yesterday normal) is compared with the WEEK; two days running
    // is "falling" and compared with today; >10% over the week is "rising".
    const week = Number(market.weekCheapest) > 0 ? Number(market.weekCheapest) : null;
    let ref = cheapest;
    let trend = "";
    if (week != null) {
      const trendPct = ((cheapest - week) / week) * 100;
      if (trendPct < -VS_TREND_PCT) {
        const y = Number(market.yesterdayCheapest);
        const yesterdayNormal = market.yesterdayCheapest != null && Number.isFinite(y) && y >= week * (1 - VS_TREND_PCT / 100);
        if (yesterdayNormal) { ref = week; trend = ` · dipped today to ${fmtMoney(cheapest)} (week ${fmtMoney(week)})`; }
        else trend = ` · falling (week ${fmtMoney(week)})`;
      } else if (trendPct > VS_TREND_PCT) trend = ` · rising (week ${fmtMoney(week)})`;
    }
    const gapPct = ((Number(sellAt) - ref) / ref) * 100;
    const band = gapPct <= VS_COMPETITIVE_PCT ? "competitive" : gapPct <= VS_FAR_ABOVE_PCT ? "above" : "far_above";
    const rounded = Math.round(gapPct * 10) / 10;
    const label = `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
    const listings = market.listings != null ? ` · ${Number(market.listings).toLocaleString("en-US")} listings` : "";
    const against = ref === cheapest ? `vs cheapest bazaar ${fmtMoney(cheapest)}` : `vs the week's cheapest ${fmtMoney(ref)}`;
    return { band, gapPct, label, title: `${against}${listings} · checked ${checked}${trend}` };
  }

  /** What a sale at `price` puts in your pocket after Torn's item market fee. Null without a price. */
  /**
   * 0.7.11: how fresh the bazaar Fill targets are, for the Manage/Add header. `loadedAt` is when
   * this page asked Overseer for the targets (your sell list is applied then — edits made on the
   * site since need a reload), `refsAt` when the market values behind them were fetched, and
   * `marketAt` the oldest cheapest-listing scan among the rows. All ms, or null when unknown.
   * Returns { text, title, stale } — text "" when nothing has loaded yet.
   */
  const TARGETS_STALE_MS = 30 * 60000;
  const REFS_STALE_MS = 2 * 3600000;
  function ageText(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return "just now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  }
  function targetsAge(info, nowMs) {
    const { loadedAt, refsAt, marketAt } = info || {};
    if (!Number.isFinite(loadedAt)) return { text: "", title: "", stale: false };
    const ago = (at) => { const t = ageText(nowMs - at); return t === "just now" ? t : `${t} ago`; };
    const why = [];
    if (nowMs - loadedAt > TARGETS_STALE_MS) why.push("loaded a while ago — reload if you changed your sell list since");
    if (Number.isFinite(refsAt) && nowMs - refsAt > REFS_STALE_MS) why.push("market values are old");
    if (Number.isFinite(marketAt) && nowMs - marketAt > VS_STALE_MS) why.push("cheapest-listing scan is old");
    const lines = [
      `Fill targets loaded from Overseer ${ago(loadedAt)}.`,
      Number.isFinite(refsAt) ? `Market values (Torn Exchange) fetched ${ago(refsAt)}.` : "Market value age unknown.",
      Number.isFinite(marketAt) ? `Cheapest-listing scan ${ago(marketAt)} (oldest row).` : null,
      "Your sell list is applied when targets load — after changing it on the site, press ↻.",
    ].filter(Boolean);
    if (why.length) lines.unshift(`Worth a reload: ${why.join("; ")}.`);
    // The headline is the oldest thing the targets depend on.
    const oldest = Math.min(loadedAt, Number.isFinite(refsAt) ? refsAt : loadedAt);
    const age = ageText(nowMs - oldest);
    return { text: age === "just now" ? "TARGETS FRESH" : `TARGETS ${age.toUpperCase()} OLD`, title: lines.join("\n"), stale: why.length > 0 };
  }

  function netAfterFee(price) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n * (1 - MARKET_FEE_RATE));
  }

  /**
   * Buy at `askPrice`, resell on the item market at `marketValue`: profit after the fee, or null
   * when that isn't worth calling a flip (no MV, no profit, or under MIN_FLIP_PCT of the outlay).
   * Market value is an average, not a promised sale price — the chip says "if resold at MV".
   */
  function flipAtMarket(askPrice, marketValue) {
    const ask = Number(askPrice);
    const net = netAfterFee(marketValue);
    if (net == null || !Number.isFinite(ask) || ask <= 1) return null;
    const profit = net - ask;
    const pct = (profit / ask) * 100;
    return profit > 0 && pct >= MIN_FLIP_PCT ? { profit, pct } : null;
  }

  /**
   * 0.7.12: how the trader mostly sells, picked once ("How do you mostly sell?"). It decides
   * which resale chip the buy pages show, so a new trader sees only what fits their playstyle:
   *  - "market": flip chip = resale at Torn market value after the 5% fee, plus the amber
   *    "% OF MARKET" / "% vs MV" marks;
   *  - "bazaar": resale chip = your own sell-list price (what Fill would type), no fee;
   *  - "trade":  no resale chip — only "under your buy".
   * Not chosen yet (null) keeps the pre-0.7.12 marks (market) and shows the chooser.
   */
  const SELL_MODES = ["bazaar", "market", "trade"];
  const SELL_MODE_LABELS = { bazaar: "Bazaar", market: "Item Market", trade: "Trade" };
  function sellModeOf(raw) { return SELL_MODES.includes(raw) ? raw : null; }
  /** Whether the amber "% of market value" marks belong on this mode's pages. */
  function showsMarketPct(mode) { return mode !== "bazaar" && mode !== "trade"; }
  /** The resale chip for a listing at `askPrice`, or null when there is none worth showing. */
  function resaleFor(mode, askPrice, marketValue, sellAt) {
    if (mode === "trade") return null;
    if (mode === "bazaar") {
      const ask = Number(askPrice);
      const sell = Number(sellAt);
      if (!Number.isFinite(ask) || ask <= 1 || !Number.isFinite(sell) || sell <= 0) return null;
      const profit = sell - ask;
      const pct = (profit / ask) * 100;
      return profit > 0 && pct >= MIN_FLIP_PCT ? { profit, pct, via: "bazaar" } : null;
    }
    const flip = flipAtMarket(askPrice, marketValue);
    return flip ? { ...flip, via: "market" } : null;
  }
  /** The chip text for a resale. */
  function resaleLabel(r) {
    return `${r.via === "bazaar" ? "resell" : "flip"} +${fmtMoney(r.profit)} (${r.pct.toFixed(1)}%)`;
  }

  /** The trade panel's money guard. */
  function moneyGuard(total, moneyInTrade) {
    if (!Number.isFinite(total) || total <= 0) return { state: "empty", diff: 0 };
    const have = Number.isFinite(moneyInTrade) ? moneyInTrade : 0;
    if (have === total) return { state: "ready", diff: 0 };
    if (have < total) return { state: "short", diff: total - have };
    return { state: "over", diff: have - total };
  }

  /** Stable fingerprint of what the other player is offering; "" when nothing is there yet. */
  function tradeSignature(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    return items.map((i) => `${i.name.toLowerCase()}×${i.qty}${i.rarity ? `★${i.rarity}` : ""}`).sort().join("|");
  }

  function compareVersions(a, b) {
    const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /**
   * WO-40 stock check: what one bazaar page says you hold, as trader-script `stock_snapshot`
   * wants it. `rows` are { itemId, count } read off the page; count null means Torn printed no
   * count, which on its bazaar pages means one (it never prints "x1").
   *
   * `complete` is a promise to the server that an item MISSING from `items` really is zero on
   * this page, so it is withheld when:
   *  - any row had no item id (something on the page we could not name);
   *  - the page is empty — far more often "not drawn yet" than "you own nothing";
   *  - five or more rows and not one printed count — that is our selectors missing Torn's
   *    count, not a page of singles, and would read every stack as 1.
   */
  function stockSnapshotItems(rows) {
    const totals = new Map();
    let complete = rows.length > 0;
    let counted = 0;
    for (const r of rows) {
      if (!r || !Number.isSafeInteger(r.itemId) || r.itemId <= 0) { complete = false; continue; }
      const read = Number.isSafeInteger(r.count) && r.count > 0;
      if (read) counted += 1;
      totals.set(r.itemId, (totals.get(r.itemId) || 0) + (read ? r.count : 1));
    }
    if (rows.length >= 5 && counted === 0) complete = false;
    const items = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([itemId, qty]) => ({ itemId, qty }));
    return { items, complete: complete && items.length > 0 };
  }

  /** Send a page's stock at most once per `everyMs` per page. `sentAt` is { add?, manage? } in ms. */
  function snapshotDue(sentAt, page, nowMs, everyMs) {
    const last = sentAt && Number(sentAt[page]);
    return !(Number.isFinite(last) && nowMs - last >= 0 && nowMs - last < everyMs);
  }

  // ---------------------------------------------------------------------------------------
  // WO-50 E: fill events. Every price this script types into a Torn box is reported to
  // trader-script `fill_event` (fire-and-forget) so the ledger can later say a sale was
  // "at your sell-list price" rather than by hand. One pass (a row Fill, FILL ALL, a $ pick,
  // Fill money) collects its fills and flushes ONCE; nothing waits on the answer.
  // ---------------------------------------------------------------------------------------

  /** Events per `fill_event` call — the server's cap. */
  const FILL_EVENT_CAP = 100;

  /** Add one fill to a pass's list. Pure: returns the list to keep (the same array when
   *  nothing was added — a bad event, a duplicate, or a full list). */
  function addFillEvent(list, itemId, price, kind, tradeId) {
    const base = Array.isArray(list) ? list : [];
    const id = Number(itemId);
    const p = Math.round(Number(price));
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(p) || p <= 0) return base;
    if (kind !== "bazaar" && kind !== "trade") return base;
    const trade = tradeId == null ? null : Number(tradeId);
    if (trade != null && (!Number.isSafeInteger(trade) || trade <= 0)) return base;
    if (base.length >= FILL_EVENT_CAP) return base;
    const event = trade == null ? { itemId: id, price: p, kind } : { itemId: id, price: p, kind, tradeId: trade };
    if (base.some((e) => e.itemId === id && e.price === p && e.kind === kind && (e.tradeId ?? null) === trade)) return base;
    return [...base, event];
  }

  /** The `trade` fills behind one Fill money: every priced line of the trade, at its price each. */
  function tradeFillEvents(lines, tradeId) {
    let list = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      if (!line || line.priceEach == null) continue;
      list = addFillEvent(list, line.itemId, line.priceEach, "trade", tradeId);
    }
    return list;
  }
  // ---------------------------------------------------------------------------------------
  // WO-48 Stocks — pure helpers (docs/trading-stocks-plan.md §5). Integer cents throughout:
  // prices have two decimals, so shares × priceCents is exact, and float maths can turn an
  // exact $1,004.00 fee into 1004.0000000001 → rounded up to 1005.
  // ---------------------------------------------------------------------------------------

  /** Torn's stock sale fee: 0.1% of the value, rounded UP to the dollar (confirmed 2026-10-28). */
  const STOCK_FEE_RATE = 0.001;

  function stockValueCents(shares, price) {
    return Number(shares) * Math.round(Number(price) * 100);
  }

  /** The fee Torn charges on a sale worth `cents`. 1,217 × $825.23 → $1,005. */
  function stockSaleFee(cents) {
    return Math.ceil(cents / 100000);
  }

  /** What Torn pays for selling `shares` at `price`: the value with cents dropped, minus the fee. */
  function stockPayout(shares, price) {
    const cents = stockValueCents(shares, price);
    return Math.floor(cents / 100) - stockSaleFee(cents);
  }

  /** Real profit of selling one lot now, after the fee, in exact cents. */
  function stockLotNetCents(shares, bought, price) {
    return stockPayout(shares, price) * 100 - stockValueCents(shares, bought);
  }

  /** The same in whole dollars, for display. MCS 5,186 @ $846.76 sold at $846.83 → −$4,029. */
  function stockLotNet(shares, bought, price) {
    return Math.round(stockLotNetCents(shares, bought, price) / 100);
  }

  /** The lowest price (two decimals) at which selling this lot loses nothing after the fee. */
  function stockBreakeven(shares, bought) {
    let cents = Math.ceil((Number(bought) / (1 - STOCK_FEE_RATE)) * 100) - 2;
    while (stockLotNetCents(shares, bought, cents / 100) < 0) cents += 1;
    return cents / 100;
  }

  /** Shares a perk needs for `increments` blocks: the first needs the requirement, each next one double the last. */
  function perkSharesFor(requirement, increments) {
    return increments > 0 ? Number(requirement) * (2 ** increments - 1) : 0;
  }

  /**
   * The verdict for one holding at `price`. `stock` is a `/v2/user/stocks` entry
   * ({ id, shares, transactions: [{ id, shares, price, timestamp }], bonus: { increment, … } }).
   * A perk held (bonus.increment ≥ 1) means the stock is not checked at all (decision 3).
   */
  function stockVerdict(stock, price) {
    const perk = Number(stock && stock.bonus && stock.bonus.increment) >= 1;
    const lots = ((stock && stock.transactions) || [])
      .map((t) => ({ id: t.id, shares: Number(t.shares), bought: Number(t.price), ts: Number(t.timestamp) }))
      .filter((l) => l.shares > 0 && l.bought > 0)
      .sort((a, b) => b.ts - a.ts || b.id - a.id)
      .map((l) => {
        const cents = stockLotNetCents(l.shares, l.bought, price);
        return { ...l, net: Math.round(cents / 100), profitable: cents > 0, breakeven: stockBreakeven(l.shares, l.bought) };
      });
    const profitable = lots.filter((l) => l.profitable);
    let run = 0;
    while (run < lots.length && lots[run].profitable) run++;
    const nearest = lots.filter((l) => !l.profitable).reduce((best, l) => (best == null || l.breakeven < best ? l.breakeven : best), null);
    return {
      perk,
      lots,
      profitableLots: profitable.length,
      profitableShares: profitable.reduce((s, l) => s + l.shares, 0),
      netIfSoldProfitable: profitable.reduce((s, l) => s + l.net, 0),
      netIfSoldAll: lots.reduce((s, l) => s + l.net, 0),
      nearestBreakeven: nearest,
      // Torn sells the NEWEST lot first when you type a count, so a typed count sells exactly the
      // profitable lots only when they are the newest ones. Otherwise: lot by lot, null here.
      newestFirstCount: profitable.length > 0 && run === profitable.length ? profitable.reduce((s, l) => s + l.shares, 0) : null,
    };
  }

  /** Selling `qty` of a perk stock: null if the perk survives, else what you'd drop to. */
  function perkWarning(stock, requirement, qty) {
    const held = Number(stock && stock.bonus && stock.bonus.increment) || 0;
    const shares = Number(stock && stock.shares) || 0;
    const req = Number(requirement);
    if (held < 1 || !(req > 0) || !(qty > 0)) return null;
    const left = Math.max(0, shares - qty);
    let after = held;
    while (after > 0 && left < perkSharesFor(req, after)) after--;
    if (after === held) return null;
    return { held, after, left, needed: perkSharesFor(req, held) };
  }

  /** Payout and real profit of selling `qty` now, taking the newest lots first as Torn does. */
  function sellPreview(stock, price, qty) {
    const lots = ((stock && stock.transactions) || [])
      .map((t) => ({ shares: Number(t.shares), bought: Number(t.price), ts: Number(t.timestamp), id: t.id }))
      .sort((a, b) => b.ts - a.ts || b.id - a.id);
    let need = Math.min(qty, lots.reduce((s, l) => s + l.shares, 0));
    let costCents = 0;
    const sold = need;
    for (const l of lots) {
      if (need <= 0) break;
      const take = Math.min(need, l.shares);
      costCents += stockValueCents(take, l.bought);
      need -= take;
    }
    if (!(sold > 0)) return null;
    const payout = stockPayout(sold, price);
    return { qty: sold, payout, fee: stockSaleFee(stockValueCents(sold, price)), net: Math.round((payout * 100 - costCents) / 100) };
  }

  /**
   * The free tiles: what everything would fetch now, the holding nearest its breakeven, perks,
   * today's move. `prices` = Map(id → price); `torn` = Map(id → `/v2/torn/stocks` entry);
   * `dayChange` = Map(id → $ change per share over the last day), may be partial.
   */
  function portfolioSummary(userStocks, prices, torn, dayChange) {
    let soldAllNow = 0;
    let gross = 0;
    let closest = null;
    let perksReady = 0;
    let nextPerk = null;
    let move = 0;
    let moveKnown = 0;
    const owned = (userStocks || []).filter((s) => Number(s.shares) > 0);
    for (const s of owned) {
      const price = prices.get(Number(s.id));
      if (!(price > 0)) continue;
      const v = stockVerdict(s, price);
      soldAllNow += v.netIfSoldAll;
      gross += v.lots.reduce((sum, l) => sum + (stockValueCents(l.shares, price) - stockValueCents(l.shares, l.bought)) / 100, 0);
      if (!v.perk && v.profitableLots === 0 && v.nearestBreakeven != null) {
        const gap = v.nearestBreakeven - price;
        if (closest == null || gap / price < closest.gap / closest.price) closest = { id: Number(s.id), price, target: v.nearestBreakeven, gap };
      }
      const b = s.bonus || {};
      if (Number(b.increment) >= 1) {
        if (b.available) perksReady++;
        else if (Number(b.frequency) > 0) {
          const days = Math.max(0, Number(b.frequency) - Number(b.progress || 0));
          if (nextPerk == null || days < nextPerk.days) {
            const t = torn && torn.get(Number(s.id));
            nextPerk = { id: Number(s.id), days, description: t && t.bonus ? t.bonus.description : null };
          }
        }
      }
      const change = dayChange && dayChange.get(Number(s.id));
      if (Number.isFinite(change)) { move += Number(s.shares) * change; moveKnown++; }
    }
    return {
      owned: owned.length,
      soldAllNow,
      gross: Math.round(gross),
      closest,
      perksReady,
      nextPerk,
      priceMove: moveKnown > 0 ? Math.round(move) : null,
      priceMoveComplete: moveKnown === owned.length,
    };
  }


  // ---------------------------------------------------------------------------------------
  // WO-66: deal alerts — pure helpers
  // ---------------------------------------------------------------------------------------

  /** How often the deal list is asked for (the server also rotates its live checks per 5 min). */
  const DEALS_POLL_MS = 5 * 60_000;
  /** Item-market reads per poll, with the player's own key (~1 Torn call a minute). */
  const MARKET_CHECKS_PER_POLL = 4;
  /** A non-subscriber is asked again this often (subscribing unlocks without a reinstall). */
  const LOCKED_RECHECK_MS = 6 * 3600_000;

  /** The pages the trading modules (and Price check) run on — everything else only gets alerts. */
  function isTradingPage(loc) {
    const path = String(loc.pathname || "");
    return routeFor(loc) != null || path === "/item.php";
  }

  function dealKey(deal) {
    return `${deal.source || "bazaar"}:${deal.itemId}:${deal.price}`;
  }

  function unseenDeals(deals, seen) {
    const set = seen instanceof Set ? seen : new Set(seen || []);
    return (deals || []).filter((d) => !set.has(dealKey(d)));
  }

  /** Cheapest item-market listing at/under the buy price, from Torn's itemmarket listings. */
  function itemMarketDealFor(item, listings) {
    if (!item || !Number.isFinite(item.buyPrice) || item.buyPrice <= 0) return null;
    let best = null;
    let qtyUnder = 0;
    for (const l of listings || []) {
      const price = Number(l.price);
      const qty = Number(l.amount ?? l.quantity) || 1;
      if (!Number.isFinite(price) || price <= 1 || price > item.buyPrice) continue;
      qtyUnder += qty;
      if (!best || price < best) best = price;
    }
    if (best == null) return null;
    return {
      source: "market", itemId: item.itemId, name: item.name, buyPrice: item.buyPrice, price: best,
      qtyUnder, sellerId: null, sellerName: null,
      underPct: Math.round(((item.buyPrice - best) / item.buyPrice) * 1000) / 10,
    };
  }

  /** Server bazaar deals + the script's own item-market deals, biggest discount first. */
  function mergeDeals(bazaarDeals, marketDeals, watched) {
    const onList = new Set((watched || []).map((w) => w.itemId));
    const out = [
      ...(bazaarDeals || []).map((d) => ({ ...d, source: "bazaar" })),
      ...(marketDeals || []).filter((d) => d && onList.has(d.itemId)),
    ];
    return out.sort((a, b) => b.underPct - a.underPct || a.itemId - b.itemId);
  }

  /** Which watched items get an item-market read this poll (a rotation over the list). */
  function pickMarketChecks(watched, slot, n) {
    const list = watched || [];
    if (list.length <= n) return list.slice();
    const start = ((Math.floor(slot) * n) % list.length + list.length) % list.length;
    const out = [];
    for (let k = 0; k < n; k++) out.push(list[(start + k) % list.length]);
    return out;
  }

  function minutesAgo(iso, now) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round((now - t) / 60_000));
    return m < 1 ? "just now" : `${m} min ago`;
  }

  /** Item-market rows of one item at or under the buy price (the seller list is sorted cheapest first). */
  function priceLineIndex(prices, buyPrice) {
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) return -1;
    let under = 0;
    for (const p of prices) {
      if (Number.isFinite(p) && p <= buyPrice) under++;
      else break;
    }
    return under;
  }

  // ---------------------------------------------------------------------------------------
  // Storage (secrets: GM only — same rule as Chain Watch)
  // ---------------------------------------------------------------------------------------

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch { /* ignore */ }
    if (SECRET_KEYS.has(key)) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return true;
      }
    } catch { /* ignore */ }
    if (SECRET_KEYS.has(key)) return false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function pdaApiKey() {
    return PDA_API_KEY && !PDA_API_KEY.includes("###") ? PDA_API_KEY.trim() : "";
  }

  // Torn PDA keeps the Overseer session between pages (0.7.15, same fix as Chain Watch
  // v0.32.1). PDA's GM storage does not survive a page load, so the session minted on one
  // Torn page was gone on the next and the script signed in again on EVERY page (~70
  // sign-ins per PDA player a day, 2026-11-02). In PDA only, the session token is mirrored
  // to page localStorage. Never the Torn key — PDA injects that fresh each load. The token
  // is identity-only (the site keeps no key), Overseer-only and lasts 12 h; the trade-off is
  // that other scripts on torn.com can read it (owner-approved for Chain Watch 2026-11-01).
  // It is tagged with a hash of the key it was minted from, so a different PDA account
  // never picks up someone else's session.
  const PDA_SESSION_MIRROR = "totr_pda_session";

  function isTornPda() {
    return typeof window !== "undefined" && !!window && typeof window.PDA_httpGet === "function";
  }

  // FNV-1a, 32-bit: a tag that tells keys apart, not a secret (can't recover a 16-char key).
  function keyTag(key) {
    let h = 0x811c9dc5;
    const s = String(key || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function readPdaSession(tornKey) {
    if (!isTornPda() || !tornKey) return "";
    try {
      const raw = localStorage.getItem(PDA_SESSION_MIRROR);
      if (!raw) return "";
      const m = JSON.parse(raw);
      return m && typeof m.t === "string" && m.k === keyTag(tornKey) ? m.t.trim() : "";
    } catch {
      return "";
    }
  }

  function writePdaSession(token, tornKey) {
    if (!isTornPda()) return;
    try {
      if (token && tornKey) localStorage.setItem(PDA_SESSION_MIRROR, JSON.stringify({ t: token, k: keyTag(tornKey) }));
      else localStorage.removeItem(PDA_SESSION_MIRROR);
    } catch {
      /* storage unavailable — the script just signs in again, as before */
    }
  }

  // Every write of the session token goes through here so the PDA mirror stays in step.
  function saveSessionToken(token) {
    const value = String(token || "").trim();
    const ok = gmSet(STORE.sessionToken, value);
    writePdaSession(value, prefs().tornKey);
    return ok;
  }

  function prefs() {
    const tornKey = String(gmGet(STORE.tornKey, "") || "").trim() || pdaApiKey();
    return {
      tornKey,
      sessionToken: String(gmGet(STORE.sessionToken, "") || "").trim() || readPdaSession(tornKey),
      fillPct: clampPct(gmGet(STORE.fillPct, DEFAULT_FILL_PCT), DEFAULT_FILL_PCT, MAX_FILL_PCT, MIN_FILL_PCT),
      dealPct: clampPct(gmGet(STORE.dealPct, DEFAULT_DEAL_PCT), DEFAULT_DEAL_PCT, 100),
      ignored: new Set((gmGet(STORE.ignored, []) || []).map(Number).filter(Number.isSafeInteger)),
      sellMode: sellModeOf(gmGet(STORE.sellMode, null)),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Requests — GM_xmlhttpRequest or Torn PDA only; never page fetch (keeps the session private)
  // ---------------------------------------------------------------------------------------

  function httpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function parseHttpJson(status, text, url) {
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw httpError(`Non-JSON response from ${url}`, status);
    }
    if (status < 200 || status >= 300) {
      throw httpError(parsed && typeof parsed.error === "string" ? parsed.error : `Request failed (${status})`, status);
    }
    return parsed;
  }

  async function requestJson(url, options = {}) {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const data = options.body == null ? undefined : JSON.stringify(options.body);
    if (typeof window.PDA_httpPost === "function" && typeof window.PDA_httpGet === "function") {
      const res = method === "POST" ? await window.PDA_httpPost(url, headers, data || "") : await window.PDA_httpGet(url, headers);
      return parseHttpJson(Number(res?.status ?? res?.statusCode ?? 200), String(res?.responseText ?? res?.body ?? ""), url);
    }
    if (typeof GM_xmlhttpRequest !== "function") {
      throw new Error("This script needs Tampermonkey (or Torn PDA).");
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data, timeout: options.timeout || 20000,
        onload: (res) => {
          try { resolve(parseHttpJson(res.status, res.responseText, url)); } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error(`Network error calling ${url}`)),
        ontimeout: () => reject(new Error(`Timed out calling ${url}`)),
      });
    });
  }

  async function connect() {
    const { tornKey } = prefs();
    if (!tornKey) throw httpError("No Torn API key saved in this script yet — open Price check on any item (or any trade) and paste a Limited key.", 401);
    const res = await requestJson(`${FUNCTIONS_URL}/connect-torn-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: { apiKey: tornKey, persist: false },
    });
    if (!res || typeof res.sessionToken !== "string") throw new Error("The site did not return a session.");
    saveSessionToken(res.sessionToken);
    return res.sessionToken;
  }

  async function callTrader(action, body = {}, retried = false) {
    let token = prefs().sessionToken;
    if (!token) token = await connect();
    try {
      return await requestJson(`${FUNCTIONS_URL}/trader-script`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`,
          "X-Session-Token": token,
        },
        body: { action, ...body },
      });
    } catch (err) {
      if (err && err.status === 401 && !retried && prefs().tornKey) {
        saveSessionToken("");
        await connect();
        return callTrader(action, body, true);
      }
      throw err;
    }
  }

  // Runtime half of the fill events: collect during a pass, flush once it settles.
  const FILL_FLUSH_MS = 400;
  const fillQueue = { list: [], timer: null, off: false };
  function noteFill(itemId, price, kind, tradeId) {
    if (fillQueue.off) return;
    fillQueue.list = addFillEvent(fillQueue.list, itemId, price, kind, tradeId);
    clearTimeout(fillQueue.timer);
    fillQueue.timer = setTimeout(flushFills, FILL_FLUSH_MS);
  }
  function noteFills(events) {
    for (const e of Array.isArray(events) ? events : []) noteFill(e.itemId, e.price, e.kind, e.tradeId);
  }
  function flushFills() {
    const events = fillQueue.list;
    fillQueue.list = [];
    if (!events.length || fillQueue.off) return;
    // Fire and forget: a lost batch costs one "sold at your price" stamp, never a fill.
    callTrader("fill_event", { events }).catch((err) => {
      if (/Unknown action/i.test(String(err && err.message))) fillQueue.off = true;
    });
  }

  // ---------------------------------------------------------------------------------------
  // DOM helpers — text only, never innerHTML for anything that came from outside
  // ---------------------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** Fill a React-controlled input so Torn's form sees it. Refuses empty / NaN / negative. */
  function setNativeValue(input, value) {
    if (!input) return false;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const text = String(Math.round(n));
    // Torn's bazaar pages are older React plus a jQuery money widget (tornInputMoney) that keeps a
    // hidden twin input; fire the full key/input/change/blur set so both pick the value up.
    try { input.focus({ preventScroll: true }); } catch (_) { /* detached */ }
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "0" }));
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const twin = input.classList && input.classList.contains("input-money")
      ? input.parentElement && input.parentElement.querySelector("input[type='hidden'].input-money, input[type='hidden'][name='price']")
      : null;
    if (twin && twin !== input) { setter.call(twin, text); twin.dispatchEvent(new Event("change", { bubbles: true })); }
    input.dispatchEvent(new Event("blur"));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return true;
  }

  /** Empty a Torn input the same way setNativeValue fills one (events + money-widget twin). */
  function clearNativeValue(input) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    try { input.focus({ preventScroll: true }); } catch (_) { /* detached */ }
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const twin = input.classList && input.classList.contains("input-money")
      ? input.parentElement && input.parentElement.querySelector("input[type='hidden'].input-money, input[type='hidden'][name='price']")
      : null;
    if (twin && twin !== input) { setter.call(twin, ""); twin.dispatchEvent(new Event("change", { bubbles: true })); }
    input.dispatchEvent(new Event("blur"));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === "function") { GM_setClipboard(String(text), "text"); return true; }
    } catch { /* fall through */ }
    try { navigator.clipboard.writeText(String(text)); return true; } catch { return false; }
  }

  const CSS = `
  .totr{font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6ebf2;background:#11161f;border:1px solid #2f3b4d;border-radius:10px;margin:10px 0;overflow:hidden}
  .totr-head{padding:12px 14px;border-bottom:1px solid #232c3a;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .totr-title{font-size:18px;font-weight:800;flex-basis:100%}
  .totr-pill{display:inline-flex;align-items:center;height:20px;padding:0 9px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:#1a2230;color:#9aa7b8}
  .totr-pill--warn{background:#3a2a0f;color:#f0b54a}.totr-pill--ok{background:#0f3324;color:#5fe0a6}.totr-pill--info{background:#16263f;color:#8ab8ff}.totr-pill--danger{background:#3d1419;color:#ff7b7b}
  .totr-body{padding:10px 14px;display:flex;flex-direction:column;gap:10px}
  .totr-row{display:grid;grid-template-columns:1fr 60px 120px 130px;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #1b2330}
  .totr-row--unpriced{color:#f0a6ff}
  .totr-num{font-variant-numeric:tabular-nums;text-align:right}
  .totr-btn{font:inherit;font-weight:600;color:#e6ebf2;background:#161d28;border:1px solid #3a475b;border-radius:6px;height:32px;padding:0 12px;cursor:pointer}
  .totr-btn--primary{background:#e23b3b;border-color:#e23b3b;color:#fff}
  .totr-actions{display:flex;gap:8px;flex-wrap:wrap}
  .totr-muted{color:#9aa7b8;font-size:12px}
  .totr-error{color:#f08a8a}
  .totr-receipts{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid #232c3a}
  .totr-receipts a{color:#8ab8ff;word-break:break-all}
  .totr-msg{padding:8px 10px;background:#0b0e13;border:1px solid #2f3b4d;border-radius:6px;white-space:pre-line;color:#c9d2de}
  .totr-chip{display:inline-block;white-space:nowrap;margin-left:6px;padding:1px 6px;border-radius:4px;font:700 11px system-ui,sans-serif}
  .totr-chip--ok{background:#0f3324;color:#5fe0a6}.totr-chip--warn{background:#3a2a0f;color:#f0c674}.totr-chip--low{background:#2a1430;color:#f0a6ff}
  .totr-mini{white-space:nowrap;font:700 11px system-ui,sans-serif;color:#e6ebf2;background:#161d28;border:1px solid #3a475b;border-radius:5px;height:24px;padding:0 8px;cursor:pointer;margin-left:6px}
  .totr-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;padding:8px 10px;background:#11161f;border:1px solid #2f3b4d;border-radius:8px;font:13px system-ui,sans-serif;color:#e6ebf2}
  .totr-card{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:6px 10px;border-radius:7px;background:#161d28;border:1px solid #232c3a;color:#e6ebf2;text-decoration:none;font-size:13px}
  .totr-card-line{display:flex;gap:6px;align-items:baseline;white-space:nowrap}
  .totr-card-name{color:#9fc3ff;max-width:120px;overflow:hidden;text-overflow:ellipsis}
  .totr-card--under{border-color:#4c8dff;box-shadow:inset 0 0 0 1px #4c8dff}
  .totr-chip--buy{background:#16263f;color:#cfe0ff;box-shadow:0 0 0 1px #4c8dff}
  .totr-mode{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .totr-mode-btn{font:600 12px system-ui,sans-serif;color:#e6ebf2;background:#161d28;border:1px solid #3a475b;border-radius:6px;height:28px;padding:0 12px;cursor:pointer}
  .totr-mode-btn--on{background:#e23b3b;border-color:#e23b3b;color:#fff}
  .totr-total{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums}
  .totr-mv{margin-left:6px;font:600 11px system-ui,sans-serif;color:#9aa7b8;white-space:nowrap}
  .totr-bz{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:6px;font:12px system-ui,sans-serif}
  .totr-bz--manage{display:inline-grid;grid-template-columns:auto auto auto auto;align-items:center;column-gap:5px;row-gap:1px;margin-left:4px;white-space:nowrap;vertical-align:middle}
  .totr-bz--manage .totr-mini{height:22px;margin-left:0}
  .totr-bz--manage .totr-dollar{height:22px;width:22px}
  .totr-bz--manage .totr-bz-profit{grid-column:1 / -1;font-size:11px;line-height:12px}
  .totr-mini--floor{border-color:#c77dd8}
  .totr-vs{font:700 11px system-ui,sans-serif;padding:1px 5px;border-radius:9px;border:1px solid #3a475b;white-space:nowrap;color:#9aa7b8}
  .totr-vs--competitive{color:#5fe0a6;border-color:#2f6b52}.totr-vs--above{color:#f0c674;border-color:#7a6431}.totr-vs--far_above{color:#ff8a80;border-color:#7a3a35}
  .totr-dollar{font:800 13px system-ui,sans-serif;color:#f5c518;background:#0b0e13;border:1px solid #3a475b;border-radius:5px;width:26px;height:24px;cursor:pointer;padding:0}
  .totr-bz-profit{font-weight:700;color:#5fe0a6;white-space:nowrap}.totr-bz-profit--floor{color:#e2a6ef}.totr-bz-profit--loss{color:#ff8a8a}.totr-bz-paid{color:#c9d2de;white-space:nowrap}
  .totr-bz-state{font-weight:700;white-space:nowrap}.totr-bz-state--ok{color:#5fe0a6}.totr-bz-state--warn{color:#f0c674}.totr-bz-state--info{color:#8ab8ff}.totr-bz-state--low{color:#e2a6ef}
  .totr-hlink{font:700 12px Arial,sans-serif;letter-spacing:.06em;color:#ccc;background:transparent;border:0;padding:0 8px;cursor:pointer;text-decoration:none}
  .totr-hage{color:#9aa7b8;font-weight:400;letter-spacing:.03em}
  .totr-hlink--ok{color:#8bc34a}.totr-hlink--qty{color:#7fb2ff}.totr-hlink--warn{color:#f0c674}.totr-hlink--clear{color:#e57373}
  li.totr-deal{position:relative;outline:2px solid #4c8dff;outline-offset:-2px}
  li.totr-flip{position:relative;outline:2px dashed #5fe0a6;outline-offset:-2px}
  .totr-dealchip--flip{color:#082217;background:#5fe0a6;border-color:#5fe0a6}
  .totr-dealchip{position:absolute;top:4px;left:4px;z-index:2;font:700 10px/1.5 system-ui,sans-serif;color:#cfe0ff;background:#16263f;border:1px solid #4c8dff;border-radius:4px;padding:0 5px;pointer-events:none;white-space:nowrap}.totr-hlink:disabled{color:#777;cursor:default}
  .totr-bzline{font:12px system-ui,sans-serif;color:#9aa7b8;margin:6px 0}
  .totr-pick-pop{position:absolute;z-index:99999;width:380px;margin:0;box-shadow:0 18px 44px rgba(0,0,0,.65)}
  .totr-pick-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #232c3a}
  .totr-pick-head strong{flex:1;font-size:15px}
  .totr-pick-x{font:700 13px system-ui,sans-serif;color:#c9d2de;background:transparent;border:0;width:28px;height:28px;cursor:pointer}
  .totr-pick-list{display:flex;flex-direction:column;gap:6px;padding:10px 12px}
  .totr-pick{display:flex;align-items:center;gap:10px;text-align:left;font:13px system-ui,sans-serif;color:#e6ebf2;background:#161d28;border:1px solid #2f3b4d;border-radius:7px;padding:0 12px;min-height:40px;cursor:pointer}
  .totr-pick--main{background:#0f2a1f;border-color:#2f6b4f}.totr-pick:disabled{opacity:.6;cursor:default}
  .totr-pick-label{flex:1}.totr-pick-profit{min-width:56px;text-align:right;font-weight:700;color:#5fe0a6}.totr-pick-profit--floor{color:#e2a6ef}
  .totr-pick-foot{display:flex;align-items:center;gap:8px;padding:8px 12px 10px;border-top:1px solid #232c3a}
  .totr-pick-foot .totr-muted{flex:1}
  .totr-linkbtn{font:12px system-ui,sans-serif;color:#8ab8ff;background:transparent;border:0;cursor:pointer;padding:0}
  .totr-keyinput{-webkit-text-security:disc}
  .totr-pcbtn{font:12px Arial,Helvetica,sans-serif;color:#ddd;background:linear-gradient(#3a3a3a,#262626);border:1px solid #555;border-radius:4px;height:26px;padding:0 12px;cursor:pointer;white-space:nowrap}
  .totr-pcbtn:hover{color:#fff;border-color:#777}
  .totr-pcbar{display:flex;justify-content:flex-end;padding:6px 8px 0}
  .totr-pc{margin:8px}
  .totr-pc--float{position:absolute;z-index:99998;margin:0;max-height:70vh;overflow:auto;box-shadow:0 18px 44px rgba(0,0,0,.65)}
  .totr-pc h4{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#66738a}
  .totr-pc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
  .totr-pc-sec{background:#161d28;border:1px solid #232c3a;border-radius:8px;padding:10px}
  .totr-pc-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid #1b2330;font-size:12px}
  .totr-pc-row:last-child{border-bottom:0}
  .totr-pc-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .totr-pc-row--you{color:#5fe0a6;font-weight:700}
  .totr-pc-row a{color:#9fc3ff;text-decoration:none}
  .totr-src{font:700 9px system-ui,sans-serif;letter-spacing:.06em;padding:1px 5px;border-radius:3px;background:#1a2230;color:#9aa7b8}
  .totr-src--market{background:#16263f;color:#8ab8ff}
  .totr-pc-stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;font-size:12px}
  .totr-pc-stats strong{display:block;font-size:15px;font-variant-numeric:tabular-nums}
  .totr-stk-chip{display:block;width:max-content;max-width:100%;margin:3px 0 0;padding:1px 7px;border-radius:4px;font:700 11px/1.6 system-ui,sans-serif;white-space:normal;background:#1a2230;color:#c9d2de}
  .totr-stk-chip--ok{background:#0f3324;color:#5fe0a6;box-shadow:0 0 0 1px #2f6b4f}
  .totr-stk-chip--info{background:#16263f;color:#cfe0ff}
  .totr-stk-chip--muted{background:#1a2230;color:#9aa7b8}
  .totr-stk-sell{margin:8px 0;padding:10px 12px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
  .totr-stk-warn{border:1px solid #a8762a;border-radius:6px;padding:8px 10px;color:#e6ebf2}
  .totr-stk-warn strong{color:#f0c674;display:block}
  .totr-stk-pos{color:#5fe0a6;font-weight:700}.totr-stk-neg{color:#ff8a8a;font-weight:700}.totr-stk-buy{color:#8ab8ff;font-weight:700}
  .totr-stk-periods{margin-left:auto;display:flex;border:1px solid #3a475b;border-radius:7px;overflow:hidden}
  .totr-stk-period{font:600 12px system-ui,sans-serif;min-height:32px;padding:0 12px;border:0;border-left:1px solid #3a475b;background:#161d28;color:#c9d2de;cursor:pointer}
  .totr-stk-period:first-child{border-left:0}.totr-stk-period--on{background:#e23b3b;color:#fff}
  .totr-stk-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
  .totr-stk-tile{background:#161d28;border:1px solid #232c3a;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;min-width:0}
  .totr-stk-tile--ok{border-color:#2f6b4f}.totr-stk-tile--bad{border-color:#6b2f36}.totr-stk-tile--warn{border-color:#6b5a2f}
  .totr-stk-tile--locked{border-style:dashed;border-color:#3a475b;gap:6px}
  .totr-stk-tile a{color:#8ab8ff;font-weight:700}
  .totr-stk-label{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9aa7b8}
  .totr-stk-value{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .totr-stk-tile--ok .totr-stk-value{color:#5fe0a6}.totr-stk-tile--bad .totr-stk-value{color:#ff8a8a}
  .totr-stk-details summary{cursor:pointer;color:#c9d2de;font-weight:600;padding:4px 0}
  .totr-stk-hrow{display:grid;grid-template-columns:56px 110px 90px minmax(0,1fr);gap:8px;padding:4px 0;border-bottom:1px solid #1b2330;font-size:12px}
  .totr-stk-hrow--ok{color:#5fe0a6}
  .totr-stk-trades{overflow-x:auto}
  .totr-stk-trades h4{margin:4px 0 6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#66738a}
  .totr-stk-trow{display:grid;grid-template-columns:86px 40px 48px 84px 84px 72px 120px minmax(90px,1fr);gap:8px;padding:5px 0;border-bottom:1px solid #1b2330;font-size:12px;min-width:640px}
  .totr-stk-trow--head{color:#9aa7b8;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
  .totr-stk-trow--sell{background:#0f1f19}
  .totr-eye{position:relative;display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;cursor:pointer;background:transparent;border:0;padding:0}
  .totr-eye img{width:18px;height:18px;display:block}
  .totr-eye--live img{border-radius:50%;box-shadow:0 0 0 2px #ff3b45}
  .totr-badge{position:absolute;right:-7px;top:-6px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:#3ecf8e;color:#06210f;font:700 9px/14px system-ui,sans-serif;text-align:center;border:1px solid #222;pointer-events:none}
  .totr-fab{position:fixed;left:58px;bottom:76px;z-index:2147483646;width:46px;height:46px;border-radius:23px;border:2px solid #e23b3b;background:#11161f;color:#e6ebf2;font:800 20px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5)}
  .totr-fab .totr-badge{right:-4px;top:-4px;min-width:20px;height:20px;font-size:11px;line-height:20px;border-radius:10px;border:2px solid #1a1a1a}
  .totr-sheet{position:fixed;z-index:2147483647;right:12px;top:80px;width:360px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#0b0e13;border:1px solid #2f3b4d;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.6);color:#e6ebf2;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  @media (max-width:600px){.totr-sheet{left:0;right:0;top:auto;bottom:0;width:auto;max-height:70vh;border-radius:16px 16px 0 0}}
  .totr-sheet-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;background:#11161f;border-bottom:1px solid #232c3a}
  .totr-sheet-head img{width:20px;height:20px}
  .totr-sheet-title{font-weight:800;letter-spacing:.04em;flex:1}
  .totr-sheet-x{width:40px;height:36px;border:0;background:transparent;color:#9aa7b8;font:700 16px system-ui,sans-serif;cursor:pointer}
  .totr-sheet-tabs{display:grid;grid-template-columns:1fr 1fr;margin:10px 12px 0;border:1px solid #2f3b4d;border-radius:9px;overflow:hidden}
  .totr-sheet-tab{min-height:38px;border:0;background:#11161f;color:#9aa7b8;font:600 13px system-ui,sans-serif;cursor:pointer}
  .totr-sheet-tab--on{background:#e23b3b;color:#fff}
  .totr-sheet-body{padding:12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
  .totr-deal-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #232c3a;background:#161d28;border-radius:10px}
  .totr-deal-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .totr-deal-pct{font:700 11px system-ui,sans-serif;color:#06210f;background:#3ecf8e;border-radius:4px;padding:0 5px;margin-left:6px}
  .totr-deal-open{min-height:40px;padding:0 14px;border-radius:8px;background:#e23b3b;color:#fff !important;text-decoration:none;font-weight:700;display:inline-flex;align-items:center}
  .totr-sheet-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px 12px;border-top:1px solid #232c3a;background:#11161f;color:#9aa7b8;font-size:12px}
  .totr-sheet-foot a,.totr-sheet-body a.totr-link{color:#8ab8ff;font-weight:600}
  .totr-lock-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:#c9d2de}
  .totr-lock-why{padding:10px 12px;border:1px solid #232c3a;background:#161d28;border-radius:10px;color:#c9d2de}
  .totr-priceline{display:flex;align-items:center;gap:8px;margin:2px 0;font:700 11px system-ui,sans-serif;color:#ff8080;letter-spacing:.04em;list-style:none}
  .totr-priceline::before,.totr-priceline::after{content:"";flex:1;border-top:2px dashed #e23b3b}`;

  function injectCss() {
    if (document.getElementById("totr-css")) return;
    document.head.append(el("style", { id: "totr-css" }, CSS));
  }

  // ---------------------------------------------------------------------------------------
  // Modules
  // ---------------------------------------------------------------------------------------

  const modules = {};

  const BAD_KEY_RE = /rejected that API key|exactly as generated|does not allow basic account info|Full-access Torn key/i;
  function forgetKey() {
    gmSet(STORE.tornKey, "");
    saveSessionToken("");
  }
  const hasKey = () => { const p = prefs(); return Boolean(p.tornKey || p.sessionToken); };

  // The Torn key box. A real password field makes Chrome (and password managers) offer to
  // save the key as a password on every Torn page, so it is a plain text box, masked with
  // CSS where the browser supports it, and marked "not a login" for the common managers.
  function keyInput() {
    return el("input", {
      type: "text", class: "totr-keyinput", placeholder: "Your Torn API key (Limited is enough)",
      autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false",
      "data-lpignore": "true", "data-1p-ignore": "true", "data-bwignore": "true", "data-form-type": "other",
      style: "flex:1;min-width:180px;height:32px;border-radius:6px;border:1px solid #2f3b4d;background:#0b0e13;color:#e6ebf2;padding:0 8px",
    });
  }

  // One-time key entry for panels other than the trade window (which has its own).
  // Stored in Tampermonkey's private storage only; tornoverseer.com keeps no copy.
  function keyEntry(onSaved, error) {
    const input = keyInput();
    const msg = el("div", { class: "totr-error" }, error || "");
    const save = () => {
      const key = input.value.trim();
      if (!key) return;
      if (!gmSet(STORE.tornKey, key)) { msg.textContent = "This browser's script manager can't store secrets — use Tampermonkey."; return; }
      saveSessionToken("");
      onSaved();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    return el("div", null,
      error ? msg : null,
      el("div", { class: "totr-muted" }, "Connect once with your Torn API key (Limited is enough — never a Full key). It stays in Tampermonkey's private storage; tornoverseer.com keeps no copy. Every Overseer panel on Torn uses it from then on."),
      el("div", { class: "totr-actions" }, input, el("button", { class: "totr-btn totr-btn--primary", type: "button", onclick: save }, "Connect")),
      error ? null : msg);
  }

  // --- Trade window (TS-2) ----------------------------------------------------------------
  modules.trade = (() => {
    // VERIFY: selectors from TornW3B Trading Companion v2.8.0 / Torn Exchange Helper v1.1.4.
    const SEL = {
      container: "#trade-container",
      anchor: "#trade-container .trade-cont",
      partnerItems: ".user.right .cont li.color2 ul.desc li",
      itemName: ".name.left",
      myMoney: ".user.left .cont li.color1 ul.desc li .name.left",
      partnerName: ".user.right .title-black",
      partnerLink: "#trade-container .log a[href*='XID=']",
      moneyInput: "input.input-money",
    };
    let state = { tradeId: null, result: null, error: null, loading: false, requestSeq: 0 };

    function readItems(root) {
      const out = [];
      for (const li of root.querySelectorAll(SEL.partnerItems)) {
        const nameEl = li.querySelector(SEL.itemName);
        if (!nameEl) continue;
        // First text node only: other scripts (TornTools) append "$value" spans.
        const first = Array.from(nameEl.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim());
        const own = Array.from(nameEl.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
        const parsed = parseItemNode(first ? first.textContent : nameEl.textContent, own);
        if (!parsed || /^no items/i.test(parsed.name)) continue;
        // getAttribute, not className: an SVG element's className is not a string.
        const glow = [li, ...li.querySelectorAll("[class*='glow-']")].map((n) => n.getAttribute("class") || "").join(" ");
        const rarity = rarityFromClasses(glow);
        out.push(rarity ? { ...parsed, rarity } : parsed);
      }
      return out;
    }

    function readMoney(root) {
      for (const node of root.querySelectorAll(SEL.myMoney)) {
        const v = parseMoney(node.textContent);
        if (v != null) return v;
      }
      return 0;
    }

    /** The element's own text (direct text nodes only), falling back to the first word of textContent. */
    function ownText(node) {
      let out = "";
      for (const child of node.childNodes) if (child.nodeType === 3) out += child.textContent;
      out = out.trim();
      return out || String(node.textContent || "").trim().replace(/\s*Hide item values.*$/i, "");
    }
    function readPartner(root) {
      const link = root.querySelector(SEL.partnerLink);
      const m = link && link.getAttribute("href").match(/XID=(\d+)/);
      const nameEl = root.querySelector(SEL.partnerName);
      // 0.7.2: the title cell also holds the "Hide item values" checkbox label;
      // take the cell's own first text node, not every descendant's text.
      return { partnerId: m ? Number(m[1]) : undefined, partnerName: nameEl ? ownText(nameEl) : undefined };
    }

    async function price(root) {
      const items = readItems(root);
      const sig = tradeSignature(items);
      const seq = ++state.requestSeq;
      state.loading = true; state.error = null; render(root);
      try {
        const res = await callTrader("price_trade", { tradeId: state.tradeId, items, ...readPartner(root) });
        if (seq !== state.requestSeq) return; // a newer request superseded this one
        state.result = res;
        state.resultSig = sig;
        if (res && res.receipts) state.receipts = { ...(state.receipts || {}), ...Object.fromEntries(Object.entries(res.receipts).filter(([, v]) => v)) };
      } catch (err) {
        if (seq !== state.requestSeq) return;
        state.error = err.message || String(err);
        // A key Torn refused is useless: forget it so the key box comes back.
        if (BAD_KEY_RE.test(state.error)) forgetKey();
      } finally {
        if (seq === state.requestSeq) { state.loading = false; render(root); }
      }
    }

    function render(root) {
      const anchor = root.querySelector(SEL.anchor);
      if (!anchor) return;
      let panel = document.getElementById("totr-trade");
      if (!panel) {
        panel = el("div", { id: "totr-trade", class: "totr" });
        anchor.after(panel);
      }
      const r = state.result;
      const guard = moneyGuard(r ? r.total : 0, readMoney(root));
      const pills = [el("span", { class: "totr-pill totr-pill--warn" }, "Buying"), el("span", { class: "totr-pill" }, `v${VERSION} beta`)];
      if (guard.state === "ready") pills.unshift(el("span", { class: "totr-pill totr-pill--ok" }, "Ready"));
      if (r && r.total >= BIG_TRADE_TOTAL) pills.push(el("span", { class: "totr-pill totr-pill--danger", title: `This trade is ${fmtMoney(r.total)}. Take the cash out of the bank right before you add it, so it isn't sitting on you to be mugged.` }, "Big cash trade"));

      const body = el("div", { class: "totr-body" });
      const p = prefs();
      if (!p.tornKey && !p.sessionToken) {
        // First run: one-time key entry. Stored in Tampermonkey's private storage only.
        const input = keyInput();
        if (state.error) body.append(el("div", { class: "totr-error" }, state.error));
        body.append(
          el("div", { class: "totr-muted" }, "Connect once with your Torn API key. It stays in Tampermonkey's private storage; tornoverseer.com keeps no copy."),
          el("div", { class: "totr-actions" }, input,
            el("button", { class: "totr-btn totr-btn--primary", type: "button", onclick: () => {
              const key = input.value.trim();
              if (!key) return;
              state.error = null;
              if (!gmSet(STORE.tornKey, key)) { state.error = "This browser's script manager can't store secrets — use Tampermonkey."; render(root); return; }
              price(root);
            } }, "Connect")));
        panel.replaceChildren(el("div", { class: "totr-head" }, ...pills, el("div", { class: "totr-title" }, "Overseer Trade")), body);
        return;
      }
      if (state.loading) body.append(el("div", { class: "totr-muted" }, "Pricing from your Overseer pricelist…"));
      if (state.error) body.append(el("div", { class: "totr-error" }, state.error));
      if (r && Array.isArray(r.lines)) {
        for (const line of r.lines) {
          const rowEl = el("div", { class: "totr-row" + (line.priceEach == null ? " totr-row--unpriced" : "") },
            el("span", null, line.name,
              line.itemId ? el("button", { class: "totr-mini", type: "button", title: "Price check", onclick: () => modules.priceCheck.toggle(line.itemId, rowEl, { name: line.name }) }, "Check") : null,
              line.itemId ? el("a", { class: "totr-mini", href: itemPageUrl(line.itemId), target: "_blank", rel: "noopener", style: "display:inline-flex;align-items:center;text-decoration:none", title: "Open this item's page on Overseer" }, "Full page") : null),
            el("span", { class: "totr-num" }, line.qty),
            el("span", { class: "totr-num" }, line.priceEach == null ? (line.reason === "ranked" ? "ranked — price it" : "not on list") : fmtMoney(line.priceEach) + (line.priceSource === "unpublished" ? " · not on TE/W3b yet" : "")),
            el("span", { class: "totr-num" }, fmtMoney(line.lineTotal)));
          body.append(rowEl);
        }
        if (r.unpriced > 0) body.append(el("div", { class: "totr-row--unpriced" }, `${r.unpriced} item(s) aren't priced — they stay out of the total.`));
        if (!state.loading && fillMoneyBlocked(state, tradeSignature(readItems(root)))) {
          body.append(el("div", { class: "totr-error" }, state.error
            ? "This total is from the last successful pricing and may be out of date — Re-price before adding money."
            : "The items changed since this total was worked out — Re-price before adding money."));
        }
        body.append(el("div", null,
          el("div", { class: "totr-muted" }, "Total to pay"),
          el("div", { class: "totr-total" }, fmtMoney(r.total)),
          el("div", { class: "totr-muted" }, guard.state === "short" ? `Add ${fmtMoney(guard.diff)}` : guard.state === "over" ? `${fmtMoney(guard.diff)} too much in trade` : guard.state === "ready" ? "Money matches — press Torn's Accept when happy." : "")));
        body.append(el("div", { class: "totr-actions" },
          r.total > 0 && guard.state !== "ready" && !fillMoneyBlocked(state, tradeSignature(readItems(root)))
            ? el("button", { class: "totr-btn totr-btn--primary", type: "button", onclick: () => fillMoney(root, r.total) }, "Fill money")
            : null,
          el("button", { class: "totr-btn", type: "button", onclick: () => copyText(r.total) }, "Copy total"),
          el("button", { class: "totr-btn", type: "button", onclick: () => price(root) }, "Re-price"),
          el("button", { class: "totr-btn", type: "button", onclick: () => { forgetKey(); state.result = null; render(root); } }, "Change key")));
        if (r.total > 0) body.append(renderReceipts(root));
      } else if (!state.loading) {
        if (!tradeSignature(readItems(root))) body.append(el("div", { class: "totr-muted" }, "Waiting for the other player to add items…"));
        body.append(el("button", { class: "totr-btn totr-btn--primary", type: "button", onclick: () => price(root) }, "Price this trade"));
      }
      panel.replaceChildren(
        el("div", { class: "totr-head" }, ...pills, el("div", { class: "totr-title" }, "Overseer Trade")),
        body);
    }

    // --- Receipts (TS-3) ------------------------------------------------------------------
    // TE: made from the browser with TE's own helper endpoints (TE links "TE Trading Helper"
    // from its site); Overseer then records it. W3b: made by the Overseer server. Both, every
    // trade, because each site only lists traders who keep making receipts on it.
    let me = null;
    async function whoAmI() {
      if (me) return me;
      const res = await callTrader("hello", { scriptVersion: VERSION });
      if (!res || !res.player || !res.player.id) throw new Error("Overseer didn't say who you are.");
      me = { id: Number(res.player.id), name: String(res.player.name || "") };
      return me;
    }

    function receiptLines() {
      return (state.result ? state.result.lines : []).filter((l) => l.priceEach != null);
    }

    // TE files a receipt under the `owner_user_id` it is given — and that id is
    // TE's own, not Torn's. TE Helper learns it from `/new_extension_get_prices`
    // (the response carries `buyer_id`) before it submits; 0.7.0–0.7.5 sent the
    // Torn player id instead, so every receipt the script made was real but
    // filed under nobody (confirmed 2026-10-29: nCnMC97zBQ absent from the
    // trader's list, never collected, never counted for "active").
    async function teBuyerId(self, partner, lines) {
      const res = await requestJson("https://tornexchange.com/new_extension_get_prices", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: {
          items: lines.map((l) => l.name),
          quantities: lines.map((l) => l.qty),
          user_name: self.name,
          seller_name: partner.partnerName || "",
        },
      });
      const id = res && (res.buyer_id ?? res.buyerId ?? (res.buyer && res.buyer.id));
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("TE didn't recognise your account — is your Torn name registered on Torn Exchange?");
      return n;
    }

    async function makeTeReceipt(partner) {
      const self = await whoAmI();
      const lines = receiptLines();
      const buyerId = await teBuyerId(self, partner, lines);
      const res = await requestJson("https://tornexchange.com/new_create_receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: {
          owner_username: self.name,
          owner_user_id: buyerId,
          seller_username: partner.partnerName || "",
          prices: lines.map((l) => l.priceEach),
          item_quantities: lines.map((l) => l.qty),
          item_names: lines.map((l) => l.name),
          trade_id: state.tradeId,
        },
      });
      try { console.info("[Overseer Trading] TE receipt response keys:", Object.keys(res || {}).join(", ")); } catch { /* ignore */ }
      const id = res && (res.receipt_id || res.receiptId);
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new Error("TE didn't return a receipt.");
      const te = {
        platform: "te",
        receiptId: String(id),
        url: `https://tornexchange.com/receipt/${id}`,
        message: [res.trade_message, res.tradeMessage, res.message].find((m) => typeof m === "string" && m.trim()) || null,
        total: Number.isSafeInteger(Number(res.total)) ? Number(res.total) : null,
      };
      // Overseer remembers it per trade. If the server half isn't live yet, keep going.
      try {
        await callTrader("record_receipt", {
          tradeId: state.tradeId, ...te, partnerId: partner.partnerId, partnerName: partner.partnerName,
          lines: lines.map((l) => ({ itemId: l.itemId ?? null, name: l.name, qty: l.qty, priceEach: l.priceEach })),
        });
      } catch (err) { te.note = "Saved on TE; Overseer couldn't record it yet."; }
      return te;
    }

    async function makeW3bReceipt(partner) {
      const res = await callTrader("create_w3b_receipt", {
        tradeId: state.tradeId, partnerId: partner.partnerId, partnerName: partner.partnerName, lines: state.result.lines,
      });
      const r = res && res.receipt;
      if (!r || typeof r.url !== "string" || !/^https:\/\/weav3r\.dev\//.test(r.url)) throw new Error("W3b didn't return a receipt.");
      return { ...r, totalsMatch: res.totalsMatch, diff: res.diff };
    }

    async function makeReceipts(root) {
      if (state.receiptBusy) return;
      state.receiptBusy = true; state.receiptErrors = {}; render(root);
      const partner = readPartner(root);
      state.receipts = state.receipts || {};
      const jobs = [];
      if (!state.receipts.te) jobs.push(makeTeReceipt(partner).then((x) => { state.receipts.te = x; }, (e) => { state.receiptErrors.te = e.message || String(e); }));
      if (!state.receipts.w3b) jobs.push(makeW3bReceipt(partner).then((x) => { state.receipts.w3b = x; }, (e) => {
        state.receiptErrors.w3b = /unknown|action/i.test(e.message || "") ? "W3b receipts arrive with the next Overseer server update." : (e.message || String(e));
      }));
      await Promise.all(jobs);
      rememberReceipts(state.tradeId, state.receipts);
      state.receiptBusy = false; render(root);
    }

    // Local copy per trade so a reload never makes a second TE receipt for the same trade.
    // (Overseer's own record replaces this once the server half is live.) Pruned after 2 days.
    function rememberReceipts(tradeId, rc) {
      if (!tradeId || !rc) return;
      const all = gmGet("totr_receipts", {}) || {};
      const cutoff = Date.now() - 2 * 86_400_000;
      for (const [k, v] of Object.entries(all)) if (!v || v.at < cutoff) delete all[k];
      all[tradeId] = { at: Date.now(), te: rc.te || null, w3b: rc.w3b || null };
      gmSet("totr_receipts", all);
    }
    function recalledReceipts(tradeId) {
      const all = gmGet("totr_receipts", {}) || {};
      const v = all[tradeId];
      return v ? { te: v.te, w3b: v.w3b } : null;
    }

    function putInComment(text) {
      const box = document.querySelector("#postTradeMessage, textarea[name*='comment' i], input[name*='comment' i], .trade-comment input, .trade-comment textarea"); // VERIFY
      if (!box) return false;
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(box, String(text).slice(0, 155));
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      box.focus();
      return true;
    }

    /** Our own short message when neither platform sent one (fits Torn's 155-char comment). */
    function defaultMessage(rc) {
      const link = (rc.te && rc.te.url) || (rc.w3b && rc.w3b.url);
      if (!link || !state.result) return null;
      const n = receiptLines().reduce((a, l) => a + l.qty, 0);
      return `Thanks! ${n} item${n === 1 ? "" : "s"} for ${fmtMoney(state.result.total)}. Receipt: ${link}`;
    }

    function renderReceipts(root) {
      const rc = state.receipts || {};
      const errs = state.receiptErrors || {};
      const box = el("div", { class: "totr-receipts" }, el("div", { class: "totr-muted" }, "Receipts"));
      const row = (label, x, err) => {
        if (x) return el("div", { class: "totr-actions" },
          el("span", { style: "min-width:110px" }, `${label} ✓`),
          el("a", { href: x.url, target: "_blank", rel: "noopener noreferrer" }, x.url.replace(/^https:\/\//, "")),
          el("button", { class: "totr-btn", type: "button", onclick: () => copyText(x.url) }, "Copy link"),
          x.note ? el("span", { class: "totr-muted" }, x.note) : null,
          x.totalsMatch === false ? el("span", { class: "totr-error" }, `W3b total differs by ${fmtMoney(Math.abs(x.diff || 0))} — check your W3b list`) : null);
        if (err) return el("div", { class: "totr-error" }, `${label}: ${err}`);
        return null;
      };
      // 0.7.1: row() is null for a receipt that does not exist yet, and the
      // native append() spells null out — "nullnull" shipped in 0.7.0.
      for (const line of [row("Torn Exchange", rc.te, errs.te), row("TornW3B", rc.w3b, errs.w3b)]) if (line) box.append(line);
      if (!rc.te && !rc.w3b && !errs.te && !errs.w3b) {
        box.append(el("div", { class: "totr-muted" }, "None yet — create them before you press Accept. A receipt is what keeps you listed on TE."));
      }
      const message = (rc.te && rc.te.message) || (rc.w3b && rc.w3b.message) || defaultMessage(rc);
      if (message) {
        box.append(el("div", { class: "totr-msg" }, message),
          el("div", { class: "totr-actions" },
            el("button", { class: "totr-btn", type: "button", onclick: () => copyText(message) }, "Copy message"),
            el("button", { class: "totr-btn", type: "button", onclick: () => putInComment(message) }, "Put in trade comment")));
      }
      if (!rc.te || !rc.w3b) {
        box.append(el("button", { class: "totr-btn totr-btn--primary", type: "button", disabled: state.receiptBusy || undefined, onclick: () => makeReceipts(root) },
          state.receiptBusy ? "Creating…" : (rc.te || rc.w3b ? "Create missing receipt" : "Create receipts")));
      }
      return box;
    }

    // On the add-money step, one click types the total in; the player presses Change.
    function fillMoney(root, total) {
      if (fillMoneyBlocked(state, tradeSignature(readItems(root)))) { render(root); return; }
      const fills = tradeFillEvents(state.result ? state.result.lines : [], state.tradeId);
      const input = document.querySelector(SEL.moneyInput);
      if (input) { if (setNativeValue(input, total)) { noteFills(fills); gmSet("totr_pending_money", null); } return; }
      // Not on the add-money step: take the player there (Torn's own link), total remembered.
      gmSet("totr_pending_money", { tradeId: state.tradeId, total, at: Date.now(), fills });
      const link = root.querySelector("a[href*='step=addmoney']"); // VERIFY
      if (link) link.click();
    }

    function onRoute() {
      const { step, tradeId } = parseTradeHash(location.hash);
      const root = document.querySelector(SEL.container);
      if (!root) return;
      if (step === "addmoney") {
        // Offer, don't auto-fill: one button beside Torn's input. VERIFY placement.
        const pending = pendingMoneyFor(gmGet("totr_pending_money", null), tradeId, Date.now());
        const input = document.querySelector(SEL.moneyInput);
        if (pending && input && !document.getElementById("totr-fillmoney")) {
          const which = pending.tradeId != null ? ` (trade #${pending.tradeId})` : "";
          input.after(el("button", { id: "totr-fillmoney", class: "totr-btn totr-btn--primary", type: "button", title: `Total remembered from the trade you just priced${which}`,
            onclick: (e) => {
              if (!setNativeValue(input, pending.total)) return;
              noteFills(pending.fills);
              // Used once: the next add-money page must not offer it again.
              gmSet("totr_pending_money", null);
              e.currentTarget.remove();
            } }, `Fill ${fmtMoney(pending.total)}${which}`));
        }
        return;
      }
      if (!["view", "accept", "accept2"].includes(step)) return;
      const changed = tradeId !== state.tradeId;
      if (changed) {
        state = { tradeId, result: null, error: null, loading: false, requestSeq: state.requestSeq, pricedSig: null, resultSig: null, moneySeen: null, receipts: recalledReceipts(tradeId), receiptErrors: {}, receiptBusy: false };
        // A remembered total belongs to ONE trade: drop it once a different trade is on screen.
        const pending = gmGet("totr_pending_money", null);
        if (pending && tradeId != null && pending.tradeId != null && Number(pending.tradeId) !== Number(tradeId)) gmSet("totr_pending_money", null);
      }
      // Torn fills the trade in after the page loads, and its timers tick every second. So:
      // price only once items are actually on the page, re-price when the items change, and
      // otherwise leave the panel alone (redrawing on every tick wiped the key box).
      const sig = tradeSignature(readItems(root));
      const money = readMoney(root);
      const ready = prefs().tornKey || prefs().sessionToken;
      if (ready && sig && sig !== state.pricedSig && !state.loading && !state.error && step === "view") {
        state.pricedSig = sig;
        price(root);
        return;
      }
      const panelThere = document.getElementById("totr-trade");
      if (changed || !panelThere || money !== state.moneySeen) {
        state.moneySeen = money;
        render(root);
      }
    }

    return { onRoute };
  })();

  // --- Your bazaar: sell list (WO-35 BZ-2) ------------------------------------------------
  // Prices come from the trader's Bazaar sell list on tornoverseer.com (trader-script
  // `sell_prices`): default rule → category rule → item override, never below cost + floor%.
  // The script stays thin: header links FILL ALL · FILL QTY · SETTINGS (Manage: FIX N OFF
  // TARGET), and per row [Fill $X] [$] + profit each. $ opens "pick a price". It only fills
  // boxes — you still press Torn's Add to Bazaar / Save Changes.
  modules.bazaarOwn = (() => {
    const SEL = {
      priceInput: "input[placeholder*='Price' i], input.input-money:not([type='hidden']), input[aria-label*='Price' i], input[name*='price' i]",
      qtyInput: "input[name='amount'], input[placeholder*='Qty' i], input[placeholder*='Amount' i], input[name*='amount' i], input[aria-label*='Amount' i]",
    };
    const sell = new Map();   // itemId → sell_prices answer
    const SELL_RETRY_MS = 30_000; // 0.7.4: pause after a transient sell_prices failure
    let retryAfter = 0;
    const pending = new Set();
    let lastError = null;
    let popup = null;
    const fresh = { loadedAt: null, refsAt: null }; // 0.7.11: target freshness (see targetsAge)
    let ageTimer = null;

    function rowOf(input) {
      return input.closest("li, tr, [class*='row___'], [class*='item___'], [class*='listItem___']") || input.parentElement;
    }
    function marketValueIn(row) {
      const hit = moneyIn(row);
      return hit && hit.value > 0 ? hit : null;
    }
    /** The count Torn prints on the row, or null when there is none to read. */
    function countIn(row) {
      // Torn's Add row: <div class="item-amount qty">9</div>, and "x 9" in the name spans.
      const badge = row.querySelector(".item-amount, [class*='amount___'], [class*='quantity___']");
      const b = badge && Number(String(badge.textContent || "").replace(/[^0-9]/g, ""));
      if (b > 0) return b;
      const nameEl = row.querySelector(".name-wrap .t-hide, .name-wrap, [class*='name___']") || row;
      const m = (nameEl.textContent || "").match(/(?:^|[^A-Za-z0-9])x\s?([0-9][0-9,]*)(?![0-9])/);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    }
    // A row with no printed count is a single item (Torn never prints "x1"). `held` is what
    // FILL QTY types; the stock check reads the raw `count` so it can tell "1" from "unread".
    function itemIdIn(row) {
      const img = row.querySelector("img[src*='/images/items/']");
      const m = img && img.getAttribute("src").match(/\/images\/items\/(\d+)\//);
      return m ? Number(m[1]) : null;
    }
    function rows() {
      const out = [];
      for (const input of document.querySelectorAll(SEL.priceInput)) {
        if (input.closest(".totr") || input.type === "hidden") continue;
        const row = rowOf(input);
        if (!row || out.some((r) => r.row === row)) continue;
        const mvHit = marketValueIn(row);
        const count = countIn(row);
        out.push({ row, price: input, qty: row.querySelector(SEL.qtyInput), mvNode: mvHit ? mvHit.node : null, held: count || 1, count, itemId: itemIdIn(row) });
      }
      return out;
    }
    // Torn keeps every category's list in the page and hides the ones you aren't looking at —
    // and only lets you add one category at a time — so the header links act on the open tab only.
    function shownRow(r) {
      if (!r.row.isConnected || (r.price && r.price.disabled)) return false;
      for (let n = r.row; n && n !== document.body; n = n.parentElement) {
        if (n.hidden) return false;
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
      }
      return true;
    }
    function isManage() { return /manage/i.test(location.hash); }
    function listedPrice(input) {
      // Torn pre-fills new Add rows with $1 — that isn't a price anyone chose, so it counts as empty.
      const n = Number(String(input.value || "").replace(/[^0-9]/g, ""));
      return Number.isFinite(n) && n > 1 ? n : null;
    }
    function cellOf(row, node, avoid) {
      let cell = node && node.parentElement;
      if (!cell || !row.contains(cell)) return null;
      while (cell.parentElement && cell.parentElement !== row && !cell.parentElement.querySelector("input")
        && !(avoid && cell.parentElement.contains(avoid))) cell = cell.parentElement;
      return cell.querySelector("input") || (avoid && cell.contains(avoid)) ? null : cell;
    }
    function nameNode(row) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (t && !/\$/.test(t) && /[A-Za-z]{2}/.test(t) && !(n.parentElement && n.parentElement.closest("[data-totr-ui], button, input"))) return n;
      }
      return null;
    }
    /** The column right after Name — Torn's Details column on Manage. Found by position, not
     *  class names: climb from the name text to the cell whose parent also holds the price box,
     *  then take its next sibling, as long as that is neither the RRP nor an input cell. */
    function detailsCell(r) {
      let cell = nameNode(r.row);
      cell = cell && cell.parentElement;
      while (cell && cell.parentElement && !cell.parentElement.contains(r.price)) cell = cell.parentElement;
      for (let next = cell && cell.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.querySelector("input") || (r.mvNode && next.contains(r.mvNode))) return null;
        return next;
      }
      return null;
    }
    /** Manage: Torn's Details column. Add: after the value text. */
    function placeFor(r) {
      if (isManage()) {
        const details = detailsCell(r);
        if (details) return details;
      }
      return cellOf(r.row, r.mvNode, null);
    }

    const paidText = (s) => (s && s.costEach != null && Number(s.costEach) > 0 ? `paid ${fmtMoney(Math.round(Number(s.costEach)))}` : "");
    const profitText = (s, price) => (s && s.costEach != null && price != null ? `${price - s.costEach >= 0 ? "+" : "−"}${fmtMoney(Math.abs(price - s.costEach))}` : "");

    /** Manage only: how the listed price sits against the sell-list price. */
    function stateFor(r, s) {
      const listed = listedPrice(r.price);
      if (!s || s.sellAt == null || listed == null) return null;
      if (s.floor != null && listed < s.floor) return { text: "under floor", cls: "low", off: true };
      const d = driftPct(listed, s.sellAt);
      if (d == null) return null;
      if (Math.abs(d) < 2) return { text: "✓", cls: "ok", off: false };
      return { text: `${d > 0 ? "+" : ""}${d}%`, cls: d < 0 ? "info" : "warn", off: true };
    }

    function fillRow(r, price) {
      const s = sell.get(r.itemId);
      const p = price != null ? price : s && s.sellAt;
      if (p == null) return;
      // Quantity first: Torn redraws a row when its qty changes and can drop a price typed
      // just before. Then check once more a moment later and put the price back if it was lost.
      if (r.qty && !isManage() && !r.qty.value) setNativeValue(r.qty, r.held);
      if (setNativeValue(r.price, p)) noteFill(r.itemId, p, "bazaar");
      setTimeout(() => {
        if (r.price.isConnected && listedPrice(r.price) !== Math.round(p)) setNativeValue(r.price, p);
        refresh(r);
      }, 150);
      refresh(r);
    }
    /** CLEAR: empty qty and price on the open tab, so Torn counts nothing from it. */
    function clearRow(r) {
      for (const input of [r.qty, r.price]) {
        if (!input || input.disabled) continue;
        clearNativeValue(input);
        // Torn's money box copies the last value into its grey hint; put the hint back.
        if (input === r.price && /\d/.test(input.getAttribute("placeholder") || "")) input.setAttribute("placeholder", "Price");
      }
      refresh(r);
    }
    // FILL QTY is an explicit ask: set every row to all you hold, even over a 1 already typed.
    function fillQty(r) { if (r.qty && !isManage() && String(r.qty.value) !== String(r.held)) setNativeValue(r.qty, r.held); }

    function decorate(r) {
      if (!r.itemId) return;
      const s = sell.get(r.itemId);
      if (s === undefined) return; // not loaded yet
      const key = `${r.itemId}:${s ? s.sellAt : "x"}`;
      if (r.row.dataset.totr === key) { refresh(r); return; }
      r.row.querySelectorAll("[data-totr-row]").forEach((n) => n.remove());
      r.row.dataset.totr = key;
      const box = el("span", { class: "totr-bz" + (isManage() ? " totr-bz--manage" : ""), "data-totr-ui": "1", "data-totr-row": "1" });
      if (s && s.sellAt != null) {
        box.append(el("button", { class: "totr-mini" + (s.heldAtFloor ? " totr-mini--floor" : ""), type: "button", title: s.ruleLabel || "", onclick: () => fillRow(r) }, `Fill ${fmtMoney(s.sellAt)}`));
        // WO-53 MC-3: the same "vs cheapest" pill as the site's Bazaar tab, beside Fill.
        const vs = vsCheapest(s.sellAt, s.market, Date.now());
        if (vs.label) box.append(el("span", { class: `totr-vs totr-vs--${vs.band}`, title: vs.title }, vs.label));
      } else {
        box.append(el("span", { class: "totr-muted", title: (s && s.ruleLabel) || "" }, s && s.reason === "unknown_category" ? "Open the Bazaar tab on the site" : "Priced by hand"));
      }
      box.append(el("button", { class: "totr-dollar", type: "button", "aria-label": "Quick prices", onclick: (e) => openPopup(r, e.currentTarget) }, "$"));
      box.append(el("span", { class: "totr-bz-state", "data-totr-state": "1" }));
      // 0.7.13: what you paid, right on the Manage row — the reason to Fix or not, without
      // opening Price check. Ledger cost of the ones you still hold (average when bought at
      // different prices); nothing when the ledger has no open lot for the item.
      const paid = paidText(s);
      if (isManage() && paid) box.append(el("span", { class: "totr-bz-paid", title: "What you paid for the ones you still hold (your ledger's open lots; an average if you bought at different prices)" }, paid));
      // 0.7.14 (WO-64): your bazaar vs the best trader vs the item market, on Overseer.
      if (isManage() && r.itemId) box.append(el("a", { class: "totr-linkbtn", href: itemPageUrl(r.itemId, "sell"), target: "_blank", rel: "noopener", title: "Compare your bazaar, the best trader and the item market for this item" }, "Compare"));
      // 0.7.12: a loss reads red (it used to stay green with only a minus sign).
      const loss = s && s.sellAt != null && s.costEach != null && s.sellAt < s.costEach;
      box.append(el("span", { class: "totr-bz-profit" + (s && s.heldAtFloor ? " totr-bz-profit--floor" : loss ? " totr-bz-profit--loss" : "") }, s && s.sellAt != null ? `${profitText(s, s.sellAt)}${s.heldAtFloor ? " · floor" : ""}` : ""));
      const spot = placeFor(r);
      if (spot) spot.append(box); else r.price.insertAdjacentElement("afterend", box);
      if (!r.price.dataset.totrListen) { r.price.dataset.totrListen = "1"; r.price.addEventListener("input", () => refresh(r)); }
      refresh(r);
    }

    function refresh(r) {
      const tag = r.row.querySelector("[data-totr-state]");
      if (!tag) return;
      const st = isManage() ? stateFor(r, sell.get(r.itemId)) : null;
      const text = st ? st.text : "";
      const cls = "totr-bz-state" + (st ? ` totr-bz-state--${st.cls}` : "");
      if (tag.textContent !== text) tag.textContent = text;
      if (tag.className !== cls) tag.className = cls;
    }

    // ---- $ popup: pick a price -----------------------------------------------------------
    function closePopup() { if (popup) { popup.remove(); popup = null; } }
    function openPopup(r, anchor) {
      closePopup();
      const s = sell.get(r.itemId) || {};
      const name = (nameNode(r.row) || {}).textContent || "Item";
      const choices = [];
      if (s.sellAt != null) choices.push({ label: `Sell list (${(s.ruleLabel || "").replace(/^.*?:\s*/, "") || "your rule"})`, price: s.sellAt, main: true });
      if (s.teMarketValue && s.teMarketValue !== s.sellAt) choices.push({ label: "TE market value", price: s.teMarketValue });
      const cheapest = { label: "Cheapest bazaar now", price: null, loading: true };
      choices.push(cheapest);
      if (s.floor != null) choices.push({ label: "Your floor (cost + %)", price: s.floor, floor: true });
      const list = el("div", { class: "totr-pick-list" });
      const head = el("div", { class: "totr-pick-head" }, el("strong", null, name.trim()),
        el("span", { class: "totr-muted" }, [s.teMarketValue ? `TE MV ${fmtMoney(s.teMarketValue)}` : null, s.costEach != null ? `paid ${fmtMoney(s.costEach)}` : null].filter(Boolean).join(" · ")),
        el("button", { type: "button", class: "totr-pick-x", "aria-label": "Close", onclick: closePopup }, "✕"));
      const draw = () => {
        list.replaceChildren(...choices.map((c) => el("button", {
          type: "button", class: "totr-pick" + (c.main ? " totr-pick--main" : ""), disabled: c.price == null,
          onclick: () => { fillRow(r, c.price); closePopup(); },
        }, el("span", { class: "totr-pick-label" }, c.label),
          el("strong", null, c.price == null ? (c.loading ? "…" : "—") : fmtMoney(c.price)),
          el("span", { class: "totr-pick-profit" + (c.floor ? " totr-pick-profit--floor" : "") }, c.price == null ? "" : profitText(s, c.price)))));
      };
      draw();
      const foot = el("div", { class: "totr-pick-foot" }, el("span", { class: "totr-muted" }, "Click a price to fill it"),
        el("button", { type: "button", class: "totr-linkbtn", onclick: () => { closePopup(); modules.priceCheck.toggle(r.itemId, r.row.closest("li, tr") || r.row, { float: true }); } }, "Full price check"));
      popup = el("div", { class: "totr totr-pick-pop", "data-totr-ui": "1", role: "dialog", "aria-label": `${name.trim()} prices` }, head, list, foot);
      document.body.append(popup);
      const rect = anchor.getBoundingClientRect();
      popup.style.top = `${Math.round(window.scrollY + rect.bottom + 6)}px`;
      popup.style.left = `${Math.round(Math.max(8, Math.min(window.scrollX + rect.left - 120, window.scrollX + document.documentElement.clientWidth - 400)))}px`;
      callTrader("quote", { itemIds: [r.itemId] }).then((res) => {
        const q = ((res && res.items) || []).find((x) => x.itemId === r.itemId);
        const low = q && Array.isArray(q.bazaars) && q.bazaars.length ? Math.min(...q.bazaars.map((b) => b.price)) : null;
        cheapest.price = low; cheapest.loading = false; if (popup) draw();
      }).catch(() => { cheapest.loading = false; if (popup) draw(); });
    }

    // ---- header links + status line -------------------------------------------------------
    function headerEl() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/^\s*(Add items to your Bazaar|Manage your Bazaar)\s*$/i.test(n.textContent)) return n.parentElement;
      }
      return null;
    }
    // 0.7.11: "TARGETS 12M OLD ↻" in the header — click to ask Overseer again.
    function updateAge() {
      const node = document.getElementById("totr-hage");
      if (!node || !node.isConnected) { clearInterval(ageTimer); ageTimer = null; return; }
      let marketAt = null;
      for (const s of sell.values()) {
        const at = Date.parse((s && s.market && s.market.capturedAt) || "");
        if (Number.isFinite(at)) marketAt = marketAt == null ? at : Math.min(marketAt, at);
      }
      const a = targetsAge({ ...fresh, marketAt }, Date.now());
      node.hidden = !a.text;
      const text = a.text ? `${a.text} ↻` : "";
      if (node.textContent !== text) node.textContent = text;
      node.title = a.title;
      node.classList.toggle("totr-hlink--warn", a.stale);
      if (!ageTimer && IS_BROWSER) ageTimer = setInterval(updateAge, 30_000);
    }
    function reloadTargets() {
      sell.clear();
      fresh.loadedAt = null;
      fresh.refsAt = null;
      retryAfter = 0;
      const node = document.getElementById("totr-hage");
      if (node) node.textContent = "LOADING…";
      run().catch(() => {});
    }
    function headerLinks(list) {
      const manage = isManage();
      const off = manage ? list.filter((r) => { const st = stateFor(r, sell.get(r.itemId)); return st && st.off; }) : [];
      const sig = manage ? `m${off.length}` : "a";
      let box = document.getElementById("totr-hlinks");
      if (box && box.isConnected && box.dataset.sig === sig) return;
      if (box) box.remove();
      const links = manage
        ? [el("button", { type: "button", class: "totr-hlink totr-hlink--warn", disabled: !off.length, onclick: () => off.filter(shownRow).forEach((r) => fillRow(r)) }, off.length ? `FIX ${off.length} OFF TARGET` : "ALL ON TARGET")]
        : [el("button", { type: "button", class: "totr-hlink totr-hlink--ok", onclick: () => rows().filter(shownRow).forEach((r) => { if (!listedPrice(r.price)) fillRow(r); else if (r.qty && !r.qty.value) setNativeValue(r.qty, r.held); }) }, "FILL ALL"),
           el("button", { type: "button", class: "totr-hlink totr-hlink--qty", onclick: () => rows().filter(shownRow).forEach(fillQty) }, "FILL QTY"),
           el("button", { type: "button", class: "totr-hlink totr-hlink--clear", title: "Empty qty and price on this tab", onclick: () => rows().filter(shownRow).forEach(clearRow) }, "CLEAR")];
      links.push(el("a", { class: "totr-hlink", href: `${SITE_URL}/trading/bazaar`, target: "_blank", rel: "noopener" }, "SETTINGS"));
      links.unshift(el("button", { type: "button", id: "totr-hage", class: "totr-hlink totr-hage", onclick: reloadTargets }));
      box = el("span", { id: "totr-hlinks", "data-totr-ui": "1", "data-sig": sig }, ...links);
      const header = headerEl();
      if (header) { header.style.display = "flex"; header.style.alignItems = "center"; box.style.marginLeft = "auto"; header.append(box); }
      else {
        const parent = list[0] && list[0].row.parentElement;
        const anchor = parent && (parent.closest("table") || parent);
        if (anchor) anchor.insertAdjacentElement("beforebegin", el("div", { class: "totr-bar totr", "data-totr-ui": "1" }, el("strong", null, "Overseer"), box));
      }
    }
    function statusLine(list) {
      let line = document.getElementById("totr-bzline");
      const loaded = list.filter((r) => sell.get(r.itemId));
      const byHand = loaded.filter((r) => sell.get(r.itemId).sellAt == null).length;
      const text = lastError ? `Overseer: ${lastError}` : `Overseer prices from your sell list${byHand ? ` · ${byHand} priced by hand` : ""}${stockNote ? ` · ${stockNote}` : ""} · v${VERSION}`;
      if (line && line.isConnected) { if (line.textContent !== text) line.textContent = text; return; }
      const parent = list[0] && list[0].row.parentElement;
      const anchor = parent && (parent.closest("table") || parent);
      if (!anchor) return;
      line = el("div", { id: "totr-bzline", class: "totr-bzline" + (lastError ? " totr-error" : ""), "data-totr-ui": "1" }, text);
      anchor.insertAdjacentElement("beforebegin", line);
    }

    async function load(list) {
      if (Date.now() < retryAfter) return false;
      const ids = [...new Set(list.map((r) => r.itemId).filter((id) => id && !sell.has(id) && !pending.has(id)))].slice(0, 100);
      if (!ids.length) return false;
      ids.forEach((id) => pending.add(id));
      try {
        const res = await callTrader("sell_prices", { itemIds: ids });
        const now = Date.now();
        if (fresh.loadedAt == null) fresh.loadedAt = now; // the oldest batch is the one that matters
        const refsAt = Date.parse((res && res.referencesAt) || "");
        if (Number.isFinite(refsAt)) fresh.refsAt = fresh.refsAt == null ? refsAt : Math.min(fresh.refsAt, refsAt);
        for (const it of (res && res.items) || []) sell.set(it.itemId, it);
        for (const id of ids) if (!sell.has(id)) sell.set(id, null);
        lastError = null;
      } catch (err) {
        const permanent = (err && [401, 402, 403].includes(err.status)) || /Unknown action/i.test(String(err && err.message));
        lastError = err && err.status === 402 ? "the sell list needs an Overseer Trading subscription."
          : /Unknown action/i.test(String(err && err.message)) ? "the sell list isn't live yet."
          : `${(err && err.message) || String(err)} — retrying shortly.`;
        // 0.7.4: only a PERMANENT answer settles the rows as unpriced. A one-off 500 used to mark
        // every row on the page "Priced by hand" for the rest of the visit; now the rows stay
        // unloaded and the next pass asks again after a short pause.
        if (permanent) for (const id of ids) sell.set(id, null);
        else {
          retryAfter = Date.now() + SELL_RETRY_MS;
          // Torn's bazaar page can sit still, so don't wait for a DOM change to ask again.
          if (IS_BROWSER) setTimeout(() => { run().catch(() => {}); }, SELL_RETRY_MS + 50);
        }
      }
      ids.forEach((id) => pending.delete(id));
      return true;
    }

    // ---- stock check (WO-40) ---------------------------------------------------------------
    // The ledger can't see stock that left without a log entry (museum exchanges, item use from
    // a year ago), so it thinks you still hold it. Once the page has stopped changing for a few
    // seconds, send what this page shows — Add = your inventory, Manage = your listings — at
    // most once per 10 minutes per page. The server compares the two with your open lots once a
    // day; nothing here changes anything on Torn.
    const STOCK_EVERY_MS = 10 * 60 * 1000;
    const STOCK_SETTLE_MS = 3000;
    const STOCK_MAX_ITEMS = 2000;
    let stockTimer = null;
    let stockNote = null;
    let stockOff = false; // the server doesn't know stock_snapshot yet — stop asking this visit

    function scheduleStock() {
      if (stockOff) return;
      clearTimeout(stockTimer);
      stockTimer = setTimeout(() => { sendStock().catch(() => { /* noted below */ }); }, STOCK_SETTLE_MS);
    }
    async function sendStock() {
      const page = isManage() ? "manage" : "add";
      const sentAt = gmGet(STORE.stockSentAt, {}) || {};
      if (!snapshotDue(sentAt, page, Date.now(), STOCK_EVERY_MS)) return;
      const list = rows();
      if (!list.length) return;
      const snap = stockSnapshotItems(list.map((r) => ({ itemId: r.itemId, count: r.count })));
      if (!snap.items.length) return;
      const items = snap.items.slice(0, STOCK_MAX_ITEMS);
      const complete = snap.complete && items.length === snap.items.length;
      try {
        await callTrader("stock_snapshot", { page, items, complete });
        gmSet(STORE.stockSentAt, { ...sentAt, [page]: Date.now() });
        stockNote = `stock check sent (${items.length} item${items.length === 1 ? "" : "s"}${complete ? "" : ", partial"})`;
      } catch (err) {
        if (/Unknown action/i.test(String(err && err.message))) { stockOff = true; stockNote = null; }
        else stockNote = "stock check not sent";
      }
      statusLine(rows());
    }

    async function run() {
      const list = rows();
      if (!list.length) return;
      if (!prefs().tornKey && !prefs().sessionToken) {
        lastError = "connect first: open Price check on any item (or any trade) and paste your Torn key.";
        statusLine(list);
        return;
      }
      if (await load(list)) document.getElementById("totr-bzline")?.remove();
      list.forEach(decorate);
      headerLinks(list);
      updateAge();
      statusLine(list);
      if (!lastError) scheduleStock();
    }

    if (IS_BROWSER) document.addEventListener("click", (e) => { if (popup && !popup.contains(e.target) && !(e.target.closest && e.target.closest(".totr-dollar"))) closePopup(); });
    return { onRoute: run };
  })();

  // --- Someone's bazaar + item market (TS-5) — skeletons ---------------------------------
  // --- Item market: bazaar strip (TS-5) --------------------------------------------------
  // VERIFY: item id from the market hash (#/market/view=search&itemID=206…) or the expanded
  // item's aria-controls; strip goes above Torn's seller list.
  // ---- 0.7.12: "How do you mostly sell?" — shared by the buy pages ---------------------
  let modeChooserOpen = false;
  /** The chooser bar (not chosen yet, or "change" pressed). Picking reloads so every mark redraws. */
  function sellModeBar() {
    const mode = prefs().sellMode;
    // 0.7.14: also saved to your Overseer account (WO-64), so every device and the site's
    // Trading → Items page agree. The reload waits for the save (or its failure) briefly.
    const pick = (m) => {
      gmSet(STORE.sellMode, m);
      modeChooserOpen = false;
      const done = () => location.reload();
      callTrader("sell_mode", { mode: m }).then(done, done);
      setTimeout(done, 2500);
    };
    return el("div", { class: "totr-bar", id: "totr-mode-bar", "data-totr-ui": "1" },
      el("strong", null, "Overseer"),
      el("span", null, "How do you mostly sell?"),
      el("span", { class: "totr-mode" }, ...SELL_MODES.map((m) =>
        el("button", { type: "button", class: "totr-mode-btn" + (mode === m ? " totr-mode-btn--on" : ""), onclick: () => pick(m) }, SELL_MODE_LABELS[m]))),
      el("span", { class: "totr-muted" }, "Highlights then show only what fits how you make money. Change it any time."));
  }
  /** 0.7.14: no choice on this device yet? Take the one saved to the account (once per page load). */
  let modePulled = false;
  function pullSellMode() {
    if (modePulled || prefs().sellMode || (!prefs().tornKey && !prefs().sessionToken)) return;
    modePulled = true;
    callTrader("sell_mode").then((res) => {
      const m = sellModeOf(res && res.mode);
      if (m && !prefs().sellMode) { gmSet(STORE.sellMode, m); location.reload(); }
    }).catch(() => { /* older server or offline: the chooser still asks */ });
  }
  /** The site's Item page for one item (WO-64). */
  function itemPageUrl(itemId, tab) {
    return `${SITE_URL}/trading/items/${itemId}${tab ? `?tab=${tab}` : ""}`;
  }

  /** "Selling via Bazaar · change" for a panel header once a mode is picked. */
  function sellModeLink() {
    const mode = prefs().sellMode;
    if (!mode) return null;
    return el("button", { type: "button", class: "totr-linkbtn", title: "Change how you mostly sell", onclick: () => { modeChooserOpen = true; document.getElementById("totr-mode-bar")?.remove(); window.dispatchEvent(new HashChangeEvent("hashchange")); } }, `Selling via ${SELL_MODE_LABELS[mode]} · change`);
  }
  /** Put the chooser before `anchor` when it is wanted and not already there. */
  function placeSellModeBar(anchor) {
    pullSellMode();
    const want = !prefs().sellMode || modeChooserOpen;
    const bar = document.getElementById("totr-mode-bar");
    if (!want) { bar?.remove(); return; }
    if (bar && bar.isConnected) return;
    if (anchor && anchor.parentElement) anchor.insertAdjacentElement("beforebegin", sellModeBar());
  }
  // Bazaar mode's resale price: your sell-list price, from `sell_prices` (100 ids a call).
  const sellAtCache = new Map(); // itemId → sellAt | null
  async function loadSellAt(ids) {
    const want = [...new Set(ids)].filter((id) => !sellAtCache.has(id));
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100);
      try {
        const res = await callTrader("sell_prices", { itemIds: chunk });
        for (const it of (res && res.items) || []) sellAtCache.set(it.itemId, it.sellAt != null ? Number(it.sellAt) : null);
      } catch { return false; } // leave uncached; the next scan retries
      for (const id of chunk) if (!sellAtCache.has(id)) sellAtCache.set(id, null);
    }
    return true;
  }

  modules.itemMarket = (() => {
    let current = { itemId: null, data: null, error: null };

    function itemIdNow() {
      const m = location.hash.match(/itemID=(\d+)/i);
      if (m) return Number(m[1]);
      const btn = document.querySelector("button[aria-controls^='wai-itemInfo-'][aria-expanded='true']");
      const id = btn && btn.getAttribute("aria-controls").split("-").pop();
      return id && /^\d+$/.test(id) ? Number(id) : null;
    }

    function anchor() {
      return document.querySelector("[class*='sellerListWrapper___'], [class^='sellerList___'], [class*=' sellerList___']");
    }

    function render() {
      const a = anchor();
      if (!a) return;
      let strip = document.getElementById("totr-strip");
      // Inside Torn's seller list at the top: as its sibling it became a narrow flex column.
      if (!strip || !strip.isConnected) { strip?.remove(); strip = el("div", { id: "totr-strip", class: "totr", style: "width:100%;flex-basis:100%;box-sizing:border-box;margin-bottom:8px" }); a.prepend(strip); }
      const d = current.data;
      const mode = prefs().sellMode;
      placeSellModeBar(strip);
      const head = el("div", { class: "totr-head" }, el("strong", null, "Bazaars"));
      if (d) {
        head.append(...[
          el("span", { class: "totr-muted" }, `Market ${fmtMoney(d.marketValue)}`),
          netAfterFee(d.marketValue) != null ? el("span", { class: "totr-muted", title: "What a sale at market value pays you after Torn's 5% item market fee — pay more than this and reselling at MV loses money." }, `· ${fmtMoney(netAfterFee(d.marketValue))} after 5% fee`) : null,
          d.buyPrice != null ? el("span", { class: "totr-muted" }, `You buy at ${fmtMoney(d.buyPrice)}`) : null,
          mode === "bazaar" && sellAtCache.get(current.itemId) != null ? el("span", { class: "totr-muted" }, `· You sell at ${fmtMoney(sellAtCache.get(current.itemId))}`) : null,
          el("span", { class: "totr-muted" }, "· 5 cheapest"),
          sellModeLink(),
          el("a", { class: "totr-mini", href: itemPageUrl(current.itemId), target: "_blank", rel: "noopener", style: "margin-left:auto;display:inline-flex;align-items:center;text-decoration:none", title: "Every listing, buyers and your three ways to sell, on Overseer" }, "Full page"),
          el("button", { class: "totr-mini", type: "button", onclick: () => modules.priceCheck.toggle(current.itemId, strip, { name: d.itemName }) }, "Price check"),
        ].filter(Boolean)); // native append() would print a null as the text "null" // native append() would print a null as the text "null"
      }
      const body = el("div", { class: "totr-body", style: "flex-direction:row;flex-wrap:wrap" });
      if (current.error) body.append(el("div", { class: "totr-error" }, current.error));
      else if (!d) body.append(el("div", { class: "totr-muted" }, "Checking bazaars…"));
      else if (!d.bazaars || !d.bazaars.length) body.append(el("div", { class: "totr-muted" }, d.bazaarError ? "Bazaar listings unavailable right now." : "No bazaars selling this right now."));
      else {
        const list = [...d.bazaars].sort((x, y) => x.price - y.price);
        for (const b of list) {
          const pct = d.marketValue ? ((b.price - d.marketValue) / d.marketValue) * 100 : null;
          const under = d.buyPrice != null && b.price < d.buyPrice;
          const href = b.playerId ? `https://www.torn.com/bazaar.php?userId=${b.playerId}&totr=${current.itemId}-${b.price}#/` : null;
          // Two lines: "Name  $300 × 1" / tag.
          body.append(el(href ? "a" : "div", { href, target: href ? "_blank" : null, rel: href ? "noopener" : null, class: "totr-card" + (under ? " totr-card--under" : "") },
            el("span", { class: "totr-card-line" },
              el("span", { class: "totr-card-name" }, b.name || "Bazaar"),
              el("strong", null, fmtMoney(b.price)),
              el("span", { class: "totr-muted" }, `× ${b.qty}`)),
            stripChip(b, under, pct, mode, d)));
        }
        if (d.hiddenOutliers) body.append(el("div", { class: "totr-muted", style: "flex-basis:100%" }, `${d.hiddenOutliers} dollar-bazaar listing${d.hiddenOutliers === 1 ? "" : "s"} hidden`));
      }
      strip.replaceChildren(head, body);
    }

    /** One chip per strip card: blue under your buy, else what fits the sell mode. */
    function stripChip(b, under, pct, mode, d) {
      if (under) return el("span", { class: "totr-chip totr-chip--buy" }, "Under your buy");
      if (showsMarketPct(mode)) {
        return pct != null ? el("span", { class: "totr-chip " + (pct <= 0 ? "totr-chip--ok" : "totr-chip--warn") }, `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% vs MV`) : null;
      }
      const r = resaleFor(mode, b.price, d.marketValue, sellAtCache.get(current.itemId));
      return r ? el("span", { class: "totr-chip totr-chip--ok" }, resaleLabel(r)) : null;
    }

    async function load(itemId) {
      current = { itemId, data: null, error: null };
      if (prefs().sellMode === "bazaar") loadSellAt([itemId]).then(() => { if (current.itemId === itemId) render(); });
      render();
      try {
        const res = await callTrader("quote", { itemIds: [itemId] });
        if (current.itemId !== itemId) return;
        current.data = (res && res.items || []).find((q) => q.itemId === itemId) || null;
        if (!current.data) current.error = "No price data for this item.";
      } catch (err) {
        if (current.itemId !== itemId) return;
        current.error = err.status === 402 ? "Trading needs an Overseer subscription." : (err.message || String(err));
      }
      render();
    }

    // ---- category grid: outline tiles whose cheapest listing is at/under your buy price ------
    // Tiles are Torn's <li> with a "View info" button (aria-controls="wai-itemInfo-<id>") and a
    // "Buy item X, $1009, 280807 in total." button — both aria, so no hashed class names.
    const gridQuotes = new Map();   // itemId → quote (light) | null
    const gridPending = new Set();
    function gridTiles() {
      const out = [];
      for (const btn of document.querySelectorAll("button[aria-controls^='wai-itemInfo-']")) {
        const li = btn.closest("li");
        if (!li || li.closest(".totr, [data-totr-ui]")) continue;
        const id = Number(btn.getAttribute("aria-controls").replace(/\D/g, ""));
        const buy = li.querySelector("button[aria-label^='Buy item']");
        const m = buy && buy.getAttribute("aria-label").match(/\$([0-9][0-9,]*)/);
        const price = m ? Number(m[1].replace(/,/g, "")) : (moneyIn(li) || {}).value;
        if (id && price > 0) out.push({ li, itemId: id, price });
      }
      return out;
    }
    async function loadGrid(list) {
      const ids = [...new Set(list.map((t) => t.itemId))].filter((id) => !gridQuotes.has(id) && !gridPending.has(id)).slice(0, 100);
      if (!ids.length) return false;
      ids.forEach((id) => gridPending.add(id));
      try {
        const res = await callTrader("quote", { itemIds: ids, bazaars: false });
        for (const q of (res && res.items) || []) gridQuotes.set(q.itemId, q);
      } catch { /* leave unmarked; retried on the next scan */ ids.forEach((id) => gridPending.delete(id)); return false; }
      for (const id of ids) { if (!gridQuotes.has(id)) gridQuotes.set(id, null); gridPending.delete(id); }
      return true;
    }
    function markGrid(list) {
      for (const t of list) {
        const q = gridQuotes.get(t.itemId);
        const buyAt = q && q.buyPrice != null ? q.buyPrice : null;
        const deal = buyAt != null && t.price <= buyAt;
        // Buy-list deals win; otherwise a flip if reselling at MV clears the 5% fee. t.price is
        // read off the tile on every scan, so a listing that sold never leaves a stale chip.
        const mode = prefs().sellMode;
        const flip = deal ? null : resaleFor(mode, t.price, q && q.marketValue, sellAtCache.get(t.itemId));
        const sig = deal ? `d${t.price}:${buyAt}` : flip ? `f${t.price}:${flip.via}:${flip.profit}` : "";
        if ((t.li.dataset.totrDeal || "") === sig) continue;
        t.li.dataset.totrDeal = sig;
        t.li.classList.toggle("totr-deal", deal);
        t.li.classList.toggle("totr-flip", Boolean(flip));
        t.li.querySelector(".totr-dealchip")?.remove();
        const stuckNote = notSellingLine(q && q.stock, Date.now());
        const stuckTail = stuckNote ? `\n${stuckNote}` : "";
        if (deal) {
          const under = buyAt - t.price;
          t.li.append(el("span", { class: "totr-dealchip", "data-totr-ui": "1", title: `Cheapest listing ${fmtMoney(t.price)} · your Pricelist buy price ${fmtMoney(buyAt)}${stuckTail}` },
            under > 0 ? `${fmtMoney(under)} under your buy` : "at your buy"));
        } else if (flip) {
          const why = flip.via === "bazaar"
            ? `Cheapest listing ${fmtMoney(t.price)} · your bazaar sell-list price ${fmtMoney(sellAtCache.get(t.itemId))} (no fee in a bazaar).`
            : `Cheapest listing ${fmtMoney(t.price)} · market value ${fmtMoney(q.marketValue)} · resold at MV it nets ${fmtMoney(netAfterFee(q.marketValue))} after Torn's 5% fee. MV is an average, not a promised sale.`;
          t.li.append(el("span", { class: "totr-dealchip totr-dealchip--flip", "data-totr-ui": "1", title: `${why}${stuckTail}` }, resaleLabel(flip)));
        }
      }
    }
    async function grid() {
      const list = gridTiles();
      if (!list.length) return;
      placeSellModeBar(list[0].li.closest("ul") || list[0].li);
      markGrid(list);
      let changed = await loadGrid(list);
      if (prefs().sellMode === "bazaar") {
        const ids = list.map((t) => t.itemId).filter((id) => !sellAtCache.has(id)).slice(0, 100);
        if (ids.length && await loadSellAt(ids)) changed = true;
      }
      if (changed) markGrid(gridTiles());
    }

    // ---- 0.8.0 (WO-66): one dashed "your price" line in Torn's seller list ------------------
    // Torn already sorts the item's listings cheapest first, so per-row colours added little:
    // a single line shows where your buy price falls. VERIFY the row selector on live Torn.
    function sellerRows(a) {
      const rows = [];
      for (const row of a.querySelectorAll("[class*='rowWrapper___'], li[class*='row___'], [class*='sellerRow___']")) {
        if (row.closest(".totr, [data-totr-ui]") || row.parentElement?.closest("[class*='rowWrapper___'], [class*='sellerRow___']")) continue;
        const m = moneyIn(row);
        if (m) rows.push({ row, price: m.value });
      }
      return rows;
    }
    function markSellerList() {
      const a = anchor();
      if (!a) return;
      const buy = current.data && current.data.buyPrice != null ? current.data.buyPrice : null;
      const old = a.querySelector(".totr-priceline");
      const rows = buy == null ? [] : sellerRows(a);
      const at = buy == null || !rows.length ? -1 : priceLineIndex(rows.map((r) => r.price), buy);
      if (at < 0) { old?.remove(); return; }
      const label = `YOUR PRICE ${fmtMoney(buy)} · ${at} under`;
      const before = rows[at] ? rows[at].row : null;
      if (old && old.textContent === label && old.nextElementSibling === before) return;
      old?.remove();
      const tag = before && before.tagName === "LI" ? "li" : "div";
      const line = el(tag, { class: "totr-priceline", "data-totr-ui": "1", role: "separator" }, label);
      if (before) before.before(line);
      else rows[rows.length - 1].row.after(line);
    }

    return {
      onRoute() {
        if (!prefs().tornKey && !prefs().sessionToken) return; // trade panel handles first sign-in
        grid();
        const id = itemIdNow();
        if (!id) return;
        if (id !== current.itemId) { load(id); return; }
        const strip = document.getElementById("totr-strip");
        if (!strip) render(); else placeSellModeBar(strip);
        markSellerList();
      },
    };
  })();

  // --- Someone's bazaar: arrival + deals (TS-5) -------------------------------------------
  // Arrival: a strip card links here with ?totr=<itemId>-<price>; outline that item, scroll to
  // it, and say whether the price moved. Deals: listings under your buy price get a green
  // badge, at/under your deal % of market value an amber one. VERIFY data-testid selectors.
  modules.bazaarOther = (() => {
    let arrival = null;
    let dealsFor = null;
    let quotes = new Map();
    const pending = new Set();

    function cards() {
      return [...document.querySelectorAll("[data-testid='item']")].map((card) => {
        const img = card.querySelector("img[src*='/items/']");
        const m = img && img.getAttribute("src").match(/\/items\/(\d+)\//);
        const priceEl = card.querySelector("[data-testid='price']");
        const hit = moneyIn(priceEl);
        return { card, itemId: m ? Number(m[1]) : null, price: hit ? hit.value : null };
      }).filter((c) => c.itemId);
    }

    function readArrival() {
      if (arrival !== null) return arrival;
      const p = new URLSearchParams(location.search).get("totr");
      const m = p && p.match(/^(\d+)-(\d+)$/);
      arrival = m ? { itemId: Number(m[1]), price: Number(m[2]), done: false } : false;
      return arrival;
    }

    function showArrival(list) {
      const a = readArrival();
      if (!a || a.done) return;
      const hit = list.find((c) => c.itemId === a.itemId);
      if (!hit) return;
      a.done = true;
      hit.card.style.outline = "3px solid #8ab8ff";
      hit.card.style.outlineOffset = "2px";
      hit.card.scrollIntoView({ block: "center", behavior: "smooth" });
      const moved = hit.price != null && hit.price !== a.price
        ? (hit.price > a.price ? `Careful — price went up from ${fmtMoney(a.price)} to ${fmtMoney(hit.price)}.` : `Price dropped from ${fmtMoney(a.price)} to ${fmtMoney(hit.price)}.`)
        : `Here it is at ${fmtMoney(hit.price)}.`;
      const note = el("div", { class: "totr-bar", "data-totr-ui": "1" }, el("strong", null, "Overseer"), el("span", null, moved));
      hit.card.closest("[data-testid='bazaar-items']")?.before(note);
      try { const u = new URL(location.href); u.searchParams.delete("totr"); history.replaceState(history.state, "", u.toString()); } catch { /* ignore */ }
    }

    async function loadDeals(list) {
      const ids = [...new Set(list.map((c) => c.itemId))].filter((id) => !quotes.has(id) && !pending.has(id)).slice(0, 50);
      if (!ids.length) return;
      ids.forEach((id) => pending.add(id));
      try {
        // bazaars:false — only market value + your buy price; no W3b calls (needs TS-5 server flag;
        // an older server answers what it can and defers the rest, which we simply skip).
        const res = await callTrader("quote", { itemIds: ids, bazaars: false });
        for (const q of (res && res.items) || []) quotes.set(q.itemId, q);
        for (const id of ids) if (!quotes.has(id)) quotes.set(id, null);
      } catch { for (const id of ids) quotes.set(id, null); }
      ids.forEach((id) => pending.delete(id));
    }

    /** Armor/weapons show a quality number ("46.60") on the card. One market value covers
     *  every quality, so a cheap piece is often just a weaker one — no "% of market" tag. */
    function hasQuality(card) {
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/^\s*\d{1,3}\.\d{2}\s*$/.test(n.textContent)) return true;
      }
      return false;
    }

    function markDeals(list) {
      const dealPct = prefs().dealPct;
      for (const c of list) {
        if (c.card.dataset.totrDeal) continue;
        const q = quotes.get(c.itemId);
        if (q === undefined || c.price == null) continue;
        c.card.dataset.totrDeal = "1";
        if (!q || prefs().ignored.has(c.itemId)) continue;
        if (c.price <= 1) continue; // $1 listings are display/locked items, not deals
        let label = null; let cls = null;
        const mode = prefs().sellMode;
        const resale = mode === "bazaar" ? resaleFor(mode, c.price, q.marketValue, sellAtCache.get(c.itemId)) : null;
        // 0.7.12: under your buy is BLUE on every page (it was green here, blue on the grid).
        if (q.buyPrice != null && c.price < q.buyPrice) { label = "UNDER YOUR BUY"; cls = "buy"; }
        else if (resale) { label = `RESELL +${fmtMoney(resale.profit)}`; cls = "ok"; }
        else if (showsMarketPct(mode) && q.marketValue && c.price <= q.marketValue * dealPct / 100 && !hasQuality(c.card)) { label = `${Math.round((c.price / q.marketValue) * 100)}% OF MARKET`; cls = "warn"; }
        if (!label) continue;
        c.card.style.boxShadow = cls === "buy" ? "inset 0 0 0 3px #4c8dff" : cls === "ok" ? "inset 0 0 0 3px #5fe0a6" : "inset 0 0 0 3px #e0a23b";
        const stuckNote = notSellingLine(q.stock, Date.now());
        c.card.querySelector("[data-testid='price']")?.after(el("span", { class: `totr-chip totr-chip--${cls}`, "data-totr-ui": "1", title: stuckNote || undefined }, stuckNote ? `${label} · HOLD ${Number(q.stock.onHand).toLocaleString("en-US")}` : label));
      }
    }

    /** Money on hand, from Torn's sidebar ("Money: $1,006,644"). Null if it can't be read. */
    function walletNow() {
      const node = document.getElementById("user-money");
      const attr = node && Number(node.getAttribute("data-money"));
      if (Number.isFinite(attr) && attr >= 0 && node.getAttribute("data-money") !== null) return attr;
      const hit = moneyIn(node);
      return hit ? hit.value : null;
    }

    /** "Max" next to the quantity box of an opened listing: fills as many as you can afford
     *  (all in stock if your money covers it). Fills the box only — you press Torn's Buy. */
    function addMaxButtons() {
      const scope = document.querySelector("[data-testid='bazaar-items']") || document;
      for (const buy of scope.querySelectorAll("button")) {
        if (!/^buy$/i.test((buy.textContent || "").trim()) || buy.closest("[data-totr-ui]")) continue;
        let box = buy.parentElement;
        let input = null;
        for (let i = 0; box && i < 5 && !input; i += 1, box = box.parentElement) {
          input = [...box.querySelectorAll("input")].find((x) => !x.closest("[data-totr-ui]") && x.type !== "hidden" && x.type !== "checkbox") || null;
          if (input) break;
        }
        if (!input || !box) continue;
        const holder = box.closest("[data-testid='item']") || box;
        if (holder.querySelector(".totr-max")) continue;
        // Something on the listing already fills the max (Torn's green "fill max", or another
        // script's): a second Max would only sit on top of it.
        const otherMax = [...holder.querySelectorAll("button, a, span, div, label")].some((n) =>
          !n.closest("[data-totr-ui]") && n.children.length === 0 && isMaxLabel(n.textContent));
        if (otherMax) continue;
        // Torn's quantity/Buy column is too narrow to share, so Max sits under the
        // "(n in stock)" line on the left of the opened listing — the DEEPEST element holding
        // that text (it is not always a leaf: the number can be its own span). No stock line,
        // no Max: dropped into the narrow column it overlaps Torn's own controls.
        const stockLine = [...holder.querySelectorAll("*")].filter((n) =>
          !n.closest("[data-totr-ui]") && parseStock(n.textContent) != null &&
          ![...n.children].some((c) => parseStock(c.textContent) != null)
        )[0];
        if (!stockLine) continue;
        const btn = el("button", { class: "totr-mini totr-max", type: "button", "data-totr-ui": "1", title: "Fill in as many as you can afford", style: "display:inline-block;margin:4px 0 0 0" }, "Max");
        btn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          const card = box.closest("[data-testid='item']") || box;
          const price = moneyIn(card.querySelector("[data-testid='price']") || card);
          const stock = parseStock(card.textContent);
          const money = walletNow();
          if (!price || money == null) { btn.textContent = "?"; btn.title = "Couldn't read the price or your money on this page."; return; }
          const qty = maxAffordable(price.value, stock, money);
          if (qty < 1) { btn.textContent = "Can't afford"; setTimeout(() => { btn.textContent = "Max"; }, 1500); return; }
          setNativeValue(input, qty);
        });
        stockLine.after(btn);
      }
    }

    return {
      async onRoute() {
        addMaxButtons();
        const list = cards();
        if (!list.length) return;
        showArrival(list);
        if (!prefs().tornKey && !prefs().sessionToken) return;
        const key = location.search;
        if (dealsFor !== key) { dealsFor = key; quotes = new Map(); }
        placeSellModeBar(document.querySelector("[data-testid='bazaar-items']"));
        await loadDeals(list);
        if (prefs().sellMode === "bazaar") await loadSellAt(list.map((c) => c.itemId).slice(0, 100));
        markDeals(list);
      },
    };
  })();


  // --- Price check (TS-7) -----------------------------------------------------------------
  // One button on the item you are looking at → one panel: what it is listed for right now
  // (item market + bazaars), who is buying it and at what, and your own 90 days with it.
  // Same data as the site's Price check drawer (trader-price-check), through trader-script's
  // `price_check` action. Torn's item market is read HERE with your own key (the site keeps no
  // copy of it) and handed to the server, which merges and filters it exactly like the drawer.
  // Placement: a "Price check" button in Torn's own item info box (Items page, item market —
  // wherever that box opens), a "Check" button per trade line, and one in the bazaar strip.
  modules.priceCheck = (() => {
    const cache = new Map(); // itemId → { at, data }
    const CACHE_MS = 60_000;
    let seq = 0;

    async function readItemMarket(itemId) {
      const key = prefs().tornKey;
      if (!key) return { itemMarket: null, itemMarketError: "No Torn key saved in this script, so the item market can't be read." };
      try {
        const res = await requestJson(`https://api.torn.com/v2/market/${itemId}/itemmarket?offset=0&comment=overseer&key=${encodeURIComponent(key)}`);
        if (res && res.error) return { itemMarket: null, itemMarketError: `Torn: ${res.error.error || "error " + res.error.code}` };
        const env = (res && res.itemmarket) || res;
        if (!env || !Array.isArray(env.listings)) return { itemMarket: null, itemMarketError: "Torn answered in a shape this script does not recognise." };
        // Only what the server reads: price + amount, capped — never the whole response.
        const listings = env.listings.slice(0, 100).map((l) => ({ price: Number(l.price), amount: Number(l.amount ?? l.quantity) }));
        return { itemMarket: { itemmarket: { listings } }, itemMarketError: null };
      } catch (err) {
        return { itemMarket: null, itemMarketError: String(err && err.message || err).replace(/key=[^&\s)]+/gi, "key=…") };
      }
    }

    async function load(itemId, force) {
      const hit = cache.get(itemId);
      if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
      const market = await readItemMarket(itemId);
      const data = await callTrader("price_check", { itemId, ...market });
      cache.set(itemId, { at: Date.now(), data });
      return data;
    }

    const money = (n) => (n == null ? "—" : fmtMoney(n));
    const sec = (title, ...kids) => el("div", { class: "totr-pc-sec" }, el("h4", null, title), ...kids);
    const stat = (label, value) => el("div", null, el("span", { class: "totr-muted" }, label), el("strong", null, value));

    function sellingBlock(s) {
      if (!s) return sec("Selling now", el("div", { class: "totr-muted" }, "Not available."));
      const kids = [el("div", { class: "totr-pc-stats" }, stat("Item market low", money(s.marketLow)), stat("Bazaar low", money(s.bazaarLow)))];
      for (const r of s.rows || []) {
        const who = r.source === "bazaar"
          ? (r.sellerId ? el("a", { href: `https://www.torn.com/bazaar.php?userId=${r.sellerId}#/`, target: "_blank", rel: "noopener" }, r.sellerName || `#${r.sellerId}`) : (r.sellerName || "Bazaar"))
          : el("span", { class: "totr-muted" }, "Item market");
        kids.push(el("div", { class: "totr-pc-row" },
          el("span", { class: "totr-src" + (r.source === "market" ? " totr-src--market" : "") }, r.source === "market" ? "MARKET" : "BAZAAR"),
          el("span", { class: "grow" }, who),
          el("span", { class: "totr-muted" }, `× ${r.quantity}`),
          el("strong", { class: "totr-num" }, money(r.price))));
      }
      if (!(s.rows || []).length && !s.bazaarError && !s.marketError) kids.push(el("div", { class: "totr-muted" }, "Nobody is selling this right now."));
      if (s.hiddenDollarCount) kids.push(el("div", { class: "totr-muted" }, `${s.hiddenDollarCount} dollar-bazaar listing${s.hiddenDollarCount === 1 ? "" : "s"} hidden`));
      if (s.marketError) kids.push(el("div", { class: "totr-error" }, `Item market: ${s.marketError}`));
      if (s.bazaarError) kids.push(el("div", { class: "totr-error" }, `Bazaars: ${s.bazaarError}`));
      return sec("Selling now", ...kids);
    }

    function teLine(te) {
      if (!te) return null;
      if (te.kind === "contested") {
        const st = te.standing || {};
        const top = st.topRivalName ? ` · top ${st.topRivalName} ${money(st.topRivalPrice)}` : "";
        return `TE: you're #${st.rank ?? "?"}${top}`;
      }
      if (te.kind === "uncontested") return "TE: nobody beats you in the top 3";
      if (te.kind === "unknown") return "TE: not sure (last scan was partial)";
      return null; // not-covered / never-scanned: say nothing rather than guess
    }

    function buyingBlock(b) {
      if (!b) return sec("Buying now", el("div", { class: "totr-muted" }, "Not available."));
      const kids = [];
      if (b.w3bRows) {
        b.w3bRows.forEach((r, i) => kids.push(el("div", { class: "totr-pc-row" + (r.isYou ? " totr-pc-row--you" : "") },
          el("span", { class: "totr-muted" }, `#${i + 1}`),
          el("span", { class: "grow" }, r.isYou ? "You" : (r.name || (r.playerId ? `#${r.playerId}` : "Trader"))),
          el("strong", { class: "totr-num" }, money(r.price)))));
        if (!b.w3bRows.length) kids.push(el("div", { class: "totr-muted" }, "Nobody on W3b is buying this."));
        const where = b.w3bRank != null
          ? `You're #${b.w3bRank} of ${b.w3bCount}` + (b.w3bGapToTop > 0 ? ` · ${money(b.w3bGapToTop)} below the top` : "")
          : (b.w3bPartial ? "You're not in the first page of W3b buyers" : "You're not buying this on W3b");
        kids.push(el("div", { class: "totr-muted" }, where));
      } else if (b.w3bError) kids.push(el("div", { class: "totr-error" }, `W3b: ${b.w3bError}`));
      const te = teLine(b.te);
      if (te) kids.push(el("div", { class: "totr-muted" }, te));
      return sec("Buying now", ...kids);
    }

    function historyBlock(h) {
      if (!h) return sec("Your history", el("div", { class: "totr-muted" }, "Not available."));
      if (!h.boughtUnits && !h.soldUnits && !h.onHand) return sec(`Your history (${h.windowDays} days)`, el("div", { class: "totr-muted" }, `No trades of this item in ${h.windowDays} days.`));
      const kids = [el("div", { class: "totr-pc-stats" },
        stat("Acquired", `${h.boughtUnits}${h.medianCost != null ? " @ " + money(h.medianCost) : ""}`),
        stat("Sold", `${h.soldUnits}${h.medianSale != null ? " @ " + money(h.medianSale) : ""}`),
        h.realizedProfit != null ? stat("Profit", money(h.realizedProfit)) : null)];
      const stock = [`On hand ${h.onHand}`];
      if (h.sellPerDay) stock.push(`sells ~${Math.round(h.sellPerDay * 10) / 10}/day`);
      if (h.daysOfStock != null) stock.push(`≈ ${Math.round(h.daysOfStock)} days of stock`);
      kids.push(el("div", { class: "totr-muted" }, stock.join(" · ")));
      for (const m of (h.recent || []).slice(0, 5)) {
        kids.push(el("div", { class: "totr-pc-row" },
          el("span", { class: "totr-src" + (m.kind === "sold" ? " totr-src--market" : "") }, m.kind === "sold" ? "SOLD" : "IN"),
          el("span", { class: "grow" }, `${m.qty} · ${m.counterparty || m.channel || ""}`),
          el("strong", { class: "totr-num" }, money(m.priceEach))));
      }
      if (h.truncated) kids.push(el("div", { class: "totr-muted" }, "Partial — more history than one read holds."));
      return sec(`Your history (${h.windowDays} days)`, ...kids);
    }

    function render(panel, d, opts) {
      const row = d.row;
      const pills = [el("span", { class: "totr-pill totr-pill--info" }, "Price check")];
      const head = el("div", { class: "totr-head" }, ...pills,
        el("span", { class: "totr-muted" }, `Market value ${money(d.snapshot && d.snapshot.marketPrice)}`),
        netAfterFee(d.snapshot && d.snapshot.marketPrice) != null ? el("span", { class: "totr-muted", title: "What a sale at market value pays you after Torn's 5% item market fee." }, `· ${money(netAfterFee(d.snapshot.marketPrice))} after 5% fee`) : null,
        el("span", { class: "totr-muted" }, row ? (row.lastPublishedPrice != null ? `· You buy at ${money(row.lastPublishedPrice)}` : "· On your list, not published yet") : "· Not on your pricelist"),
        d.trend && d.trend.median != null ? el("span", { class: "totr-muted" }, `· ${d.trend.windowDays}-day median ${money(d.trend.median)}${d.trend.changePct != null ? ` (${d.trend.changePct > 0 ? "+" : ""}${Math.round(d.trend.changePct)}%)` : ""}`) : null,
        el("button", { class: "totr-mini", type: "button", style: "margin-left:auto", onclick: () => open(opts.itemId, panel, opts, true) }, "Refresh"),
        el("button", { class: "totr-mini", type: "button", "aria-label": "Close", onclick: () => panel.remove() }, "✕"),
        el("div", { class: "totr-title", style: "font-size:15px" }, d.itemName || opts.name || `Item #${opts.itemId}`));
      const body = el("div", { class: "totr-body" });
      if (opts.quality) body.append(el("div", { class: "totr-muted" }, "Weapons and armor vary by quality and bonus — these prices ignore both."));
      if (d.reprice && d.reprice.managed) body.append(el("div", { class: "totr-muted" }, `Auto-reprice manages this row${d.reprice.maxMovePct != null ? ` (moves up to ${d.reprice.maxMovePct}%)` : ""}${d.reprice.pausedReason ? " — paused: " + d.reprice.pausedReason : ""}.`));
      body.append(el("div", { class: "totr-pc-grid" }, sellingBlock(d.sellingNow), buyingBlock(d.buyingNow), historyBlock(d.history)));
      panel.replaceChildren(head, body);
    }

    async function open(itemId, panel, opts, force) {
      const my = ++seq;
      panel.dataset.req = String(my);
      const askKey = (error) => panel.replaceChildren(el("div", { class: "totr-head" },
        el("span", { class: "totr-pill totr-pill--info" }, "Price check"),
        el("button", { class: "totr-mini", type: "button", style: "margin-left:auto", "aria-label": "Close", onclick: () => panel.remove() }, "✕")),
        el("div", { class: "totr-body" }, keyEntry(() => open(itemId, panel, opts, true), error)));
      if (!hasKey()) { askKey(); return; }
      panel.replaceChildren(el("div", { class: "totr-body" }, el("span", { class: "totr-muted" }, "Checking prices…")));
      try {
        const d = await load(itemId, force);
        if (panel.dataset.req !== String(my)) return; // a newer check replaced this one
        render(panel, d, { ...opts, itemId });
      } catch (err) {
        if (panel.dataset.req !== String(my)) return;
        if (BAD_KEY_RE.test(String(err && err.message))) { forgetKey(); cache.clear(); askKey(err.message); return; }
        const msg = err && err.status === 402 ? "Price check needs an Overseer Trading subscription."
          : err && err.status === 429 ? (err.message || "Too many price checks in a minute — give it a moment.")
          : (err && err.message) || String(err);
        panel.replaceChildren(el("div", { class: "totr-body" }, el("span", { class: "totr-error" }, msg),
          el("button", { class: "totr-mini", type: "button", onclick: () => panel.remove() }, "Close")));
      }
    }

    // Torn's bazaar lists place each row at a fixed height (absolutely positioned or clipped),
    // so a panel dropped in after a row sits BEHIND the rows below it. There the panel floats
    // above the page instead, just under the row, like the $ popup.
    let floating = null;
    function closeFloating() {
      if (floating) { floating.remove(); floating = null; }
      document.removeEventListener("keydown", onFloatKey, true);
    }
    function onFloatKey(e) { if (e.key === "Escape") closeFloating(); }
    function needsFloat(anchor) {
      for (let n = anchor, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
        const cs = getComputedStyle(n);
        if (cs.position === "absolute" || cs.position === "fixed" || cs.transform !== "none") return true;
      }
      return false;
    }

    /** Open (or close, if already open) the panel for `itemId` right after `anchor`. */
    function toggle(itemId, anchor, opts = {}) {
      if (!itemId || !anchor) return;
      if (opts.float || needsFloat(anchor)) {
        const same = floating && floating.isConnected && floating.dataset.item === String(itemId);
        closeFloating();
        if (same) return;
        const rect = anchor.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const width = Math.min(Math.max(rect.width, 560), vw - 16);
        const panel = el("div", { class: "totr totr-pc totr-pc--float", "data-totr-ui": "1", "data-item": String(itemId) });
        panel.style.top = `${Math.round(window.scrollY + rect.bottom + 4)}px`;
        panel.style.left = `${Math.round(window.scrollX + Math.max(8, Math.min(rect.left, vw - width - 8)))}px`;
        panel.style.width = `${Math.round(width)}px`;
        document.body.append(panel);
        floating = panel;
        document.addEventListener("keydown", onFloatKey, true);
        open(itemId, panel, opts, false);
        return;
      }
      const next = anchor.nextElementSibling;
      if (next && next.classList.contains("totr-pc") && next.dataset.item === String(itemId)) { next.remove(); return; }
      if (next && next.classList.contains("totr-pc")) next.remove();
      const panel = el("div", { class: "totr totr-pc", "data-totr-ui": "1", "data-item": String(itemId) });
      anchor.insertAdjacentElement("afterend", panel);
      open(itemId, panel, opts, false);
    }

    // Torn's item info box: the panel with "Value:" / "Circ:" and the item picture. Found by
    // its labels, not class names, so it works wherever Torn opens it.
    function infoBoxes() {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!/^\s*Circ:\s*$/.test(n.textContent)) continue;
        let box = n.parentElement;
        while (box && box !== document.body && !box.querySelector("img[src*='/images/items/']")) box = box.parentElement;
        if (!box || box === document.body || box.closest(".totr") || out.includes(box)) continue;
        // Exactly one item pictured, or we climbed into a list of items and can't tell which.
        const ids = new Set([...box.querySelectorAll("img[src*='/images/items/']")]
          .map((img) => (img.getAttribute("src").match(/\/images\/items\/(\d+)\//) || [])[1]).filter(Boolean));
        if (ids.size !== 1) continue;
        out.push({ box, itemId: Number([...ids][0]), quality: /Quality:/.test(box.textContent || "") });
      }
      // Torn can render the box twice, one nested inside the other (or a hidden copy). A bar in
      // the inner one sits inside the picture/stats layout and pushes the stats out of view, so
      // keep only the outermost visible box.
      return out.filter(({ box }) => box.getClientRects().length > 0
        && !out.some((o) => o.box !== box && o.box.contains(box)));
    }

    function scan() {
      const boxes = infoBoxes();
      // Drop bars left in boxes we no longer use (and the panel each one opened).
      for (const bar of document.querySelectorAll(".totr-pcbar")) {
        if (boxes.some((b) => b.box === bar.parentElement)) continue;
        const next = bar.nextElementSibling;
        if (next && next.classList.contains("totr-pc")) next.remove();
        bar.remove();
      }
      for (const { box, itemId, quality } of boxes) {
        const existing = box.querySelector(":scope > .totr-pcbar");
        if (existing && existing.dataset.item === String(itemId)) continue;
        if (existing) existing.remove();
        const bar = el("div", { class: "totr-pcbar", "data-totr-ui": "1", "data-item": String(itemId) });
        bar.append(el("button", { class: "totr-pcbtn", type: "button", onclick: () => toggle(itemId, bar, { quality }) }, "Price check"));
        box.prepend(bar);
      }
    }

    return { toggle, scan };
  })();


  // --- Stocks (WO-48, docs/trading-stocks-plan.md) ----------------------------------------
  // page.php?sid=stocks. Free: after-fee verdict per holding, lot lines, Fill the profitable
  // shares, the perk warning on the sell box, and four portfolio tiles — all from the player's
  // own key, straight to api.torn.com. Trading: profit from real sales (Torn log, synced
  // server-side), via trader-script `stock_stats`. Fills one box at most; never presses Sell.
  //
  // VERIFY: the stock page's markup has not been captured. Everything is found by visible text
  // ("(MCS)", "How many shares would you like to sell?", "SELL", the lot's share count), never
  // hashed class names, and the panel lists every holding itself — so a label that cannot find
  // its row costs only the label.
  modules.stocks = (() => {
    const PORTFOLIO_MS = 60_000; // prices tick every minute
    const DAY_CHANGE_MS = 5 * 60_000;
    const STATS_MS = 60_000;
    const PERIODS = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
    const SHOWN_TRADES = 20;

    let data = null; // { at, user, torn, prices, error }
    let loading = false;
    let dayChange = new Map();
    let dayAt = 0;
    let dayLoading = false;
    let period = "today";
    const stats = new Map(); // period → { at, res, error, status }
    let statsLoading = false;
    let holdingsOpen = false;

    const maskKey = (m) => String(m).replace(/key=[^&\s)]+/gi, "key=…");
    const apiUrl = (path, key) => `https://api.torn.com/v2/${path}?comment=overseer&key=${encodeURIComponent(key)}`;
    const tornError = (res) => (res && res.error ? `Torn: ${res.error.error || "error " + res.error.code}` : null);
    const fmtInt = (n) => Math.round(Number(n)).toLocaleString("en-US");
    const fmtPrice = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtMoney(Math.abs(n));
    const short = (n) => {
      const a = Math.abs(n);
      const s = a >= 1e9 ? `$${(a / 1e9).toFixed(2)}b` : a >= 1e6 ? `$${(a / 1e6).toFixed(2)}m` : a >= 1e4 ? `$${(a / 1e3).toFixed(1)}k` : fmtMoney(a);
      return (n > 0 ? "+" : n < 0 ? "−" : "") + s;
    };
    const acronymOf = (id) => {
      const t = data && data.torn && data.torn.get(Number(id));
      return t && t.acronym ? t.acronym : `#${id}`;
    };
    const holdings = () => ((data && data.user) || []).filter((s) => Number(s.shares) > 0);

    // ── data ──────────────────────────────────────────────────────────────────────────
    async function loadPortfolio(force) {
      if (loading || (!force && data && Date.now() - data.at < PORTFOLIO_MS)) return;
      const key = prefs().tornKey;
      if (!key) { data = { at: Date.now(), error: "nokey" }; render(); return; }
      loading = true;
      try {
        const [u, t] = await Promise.all([requestJson(apiUrl("user/stocks", key)), requestJson(apiUrl("torn/stocks", key))]);
        const err = tornError(u) || tornError(t);
        if (err) {
          data = { at: Date.now(), error: /error 16|access level/i.test(err) ? "Torn says this key can't read your stocks — it needs Limited access." : err };
        } else {
          const torn = new Map(((t && t.stocks) || []).map((s) => [Number(s.id), s]));
          const prices = new Map([...torn.values()].map((s) => [Number(s.id), Number(s.market && s.market.price)]));
          data = { at: Date.now(), user: Array.isArray(u && u.stocks) ? u.stocks : [], torn, prices, error: null };
        }
      } catch (e) {
        data = { at: Date.now(), error: maskKey(e && e.message || e) };
      } finally {
        loading = false;
        render();
      }
    }

    async function loadDayChanges() {
      if (dayLoading || !data || !data.user || Date.now() - dayAt < DAY_CHANGE_MS) return;
      const key = prefs().tornKey;
      if (!key) return;
      dayLoading = true;
      const next = new Map();
      for (const s of holdings()) {
        try {
          const r = await requestJson(apiUrl(`torn/${Number(s.id)}/stocks`, key));
          const day = r && r.stocks && r.stocks.chart && r.stocks.chart.performance && r.stocks.chart.performance.last_day;
          if (day && Number.isFinite(Number(day.change))) next.set(Number(s.id), Number(day.change));
        } catch { /* partial is fine — the tile says so */ }
      }
      dayChange = next;
      dayAt = Date.now();
      dayLoading = false;
      render();
    }

    async function loadStats(force) {
      const cur = stats.get(period);
      if (statsLoading || !hasKey() || (!force && cur && Date.now() - cur.at < STATS_MS)) return;
      statsLoading = true;
      const p = period;
      try {
        stats.set(p, { at: Date.now(), res: await callTrader("stock_stats", { period: p }), error: null, status: 200 });
      } catch (e) {
        const msg = e && e.message || String(e);
        if (BAD_KEY_RE.test(msg)) forgetKey();
        stats.set(p, { at: Date.now(), res: null, error: /Unknown action/i.test(msg) ? "arrives with the next Overseer update" : msg, status: e && e.status || null });
      } finally {
        statsLoading = false;
        render();
        // The player switched period while this one loaded: load theirs now, not on some later page change.
        if (p !== period) loadStats(false);
      }
    }

    // ── finding Torn's page by its visible text ───────────────────────────────────────
    function pageRoot() {
      return document.querySelector("#mainContainer .content-wrapper") || document.querySelector(".content-wrapper") || document.body;
    }
    /** Every visible text node of Torn's own page, read ONCE per pass (not once per lookup). */
    let passTexts = null;
    function allTexts() {
      if (passTexts) return passTexts;
      passTexts = [];
      const w = document.createTreeWalker(pageRoot(), NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent.trim() || (n.parentElement && n.parentElement.closest(".totr, [data-totr-ui], script, style"))) continue;
        passTexts.push(n);
      }
      return passTexts;
    }
    function textNodes(re) {
      return allTexts().filter((n) => re.test(n.textContent));
    }
    /** Stock name elements by id: the element whose text starts "(MCS)". */
    function nameElements() {
      const byAcr = new Map([...((data && data.torn) || new Map()).values()].map((t) => [t.acronym, Number(t.id)]));
      const out = new Map();
      for (const n of textNodes(/^\s*\(([A-Z]{2,4})\)/)) {
        const id = byAcr.get(n.textContent.trim().match(/^\(([A-Z]{2,4})\)/)[1]);
        if (id && !out.has(id)) out.set(id, n.parentElement);
      }
      return out;
    }
    const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    // ── labels on Torn's rows ─────────────────────────────────────────────────────────
    function setLine(id, makeAt, cls, text, title) {
      let line = document.getElementById(id);
      const sig = `${cls}|${text}`;
      if (line && line.isConnected && line.dataset.sig === sig) return;
      if (line) line.remove();
      line = el("div", { id, class: `totr-stk-chip totr-stk-chip--${cls}`, "data-totr-ui": "1", "data-sig": sig, title: title || null }, text);
      makeAt(line);
    }

    function decorateRows(names) {
      for (const s of holdings()) {
        const id = Number(s.id);
        const nameEl = names.get(id);
        const price = data.prices.get(id);
        if (!nameEl || !(price > 0)) continue;
        const v = stockVerdict(s, price);
        let cls; let text;
        if (v.perk) { cls = "muted"; text = "perk active — not checked"; }
        else if (v.profitableLots > 0) { cls = "ok"; text = `${signed(v.netIfSoldProfitable)} after fee · ${v.profitableLots} of ${v.lots.length} lots`; }
        else if (v.nearestBreakeven != null) { cls = "info"; text = `after fee ${signed(v.netIfSoldAll)} · breakeven ${fmtPrice(v.nearestBreakeven)} (+${(((v.nearestBreakeven - price) / price) * 100).toFixed(2)}%)`; }
        else continue;
        setLine(`totr-stk-row-${id}`, (line) => nameEl.insertAdjacentElement("afterend", line), cls, text,
          "Overseer: what selling would really pay after Torn's 0.1% fee, which Torn's Profit column leaves out.");
      }
    }

    function decorateLots() {
      const used = new Set(); // two identical lots must label two rows, not the first one twice
      const exactText = new Map();
      for (const n of allTexts()) {
        const t = n.textContent.trim();
        if (!exactText.has(t)) exactText.set(t, []);
        exactText.get(t).push(n);
      }
      for (const s of holdings()) {
        const id = Number(s.id);
        const price = data.prices.get(id);
        if (!(price > 0)) continue;
        const v = stockVerdict(s, price);
        if (v.perk) continue;
        for (const lot of v.lots) {
          const lineId = `totr-stk-lot-${lot.id}`;
          const boughtText = fmtPrice(lot.bought);
          const rowFor = (n) => {
            let r = n.parentElement;
            for (let i = 0; i < 5 && r; i++, r = r.parentElement) if (r.textContent.includes(boughtText) && r.textContent.length < 400) return r;
            return null;
          };
          const row = (exactText.get(fmtInt(lot.shares)) || []).map(rowFor).find((r) => r && !used.has(r));
          if (!row) continue;
          used.add(row);
          const text = lot.profitable
            ? `after fee ${signed(lot.net)} — in profit`
            : `after fee ${signed(lot.net)} · breakeven ${fmtPrice(lot.breakeven)}`;
          setLine(lineId, (line) => {
            if (row.tagName === "TR") {
              const tr = el("tr", { id: lineId, "data-totr-ui": "1", "data-sig": line.dataset.sig }, el("td", { colspan: "99" }, line));
              line.removeAttribute("id");
              row.insertAdjacentElement("afterend", tr);
            } else row.insertAdjacentElement("afterend", line);
          }, lot.profitable ? "ok" : "muted", text);
        }
      }
    }

    /** Torn's sell box: its input, its SELL button, and which stock it belongs to. */
    function sellBoxes(names) {
      const out = [];
      for (const n of textNodes(/How many shares would you like to sell\?/i)) {
        let box = n.parentElement;
        let button = null;
        for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
          button = [...box.querySelectorAll("button, input[type='submit'], a")].find((b) => /^\s*sell\s*$/i.test(b.textContent || b.value || ""));
          if (button) break;
        }
        if (!box || !button) continue;
        // Torn's own share box is the last input BEFORE its SELL button (TornTools adds one after).
        const input = [...box.querySelectorAll("input:not([type='hidden'])")].filter((i) => before(i, button) && !i.closest("[data-totr-ui]")).pop();
        if (!input) continue;
        // The stock is the last name BEFORE the "How many shares…" text. Not before `box`: the
        // climb to the SELL button can reach a container holding the row's own name, and
        // compareDocumentPosition then says "contains", which is not "follows" — the box would be
        // pinned on the stock ABOVE, and Fill would type its count into the wrong sell box.
        let stockId = null;
        for (const [id, nameEl] of names) if (before(nameEl, n) && (stockId == null || before(names.get(stockId), nameEl))) stockId = id;
        if (stockId != null) out.push({ box, input, stockId });
      }
      return out;
    }

    function decorateSellBoxes(names) {
      for (const { box, input, stockId } of sellBoxes(names)) {
        const stock = holdings().find((s) => Number(s.id) === stockId);
        const price = data.prices.get(stockId);
        if (!stock || !(price > 0)) continue;
        const t = data.torn.get(stockId);
        const requirement = t && t.bonus ? Number(t.bonus.requirement) : null;
        const v = stockVerdict(stock, price);
        const helperId = `totr-stk-sell-${stockId}`;
        let helper = document.getElementById(helperId);
        if (!helper || !helper.isConnected) {
          helper?.remove();
          helper = el("div", { id: helperId, class: "totr totr-stk-sell", "data-totr-ui": "1" });
          box.insertAdjacentElement("afterend", helper);
        }
        // The listener calls whatever the latest decorate left here, so a price tick never
        // leaves the preview working from an old price.
        input.totrStkPaint = () => paintSell(helper, stock, price, requirement, v, input);
        if (!input.dataset.totrStk) {
          input.dataset.totrStk = "1";
          input.addEventListener("input", () => input.totrStkPaint && input.totrStkPaint());
        }
        input.totrStkPaint();
      }
    }

    function paintSell(helper, stock, price, requirement, v, input) {
      const qty = Number(String(input.value || "").replace(/[^0-9]/g, "")) || 0;
      const parts = [];
      if (!v.perk) {
        if (v.newestFirstCount > 0) {
          parts.push(el("button", { class: "totr-btn totr-btn--primary", type: "button", onclick: () => { setNativeValue(input, v.newestFirstCount); paintSell(helper, stock, price, requirement, v, input); } },
            `Fill ${fmtInt(v.newestFirstCount)} ${acronymOf(stock.id)} shares (${signed(v.netIfSoldProfitable)} after fee)`));
        } else if (v.profitableLots > 0) {
          parts.push(el("div", { class: "totr-muted" }, `${v.profitableLots} lot${v.profitableLots === 1 ? "" : "s"} in profit, but not the newest — Torn sells newest first when you type a number, so sell those lot by lot with Torn's Sell links.`));
        } else if (v.nearestBreakeven != null) {
          parts.push(el("div", { class: "totr-muted" }, `No lot is in profit after the 0.1% fee yet — the nearest breaks even at ${fmtPrice(v.nearestBreakeven)}.`));
        }
      }
      if (qty > 0) {
        const preview = sellPreview(stock, price, qty);
        const warn = perkWarning(stock, requirement, qty);
        if (warn) {
          const t = data.torn.get(Number(stock.id));
          const perkName = t && t.bonus ? t.bonus.description : "this stock's perk";
          const days = stock.bonus && !stock.bonus.available && Number(stock.bonus.frequency) > 0
            ? ` The next one is due in ${Math.max(0, Number(stock.bonus.frequency) - Number(stock.bonus.progress || 0))} days.` : "";
          parts.push(el("div", { class: "totr-stk-warn" },
            el("strong", null, warn.after === 0 ? `You'd lose the ${perkName} perk` : `You'd drop from increment ${warn.held} to ${warn.after}`),
            el("div", null, `Selling ${fmtInt(qty)} leaves you ${fmtInt(warn.left)} shares, under the ${fmtInt(warn.needed)} it needs.${days}`)));
        }
        if (preview) {
          parts.push(el("div", { class: "totr-muted" }, `After the 0.1% fee (${fmtMoney(preview.fee)}) you get ${fmtMoney(preview.payout)} · `,
            el("span", { class: preview.net >= 0 ? "totr-stk-pos" : "totr-stk-neg" }, `${signed(preview.net)} vs what those shares cost`)));
        }
      }
      if (parts.length === 0) { helper.replaceChildren(); helper.hidden = true; return; }
      helper.hidden = false;
      helper.replaceChildren(...parts);
    }

    // ── the Overseer panel ────────────────────────────────────────────────────────────
    function panelAnchor(names) {
      const header = textNodes(/^\s*Stock Name\s*$/)[0];
      const first = [...names.values()].sort((a, b) => (before(a, b) ? -1 : 1))[0];
      if (header && first) {
        let box = header.parentElement;
        while (box && !box.contains(first)) box = box.parentElement;
        if (box && box !== pageRoot()) {
          // The child of `box` that holds the header: insert the panel just above it.
          let top = header.parentElement;
          while (top.parentElement && top.parentElement !== box) top = top.parentElement;
          return top;
        }
      }
      return null;
    }

    function ensurePanel(names) {
      let panel = document.getElementById("totr-stocks");
      if (!panel || !panel.isConnected) {
        panel?.remove();
        panel = el("div", { id: "totr-stocks", class: "totr" });
        pageRoot().prepend(panel);
        render();
      }
      // The list can only be found once the stock names are known (they come with the data),
      // so a panel parked at the top moves above the list the first time it can — once.
      if (panel.dataset.anchored !== "1") {
        const anchor = panelAnchor(names);
        if (anchor) {
          anchor.insertAdjacentElement("beforebegin", panel);
          panel.dataset.anchored = "1";
        }
      }
      return panel;
    }

    const tile = (label, value, sub, cls) =>
      el("div", { class: "totr-stk-tile" + (cls ? ` totr-stk-tile--${cls}` : "") },
        el("span", { class: "totr-stk-label" }, label),
        el("strong", { class: "totr-stk-value" }, value),
        sub ? el("span", { class: "totr-muted" }, sub) : null);

    function tradingTiles() {
      const cur = stats.get(period);
      if (!hasKey()) return [];
      if (!cur) return [tile("Profit · after fees", "…", "reading your Torn log")];
      if (cur.status === 402) {
        return [el("div", { class: "totr-stk-tile totr-stk-tile--locked" },
          el("span", { class: "totr-stk-label" }, "Profit · fees · best & worst · average hold"),
          el("span", null, "Profit from your real buys and sells, read from your Torn log."),
          el("a", { href: `${SITE_URL}/trading`, target: "_blank", rel: "noopener" }, "Get Trading on tornoverseer.com"))];
      }
      if (cur.error) return [tile("Profit · after fees", "—", cur.error)];
      const r = cur.res || {};
      if (!r.logConnected) {
        return [el("div", { class: "totr-stk-tile totr-stk-tile--locked" },
          el("span", { class: "totr-stk-label" }, "Profit from your stock sales"),
          el("span", null, "Connect your Overseer Ledger key on the Trading page — profit, fees and hold times then sync from your Torn log."),
          el("a", { href: `${SITE_URL}/trading`, target: "_blank", rel: "noopener" }, "Open the Trading page"))];
      }
      const st = r.stats || {};
      const out = [
        tile("Profit · after fees", signed(st.profit || 0), `${st.sales || 0} sale${st.sales === 1 ? "" : "s"} · ${st.inProfit || 0} in profit, ${st.atLoss || 0} at a loss`, (st.profit || 0) >= 0 ? "ok" : "bad"),
        tile("Fees paid", fmtMoney(st.fees || 0), st.soldWorth ? `on ${short(st.soldWorth).replace(/^\+/, "")} of sales` : "0.1% of every sale, rounded up"),
        tile("Average hold", st.avgHoldDays == null ? "—" : `≈ ${st.avgHoldDays < 1 ? (st.avgHoldDays * 24).toFixed(1) + " h" : st.avgHoldDays.toFixed(1) + " days"}`,
          st.holdUnknownSales ? `${st.holdUnknownSales} sale(s) older than the synced history` : "bought → sold, newest lot first"),
      ];
      if (st.best) out.push(tile("Best trade", `${acronymOf(st.best.stockId)} ${signed(st.best.netProfit)}`, `${fmtInt(st.best.shares)} @ ${fmtPrice(st.best.price)}`, "ok"));
      if (st.worst) out.push(tile("Worst trade", `${acronymOf(st.worst.stockId)} ${signed(st.worst.netProfit)}`, `${fmtInt(st.worst.shares)} @ ${fmtPrice(st.worst.price)}`, "bad"));
      return out;
    }

    function freeTiles() {
      if (!data || !data.user) return [];
      const sum = portfolioSummary(data.user, data.prices, data.torn, dayChange);
      if (sum.owned === 0) return [tile("Your stocks", "none held", "nothing to check")];
      const out = [
        tile("If you sold everything now", `≈ ${short(sum.soldAllNow)}`, `before the fee: ${short(sum.gross)}`, sum.soldAllNow >= 0 ? null : "bad"),
      ];
      if (sum.closest) {
        out.push(tile("Closest to profit", `${acronymOf(sum.closest.id)} +${fmtPrice(sum.closest.gap)}`,
          `needs ${fmtPrice(sum.closest.target)} (+${((sum.closest.gap / sum.closest.price) * 100).toFixed(2)}%)`, "warn"));
      }
      const next = sum.nextPerk ? `next: ${acronymOf(sum.nextPerk.id)}${sum.nextPerk.description ? " " + sum.nextPerk.description : ""} in ${sum.nextPerk.days} day${sum.nextPerk.days === 1 ? "" : "s"}` : "";
      out.push(tile("Perks", `${sum.perksReady} ready to collect`, next));
      out.push(tile("24h price move", sum.priceMove == null ? "…" : short(sum.priceMove),
        sum.priceMoveComplete ? "your shares × each stock's 24h change" : "some stocks still loading", sum.priceMove == null ? null : sum.priceMove >= 0 ? "ok" : "bad"));
      return out;
    }

    function holdingsTable() {
      const rows = holdings().map((s) => {
        const id = Number(s.id);
        const price = data.prices.get(id);
        const v = price > 0 ? stockVerdict(s, price) : null;
        const status = !v ? "no price"
          : v.perk ? "perk active — not checked"
          : v.profitableLots > 0 ? `${signed(v.netIfSoldProfitable)} after fee on ${v.profitableLots} of ${v.lots.length} lots`
          : v.nearestBreakeven != null ? `${signed(v.netIfSoldAll)} after fee · breakeven ${fmtPrice(v.nearestBreakeven)}` : "—";
        return el("div", { class: "totr-stk-hrow" + (v && !v.perk && v.profitableLots > 0 ? " totr-stk-hrow--ok" : "") },
          el("span", null, acronymOf(id)), el("span", { class: "totr-num" }, fmtInt(s.shares)), el("span", { class: "totr-num" }, price > 0 ? fmtPrice(price) : "—"), el("span", null, status));
      });
      if (rows.length === 0) return null;
      const details = el("details", { class: "totr-stk-details", open: holdingsOpen || null },
        el("summary", null, `Your ${rows.length} holding${rows.length === 1 ? "" : "s"} after the fee`), ...rows);
      details.addEventListener("toggle", () => { holdingsOpen = details.open; });
      return details;
    }

    function tradesTable() {
      const cur = stats.get(period);
      const st = cur && cur.res && cur.res.stats;
      if (!st || !Array.isArray(st.trades) || st.trades.length === 0) return null;
      const when = (iso) => {
        const d = new Date(iso);
        const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
        return period === "today" ? hm : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${hm}`;
      };
      const rows = st.trades.slice(0, SHOWN_TRADES).map((t) =>
        el("div", { class: "totr-stk-trow" + (t.side === "sell" ? " totr-stk-trow--sell" : "") },
          el("span", { class: "totr-muted" }, when(t.ts)),
          el("span", { class: t.side === "sell" ? "totr-stk-pos" : "totr-stk-buy" }, t.side === "sell" ? "Sell" : "Buy"),
          el("span", null, acronymOf(t.stockId)),
          el("span", { class: "totr-num" }, fmtInt(t.shares)),
          el("span", { class: "totr-num" }, fmtPrice(t.price)),
          el("span", { class: "totr-num" }, t.fees == null ? "—" : fmtMoney(t.fees)),
          el("span", { class: "totr-num" }, t.side === "sell" ? `+${fmtMoney(t.worth)}` : `−${fmtMoney(t.worth)}`),
          el("span", { class: "totr-num " + (t.netProfit == null ? "totr-muted" : t.netProfit >= 0 ? "totr-stk-pos" : "totr-stk-neg") }, t.netProfit == null ? "open lot" : signed(t.netProfit))));
      const more = st.trades.length > SHOWN_TRADES || st.tradesTruncated ? el("div", { class: "totr-muted" }, `Showing the newest ${SHOWN_TRADES} of ${st.buys + st.sales} trades.`) : null;
      return el("div", { class: "totr-stk-trades" },
        el("h4", null, period === "today" ? "Today's trades" : `Trades · last ${period === "7d" ? "7" : "30"} days`),
        el("div", { class: "totr-stk-trow totr-stk-trow--head" }, ...["Time (TCT)", "Side", "Stock", "Shares", "Price", "Fee", "Cash", "Profit"].map((h) => el("span", null, h))),
        ...rows, more);
    }

    function render() {
      const panel = document.getElementById("totr-stocks");
      if (!panel) return;
      const head = el("div", { class: "totr-head" },
        el("span", { class: "totr-pill totr-pill--info" }, "Overseer"),
        el("strong", { style: "font-size:16px" }, "Your stocks"),
        el("span", { class: "totr-muted" }, "Torn City time"),
        el("div", { class: "totr-stk-periods", role: "group", "aria-label": "Period" },
          ...PERIODS.map(([p, label]) => el("button", {
            type: "button", class: "totr-stk-period" + (p === period ? " totr-stk-period--on" : ""), "aria-pressed": p === period ? "true" : "false",
            onclick: () => { period = p; render(); loadStats(false); },
          }, label))));
      const body = el("div", { class: "totr-body" });
      if (!prefs().tornKey) {
        body.append(keyEntry(() => { data = null; loadPortfolio(true); loadStats(true); }));
      } else if (data && data.error && data.error !== "nokey") {
        body.append(el("div", { class: "totr-error" }, data.error));
      } else if (!data) {
        body.append(el("div", { class: "totr-muted" }, "Reading your stocks…"));
      } else {
        body.append(el("div", { class: "totr-stk-tiles" }, ...tradingTiles(), ...freeTiles()));
        const h = holdingsTable();
        if (h) body.append(h);
        const t = tradesTable();
        if (t) body.append(t);
        const r = stats.get(period) && stats.get(period).res;
        if (r && r.logConnected) {
          const ago = r.lastSyncAt ? Math.max(0, Math.round((Date.now() - Date.parse(r.lastSyncAt)) / 60_000)) : null;
          body.append(el("div", { class: "totr-muted" }, `Sales sync from your Torn log every 15 minutes${ago == null ? "" : ` · last read ${ago} min ago`}.`));
          const problem = r.stockError || r.lastError;
          if (problem) body.append(el("div", { class: "totr-error" }, `Last stock sync problem: ${problem}`));
        }
      }
      panel.replaceChildren(head, body);
    }

    function onRoute() {
      passTexts = null; // Torn redraws between passes: re-read its text each time, once
      const names = nameElements();
      ensurePanel(names);
      loadPortfolio(false);
      loadStats(false);
      if (!data || !data.user) return;
      loadDayChanges();
      decorateRows(names);
      decorateLots();
      decorateSellBoxes(names);
    }

    return { onRoute };
  })();

  // --- WO-66: deal alerts on every page ----------------------------------------------------
  // The Overseer eye joins Torn's Information icons (sidebar) with a green count of new deals;
  // a round "$" button shows the same count when there are new deals (phones, where the sidebar
  // is tucked away), stacked above Chain Watch's TO button if that is installed. Either opens a
  // panel: Deals (bazaars from the server, the item market read here with your own key) and your
  // Buy list. A non-subscriber gets the eye only, opening a locked panel — nothing else starts.
  // Deals and the subscription answer are cached in page storage (not secret) so a page load
  // never re-asks the server inside DEALS_POLL_MS. VERIFY the sidebar selector on live Torn.
  const EYE_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAJ4klEQVR42s1Ye3BU5RX/nfPdzW6yeZBks3s3kBAJ4gORBqiMVgdf7VgfzMCI2BnFqpWOFPpHZQYZ7GhrtU6tdjqUDlNHaIcZdRRrdAQVqBBNRTEdEkQoJOGVQEgCITHZZO/uPd/pH7tEpFgeYvXM3Llzd7693+/+zuv3HeD823QADr5FxgACjwIcBWJR8O4QUKkATQYCWbD0TQAzfNLuI4B7ZlKuApg7vCh7zcrczhrouXwZM2AJgGSepwK4sRI86UYKXRMDlz6ng8cqYba2wt/VB30PwEYA3QzAZoDK18aa+ZyYe76DwIdLKN++yaW6l6OqPFJ/RmGZT2Hdz642cpmuomK9k3I7CkF/AFDJAB7NhMV5d7vJvnHqpWTql1ORHjRxVS73j1HUO0rRlFLcX0BhuZ/y/MPspvpN3FOKp5TKtY4jehUFuwE8gK8BpAlk7nPvRV6yi2KqHE99xm46wa4oxcUjV3o5LndTnsylsCiVS9rEZYji4pPr7+Wo18OuPkcjNApaSucRpMnWjMVzkadKI2WIYuk0xaxSXOo5Ig85hXKlkyujyJEAIPnMcpkTlLudsLxCxdLJMelnVzyK+krl3tNUqACW8+fJ89UyFcBPHqR8/QeXptIU85XispPK5A7OswZkM7EPC0By8/IkmwRy/PdJHJQNVCJK5fImFcsaLk3+jYuVgYUnxPRZZzEzYC0w4S7K3bIKxYGjEHxGlraqjwd5gLokDQB6w7Rp+OHNt9CY6jHa3NKCCRMuR/PuXfT2W2/phg0bkLaWgmz0p5oLj4AHOKyTLekC7dc/aWKqAbZKxt32jKl7FGAFaDR43SGKqk9uSikuz1ChwGRYG+m6snbtWlFVUVVJpVKy49Mdx5+t53l2xYoVMmH8+AybDLuIwrLHuHKUY143xbQazjsnxONZl5Prf00F2kax9BGKSTOVicuOBWCvv+46Wbhwofi+L57nSSKREFW1x8ENDQ1JYmDAfvDBB7J582aZVFMjAGyEjeymMhlkV5Rc/wkqsACuMp93pdPb8cAtA63aT1FVdr0Eu3KHycTXxMsmSCKRsF1dXXbLli3DjG3btk1qa2uloaHBJgYS0nagTerr6yWRSMjKFSvELYtaENkfc55ViotSzPs3RTQCWo6zSBjKriqciWCbUlwPmJi/3kQkwGyZSN54/XVRVRkcHLRtBw7IJ59sk9tuvVUCgYAAsMuWLRNVlZ6eHjnc2SleMim+78sjS5YIAFviBGQ3R6WXXd+juN5Mwd0AguYMuxtrhurv/goF9hC7stNEZbEpFAD2ismTZe/evdLQ0CCqKp2dnVJdXT2cuTU1NcOMNjc3S1dXl6TTaVFV2dbUJKFgUAiQNVwiO0xMmk3ULqH8NIBLs/vyyUrkVAxaABVpBvVA5GJr0JJtnxMvn4iqqiqMu3AcrLVYunQpWltbEQqFwMxoaWnB6tWrsXXrVsyePRvbt28nx3HQcagDF4wZg6qKSiiAnSS4xDLCSjIyU2pHOZl9v8DgybqNFLAGuGssOY/7gF2tSV4KQR0yJeWSy8ZnPsIxyszU2NiozKx+Ok1qLfr7+2nWrFlKRKqq8LyUtrW14fDhw5gYmUhFxSMUAJZjCP+Eh1FqSAm2AmZZm8piBV6lDEg9FYNKAOUA7/Wp1o6HQ1dxSGdTGNXZyMz+QVUVBw8eRCgUgrWWiBkKgIhgjIFhRn44jLKyCI4d68WkmklQVQz092dVbQhPUSF+gTydiAANAatLgA9PBPelLk4DB7ohrw2ppWkURJVxUAUHBODT7Z8inU7j/fffR3d3t86bNw+O4yCdTsNxHDCzAoAvgnvvvQ+jK0ejanQlGcdg//79uv/AAQKA76uDccqoIoePwNIRlRc/A9rPNEkoCIyZj7xEmsutb8r9P5giAWCrq6qkpaVVGhsbRVVte3u7LFiwQCoqKk5scXLPnDkyODgo7W1tx2ukPPP00wLAxpyAdFBUjlLUP8auzqFQJ4BSzYA7vXjILjRTEPiwh13bx276X1wmBWwsAHnqyd/KQP+AiIg0NTbJCy+8IJs3b5aVK1fKww8/LB9//PFwd2ltbZX2tnbp7u6WUfG4BcHO43xRiksrR72DFLVjwbU4S+HgZPP9obe5RFOcaXOPUYGASUYUFMimTZskmUxKbW2t1G2qk4GBgeHysmfPHhER6yWT1vd9eemll+TKK6YKABnDjvRSTLopKsLx9PNUpABmmFMn7ZcX6yyL0dsQ7OpnV9ZScfo1LpE4OwJAxlZVyaJFi2T9+vXS29ub6cWeJzt37JTdu3bJvn37pKmpSY4cPSp33H57xvWG7GLOl79ysTzPxanDHNOp5DQCyDlj957iUDTvWSrSahgvRCQzKSQXc6ZjhEO5MnPGDNn47ruiqjI0NCR1dXWiqvLss8/Kk088IRdVjxUA4hgjv6MiuZlCUkFG0lyeehwFCuAHp5Nc/7MnK0AXw3l9BY3QKZTj7eEy6aCo3Mih4YQIh8P2hmuvlRnTp8ukmhq55aabpNx1h/XgJSZo11GJKI2UP3KRbONIsp5KNQD83nxF0Xrc1UWV4IZ6jugAx1IdHJUuduUxUyijTY7QCdl74lXoOPKIKZTejHKRXoqJcrm3ioo1Bn51FmBOdxw9E5+zAawAI++kUP1vuKhqLXn+JAR4BBh9alGkQAMLmkjwvAxgIRdgihq8gRTmIxfjLaMPFkVgaYUNTEfPuh3qT1cgRcOF4/wcN6fMpNBAF0X9for6hzgmDSYmSXZFTVw6OCYVMNJDUVGKyz6OSgNHJM0xSVMsNUCuXo2c7QCKzlT/namKFQEcB2j4uyZ/vp5SJp+MHYJiow7hEFn0qEVCM4IiCSAFi5FKCBPjKGAdMjwffX31SM12gD7JuNbifNq0bH2sglm1iSPqczzVzFEZzDK2nkokBpaPuFQ8iomQK+0mJsrlqb/wCAXwI+cs691ZnQPqMkzyPsiCP9uB1u3wnSTUMjEGmHDEMCwBCSIkidBPwA4V/x31Aott31IGXvxeBpz/tQ6NsvEzbSrnyHtOWXqQ436nicsajsg4cmSfiWUZjKXe5lItBm0BEDyXARKfA0C5OuPqug4rT+VZdXJVbYkC5WAIgGMggFgZzOs12X8MOscBvFcy2ar4Pxhpho2ca5Hz0SC5qlye2sgRuZQcaWNXEmY47u4/HxOEcxpcZnec8EvKH1QqT39EEb8GjvSaeGqviesF4Ncom1zfyGh1GuAYACHgoc0c0VaOehPhpJXLZT6FuwGMynYixjdk9HI28G+inHcbKaK3IJhcQyUK4D4+VxFwvl2dBXLhHMrtnUG5eg0F1gHAy98CcF8YbjrgBUFQEsBF+Jawd7LwyAdwO537/Pu/7D9oxDmtTksOnAAAAABJRU5ErkJggg==";
  const ALERTS_STORE = "totr_alerts_v1";

  modules.alerts = (() => {
    let state = null;
    let open = false;
    let tab = "deals";
    let busy = false;

    function load() {
      if (state) return state;
      try { state = JSON.parse(localStorage.getItem(ALERTS_STORE) || "null"); } catch { state = null; }
      if (!state || typeof state !== "object") state = {};
      state.seen = Array.isArray(state.seen) ? state.seen.slice(-300) : [];
      state.market = state.market && typeof state.market === "object" ? state.market : {};
      return state;
    }
    function save() {
      try { localStorage.setItem(ALERTS_STORE, JSON.stringify(state)); } catch { /* storage off: just re-asks */ }
    }

    function deals() {
      const s = load();
      const market = Object.values(s.market || {}).map((m) => m && m.deal).filter(Boolean);
      return mergeDeals(s.deals, market, s.watched);
    }
    function unseen() { return unseenDeals(deals(), load().seen); }

    async function poll(force) {
      if (busy || !hasKey()) return;
      if (typeof document !== "undefined" && document.hidden && !force) return;
      const s = load();
      const now = Date.now();
      if (s.locked && !force && now - (s.at || 0) < LOCKED_RECHECK_MS) return;
      if (!s.locked && !force && now - (s.at || 0) < DEALS_POLL_MS) return;
      busy = true;
      try {
        const res = await callTrader("deals");
        s.locked = false;
        s.watched = Array.isArray(res && res.watched) ? res.watched : [];
        s.deals = Array.isArray(res && res.deals) ? res.deals : [];
        s.checkedAt = (res && res.checkedAt) || new Date(now).toISOString();
        s.error = null;
        // Item market, with the player's own key: a few watched items per poll, in rotation.
        const key = prefs().tornKey;
        if (key) {
          const pick = pickMarketChecks(s.watched, Math.floor(now / DEALS_POLL_MS), MARKET_CHECKS_PER_POLL);
          for (const item of pick) {
            try {
              const r = await requestJson(`https://api.torn.com/v2/market/${item.itemId}/itemmarket?offset=0&comment=overseer&key=${encodeURIComponent(key)}`);
              const env = (r && r.itemmarket) || r;
              if (r && r.error) break; // key problem or rate limit: stop for this poll
              s.market[item.itemId] = { at: now, deal: itemMarketDealFor(item, env && env.listings) };
            } catch { break; }
          }
          // Forget items that left the list.
          const ids = new Set(s.watched.map((w) => String(w.itemId)));
          for (const id of Object.keys(s.market)) if (!ids.has(id)) delete s.market[id];
        }
      } catch (err) {
        if (err && err.status === 402) { s.locked = true; s.deals = []; s.watched = []; s.market = {}; }
        else s.error = String((err && err.message) || err).replace(/key=[^&\s)]+/gi, "key=…");
      } finally {
        s.at = now;
        busy = false;
        save();
        render();
      }
    }

    // ---- sidebar eye (VERIFY: Torn's status icon list in the left sidebar) ----------------
    // 0.8.1: the class guess missed on live Torn (2026-11-07), so the eye never showed. Try the
    // known class shapes first, then fall back to the sidebar block headed "Information" and
    // its first list of icons. Remembered while it stays on the page.
    let iconListCache = null;
    function iconList() {
      if (iconListCache && iconListCache.isConnected) return iconListCache;
      iconListCache = document.querySelector("ul[class*='status-icons'], ul[class*='statusIcons'], ul[class*='status_icons']")
        || iconListUnderHeading();
      return iconListCache;
    }
    function iconListUnderHeading() {
      const root = document.getElementById("sidebarroot") || document.getElementById("sidebar") || document.body;
      if (!root) return null;
      for (const h of root.querySelectorAll("h2, h3, h4, h5, div, span, p")) {
        if (h.children.length || h.textContent.trim() !== "Information") continue;
        let box = h.parentElement;
        for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
          const ul = [...box.querySelectorAll("ul")].find((u) => u.id !== "totr-eye" && u.children.length >= 3
            && [...u.children].every((li) => li.tagName === "LI") && u.querySelector("li a, li svg, li img, li [class*='icon']"));
          if (ul) return ul;
        }
      }
      return null;
    }
    function ensureEye(count, locked) {
      const list = iconList();
      if (!list) return;
      let li = document.getElementById("totr-eye");
      if (!li || !li.isConnected) {
        li = el("li", { id: "totr-eye", "data-totr-ui": "1", style: "position:relative" },
          el("button", { type: "button", class: "totr-eye", onclick: () => toggle(true) },
            el("img", { src: EYE_SRC, alt: "" })));
        list.append(li);
      }
      const btn = li.querySelector("button");
      const label = locked ? "Torn Overseer: Trading is locked" : count > 0 ? `Torn Overseer: ${count} new deal${count === 1 ? "" : "s"} under your price` : "Torn Overseer: no new deals";
      btn.setAttribute("aria-label", label);
      btn.title = label;
      const badge = btn.querySelector(".totr-badge");
      if (count > 0) {
        if (badge) badge.textContent = String(count);
        else btn.append(el("span", { class: "totr-badge" }, String(count)));
      } else badge?.remove();
    }

    // ---- floating "$" button: only while there is something new --------------------------
    function ensureFab(count) {
      let fab = document.getElementById("totr-fab");
      if (count <= 0) { fab?.remove(); return; }
      if (!fab) {
        fab = el("button", { id: "totr-fab", type: "button", class: "totr-fab", "data-totr-ui": "1", onclick: () => toggle(true) }, "$");
        document.body.append(fab);
      }
      // Stack above Chain Watch's TO launcher when it is on screen.
      const to = document.getElementById("tocw-launcher");
      if (to && to.style.display !== "none") {
        const r = to.getBoundingClientRect();
        fab.style.left = `${Math.round(r.left)}px`;
        fab.style.bottom = `${Math.round(window.innerHeight - r.top + 10)}px`;
      } else {
        fab.style.left = "";
        fab.style.bottom = "";
      }
      fab.setAttribute("aria-label", `Overseer Trading: ${count} new deal${count === 1 ? "" : "s"}`);
      let badge = fab.querySelector(".totr-badge");
      if (!badge) { badge = el("span", { class: "totr-badge" }); fab.append(badge); }
      badge.textContent = String(count);
    }

    // ---- the panel ------------------------------------------------------------------------
    function toggle(want) {
      open = want == null ? !open : want;
      if (open) {
        const s = load();
        // Opening marks what is listed as seen: the counts clear.
        s.seen = [...new Set([...(s.seen || []), ...deals().map(dealKey)])].slice(-300);
        save();
        poll(false);
      }
      render();
    }

    function dealCard(d) {
      const href = d.source === "market"
        ? `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${d.itemId}`
        : d.sellerId ? `https://www.torn.com/bazaar.php?userId=${d.sellerId}&totr=${d.itemId}-${d.price}#/` : null;
      return el("div", { class: "totr-deal-card" },
        el("div", { class: "totr-deal-main" },
          el("div", null, el("b", null, d.name || `Item ${d.itemId}`), el("span", { class: "totr-deal-pct" }, d.underPct > 0 ? `−${d.underPct}%` : "at price")),
          el("div", null, el("b", null, fmtMoney(d.price)), el("span", { class: "totr-muted" }, ` · ×${d.qtyUnder || 1} · ${d.source === "market" ? "Item market" : `Bazaar${d.sellerName ? " · " + d.sellerName : ""}`}`)),
          el("div", { class: "totr-muted" }, `Your price ${fmtMoney(d.buyPrice)}`)),
        href ? el("a", { class: "totr-deal-open", href }, "Open") : null);
    }

    function lockedBody() {
      return [
        el("div", null, el("b", null, "Buy cheaper and sell smarter, right on Torn's pages.")),
        el("ul", { class: "totr-lock-list" },
          el("li", null, el("b", null, "Deal alerts"), " when items on your buy list drop under your price"),
          el("li", null, el("b", null, "A buy list"), " with no Torn Exchange account needed"),
          el("li", null, el("b", null, "One-tap bazaar fill"), " from your sell list"),
          el("li", null, el("b", null, "Real profit per item"), " from your Torn log, after fees"),
          el("li", null, el("b", null, "Price check"), " on any item")),
        el("div", { class: "totr-lock-why" },
          el("b", null, "Why it's separate from your faction: "),
          "Trading is your own money, not your faction's. It follows you if you switch factions, and your faction doesn't pay for one trader."),
        el("a", { class: "totr-deal-open", href: `${SITE_URL}/trading`, target: "_blank", rel: "noopener", style: "justify-content:center" }, "Get Trading on tornoverseer.com"),
      ];
    }

    function renderSheet() {
      let sheet = document.getElementById("totr-sheet");
      if (!open) { sheet?.remove(); return; }
      if (!sheet) {
        sheet = el("section", { id: "totr-sheet", class: "totr-sheet", "data-totr-ui": "1", role: "dialog", "aria-label": "Overseer Trading" });
        document.body.append(sheet);
      }
      const s = load();
      const head = el("div", { class: "totr-sheet-head" },
        el("img", { src: EYE_SRC, alt: "" }),
        el("span", { class: "totr-sheet-title" }, "OVERSEER TRADING"),
        el("button", { type: "button", class: "totr-sheet-x", "aria-label": "Close", onclick: () => toggle(false) }, "✕"));
      const body = el("div", { class: "totr-sheet-body" });
      const parts = [head];
      if (s.locked) {
        body.append(...lockedBody());
        parts.push(body);
      } else {
        const list = deals();
        parts.push(el("div", { class: "totr-sheet-tabs", role: "tablist" },
          el("button", { type: "button", role: "tab", class: "totr-sheet-tab" + (tab === "deals" ? " totr-sheet-tab--on" : ""), onclick: () => { tab = "deals"; render(); } }, `Deals · ${list.length}`),
          el("button", { type: "button", role: "tab", class: "totr-sheet-tab" + (tab === "list" ? " totr-sheet-tab--on" : ""), onclick: () => { tab = "list"; render(); } }, `Buy list · ${(s.watched || []).length}`)));
        if (tab === "deals") {
          if (s.error) body.append(el("div", { class: "totr-error" }, s.error));
          if (!(s.watched || []).length) {
            body.append(el("div", { class: "totr-muted" }, "Your buy list is empty. Add the items you buy and the prices you'll pay, and deals show up here."),
              el("a", { class: "totr-link", href: `${SITE_URL}/trading/buy-list`, target: "_blank", rel: "noopener" }, "Set up your buy list"));
          } else if (!list.length) {
            body.append(el("div", { class: "totr-muted" }, "Nothing under your prices right now."));
          } else body.append(...list.map(dealCard));
        } else {
          for (const w of s.watched || []) {
            body.append(el("div", { class: "totr-deal-card" },
              el("div", { class: "totr-deal-main" }, el("b", null, w.name || `Item ${w.itemId}`)),
              el("b", null, fmtMoney(w.buyPrice))));
          }
          body.append(el("div", { class: "totr-muted" }, "Weapons and armor aren't on the buy list yet."));
        }
        parts.push(body);
        parts.push(el("div", { class: "totr-sheet-foot" },
          el("span", null, `${s.checkedAt ? "Checked " + minutesAgo(s.checkedAt, Date.now()) : "Checking…"} · ${(s.watched || []).length} watched`),
          el("a", { href: `${SITE_URL}/trading/buy-list`, target: "_blank", rel: "noopener" }, "Edit buy list")));
      }
      sheet.replaceChildren(...parts);
    }

    function render() {
      if (!IS_BROWSER || !hasKey()) return;
      const s = load();
      const count = s.locked ? 0 : unseen().length;
      ensureEye(count, Boolean(s.locked));
      ensureFab(count);
      renderSheet();
    }

    let started = false;
    /** Torn redraws the sidebar: put the eye back (cheap — an id lookup first). */
    function tick() {
      if (!started) { start(); return; }
      if (!document.getElementById("totr-eye") || (unseen().length > 0 && !document.getElementById("totr-fab"))) render();
    }
    function start() {
      if (started || !hasKey()) return;
      started = true;
      render();
      poll(false);
      setInterval(() => poll(false), 60_000);
      // 0.8.2: the sidebar loads after the script and is redrawn by Torn; the page watcher's
      // debounce never settles on pages whose timers tick every second, so the eye was not put
      // back after a refresh. A 2-second check (an id lookup) keeps it in place.
      setInterval(() => { if (!document.hidden) tick(); }, 2_000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(false); });
    }
    return {
      start,
      tick,
      /** The item market page's buy price for one item, for the price line. */
      buyPriceFor(itemId) {
        const w = (load().watched || []).find((x) => x.itemId === itemId);
        return w ? w.buyPrice : null;
      },
    };
  })();

  // ---------------------------------------------------------------------------------------
  // Boot: route, then re-route on SPA navigation (debounced; ignores our own mutations)
  // ---------------------------------------------------------------------------------------

  function boot() {
    injectCss();
    let timer = null;
    const run = () => {
      // 0.8.0: the script now loads on every Torn page for the deal alerts. The trading
      // modules and Price check still run only on the pages they always ran on.
      try { modules.alerts.tick(); } catch (err) { console.warn("[Overseer Trading]", err); }
      if (!isTradingPage(location)) return;
      const name = routeFor(location);
      if (name && modules[name]) {
        try { modules[name].onRoute(); } catch (err) { console.warn("[Overseer Trading]", err); }
      }
      // Price check rides along on the trading pages (incl. the Items page).
      try { modules.priceCheck.scan(); } catch (err) { console.warn("[Overseer Trading]", err); }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(run, isTradingPage(location) ? 150 : 1000); };
    window.addEventListener("hashchange", schedule);
    // Our own UI and Chain Watch's panel (which redraws every second) never wake a re-scan.
    const ours = (node) => node && node.closest && node.closest(".totr, [data-totr-ui], #tocw, [id^='tocw-']");
    new MutationObserver((records) => {
      if (records.every((r) => ours(r.target))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true });
    run();
  }

  if (!IS_BROWSER) {
    if (typeof module === "object" && module && module.exports) {
      module.exports = { isTradingPage, dealKey, unseenDeals, itemMarketDealFor, mergeDeals, pickMarketChecks, minutesAgo, priceLineIndex, prefs, saveSessionToken, keyTag, vsCheapest, targetsAge, parseStock, maxAffordable, tradeSignature, routeFor, parseTradeHash, parseItemLine, parseItemNode, rarityFromClasses, pendingMoneyFor, fillMoneyBlocked, parseMoney, fmtMoney, clampPct, fillTarget, driftPct, moneyGuard, compareVersions, stockSnapshotItems, snapshotDue, addFillEvent, tradeFillEvents, FILL_EVENT_CAP, netAfterFee, flipAtMarket, notSellingLine, sellModeOf, showsMarketPct, resaleFor, resaleLabel, isMaxLabel, stockSaleFee, stockPayout, stockLotNet, stockBreakeven, perkSharesFor, stockVerdict, perkWarning, sellPreview, portfolioSummary };
    }
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
