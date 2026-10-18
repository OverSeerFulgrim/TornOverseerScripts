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
3. Open [torn.com](https://www.torn.com) — the Chain Watch launcher appears.

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
- **Faction leadership** (Command access on Overseer: leader, co-leader, admin, or whitelisted
  for Leadership) gets a **LEADERSHIP** label and a **Leadership** tab — a short to-do list
  with a count on the tab:
  - **Not sent yet** — warnings prepared in the last week that were never sent. **Resume**
    reopens Torn's compose page with that template; **✕** discards it (asks first, logged in
    Command).
  - **Needs a message** — flagged members nobody has decided on yet, worst first, with their
    flags, three dots for check-in → formal → final (filled to the last one actually sent),
    and the next step. Tap a member: **Are these flags excused?** *Excused* archives their
    flags as excused; *Not excused* archives them as not excused and offers **Send <next
    step> on Torn**. Either way the member drops off until a new flag appears, and the
    decision is on their Overseer profile and in the Command log.
  - **History** — the last 7 days of messages, grouped by member (collapsed by default).

  "Open in Torn" on a flagged member in Overseer still lands on Torn's compose page, and the
  script fills in the subject and message from a one-time link only the leader who made it can
  use. On Torn's compose page an Overseer strip offers Friendly check-in / Formal / Final
  warning for any faction member, suggesting the step after the last one sent; arriving from
  the Leadership tab picks the template and fills an empty box for you. The script asks before
  replacing text already in the box, refuses if the recipient doesn't match, and never presses
  Send — it only notices when you do, to log what you sent (linked to the excused / not-excused
  decision it followed).
- **Bank tab** (every member with a connected session): request money from your faction vault —
  the same request as `/bank` on Discord and the Overseer site, with "only while I'm online" and
  your recent history. Faction **bankers** (the Discord banker role, via your linked Discord) also
  see the open requests and can **Claim** them — the Discord banker card updates — then use the
  Give link, which opens Torn's give-money page with the member and amount filled in. Leadership
  without the banker role sees the queue read-only. Overseer closes a request when Torn shows the
  payment.
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

Both are reached through the userscript manager (`GM_xmlhttpRequest`) or Torn PDA — never
through the page's own `fetch` — so torn.com's scripts never see your credentials. The
`@connect` entries in the metadata block list exactly these two hosts.

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

## License

MIT — see [LICENSE](LICENSE).
