# TornOverseerScripts

Companion userscripts for **[Torn Overseer](https://github.com/OverSeerFulgrim)** — a faction
intelligence dashboard for [Torn](https://www.torn.com).

## Torn Overseer Chain Watch (`Torn-Overseer-Chain-Watch.user.js`)

An in-game overlay that adds a Chain Watch panel to torn.com: a scheduled-chain countdown,
chain-watch shift signup, a live chain timer, and a best-effort hit leaderboard. It's the
third signup surface alongside the Overseer site and the public per-event signup link.

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

You have two ways in; pick whichever fits.

**Link mode —** open a chain-watch signup **link** that leadership posts in faction chat once.
The panel binds to that event. **Viewing** the sheet, live chain, and leaderboard needs no key.
**Signing up** authenticates with your limited Torn key (Torn PDA provides it automatically) so
your claim is recorded as a verified member of the correct faction — no account or site signup
needed. Add the key once in **Settings** and the link handles the rest.

**Session mode (managers / full schedule) —**

1. Open the Chain Watch panel → **Settings**.
2. Add a **limited-access** Torn API key (Torn → Settings → API Keys). A limited key is all the
   script needs — never use a full-access key. On Torn PDA this is provided for you.
3. Click **Connect site from Torn key** to mint an Overseer session. That's it — the session
   renews itself automatically when it expires.

The Torn key is used **only** to mint and renew that session. All data the panel shows — the
schedule, live chain, and hit leaderboard — is served by the Overseer backend, so the script
**never calls `api.torn.com`** and works without a key of its own once a session or link is set.

### Security

- Your Torn key and Overseer session are stored **only** in the userscript manager's
  per-script storage (`GM_setValue`), which torn.com's own page scripts cannot read. If a
  userscript manager isn't available, the script **refuses to store them** rather than fall
  back to page storage. A key left in page storage by an older version is migrated out on first
  run.
- The PDA-injected key is never persisted.
- Every request goes through the userscript manager (or Torn PDA) to the **Overseer backend
  only** — never to `api.torn.com`, and never through the page's own `fetch` — so your
  credentials are never exposed to the site.
- Use a **limited-access** key. The script and the Overseer backend never require a full key.

### Contributing

Single-file userscript, no build step. Keep it working at every commit (there's no test
harness — sanity-check the metadata block and `node --check` the file). Bump `@version` **and**
the `VERSION` constant together. Issues and PRs welcome.

## License

MIT — see [LICENSE](LICENSE).
