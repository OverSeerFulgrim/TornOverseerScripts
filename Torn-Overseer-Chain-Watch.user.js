// ==UserScript==
// @name         Torn Overseer Chain Watch
// @namespace    torn-overseer
// @version      0.1.2
// @description  Read-only scheduled chain countdown, chainwatch shift signup, live chain timer, and best-effort hit leaderboard.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @connect      ijolgywtybadfuvyopeg.supabase.co
// @connect      *.supabase.co
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  if (window.__tornOverseerChainWatchLoaded) return;
  window.__tornOverseerChainWatchLoaded = true;

  const VERSION = "0.1.2";
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
    collapsed: "tocw_collapsed",
  };

  const state = {
    loading: false,
    error: null,
    notice: null,
    watch: null,
    chain: null,
    attacks: null,
    fetchedAt: null,
    settingsOpen: false,
    collapsed: readBool(STORE.collapsed, false),
  };

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch {
      /* ignore */
    }
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
        return;
      }
    } catch {
      /* ignore */
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  function readString(key, fallback = "") {
    const value = gmGet(key, fallback);
    return typeof value === "string" ? value : fallback;
  }

  function readBool(key, fallback) {
    const value = gmGet(key, fallback);
    return typeof value === "boolean" ? value : fallback;
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
    };
  }

  function saveSettings(next) {
    gmSet(STORE.tornKey, (next.tornKey || "").trim());
    gmSet(STORE.functionsUrl, (next.functionsUrl || DEFAULT_FUNCTIONS_URL).trim());
    gmSet(STORE.anonKey, (next.anonKey || DEFAULT_ANON_KEY).trim());
    gmSet(STORE.sessionToken, (next.sessionToken || "").trim());
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

  function parseHttpJson(status, responseText, url) {
    let parsed = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}`);
    }
    if (status < 200 || status >= 300) {
      const msg =
        parsed && typeof parsed === "object" && typeof parsed.error === "string"
          ? parsed.error
          : `Request failed (${status})`;
      throw new Error(msg);
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

  async function requestJsonWithFetch(url, options = {}) {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body == null ? undefined : JSON.stringify(options.body);
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    return parseHttpJson(res.status, text, url);
  }

  function requestJson(url, options = {}) {
    if (
      typeof window.PDA_httpGet === "function" &&
      ((options.method || "GET") === "GET" || typeof window.PDA_httpPost === "function")
    ) {
      return requestJsonWithTornPda(url, options);
    }
    if (typeof GM_xmlhttpRequest !== "function") return requestJsonWithFetch(url, options);

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

  async function callFunction(slug, body = {}) {
    const cfg = settings();
    if (!cfg.functionsUrl || !cfg.anonKey || !cfg.sessionToken) {
      throw new Error("Connect the site session in Settings.");
    }
    return requestJson(`${cfg.functionsUrl.replace(/\/+$/, "")}/${slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        "X-Session-Token": cfg.sessionToken,
      },
      body,
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
      if (cfg.functionsUrl && cfg.anonKey && cfg.sessionToken) {
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

  function shiftLabel(shift) {
    return `${tctTime(shift.shift_start)}-${tctTime(shift.shift_end).replace(" TCT", "")}`;
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
      .tocw-head { padding: 14px 14px 10px; border-bottom: 1px solid #25384d; }
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
      #tocw.collapsed { width: 260px; }
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
    }
  }

  function render() {
    createShell();
    const box = document.getElementById("tocw");
    if (!box) return;
    box.classList.toggle("collapsed", state.collapsed);

    const cfg = settings();
    const event = state.watch?.event || null;
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

    box.innerHTML = `
      <div class="tocw-head">
        <div class="tocw-pills">
          <span class="tocw-pill ${live ? "ok" : "warn"}">${live ? "LIVE TORN API" : "SCHEDULED"}</span>
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
        ${!cfg.tornKey || !cfg.sessionToken ? `<div class="tocw-alert">Add your Torn API key, connect the site session, then refresh.</div>` : ""}
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
        ${canManage ? `<button class="small" data-tocw-action="schedule" style="margin-top:8px;">Schedule chain</button>` : ""}
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
    const assigned = shift.watcher_id != null;
    const own = Number(shift.watcher_id) === Number(viewer.player_id);
    const canManage = Boolean(viewer.can_manage);
    const tone = statusClass(shift.watcher_online_status);
    const actions = assigned
      ? [
          canManage ? `<button class="small" data-tocw-action="assign" data-shift="${shift.id}">Change</button>` : "",
          canManage || own ? `<button class="small" data-tocw-action="clear" data-shift="${shift.id}">${own && !canManage ? "Leave" : "Clear"}</button>` : "",
        ].join("")
      : canManage
        ? `<button class="small" data-tocw-action="assign" data-shift="${shift.id}">Assign</button>`
        : `<button class="small" data-tocw-action="signup" data-shift="${shift.id}">Sign up</button>`;
    return `
      <div class="tocw-row">
        <div class="tocw-muted">${shiftLabel(shift)}</div>
        <div>
          ${assigned ? `<span class="tocw-dot ${tone}"></span>${escapeHtml(shift.watcher_name || `ID ${shift.watcher_id}`)} <span class="tocw-muted">${escapeHtml(shift.watcher_online_status || "")}</span>` : `<span class="tocw-muted">Open</span>`}
        </div>
        <div>${actions}</div>
      </div>
    `;
  }

  async function handleAction(btn) {
    const action = btn.getAttribute("data-tocw-action");
    const shiftId = Number(btn.getAttribute("data-shift"));
    try {
      if (action === "signup") {
        state.watch = await callFunction("chain-watch", { action: "signup", shift_id: shiftId });
        state.notice = "Shift claimed.";
      } else if (action === "assign") {
        const watcherId = promptWatcherId();
        if (!watcherId) return;
        state.watch = await callFunction("chain-watch", { action: "assign", shift_id: shiftId, watcher_id: watcherId });
        state.notice = "Shift assigned.";
      } else if (action === "clear") {
        if (!confirm("Clear this chainwatch shift?")) return;
        state.watch = await callFunction("chain-watch", { action: "clear", shift_id: shiftId });
        state.notice = "Shift cleared.";
      } else if (action === "schedule") {
        const scheduled = promptSchedule();
        if (!scheduled) return;
        state.watch = await callFunction("chain-watch", { action: "save_event", ...scheduled });
        state.notice = "Chain scheduled.";
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
    const event = state.watch?.event;
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
      <label>Torn API key ${pdaApiKey() ? "(from TornPDA)" : ""}
        <input id="tocw-set-torn-key" type="password" value="${escapeHtml(cfg.tornKey)}" autocomplete="off" />
      </label>
      <label>Site session token
        <input id="tocw-set-session" type="password" value="${escapeHtml(cfg.sessionToken)}" autocomplete="off" />
      </label>
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
      saveSettings(collect());
      state.notice = "Settings saved.";
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
    launcher.textContent = "CW";
    launcher.title = "Open Chain Watch";
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

  function boot() {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }
    console.info("[Torn Overseer Chain Watch] loaded", location.href);
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
