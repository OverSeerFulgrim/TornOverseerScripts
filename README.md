# TornOverseerScripts

Companion userscripts for **[Torn Overseer](https://github.com/OverSeerFulgrim)** — a faction
intelligence dashboard for [Torn](https://www.torn.com).

## Torn Overseer Chain Watch (`Torn-Overseer-Chain-Watch.user.js`)

An in-game overlay that adds a Chain Watch panel to torn.com: a live drop timer and hit count
read straight from Torn, the chain-watch shift roster with signup, coverage and handoff
warnings, opt-in watcher alarms, and a hit leaderboard. Read-only — it never attacks for you.

### Install

**Desktop (Tampermonkey / Violentmonkey):**

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge,
   Firefox, Safari) or [Violentmonkey](https://violentmonkey.github.io/).
2. Click **[install the script](https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js)**
   (the raw `.user.js`). Your manager will open its install prompt — confirm it.
3. Open [torn.com](https://www.torn.com) — a green **Overseer** bar appears in the sidebar,
   above *Information*. Click it to expand the compact view; the square-arrow button pops out
   the full panel (its **Dock** button or ✕ put it back). Where Torn shows no sidebar (Torn
   PDA, narrow windows, the attack page) the floating panel and its **TO** launcher appear
   instead.

Auto-updates are enabled (`@updateURL`/`@downloadURL` point at `main`), so your manager will
offer new versions automatically.

**Mobile (Torn PDA):**

Add the script under **Torn PDA → Settings → Userscripts**. Torn PDA injects your API key
automatically — you don't paste one.

### Setup

**A Torn API key is required.** Add a **limited-access** key (Torn → Settings → API Keys) in
the panel's **Settings**; on Torn PDA it's provided for you. Everything else happens on its
own — the panel mints its Overseer session from the key as soon as you save it.

The key does two jobs:

- It reads the **live chain, hit count, faction roster and attack log** directly from Torn, so
  the drop timer matches the game rather than lagging a server cache.
- It proves you're **in the faction**, which the chain sheet requires before it will show any
  shifts. The Overseer backend answers an unverified caller with nothing but "verify yourself".

Optionally, paste a chain-watch **signup link** (leadership posts one per event in faction
chat) under Settings to pin the panel to that specific event. Without a link, the panel shows
your faction's current chain. A link still needs your key — it selects *which* event, it isn't
a way in without one. When the linked chain is over, the panel offers a one-click switch back.

### What it shows

- **Drop timer and hit count**, taken from Torn's own on-page chain bar when it's readable and
  from the API otherwise, corrected for cache age and for any difference between your clock and
  Torn's. It says **STALE** rather than showing a frozen number as if it were live.
- **Chain warm-up** is labelled as such — below 10 hits there is no chain yet.
- **Shift roster** with signup, current/next watcher, unmanned-shift warnings, and a handoff
  check before your shift ends. Names link to Torn profiles.
- **Watcher alarms** (opt-in, off by default): sound, vibration, panel flash, desktop
  notification and spoken alerts near the drop and around your own shift. Plus focus mode, a
  screen wake lock, a rotating HIT target list and a paste-to-chat status summary.
- **Managers** additionally get assign / clear / lock, drafting a chain, and faction-wide
  watcher defaults. Those are enforced server-side, not just hidden in the UI.
- **Warnings from Overseer:** "Open in Torn" on a flagged member in Overseer lands on Torn's
  compose page, and the script fills in the subject and message from a one-time link only the
  leader who made it can use. It asks before replacing text already in the box, refuses if the
  recipient doesn't match, and never presses Send — it only notices when you do, to log what you
  sent. (v0.34.0 removed the old Leadership tab and the compose-page template picker; deciding
  on flags and picking a warning now happen on the Overseer site.)
- **Bank tab** (every member with a connected session): request money from your faction vault —
  the same request as `/bank` on Discord and the Overseer site, with "only while I'm online", an
  optional note for the bankers, and your recent history. Faction **bankers** (the Discord banker role, via your linked Discord) also
  see the open requests and can **Claim** them — the Discord banker card updates — then use the
  Give link, which opens Torn's give-money page with the member and amount filled in. Leadership
  without the banker role sees the queue read-only. Overseer closes a request when Torn shows the
  payment.
- **War tab** (v0.32.0): while your faction has a War Room open — a ranked war is announced or
  live, or a leader opened one on Overseer — a **War** tab appears next to Chain (tagged NEW until
  you open it, gone again when the war is over). It is the Overseer War Room, in the same look as
  the site on a phone:
  - **War rules** from Command (Offline targets only, Stop at X points) with progress to the stop;
  - the **score** (read from Torn with your key) or, before the war starts, a countdown;
  - **My target**: your claim with its countdown, Attack and Release, and a notice when someone
    else ends your claim or hits your target while you hold it;
  - **My status**: Ready / Away and "When can you fight?";
  - the **target board** (All / Priority): status dot, idle/hospital/flight line, FF Scouter stats if
    you added an FF Scouter key, Retal and Assist links, and Reserve / Attack with the same locks as
    the site (someone else's claim, Avoid, the war rules, the leader's per-member limit). Leaders with
    release rights (Leader, Co-leader, the War officer, or the "who can unreserve" list) also get
    **Unreserve** on other members' claims — checked live with your faction's capture key.
  - On **Torn's attack page** a strip above the fight says whose target it is: *your claim · 3:12
    left*, *Held by X — don't hit*, or *Free → Reserve 5 min*.
  - The **TO** button gets a red **!** when your claim was taken, released by someone else, or the
    stop was reached. With 🔔 alarms on, the panel also chirps 30 seconds before a target you hold
    comes out of hospital, when your claim is taken, and at the stop.
  - While the War tab is open your energy and life are shared with Command (as on the site). It
    polls Overseer every 8 seconds only while the tab is on screen; otherwise one light check a
    minute, and nothing at all between wars. Attack only ever opens Torn's attack page.
- **War Room Assist** (v0.31.0): while you are on Torn's attack page against a War Room enemy, the
  script tells Overseer who you are fighting (every 10s, and once more when you leave), so the War
  Room's List view can show "<you> is fighting them · In combat now" with an Assist button for the
  rest of the faction. It sends only the target's player ID, stops when the fight is over (or after
  Torn's 5 minutes), and never touches the fight itself. Fights against anyone who isn't the
  current War Room opponent are not recorded.
- **Unclaim** (v0.30.3): a banker who claimed a request and can't pay after all presses Unclaim
  next to the Give link — the request goes back to the queue and the Discord banker card returns
  to "Waiting for a banker". Only the banker who claimed it can, and not once it's part-paid.
- **Bank alerts on the TO button** (v0.30.2): with the panel hidden, the launcher shows an amber
  count of open requests (the same number as the Bank tab) and pulses while any of them is one
  you haven't looked at yet; a green tick means your own request was paid. Tapping a badged
  button opens straight onto the Bank tab, which clears the pulse and the tick. It's kept fresh
  by one light Overseer read a minute while the Torn tab is in front — no Torn API calls.

### How your data flows

| What | Where it comes from |
| --- | --- |
| Live chain, hit count, roster, attack log | **`api.torn.com` directly, using your key** |
| Chain schedule, shifts, signups, absences | Overseer backend (Supabase functions) |
| Fallback chain + leaderboard | Overseer backend, when your own Torn read fails |
| Who you are fighting (War Room Assist) | Sent **to** the Overseer backend from Torn's attack page: the target's ID only |
| War Room board, claims, rules (War tab) | Overseer backend (`war-room`) |
| War score, your energy / life | **`api.torn.com` directly, using your key** (`/faction/wars`, `/user/bars`); energy and life are then sent to Overseer for Command |
| Stat estimates (optional) | **`ffscouter.com`**, with your own FF Scouter key, only if you added one |

Both are reached through the userscript manager (`GM_xmlhttpRequest`) or Torn PDA — never
through the page's own `fetch` — so torn.com's scripts never see your credentials. The
`@connect` entries in the metadata block list exactly these hosts (plus `ffscouter.com`, used only with your own FF Scouter key).

**Rate limits:** Torn allows 100 requests/minute **per account**, not per key, so it's shared
with every other Torn script you run and a second key won't widen it. Chain Watch keeps its
share low: it eases off when the drop timer isn't close, and only one browser window polls at a
time — the others read that result. If you still see the rate-limit warning, close spare
torn.com windows or pause another script.

### Security

- Your Torn key and Overseer session are stored **only** in the userscript manager's
  per-script storage (`GM_setValue`), which torn.com's own page scripts cannot read. If a
  userscript manager isn't available, the script **refuses to store them** rather than fall
  back to page storage. A key left in page storage by an older version is migrated out on first
  run.
- The Overseer backend **keeps no copy of your key**. It validates the key against Torn to
  confirm who you are and which faction you're in, then returns a session; the key itself never
  leaves your device.
- The PDA-injected key is never persisted.
- Use a **limited-access** key. Neither the script nor the backend ever needs a full key.
- Non-secret data is different: the chain snapshot is shared between your own browser windows
  via `localStorage` so they don't each poll Torn. That's the same hit count and timer the page
  is already showing you — no key, session or token is ever written there.

### Contributing

Single-file userscript, no build step for the script itself.

```bash
npm install     # dev-only (jsdom, for the render tests)
npm test        # unit tests (jsdom render tests included)
npm run check   # node --check + tests
```

Tests cover the pure logic (chain parsing, freshness and clock maths, shift resolution across
both payload shapes) and the render layer (rebuild behaviour, escaping, permission gating).
Note that jsdom has no layout engine, so **CSS/layout changes still need checking in a real
browser, and on a phone** — the tests can't see them.

Bump `@version` in the metadata block. The `VERSION` constant reads from `GM_info` and falls
back to a literal, so keep that literal in step too, but the header is what actually ships.

Issues and PRs welcome.

## Torn Overseer Trading (beta) (`Torn-Overseer-Trading-Beta.user.js`)

The Overseer trading companion: prices trades from your Overseer pricelist, fills your bazaar from
your Bazaar sell list (with a "vs cheapest" check beside each Fill button), shows cheaper bazaars on
the item market, a Price check on any item, and after-fee profit on the stock market. Fills boxes
only — never presses a Torn button for you. Needs an Overseer Trading subscription.

**Deal alerts (0.8.0).** The script now loads on every Torn page, but only for alerts: the
Overseer eye joins Torn's Information icons with a green count when an item on your
[buy list](https://tornoverseer.com/trading/buy-list) is listed at or under your price, and a round
`$` button shows the same count on phones (stacked above Chain Watch's TO button). Bazaars are
checked by the Overseer server; the item market is read with your own key, a few items per
5-minute check. Without a subscription you get the eye only, opening a locked panel — nothing else
runs. On the item market, one dashed "your price" line in the seller list replaces per-row colours.

Install from [Greasy Fork](https://greasyfork.org/scripts/599500), which syncs from this file.

## License

MIT — see [LICENSE](LICENSE).
