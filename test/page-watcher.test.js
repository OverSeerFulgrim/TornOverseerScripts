// Trading script 0.8.17 (WO-94 #16): the page-wide MutationObserver runs only on trading
// pages. Outside them the script exists for the deal alerts, which keep their own 2 s check.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "Torn-Overseer-Trading-Beta.user.js"), "utf8");
const { isTradingPage } = require("../Torn-Overseer-Trading-Beta.user.js");

test("the page watcher is only attached on trading pages", () => {
  const boot = src.slice(src.indexOf("function boot()"), src.indexOf("if (!IS_BROWSER)", src.indexOf("function boot()")));
  assert.match(boot, /if \(isTradingPage\(location\)\) \{\s*new MutationObserver/);
  assert.strictEqual((boot.match(/new MutationObserver/g) || []).length, 1);
});

test("isTradingPage: the pages the watcher still runs on, and ones it no longer does", () => {
  const at = (url) => new URL(url);
  assert.ok(isTradingPage(at("https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=206")));
  assert.ok(isTradingPage(at("https://www.torn.com/bazaar.php#/manage")));
  assert.ok(isTradingPage(at("https://www.torn.com/item.php")));
  assert.ok(!isTradingPage(at("https://www.torn.com/index.php")));
  assert.ok(!isTradingPage(at("https://www.torn.com/factions.php?step=your")));
  assert.ok(!isTradingPage(at("https://www.torn.com/loader.php?sid=attack&user2ID=1")));
});

test("the header no longer calls the script a draft", () => {
  assert.ok(!/DRAFT/.test(src.slice(0, 4000)));
  assert.match(src, /@version\s+0\.8\.17/);
});
