// ==UserScript==
// @name         Torn Overseer Chain Watch
// @namespace    torn-overseer
// @version      0.3.0
// @description  Read-only scheduled chain countdown, chainwatch shift signup, live chain timer, and best-effort hit leaderboard.
// @author       OverSeerFulgrim
// @license      MIT
// @supportURL   https://github.com/OverSeerFulgrim/TornOverseerScripts/issues
// @downloadURL  https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js
// @updateURL    https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js
// @match        https://www.torn.com/*
// @match        https://torn-overseer-v2.pages.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.torn.com
// @connect      ijolgywtybadfuvyopeg.supabase.co
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  if (window.__tornOverseerChainWatchLoaded) return;
  window.__tornOverseerChainWatchLoaded = true;

  const VERSION = "0.3.0";
  const UPDATE_URL = "https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js";
  // The Overseer web app host. The script @match'es it ONLY to auto-capture the signup
  // token from a /chain/e/:token link the user opens, then hands off to the torn.com panel.
  const OVERSEER_HOST = "torn-overseer-v2.pages.dev";
  const DEFAULT_FUNCTIONS_URL = "https://ijolgywtybadfuvyopeg.supabase.co/functions/v1";
  const DEFAULT_ANON_KEY = "sb_publishable_Kz_QcUJAD6wzEdCEr6FbSg_3TO5JXek";
  const PDA_API_KEY = "###PDA-APIKEY###";
  const COMMENT = "TornOverseerChainWatch";
  const BONUS_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

  const STORE = {
    tornKey: "tocw_torn_key",
    functionsUrl: "tocw_functions_url",
    anonKey: "tocw_anon_key",
    sessionToken: "tocw_session_token",
    signupToken: "tocw_signup_token",
    claimSecret: "tocw_claim_secret",
    signupIdentity: "tocw_signup_identity",
    collapsed: "tocw_collapsed",
    position: "tocw_position",
  };

  // Secrets must live in the userscript manager's per-script GM storage ONLY — never
  // in page (torn.com) localStorage, which the site's own scripts can read. If GM
  // storage is unavailable we refuse to persist them rather than leak to the page.
  // The signup token is a capability (posted in faction chat, but still) and the claim
  // secret proves ownership of a slot, so both are GM-only too.
  const SECRET_KEYS = new Set([STORE.tornKey, STORE.sessionToken, STORE.signupToken, STORE.claimSecret]);

  function hasGmStorage() {
    return typeof GM_getValue === "function" && typeof GM_setValue === "function";
  }

  const state = {
    loading: false,
    error: null,
    notice: null,
    watch: null,
    signup: null,
    chain: null,
    attacks: null,
    fetchedAt: null,
    settingsOpen: false,
    scriptTooOld: false,
    collapsed: readBool(STORE.collapsed, false),
  };

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch {
      /* ignore */
    }
    // Secrets are NEVER read from page localStorage — a value there would be a leak,
    // not a source of truth. Non-secret UI prefs may still fall back to localStorage.
    if (SECRET_KEYS.has(key)) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  // Returns true if the value was persisted. A secret is written to GM storage only;
  // if GM storage is missing we return false (caller surfaces it) rather than writing
  // the secret to page-readable localStorage.
  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return true;
      }
    } catch {
      /* ignore */
    }
    if (SECRET_KEYS.has(key)) return false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  // One-time migration: if a previous version stashed a secret in page localStorage,
  // move it into GM storage and scrub it from the page as soon as GM storage exists.
  function migrateSecretsFromLocalStorage() {
    if (!hasGmStorage()) return;
    for (const key of SECRET_KEYS) {
      let raw;
      try {
        raw = localStorage.getItem(key);
      } catch {
        continue;
      }
      if (raw == null) continue;
      try {
        const existing = GM_getValue(key, "");
        if (!existing) GM_setValue(key, JSON.parse(raw));
        localStorage.removeItem(key);
      } catch {
        /* ignore a malformed legacy value */
      }
    }
  }

  function readString(key, fallback = "") {
    const value = gmGet(key, fallback);
    return typeof value === "string" ? value : fallback;
  }

  function readBool(key, fallback) {
    const value = gmGet(key, fallback);
    return typeof value === "boolean" ? value : fallback;
  }

  function readPosition() {
    const value = gmGet(STORE.position, null);
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function clampPosition(left, top, width = 260, height = 120) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function applyPanelPosition(box) {
    const position = readPosition();
    if (!position) return;
    const rect = box.getBoundingClientRect();
    const next = clampPosition(position.left, position.top, rect.width || 260, rect.height || 120);
    box.style.left = `${next.left}px`;
    box.style.top = `${next.top}px`;
    box.style.right = "auto";
    box.style.bottom = "auto";
  }

  function savePanelPosition(box) {
    const rect = box.getBoundingClientRect();
    const next = clampPosition(rect.left, rect.top, rect.width, rect.height);
    gmSet(STORE.position, next);
  }

  function pdaApiKey() {
    return PDA_API_KEY && !PDA_API_KEY.includes("###") ? PDA_API_KEY.trim() : "";
  }

  function settings() {
    const functionsUrl = readString(STORE.functionsUrl).trim() || DEFAULT_FUNCTIONS_URL;
    const anonKey = readString(STORE.anonKey).trim() || DEFAULT_ANON_KEY;
    return {
      tornKey: readString(STORE.tornKey).trim() || pdaApiKey(),
      functionsUrl,
      anonKey,
      sessionToken: readString(STORE.sessionToken).trim(),
      signupToken: readString(STORE.signupToken).trim(),
    };
  }

  function isOverseerSite() {
    return location.host === OVERSEER_HOST;
  }

  // Grab the capability token from a /chain/e/:token link the user opened on the
  // Overseer site and stash it in (shared) GM storage so the torn.com panel picks it
  // up. Token entry is never manual — this is the one-click bind.
  function captureSignupToken() {
    const m = location.pathname.match(/\/chain\/e\/([^/?#]+)/);
    if (!m) return null;
    let token = m[1];
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      /* keep raw */
    }
    token = String(token).trim();
    if (token && token.length <= 128) {
      gmSet(STORE.signupToken, token);
      return token;
    }
    return null;
  }

  // Pull a token out of a pasted signup LINK or a raw token (last-resort manual entry).
  function extractSignupToken(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    const m = s.match(/\/chain\/e\/([^/?#]+)/);
    let token = m ? m[1] : s;
    try {
      token = decodeURIComponent(token);
    } catch {
      /* keep raw */
    }
    return String(token).trim().slice(0, 128);
  }

  // A per-device claim secret so ONLY this device can release its own slot claims.
  function ensureClaimSecret() {
    let secret = readString(STORE.claimSecret).trim();
    if (secret.length >= 8) return secret;
    const bytes = new Uint8Array(16);
    (self.crypto || window.crypto).getRandomValues(bytes);
    secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    gmSet(STORE.claimSecret, secret);
    return secret;
  }

  function getSignupIdentity() {
    const value = gmGet(STORE.signupIdentity, null);
    return value && typeof value === "object" ? value : null;
  }

  // Which surface the panel shows: a connected session (manager/member) wins; else a
  // captured signup token drives anon token mode; else nothing to show yet.
  function panelMode() {
    const cfg = settings();
    if (cfg.sessionToken) return "session";
    if (cfg.signupToken) return "token";
    return "none";
  }

  // Returns true if the secrets (key + session) were persisted; false means GM
  // storage is unavailable and they were deliberately NOT written to the page.
  function saveSettings(next) {
    const pda = pdaApiKey();
    let tornKey = (next.tornKey || "").trim();
    // Never persist the PDA-injected key — TornPDA provides it fresh each load.
    if (pda && tornKey === pda) tornKey = "";
    const okKey = gmSet(STORE.tornKey, tornKey);
    gmSet(STORE.functionsUrl, (next.functionsUrl || DEFAULT_FUNCTIONS_URL).trim());
    gmSet(STORE.anonKey, (next.anonKey || DEFAULT_ANON_KEY).trim());
    const okSession = gmSet(STORE.sessionToken, (next.sessionToken || "").trim());
    return okKey && okSession;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Semantic-ish version compare (dot-separated integers). -1 if a<b, 0 eq, 1 a>b.
  function compareVersions(a, b) {
    const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // The min/latest_script_version handshake the backend advertises in its get
  // response: too old -> the site may reject/misbehave, so lock actions; a newer
  // latest -> a non-blocking "update available" nudge.
  function scriptVersionState() {
    const w = state.watch || {};
    const min = typeof w.min_script_version === "string" ? w.min_script_version : null;
    const latest = typeof w.latest_script_version === "string" ? w.latest_script_version : null;
    return {
      tooOld: min ? compareVersions(VERSION, min) < 0 : false,
      updateAvailable: latest ? compareVersions(VERSION, latest) < 0 : false,
      latest,
    };
  }

  function httpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function parseHttpJson(status, responseText, url) {
    let parsed = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      throw httpError(`Non-JSON response from ${url}`, status);
    }
    if (status < 200 || status >= 300) {
      const msg =
        parsed && typeof parsed === "object" && typeof parsed.error === "string"
          ? parsed.error
          : `Request failed (${status})`;
      throw httpError(msg, status);
    }
    return parsed;
  }

  async function requestJsonWithTornPda(url, options = {}) {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const data = options.body == null ? undefined : JSON.stringify(options.body);
    const post = window.PDA_httpPost;
    const get = window.PDA_httpGet;
    const res = method === "POST"
      ? await post(url, headers, data || "")
      : await get(url, headers);
    const status = Number(res?.status ?? res?.statusCode ?? 200);
    const responseText = String(res?.responseText ?? res?.body ?? res ?? "");
    return parseHttpJson(status, responseText, url);
  }

  function requestJson(url, options = {}) {
    if (
      typeof window.PDA_httpGet === "function" &&
      ((options.method || "GET") === "GET" || typeof window.PDA_httpPost === "function")
    ) {
      return requestJsonWithTornPda(url, options);
    }
    // No page-context fetch fallback: every API/session call must go through the
    // userscript manager (GM_xmlhttpRequest) or Torn PDA, so the Torn key and session
    // token are never exposed to torn.com's own page scripts.
    if (typeof GM_xmlhttpRequest !== "function") {
      return Promise.reject(
        new Error("This script needs Tampermonkey (or Torn PDA) — the browser's own fetch is never used for API or session calls, to keep your Torn key and session private."),
      );
    }

    const method = options.method || "GET";
    const headers = options.headers || {};
    const data = options.body == null ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        timeout: options.timeout || 25000,
        onload: (res) => {
          try {
            resolve(parseHttpJson(res.status, res.responseText, url));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error(`Network error calling ${url}`)),
        ontimeout: () => reject(new Error(`Timed out calling ${url}`)),
      });
    });
  }

  async function tornFetch(path, params = {}) {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add a Torn API key in Settings.");
    const url = new URL(`https://api.torn.com/v2${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
    url.searchParams.set("key", cfg.tornKey);
    url.searchParams.set("comment", COMMENT);
    const data = await requestJson(url.toString());
    if (data && typeof data === "object" && data.error) {
      const err = data.error;
      throw new Error(err.error || `Torn API error ${err.code || ""}`.trim());
    }
    return data;
  }

  async function tornLegacyFaction(selections) {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add a Torn API key in Settings.");
    const url = new URL("https://api.torn.com/faction/");
    url.searchParams.set("selections", selections);
    url.searchParams.set("key", cfg.tornKey);
    return requestJson(url.toString());
  }

  async function callFunction(slug, body = {}, opts = {}) {
    const cfg = settings();
    if (!cfg.functionsUrl || !cfg.anonKey || !cfg.sessionToken) {
      throw new Error("Connect the site session in Settings.");
    }
    try {
      return await requestJson(`${cfg.functionsUrl.replace(/\/+$/, "")}/${slug}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          "X-Session-Token": cfg.sessionToken,
        },
        body,
      });
    } catch (error) {
      // Session expired or was invalidated → transparently re-mint it from the stored
      // Torn key once (sliding renewal), then retry. Needs a Torn key to reconnect.
      if (error && error.status === 401 && !opts.retried && cfg.tornKey) {
        await connectSiteFromTornKey();
        return callFunction(slug, body, { retried: true });
      }
      throw error;
    }
  }

  // Public chain-signup capability API — header-less (Content-Type only), token in the
  // body, NO session or Torn key. This is the anon token-mode path.
  async function callSignup(action, extra = {}) {
    const cfg = settings();
    const token = cfg.signupToken;
    if (!token) throw new Error("No signup link captured yet.");
    const base = (cfg.functionsUrl || DEFAULT_FUNCTIONS_URL).replace(/\/+$/, "");
    return requestJson(`${base}/chain-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { action, token, ...extra },
    });
  }

  async function connectSiteFromTornKey() {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add your Torn API key first.");
    if (!cfg.functionsUrl || !cfg.anonKey) throw new Error("The script backend is not configured.");
    const res = await requestJson(`${cfg.functionsUrl.replace(/\/+$/, "")}/connect-torn-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
      },
      body: { apiKey: cfg.tornKey },
    });
    if (!res || typeof res.sessionToken !== "string") {
      throw new Error("The site did not return a session token.");
    }
    gmSet(STORE.sessionToken, res.sessionToken);
    return res.sessionToken;
  }

  function parseChain(raw) {
    const c = raw?.chain || raw || {};
    const current = num(c.current) ?? 0;
    const timeout = num(c.timeout) ?? 0;
    return {
      active: current > 0 && timeout > 0,
      current,
      max: num(c.maximum ?? c.max) ?? 0,
      timeout,
      modifier: num(c.modifier) ?? 0,
      cooldown: num(c.cooldown) ?? 0,
      fetchedAt: Date.now(),
    };
  }

  // Convert the server-served live_chain block (token mode) into the same shape
  // parseChain produces, anchoring the countdown to when the SERVER cached it so the
  // client timer stays honest without a Torn key.
  function signupLiveChain(res) {
    const lc = res && res.live_chain && res.live_chain.chain;
    if (!lc || typeof lc !== "object") return null;
    const current = num(lc.current) ?? 0;
    const timeout = num(lc.timeout) ?? 0;
    const cachedAt = res.live_chain.fetched_at ? new Date(res.live_chain.fetched_at).getTime() : NaN;
    return {
      active: current > 0 && timeout > 0,
      current,
      max: num(lc.max) ?? 0,
      timeout,
      modifier: num(lc.modifier) ?? 0,
      cooldown: num(lc.cooldown) ?? 0,
      fetchedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now(),
    };
  }

  function asRows(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return [];
  }

  function parseAttacks(raw) {
    const rows = asRows(raw?.attacks ?? raw);
    const byId = new Map();
    let last = null;
    for (const row of rows) {
      const attacker = row?.attacker && typeof row.attacker === "object" ? row.attacker : {};
      const defender = row?.defender && typeof row.defender === "object" ? row.defender : {};
      const attackerId = num(row?.attacker_id ?? row?.attackerID ?? row?.user_id ?? attacker.id);
      if (!attackerId || attackerId <= 0) continue;
      const attackerName = row?.attacker_name || attacker.name || `ID ${attackerId}`;
      const defenderName = row?.defender_name || defender.name || row?.target_name || "target";
      const timestamp =
        num(row?.timestamp_ended ?? row?.ended ?? row?.end ?? row?.timestamp_started ?? row?.started ?? row?.timestamp) ?? 0;
      const respect =
        num(row?.respect_gain ?? row?.respect ?? row?.respectGain ?? row?.respect_total ?? row?.respectTotal) ?? 0;
      const prior = byId.get(attackerId) || {
        playerId: attackerId,
        name: attackerName,
        hits: 0,
        respect: 0,
      };
      prior.hits += 1;
      prior.respect += respect;
      byId.set(attackerId, prior);
      if (timestamp > 0 && (!last || timestamp > last.timestamp)) {
        last = { attackerName, defenderName, timestamp };
      }
    }
    const leaderboard = [...byId.values()]
      .map((row) => ({ ...row, avg: row.hits > 0 ? row.respect / row.hits : 0 }))
      .sort((a, b) => b.hits - a.hits || b.respect - a.respect)
      .slice(0, 8);
    return { leaderboard, last, error: null };
  }

  async function refreshAll(manual = false) {
    state.loading = true;
    state.error = null;
    if (manual) state.notice = null;
    render();
    try {
      const cfg = settings();
      const mode = panelMode();
      // Clear the inactive surface so a mode switch never renders stale data.
      if (mode === "token") state.watch = null;
      else state.signup = null;
      const tasks = [];
      if (cfg.tornKey) {
        tasks.push(
          tornFetch("/faction/chain")
            .then((raw) => {
              state.chain = parseChain(raw);
              state.fetchedAt = Date.now();
            })
            .catch((e) => {
              state.chain = null;
              state.error = e.message || "Could not load Torn chain.";
            }),
        );
        tasks.push(
          tornLegacyFaction("attacks")
            .then((raw) => {
              state.attacks = parseAttacks(raw);
            })
            .catch((e) => {
              state.attacks = { leaderboard: [], last: null, error: e.message || "Attack log unavailable." };
            }),
        );
      }
      if (mode === "session") {
        tasks.push(
          callFunction("chain-watch", { action: "get" })
            .then((res) => {
              state.watch = res;
            })
            .catch((e) => {
              state.watch = null;
              state.error = e.message || "Could not load Chain Watch schedule.";
            }),
        );
      }
      if (mode === "token") {
        tasks.push(
          callSignup("get")
            .then((res) => {
              state.signup = res;
              // No Torn key → drive the chain HUD from the server live-chain block.
              if (!cfg.tornKey) {
                state.chain = signupLiveChain(res);
                state.fetchedAt = Date.now();
              }
            })
            .catch((e) => {
              state.signup = null;
              state.error = e.message || "Could not load the signup sheet.";
            }),
        );
      }
      if (tasks.length === 0) {
        state.notice = null;
      } else {
        await Promise.all(tasks);
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  function chainRemaining() {
    if (!state.chain?.active) return 0;
    return Math.max(0, state.chain.timeout - Math.floor((Date.now() - state.chain.fetchedAt) / 1000));
  }

  function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function countdownTo(iso) {
    if (!iso) return null;
    return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  }

  function tctTime(iso, withDate = false) {
    if (!iso) return "--";
    const d = new Date(iso);
    const opts = withDate
      ? { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
      : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" };
    return `${d.toLocaleString("en-US", opts)} TCT`;
  }

  function nextBonus(current) {
    const target = BONUS_MILESTONES.find((n) => n > current);
    if (!target) return null;
    return { target, toGo: target - current };
  }

  function localTime(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "--";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function shiftLabel(shift) {
    const tct = `${tctTime(shift.shift_start)}-${tctTime(shift.shift_end).replace(" TCT", "")}`;
    const local = `${localTime(shift.shift_start)}-${localTime(shift.shift_end)}`;
    return `${tct} <span class="tocw-muted">· ${local} your time</span>`;
  }

  function statusClass(status) {
    if (status === "Online") return "ok";
    if (status === "Idle") return "warn";
    return "bad";
  }

  function currentAndNextShift() {
    const shifts = state.watch?.shifts || [];
    const now = Date.now();
    const current = shifts.find((s) => new Date(s.shift_start).getTime() <= now && new Date(s.shift_end).getTime() > now) || null;
    const next = shifts.find((s) => new Date(s.shift_start).getTime() > now) || null;
    return { current, next };
  }

  function createShell() {
    if (!document.getElementById("tocw-style")) {
      const style = document.createElement("style");
      style.id = "tocw-style";
      style.textContent = `
      #tocw {
        position: fixed;
        left: 82px;
        bottom: 124px;
        width: 390px;
        max-height: min(680px, calc(100vh - 148px));
        overflow: auto;
        z-index: 2147483646;
        background: #101923;
        color: #eaf3ff;
        border: 1px solid #38495e;
        border-radius: 10px;
        box-shadow: 0 14px 34px rgba(0,0,0,.42);
        font-family: Arial, sans-serif;
        font-size: 13px;
        pointer-events: auto;
      }
      #tocw * { box-sizing: border-box; }
      #tocw button, #tocw-modal button {
        cursor: pointer;
        border: 1px solid #34465d;
        border-radius: 7px;
        background: #182335;
        color: #f7fbff;
        font-weight: 700;
        padding: 7px 9px;
      }
      #tocw button.primary, #tocw-modal button.primary { background: #ff3b45; border-color: #ff3b45; }
      #tocw button.small { padding: 4px 7px; font-size: 11px; }
      #tocw button:disabled { opacity: .55; cursor: wait; }
      .tocw-head { padding: 14px 14px 10px; border-bottom: 1px solid #25384d; cursor: move; touch-action: none; user-select: none; }
      .tocw-head button { cursor: pointer; }
      .tocw-title { font-size: 19px; font-weight: 800; margin: 0 0 5px; }
      .tocw-muted { color: #9eb4ce; font-size: 12px; line-height: 1.35; }
      .tocw-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
      .tocw-pill { display: inline-flex; align-items: center; min-height: 21px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; background: #1d344f; color: #d9ebff; }
      .tocw-pill.ok { background: #103d2b; color: #d6ffe8; }
      .tocw-pill.warn { background: #67420c; color: #ffe1a7; }
      .tocw-pill.bad { background: #651922; color: #ffc6cc; }
      .tocw-body { padding: 12px 14px 14px; display: grid; gap: 10px; }
      .tocw-card { background: #0d141d; border: 1px solid #2b3d52; border-radius: 8px; padding: 10px; }
      .tocw-card-title { font-weight: 800; margin-bottom: 6px; }
      .tocw-big { font-size: 32px; font-weight: 900; letter-spacing: 0; line-height: 1; }
      .tocw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .tocw-row { display: grid; grid-template-columns: 92px 1fr auto; gap: 8px; align-items: center; padding: 7px 0; border-top: 1px solid #25384d; }
      .tocw-row:first-child { border-top: 0; }
      .tocw-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 5px; background: #789; }
      .tocw-dot.ok { background: #32d47b; }
      .tocw-dot.warn { background: #f2b13c; }
      .tocw-dot.bad { background: #ff5d67; }
      .tocw-alert { padding: 8px 9px; border-radius: 7px; background: #21180b; border: 1px solid #67420c; color: #ffdca1; }
      .tocw-alert.bad { background: #231016; border-color: #651922; color: #ffc6cc; }
      .tocw-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
      .tocw-progress { height: 8px; background: #0a1018; border-radius: 999px; overflow: hidden; border: 1px solid #28394d; margin-top: 6px; }
      .tocw-progress span { display: block; height: 100%; background: #35b76f; }
      .tocw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .tocw-table th, .tocw-table td { text-align: right; padding: 5px 4px; border-top: 1px solid #25384d; }
      .tocw-table th:first-child, .tocw-table td:first-child { text-align: left; }
      #tocw.collapsed { width: 210px; max-height: none; overflow: visible; }
      #tocw.collapsed .tocw-head { padding: 10px; border-bottom: 0; }
      #tocw.collapsed .tocw-pills { margin-bottom: 6px; }
      #tocw.collapsed .tocw-pills .tocw-pill:nth-child(n+2) { display: none; }
      #tocw.collapsed .tocw-title { font-size: 16px; margin-bottom: 2px; }
      #tocw.collapsed .tocw-muted { max-width: 126px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #tocw.collapsed #tocw-collapse { padding: 5px 8px; font-size: 12px; }
      #tocw.collapsed .tocw-body { display: none; }
      #tocw-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        background: rgba(0,0,0,.55);
      }
      #tocw-modal {
        position: fixed;
        top: 70px;
        left: 50%;
        transform: translateX(-50%);
        width: min(660px, calc(100vw - 24px));
        max-height: calc(100vh - 100px);
        overflow: auto;
        z-index: 1000001;
        background: #101923;
        color: #eaf3ff;
        border: 1px solid #33465e;
        border-radius: 10px;
        box-shadow: 0 14px 34px rgba(0,0,0,.42);
        font-family: Arial, sans-serif;
        padding: 16px;
      }
      #tocw-modal label { display: grid; gap: 5px; margin-bottom: 10px; color: #cfe0f7; font-size: 12px; font-weight: 700; }
      #tocw-modal input {
        width: 100%;
        padding: 9px 10px;
        border-radius: 7px;
        border: 1px solid #33465e;
        background: #0b1119;
        color: #f8fbff;
      }
      #tocw-modal .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #tocw-modal .tocw-modal-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 14px; }
      @media (max-width: 760px) {
        #tocw { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 68vh; }
        #tocw-modal .grid { grid-template-columns: 1fr; }
      }
    `;
      document.head.appendChild(style);
    }

    if (!document.getElementById("tocw")) {
      const box = document.createElement("div");
      box.id = "tocw";
      document.body.appendChild(box);
      applyPanelPosition(box);
    }
  }

  function bindDrag(box) {
    const handle = document.getElementById("tocw-drag-handle");
    if (!handle || handle.dataset.bound === "1") return;
    handle.dataset.bound = "1";
    handle.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target?.closest?.("button, input, textarea, select, a, summary")) return;
      const rect = box.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.right = "auto";
      box.style.bottom = "auto";
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();

      const move = (moveEvent) => {
        const next = clampPosition(
          moveEvent.clientX - offsetX,
          moveEvent.clientY - offsetY,
          box.offsetWidth,
          box.offsetHeight,
        );
        box.style.left = `${next.left}px`;
        box.style.top = `${next.top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        savePanelPosition(box);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
  }

  function render() {
    createShell();
    const box = document.getElementById("tocw");
    if (!box) return;
    box.classList.toggle("collapsed", state.collapsed);

    const cfg = settings();
    const event = state.watch?.event || state.signup?.event || null;
    const mode = panelMode();
    const chain = state.chain;
    const live = Boolean(chain?.active);
    const currentHits = chain?.current || 0;
    const remaining = chainRemaining();
    const bonus = nextBonus(currentHits);
    const previousBonus = BONUS_MILESTONES.filter((n) => n <= currentHits).pop() || 0;
    const bonusPct = bonus
      ? Math.max(0, Math.min(100, Math.round(((currentHits - previousBonus) / (bonus.target - previousBonus)) * 100)))
      : 0;
    const scheduledSeconds = event ? countdownTo(event.starts_at) : null;
    const { current, next } = currentAndNextShift();

    const vstat = scriptVersionState();
    state.scriptTooOld = vstat.tooOld;
    const versionAlert = vstat.tooOld
      ? `<div class="tocw-alert bad">Chain Watch v${VERSION} is out of date${vstat.latest ? ` (this faction needs v${escapeHtml(vstat.latest)}+)` : ""}. <a href="${UPDATE_URL}" target="_blank" rel="noreferrer noopener">Update the script</a> — actions are disabled until you do.</div>`
      : vstat.updateAvailable
        ? `<div class="tocw-alert">Chain Watch v${escapeHtml(vstat.latest)} is available (you have v${VERSION}). <a href="${UPDATE_URL}" target="_blank" rel="noreferrer noopener">Update</a>.</div>`
        : "";

    box.innerHTML = `
      <div class="tocw-head" id="tocw-drag-handle" title="Drag to move Chain Watch">
        <div class="tocw-pills">
          <span class="tocw-pill ${live ? "ok" : "warn"}">${live ? "LIVE" : "SCHEDULED"}</span>
          <span class="tocw-pill">SITE SYNC</span>
          <span class="tocw-pill">READ-ONLY</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
          <div>
            <div class="tocw-title">Chain Watch</div>
            <div class="tocw-muted">v${VERSION} - ${event ? escapeHtml(event.title) : "No chain scheduled"}</div>
          </div>
          <button id="tocw-collapse">${state.collapsed ? "Open" : "Hide"}</button>
        </div>
      </div>
      <div class="tocw-body">
        ${state.error ? `<div class="tocw-alert bad">${escapeHtml(state.error)}</div>` : ""}
        ${state.notice ? `<div class="tocw-alert">${escapeHtml(state.notice)}</div>` : ""}
        ${versionAlert}
        ${mode === "token"
          ? `<div class="tocw-alert">Signed in via link${event ? ` — ${escapeHtml(event.title)}` : ""}. No Torn key or session needed.</div>`
          : mode === "none"
            ? `<div class="tocw-alert">Open a chain-watch signup link, or add your Torn API key and connect the site session in Settings.</div>`
            : !cfg.sessionToken
              ? `<div class="tocw-alert">Connect the site session in Settings to load the schedule.</div>`
              : ""}
        ${live ? renderLive(chain, remaining, bonus, bonusPct, current, next) : renderScheduled(event, scheduledSeconds)}
        ${renderShifts()}
        <div class="tocw-actions">
          <button id="tocw-refresh" class="primary" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading" : "Refresh"}</button>
          <button id="tocw-copy">Copy</button>
          <button id="tocw-settings">Settings</button>
        </div>
        <div class="tocw-muted" style="text-align:center;">No auto attacks</div>
      </div>
    `;

    document.getElementById("tocw-collapse")?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      gmSet(STORE.collapsed, state.collapsed);
      render();
    });
    document.getElementById("tocw-refresh")?.addEventListener("click", () => void refreshAll(true));
    document.getElementById("tocw-copy")?.addEventListener("click", () => void copySummary());
    document.getElementById("tocw-settings")?.addEventListener("click", () => {
      state.settingsOpen = true;
      renderSettings();
    });
    for (const btn of box.querySelectorAll("[data-tocw-action]")) {
      btn.addEventListener("click", () => void handleAction(btn));
    }
    bindDrag(box);
    if (state.settingsOpen) {
      if (!document.getElementById("tocw-modal")) renderSettings();
    } else {
      closeSettings();
    }
  }

  function renderScheduled(event, seconds) {
    const canManage = Boolean(state.watch?.viewer?.can_manage);
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">${event ? "Next scheduled chain" : "No scheduled chain"}</div>
        <div class="tocw-big">${event ? `Starts in ${duration(seconds)}` : "--"}</div>
        <div class="tocw-muted">${event ? `${escapeHtml(event.title)} - ${tctTime(event.starts_at, true)}` : "Ask a chain-watch manager to schedule one."}</div>
        ${event && event.status === "draft" && canManage
          ? `<div class="tocw-muted" style="margin-top:6px;">Draft — <a href="https://${OVERSEER_HOST}/faction/chains" target="_blank" rel="noreferrer noopener">publish it &amp; mint the signup link on the site ↗</a></div>`
          : ""}
        ${canManage ? `<button class="small" data-tocw-action="schedule" style="margin-top:8px;">Schedule chain (draft)</button>` : ""}
      </div>
    `;
  }

  function renderLive(chain, remaining, bonus, bonusPct, current, next) {
    const attacks = state.attacks || { leaderboard: [], last: null, error: null };
    const currentOffline = current?.watcher_id && current.watcher_online_status !== "Online";
    const nextIdle = next?.watcher_id && next.watcher_online_status !== "Online";
    return `
      <div class="tocw-card">
        <div class="tocw-grid">
          <div>
            <div class="tocw-muted">Drop timer</div>
            <div class="tocw-big">${duration(remaining)}</div>
          </div>
          <div>
            <div class="tocw-muted">Hits</div>
            <div class="tocw-big">${chain.current}</div>
          </div>
        </div>
        ${bonus ? `<div class="tocw-muted" style="margin-top:8px;">Next bonus: ${bonus.toGo} to ${bonus.target}</div><div class="tocw-progress"><span style="width:${bonusPct}%"></span></div>` : ""}
      </div>
      <div class="tocw-card">
        <div class="tocw-card-title">Current watcher</div>
        ${renderWatcherLine(current, "No watcher assigned")}
        <div class="tocw-muted">${current ? `Shift ends ${tctTime(current.shift_end)}` : ""}</div>
      </div>
      <div class="tocw-card">
        <div class="tocw-card-title">Next watcher</div>
        ${renderWatcherLine(next, "No next watcher")}
        <div class="tocw-muted">${next ? `Starts ${tctTime(next.shift_start)}` : ""}</div>
      </div>
      ${currentOffline ? `<div class="tocw-alert bad">Current watcher is not online.</div>` : ""}
      ${nextIdle ? `<div class="tocw-alert">Next watcher is ${escapeHtml(next.watcher_online_status || "not online")}.</div>` : ""}
      <div class="tocw-card">
        <div class="tocw-card-title">Last attack</div>
        ${attacks.last ? `<div>${escapeHtml(attacks.last.attackerName)} vs ${escapeHtml(attacks.last.defenderName)} - ${duration(Math.floor(Date.now() / 1000 - attacks.last.timestamp))} ago</div>` : `<div class="tocw-muted">${escapeHtml(attacks.error || "Attack log unavailable.")}</div>`}
      </div>
      ${renderLeaderboard(attacks)}
    `;
  }

  function renderWatcherLine(shift, fallback) {
    if (!shift?.watcher_id) return `<div class="tocw-muted">${escapeHtml(fallback)}</div>`;
    const tone = statusClass(shift.watcher_online_status);
    return `<div><span class="tocw-dot ${tone}"></span><strong>${escapeHtml(shift.watcher_name || `ID ${shift.watcher_id}`)}</strong> <span class="tocw-muted">${escapeHtml(shift.watcher_online_status || "Unknown")}</span></div>`;
  }

  function renderLeaderboard(attacks) {
    const rows = attacks?.leaderboard || [];
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Leaderboard</div>
        ${rows.length ? `
          <table class="tocw-table">
            <thead><tr><th>Member</th><th>Hits</th><th>Total respect</th><th>Avg</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.hits}</td><td>${r.respect.toFixed(1)}</td><td>${r.avg.toFixed(2)}</td></tr>`).join("")}
            </tbody>
          </table>
        ` : `<div class="tocw-muted">${escapeHtml(attacks?.error || "No leaderboard data yet.")}</div>`}
      </div>
    `;
  }

  function renderShifts() {
    if (panelMode() === "token") return renderSignupShifts();
    const shifts = state.watch?.shifts || [];
    const viewer = state.watch?.viewer || {};
    if (!state.watch?.event) return "";
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Chainwatch shifts</div>
        ${shifts.map((shift) => renderShiftRow(shift, viewer)).join("")}
      </div>
    `;
  }

  function renderShiftRow(shift, viewer) {
    return `
      <div class="tocw-row">
        <div class="tocw-muted">${shiftLabel(shift)}</div>
        ${renderSlot(shift, "main", viewer)}
        ${renderSlot(shift, "backup", viewer)}
      </div>
    `;
  }

  // One watcher slot (main or backup) with its own claim/leave/assign/lock actions.
  // Locked slots are read-only for members (backend enforces too); a manager sees an
  // Unlock button. Every action button carries data-role so handleAction targets the
  // right slot.
  function renderSlot(shift, role, viewer) {
    const isBackup = role === "backup";
    const watcherId = isBackup ? shift.backup_watcher_id : shift.watcher_id;
    const watcherName = isBackup ? shift.backup_watcher_name : shift.watcher_name;
    const onlineStatus = isBackup ? shift.backup_watcher_online_status : shift.watcher_online_status;
    const locked = Boolean(isBackup ? shift.backup_locked : shift.locked);
    const assigned = watcherId != null;
    const own = assigned && Number(watcherId) === Number(viewer.player_id);
    const canManage = Boolean(viewer.can_manage);
    const roleLabel = isBackup ? "Backup" : "Main";
    const btn = (act, label) => `<button class="small" data-tocw-action="${act}" data-shift="${shift.id}" data-role="${role}">${label}</button>`;

    const actions = [];
    if (locked) {
      if (canManage) actions.push(btn("unlock", "Unlock"));
    } else if (assigned) {
      if (canManage) actions.push(btn("assign", "Change"));
      if (canManage || own) actions.push(btn("clear", own && !canManage ? "Leave" : "Clear"));
      if (canManage) actions.push(btn("lock", "Lock"));
    } else {
      actions.push(canManage ? btn("assign", "Assign") : btn("signup", "Sign up"));
      if (canManage) actions.push(btn("lock", "Lock"));
    }

    const who = assigned
      ? `<span class="tocw-dot ${statusClass(onlineStatus)}"></span>${escapeHtml(watcherName || `ID ${watcherId}`)} <span class="tocw-muted">${escapeHtml(onlineStatus || "")}</span>`
      : locked
        ? `<span class="tocw-muted">Locked</span>`
        : `<span class="tocw-muted">Open</span>`;

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;">
        <span class="tocw-muted" style="min-width:52px;">${roleLabel}</span>
        <span style="flex:1;">${locked ? "🔒 " : ""}${who}</span>
        <span style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${actions.join("")}</span>
      </div>
    `;
  }

  // --- Token mode (anon signup via link) --------------------------------------

  function renderSignupShifts() {
    const signup = state.signup;
    if (!signup || !signup.event) return "";
    const shifts = signup.shifts || [];
    const identity = getSignupIdentity();
    const canClaim = Boolean(signup.can_claim);
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Chainwatch shifts</div>
        ${identity && identity.name ? `<div class="tocw-muted">Signing up as ${escapeHtml(identity.name)}${identity.id == null ? " (unverified)" : ""}</div>` : ""}
        ${shifts.map((shift) => `
          <div class="tocw-row">
            <div class="tocw-muted">${shiftLabel(shift)}</div>
            ${renderSignupSlot(shift, "main", canClaim, identity)}
            ${renderSignupSlot(shift, "backup", canClaim, identity)}
          </div>
        `).join("")}
        ${!canClaim ? `<div class="tocw-muted">Signups are closed for this chain.</div>` : ""}
      </div>
    `;
  }

  function renderSignupSlot(shift, role, canClaim, identity) {
    const slot = (role === "backup" ? shift.backup : shift.main) || {};
    const roleLabel = role === "backup" ? "Backup" : "Main";
    const filled = Boolean(slot.filled);
    const locked = Boolean(slot.locked);
    const mine = filled && identity && identity.id != null && Number(slot.watcher_id) === Number(identity.id);
    const btn = (act, label) => `<button class="small" data-tocw-action="${act}" data-shift="${shift.id}" data-role="${role}">${label}</button>`;

    const actions = [];
    if (!locked && canClaim) {
      if (!filled) actions.push(btn("signup", "Sign up"));
      else if (mine) actions.push(btn("release", "Leave"));
    }

    const who = filled
      ? `<span class="tocw-dot ${statusClass(slot.online_status)}"></span>${escapeHtml(slot.watcher_name || `ID ${slot.watcher_id}`)}${slot.verified ? "" : ` <span class="tocw-muted">(unverified)</span>`}`
      : locked
        ? `<span class="tocw-muted">Locked</span>`
        : `<span class="tocw-muted">Open</span>`;

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;">
        <span class="tocw-muted" style="min-width:52px;">${roleLabel}</span>
        <span style="flex:1;">${locked ? "🔒 " : ""}${who}</span>
        <span style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${actions.join("")}</span>
      </div>
    `;
  }

  // Pick (once) who this device is signing up as, from the event roster. A roster
  // match is a VERIFIED claim (player_id); anything else is an unverified free-name
  // claim. Remembered in GM storage so later claims/releases reuse it.
  function resolveSignupIdentity() {
    const existing = getSignupIdentity();
    if (existing && existing.name) return existing;
    const roster = state.signup?.roster || [];
    const input = prompt("Sign up as — type your Torn name exactly as it appears on the faction roster:");
    if (input == null) return null;
    const name = input.trim();
    if (!name) return null;
    const match = roster.find((m) => String(m.name).toLowerCase() === name.toLowerCase());
    const identity = match ? { id: match.id, name: match.name } : { id: null, name: name.slice(0, 40) };
    gmSet(STORE.signupIdentity, identity);
    return identity;
  }

  async function handleSignupAction(btn) {
    const action = btn.getAttribute("data-tocw-action");
    const shiftId = Number(btn.getAttribute("data-shift"));
    const role = btn.getAttribute("data-role") === "backup" ? "backup" : "main";
    try {
      if (action === "signup") {
        const identity = resolveSignupIdentity();
        if (!identity) return;
        const extra = { shift_id: shiftId, role, claim_secret: ensureClaimSecret() };
        if (identity.id != null) extra.player_id = identity.id;
        else extra.free_name = identity.name;
        state.signup = await callSignup("claim", extra);
        state.notice = role === "backup" ? "Backup slot claimed." : "Shift claimed.";
      } else if (action === "release") {
        state.signup = await callSignup("release", { shift_id: shiftId, role, claim_secret: ensureClaimSecret() });
        state.notice = "Slot released.";
      }
      render();
    } catch (e) {
      state.error = e.message || "Action failed.";
      render();
    }
  }

  async function handleAction(btn) {
    // Token mode uses the public chain-signup endpoints, not the session chain-watch.
    if (panelMode() === "token") return handleSignupAction(btn);
    const action = btn.getAttribute("data-tocw-action");
    const shiftId = Number(btn.getAttribute("data-shift"));
    const role = btn.getAttribute("data-role") === "backup" ? "backup" : "main";
    // Locked out until the script is updated — the backend advertised a higher
    // min_script_version, so mutations may be rejected or behave unexpectedly.
    if (state.scriptTooOld) {
      state.error = "Update the Chain Watch script to continue — it's too old for the current site.";
      state.notice = null;
      render();
      return;
    }
    try {
      if (action === "signup") {
        state.watch = await callFunction("chain-watch", { action: "signup", shift_id: shiftId, role });
        state.notice = role === "backup" ? "Backup slot claimed." : "Shift claimed.";
      } else if (action === "assign") {
        const watcherId = promptWatcherId();
        if (!watcherId) return;
        state.watch = await callFunction("chain-watch", { action: "assign", shift_id: shiftId, watcher_id: watcherId, role });
        state.notice = "Slot assigned.";
      } else if (action === "clear") {
        if (!confirm("Clear this chainwatch slot?")) return;
        state.watch = await callFunction("chain-watch", { action: "clear", shift_id: shiftId, role });
        state.notice = "Slot cleared.";
      } else if (action === "lock" || action === "unlock") {
        state.watch = await callFunction("chain-watch", {
          action: action === "lock" ? "lock_slot" : "unlock_slot",
          shift_id: shiftId,
          role,
        });
        state.notice = action === "lock" ? "Slot locked." : "Slot unlocked.";
      } else if (action === "schedule") {
        const scheduled = promptSchedule();
        if (!scheduled) return;
        // Create a DRAFT — publishing (and minting the public signup link) stays on the
        // site, so the script never creates a half-configured live event.
        state.watch = await callFunction("chain-watch", { action: "save_event", ...scheduled, draft: true });
        state.notice = "Draft chain created — publish it on the Overseer site to open signups and mint the link.";
      }
      render();
    } catch (e) {
      state.error = e.message || "Action failed.";
      render();
    }
  }

  function promptWatcherId() {
    const roster = state.watch?.roster || [];
    const value = prompt("Assign watcher by player ID or exact name:");
    if (value == null) return null;
    const clean = value.trim();
    if (!clean) return null;
    const numeric = Number(clean);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    const found = roster.find((m) => String(m.name).toLowerCase() === clean.toLowerCase());
    if (found) return Number(found.id);
    alert("No current faction member found by that exact name. Try their player ID.");
    return null;
  }

  function promptSchedule() {
    const title = prompt("Chain title:", "Chain Night");
    if (title == null || !title.trim()) return null;
    const start = prompt("Start time in TCT/UTC (YYYY-MM-DD HH:mm):");
    if (start == null || !start.trim()) return null;
    const durationRaw = prompt("Duration in hours:", "6");
    if (durationRaw == null) return null;
    const durationHours = Number(durationRaw);
    const iso = parseTctInput(start);
    if (!iso || !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24) {
      alert("Invalid start time or duration.");
      return null;
    }
    return { title: title.trim(), starts_at: iso, duration_hours: durationHours };
  }

  function parseTctInput(value) {
    const clean = value.trim().replace(" ", "T");
    const iso = /z$/i.test(clean) || /[+-]\d\d:?\d\d$/.test(clean) ? clean : `${clean}:00Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  async function copySummary() {
    const event = state.watch?.event || state.signup?.event;
    const chain = state.chain;
    const { current, next } = currentAndNextShift();
    const lines = [
      "Chain Watch",
      event ? `${event.title}: ${tctTime(event.starts_at, true)}` : "No chain scheduled",
      chain?.active ? `Live: ${chain.current} hits, ${duration(chainRemaining())} drop timer` : "Live: no active chain",
      current?.watcher_id ? `Current watcher: ${current.watcher_name} (${current.watcher_online_status})` : "Current watcher: none",
      next?.watcher_id ? `Next watcher: ${next.watcher_name} (${next.watcher_online_status})` : "Next watcher: none",
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      state.notice = "Summary copied.";
    } catch {
      state.notice = text;
    }
    render();
  }

  function closeSettings() {
    document.getElementById("tocw-backdrop")?.remove();
    document.getElementById("tocw-modal")?.remove();
  }

  function renderSettings() {
    closeSettings();
    const cfg = settings();
    const backdrop = document.createElement("div");
    backdrop.id = "tocw-backdrop";
    const modal = document.createElement("div");
    modal.id = "tocw-modal";
    modal.innerHTML = `
      <h2 style="margin:0 0 6px;font-size:20px;">Chain Watch Settings</h2>
      <p class="tocw-muted" style="margin:0 0 14px;">
        Data Storage: local script settings plus faction schedule on Torn Overseer.
        Data Sharing: Torn API requests go to api.torn.com; shift signup goes to your configured Overseer backend.
        Purpose: scheduled chain countdown, watcher shifts, live chain timer, and read-only chain summaries.
      </p>
      <label>Torn API key ${pdaApiKey() ? "(provided by TornPDA)" : ""}
        <input id="tocw-set-torn-key" type="password" value="${escapeHtml(pdaApiKey() && cfg.tornKey === pdaApiKey() ? "" : cfg.tornKey)}" autocomplete="off" placeholder="${pdaApiKey() ? "Using the TornPDA key" : "Limited-access Torn API key"}" />
      </label>
      <label>Site session token
        <input id="tocw-set-session" type="password" value="${escapeHtml(cfg.sessionToken)}" autocomplete="off" />
      </label>
      <div style="margin-top:10px;padding:10px;border:1px solid #333;border-radius:8px;">
        <div style="font-weight:700;">Signup link (token mode)</div>
        <div class="tocw-muted" style="margin:4px 0 8px;">
          ${cfg.signupToken
            ? "Linked to a signup event. Just open the link leadership posts to switch events — no key needed."
            : "Open a chain-watch signup link (from faction chat) once to bind this panel. No key or session needed."}
        </div>
        <div class="grid" style="grid-template-columns:1fr auto;gap:8px;align-items:end;">
          <label style="margin:0;">Paste a link or token (fallback)
            <input id="tocw-set-signup" value="" autocomplete="off" placeholder="https://${OVERSEER_HOST}/chain/e/…" />
          </label>
          <button id="tocw-signup-clear" ${cfg.signupToken ? "" : "disabled"}>Clear link</button>
        </div>
      </div>
      <details style="margin-top:10px;">
        <summary class="tocw-muted" style="cursor:pointer;font-weight:700;">Advanced backend settings</summary>
        <div class="grid" style="margin-top:10px;">
          <label>Functions URL
            <input id="tocw-set-functions" value="${escapeHtml(cfg.functionsUrl)}" />
          </label>
          <label>Supabase publishable key
            <input id="tocw-set-anon" type="password" value="${escapeHtml(cfg.anonKey)}" autocomplete="off" />
          </label>
        </div>
      </details>
      <div class="tocw-modal-actions">
        <button id="tocw-modal-close">Close</button>
        <button id="tocw-modal-connect">Connect site from Torn key</button>
        <button id="tocw-modal-save" class="primary">Save</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    const collect = () => ({
      tornKey: valueOf("tocw-set-torn-key"),
      functionsUrl: valueOf("tocw-set-functions"),
      anonKey: valueOf("tocw-set-anon"),
      sessionToken: valueOf("tocw-set-session"),
    });
    const close = () => {
      state.settingsOpen = false;
      render();
    };
    backdrop.addEventListener("click", close);
    document.getElementById("tocw-modal-close")?.addEventListener("click", close);
    document.getElementById("tocw-modal-save")?.addEventListener("click", () => {
      const ok = saveSettings(collect());
      // Last-resort manual link entry: bind a pasted signup link/token.
      const pasted = extractSignupToken(valueOf("tocw-set-signup"));
      if (pasted) gmSet(STORE.signupToken, pasted);
      if (ok) {
        state.notice = pasted ? "Signup link saved." : "Settings saved.";
      } else {
        state.error = "Install Tampermonkey or use Torn PDA — your key and session can't be stored securely otherwise, so they were not saved.";
      }
      close();
    });
    document.getElementById("tocw-signup-clear")?.addEventListener("click", () => {
      gmSet(STORE.signupToken, "");
      gmSet(STORE.signupIdentity, null);
      state.signup = null;
      state.notice = "Signup link cleared.";
      close();
    });
    document.getElementById("tocw-modal-connect")?.addEventListener("click", async () => {
      saveSettings(collect());
      try {
        const token = await connectSiteFromTornKey();
        document.getElementById("tocw-set-session").value = token;
        saveSettings({ ...collect(), sessionToken: token });
        state.notice = "Site connected.";
        close();
      } catch (e) {
        state.error = e.message || "Site connection failed.";
        render();
      }
    });
  }

  function valueOf(id) {
    const el = document.getElementById(id);
    return el && "value" in el ? String(el.value).trim() : "";
  }

  function createLauncher() {
    if (document.getElementById("tocw-launcher")) return;
    const launcher = document.createElement("button");
    launcher.id = "tocw-launcher";
    launcher.type = "button";
    launcher.textContent = "TO";
    launcher.title = "Open Torn Overseer";
    launcher.style.cssText = [
      "position:fixed",
      "left:58px",
      "bottom:76px",
      "z-index:2147483647",
      "width:46px",
      "height:38px",
      "border-radius:9px",
      "border:2px solid #ff6870",
      "background:#ff3b45",
      "color:#fff",
      "font:bold 15px Arial,sans-serif",
      "box-shadow:0 8px 22px rgba(0,0,0,.45)",
      "cursor:pointer",
    ].join(";");
    launcher.addEventListener("click", () => {
      state.collapsed = false;
      gmSet(STORE.collapsed, false);
      createShell();
      render();
      const box = document.getElementById("tocw");
      if (box) box.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    document.body.appendChild(launcher);
  }

  // On the Overseer site we ONLY capture the signup token from a /chain/e/:token link
  // and hand off to the torn.com panel — never render our own UI over the site's app.
  function bootOverseerCapture() {
    migrateSecretsFromLocalStorage();
    const token = captureSignupToken();
    if (token) showCaptureToast();
  }

  function showCaptureToast() {
    if (document.getElementById("tocw-capture-toast")) return;
    const toast = document.createElement("div");
    toast.id = "tocw-capture-toast";
    toast.textContent = "Chain Watch: this event is now linked in your in-game panel. Open Torn to sign up from the game.";
    toast.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
      "max-width:min(92vw,420px);background:#111;color:#fff;border:1px solid #3a3a3a;border-radius:10px;" +
      "padding:12px 16px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }
    if (isOverseerSite()) {
      bootOverseerCapture();
      return;
    }
    console.info("[Torn Overseer Chain Watch] loaded", location.href);
    migrateSecretsFromLocalStorage();
    createLauncher();
    try {
      createShell();
      render();
    } catch (error) {
      console.error("[Torn Overseer Chain Watch] render failed", error);
    }
    setTimeout(() => void refreshAll(false), 800);
    setInterval(safeRender, 1000);
    setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll(false);
    }, 30_000);
  }

  function safeRender() {
    try {
      render();
    } catch (error) {
      console.error("[Torn Overseer Chain Watch] render failed", error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
