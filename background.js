// ============================================================================
// Auto Clear & Optimize (Pro) - background service worker
// ============================================================================
// Two jobs:
//   1. CLEAN  - periodically wipe selected browsing data (history, cache,
//      cookies, site storage, etc.) on a user-defined interval.
//   2. OPTIMIZE - periodically discard idle tabs from memory so Chrome stays
//      light and responsive. Discarded tabs stay in the tab strip and reload
//      instantly when clicked.
// ============================================================================

const CLEAR_ALARM = "autoClearAlarm";
const OPTIMIZE_ALARM = "tabOptimizeAlarm";

// Chrome enforces a 30s (0.5 min) floor on alarm periods. Anything lower is
// clamped by Chrome, so 0.5 is the smallest interval we offer.
const MIN_INTERVAL = 0.5;

// Default settings. Note: passwords / autofill are intentionally OFF by
// default - wiping them every minute would log the user out of everything and
// erase saved logins. They can be enabled in the popup if the user wants it.
// Domains exempt from the immediate wipe. Their cookies / site storage are not
// nuked on the regular cycle - instead each gets a grace window (see
// whitelistTtlMinutes) so an in-progress login or scrape isn't killed
// mid-flight. After the grace elapses the data is wiped on the next cycle.
const WHITELIST_DEFAULT = ["amazon.com"];

// Origin-keyed browsing-data types. These can be scoped per-origin (so we can
// spare whitelisted sites); everything else (HTTP cache, history, etc.) is
// global and can't be filtered by origin.
const ORIGIN_SCOPED = new Set([
  "cacheStorage", "cookies", "fileSystems",
  "indexedDB", "localStorage", "serviceWorkers", "webSQL"
]);

// Internal storage key tracking when whitelisted-domain data was first seen,
// so we know when its grace window has elapsed. Not user-facing.
const WL_SEEN_KEY = "_wlSeen";

// ---------------------------------------------------------------------------
// Source Genius scrape handshake
// ---------------------------------------------------------------------------
// Source Genius (the Amazon brand-finder extension) marks an active scrape run
// by setting a guard cookie named `sg_active` on a sentinel URL. While that
// cookie exists we PAUSE all data wiping and tab discarding, so a run's Amazon
// session cookies, site storage and helper tabs are never destroyed mid-scrape.
// Wiping them logs the scrape's fetches out of Amazon and trips Amazon's bot
// wall (503 / robot-check), which is the failure this handshake prevents.
// Crash-safe: the guard cookie self-expires (~3 min), so if Source Genius dies
// the cleaner automatically resumes on the next cycle. No extension IDs or
// messaging needed — the cookie store is shared across extensions.
const SG_GUARD_URL  = "https://sg-guard.invalid/";
const SG_GUARD_NAME = "sg_active";

function isScrapeGuardActive() {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve(false);
    try {
      chrome.cookies.get({ url: SG_GUARD_URL, name: SG_GUARD_NAME }, (c) => {
        void chrome.runtime.lastError; // absent cookie is not an error
        resolve(!!c);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const logStr = `[${time}] ${msg}`;
  console.log(logStr);
  try {
    const data = await new Promise((r) => chrome.storage.local.get({ logs: [] }, r));
    const logs = data.logs || [];
    logs.push(logStr);
    if (logs.length > 50) logs.shift();
    await new Promise((r) => chrome.storage.local.set({ logs }, r));
  } catch (_) {}
}

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 2,
  whitelist: WHITELIST_DEFAULT,
  whitelistTtlMinutes: 2,
  categories: {
    cache: true,
    cacheStorage: true,
    cookies: true,
    downloads: false,
    fileSystems: true,
    formData: false,
    history: true,
    indexedDB: true,
    localStorage: true,
    serviceWorkers: true,
    passwords: false
  },
  optimizer: {
    enabled: true,
    idleMinutes: 5,
    discardPinned: false
  },
  stats: {
    lastCleared: "Never",
    clearCount: 0,
    tabsDiscarded: 0
  }
};

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (data) => {
      // Merge nested objects so new keys in DEFAULTS survive upgrades.
      resolve({
        ...DEFAULTS,
        ...data,
        whitelist: Array.isArray(data.whitelist) ? data.whitelist : DEFAULTS.whitelist,
        categories: { ...DEFAULTS.categories, ...(data.categories || {}) },
        optimizer: { ...DEFAULTS.optimizer, ...(data.optimizer || {}) },
        stats: { ...DEFAULTS.stats, ...(data.stats || {}) }
      });
    });
  });
}

function setSettings(patch) {
  return new Promise((resolve) => chrome.storage.local.set(patch, resolve));
}

// Atomic-ish read-modify-write for the stats object. chrome.storage has no
// transactions, so both the clear cycle and the optimize cycle would otherwise
// read a stale `stats`, mutate their own field, and write the whole object
// back - clobbering each other's increment. Re-reading immediately before the
// write shrinks that race window to almost nothing.
function bumpStats(mutator) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ stats: DEFAULTS.stats }, (data) => {
      const stats = { ...DEFAULTS.stats, ...(data.stats || {}) };
      mutator(stats);
      chrome.storage.local.set({ stats }, resolve);
    });
  });
}

// Re-entrancy guards. An alarm can fire again while the previous cycle is still
// awaiting cookie/browsingData calls; without these, cycles overlap and race
// the _wlSeen bookkeeping (double-wiping whitelisted domains mid-grace).
let clearRunning = false;
let optimizeRunning = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await setSettings(s);           // persist any newly-added default keys
  await rescheduleAll(s);
  updateBadge(s.enabled);
  if (s.enabled) {
    clearBrowsingData();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  await rescheduleAll(s);
  updateBadge(s.enabled);
  if (s.enabled) {
    clearBrowsingData();
  }
});

// React to changes made from the popup.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  
  let needsReschedule = false;
  if (changes.enabled && changes.enabled.oldValue !== changes.enabled.newValue) {
    needsReschedule = true;
  }
  if (changes.intervalMinutes && changes.intervalMinutes.oldValue !== changes.intervalMinutes.newValue) {
    needsReschedule = true;
  }
  if (changes.optimizer) {
    const oldOpt = changes.optimizer.oldValue || {};
    const newOpt = changes.optimizer.newValue || {};
    if (oldOpt.enabled !== newOpt.enabled || oldOpt.idleMinutes !== newOpt.idleMinutes || oldOpt.discardPinned !== newOpt.discardPinned) {
      needsReschedule = true;
    }
  }

  if (needsReschedule) {
    const s = await getSettings();
    await rescheduleAll(s);
    if (changes.enabled) updateBadge(s.enabled);
  }
});

// ---------------------------------------------------------------------------
// Alarm scheduling
// ---------------------------------------------------------------------------

async function rescheduleAll(s) {
  // Clear job
  await chrome.alarms.clear(CLEAR_ALARM);
  if (s.enabled) {
    const period = Math.max(MIN_INTERVAL, Number(s.intervalMinutes) || 1);
    chrome.alarms.create(CLEAR_ALARM, { periodInMinutes: period });
    await addLog(`Scheduled clear cycle every ${period} min.`);
  } else {
    await addLog("Auto-clear is disabled.");
  }

  // Optimize job - independent of the master enable so tabs can be kept light
  // even when auto-wipe is paused.
  await chrome.alarms.clear(OPTIMIZE_ALARM);
  if (s.optimizer.enabled) {
    chrome.alarms.create(OPTIMIZE_ALARM, { periodInMinutes: 1 });
    await addLog("Tab optimizer scheduled (runs every 1 min).");
  } else {
    await addLog("Tab optimizer is disabled.");
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEAR_ALARM) clearBrowsingData();
  else if (alarm.name === OPTIMIZE_ALARM) optimizeTabs();
});

// ---------------------------------------------------------------------------
// Messaging (manual actions from popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "wipeNow") {
    clearBrowsingData().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "optimizeNow") {
    optimizeTabs(true).then((n) => sendResponse({ ok: true, discarded: n }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Job 1: Clear browsing data
// ---------------------------------------------------------------------------

async function clearBrowsingData() {
  if (clearRunning) {
    console.log("AutoClear: clear already in progress - skipping overlapping cycle.");
    return;
  }
  clearRunning = true;
  try {
    await _clearBrowsingData();
  } finally {
    clearRunning = false;
  }
}

async function _clearBrowsingData() {
  await addLog("Starting data clearing cycle...");

  // Source Genius handshake: during an active scrape we no longer pause the
  // whole cycle. We still wipe everything - cache, history, and every
  // NON-whitelisted domain's cookies + storage - so Chrome stays light even
  // during long runs. The one thing we never touch mid-scrape is the
  // whitelisted domains: the delayed whitelist-TTL wipe below is skipped while
  // a scrape is live, so a running Amazon session (and any whitelisted
  // search-tier domains) survive the whole run. Full cleanup, including the
  // whitelisted domains, resumes on the first idle cycle after the guard
  // cookie self-expires.
  const scrapeActive = await isScrapeGuardActive();
  if (scrapeActive) {
    await addLog("Source Genius scrape active (sg_active) - clearing all except whitelisted domains.");
  }

  const s = await getSettings();
  const whitelist = (s.whitelist || []).map((d) => normalizeDomain(d)).filter(Boolean);
  const ttlMs = Math.max(0.5, Number(s.whitelistTtlMinutes) || 2) * 60 * 1000 - 10000; // 10s buffer to account for alarm timing variations

  // Build the dataToRemove map from the user's category selection.
  const dataToRemove = {};
  for (const [key, on] of Object.entries(s.categories)) {
    if (on) dataToRemove[key] = true;
  }

  if (Object.keys(dataToRemove).length === 0) {
    await addLog("No categories selected to clear.");
    return;
  }

  // Cookies are handled by sweepCookies() (chrome.cookies API) instead of
  // browsingData, because only that path can match & skip whitelisted domains
  // by suffix (browsingData wipes all cookies globally with no domain filter).
  const wantCookies = !!dataToRemove.cookies;
  delete dataToRemove.cookies;

  // Split the rest into origin-scoped (can spare whitelisted origins) vs global.
  const originScoped = {};
  const global = {};
  for (const key of Object.keys(dataToRemove)) {
    if (ORIGIN_SCOPED.has(key)) originScoped[key] = true;
    else global[key] = true;
  }

  const since = 0; // from the beginning of time
  const originTypes = { unprotectedWeb: true, protectedWeb: true };
  const wlOrigins = whitelist.length ? await getWhitelistOrigins(whitelist) : [];

  // 1. Clear origin-scoped storage
  if (Object.keys(originScoped).length > 0) {
    try {
      const opts = { since, originTypes };
      if (wlOrigins.length > 0) opts.excludeOrigins = wlOrigins;
      await addLog(`Clearing origin-scoped storage (${Object.keys(originScoped).join(", ")})...`);
      await chrome.browsingData.remove(opts, originScoped);
      await addLog("Origin-scoped storage cleared successfully.");
    } catch (e) {
      await addLog(`Error clearing origin-scoped storage: ${e.message || e}`);
    }
  }

  // 2. Clear global storage
  if (Object.keys(global).length > 0) {
    try {
      await addLog(`Clearing global data (${Object.keys(global).join(", ")})...`);
      await chrome.browsingData.remove({ since, originTypes }, global);
      await addLog("Global data cleared successfully.");
    } catch (e) {
      await addLog(`Error clearing global data: ${e.message || e}`);
    }
  }

  // Cookie sweep that skips whitelisted domains.
  if (wantCookies) {
    try {
      await addLog("Sweeping non-whitelisted cookies...");
      await sweepCookies(whitelist);
      await addLog("Non-whitelisted cookies cleared successfully.");
    } catch (e) {
      await addLog(`Error sweeping cookies: ${e.message || e}`);
    }
  }

  // Delayed wipe: whitelisted domains whose grace window has elapsed get their
  // cookies + site storage cleared now. This is what keeps a running Amazon
  // session/scrape alive for up to `ttlMs`, then cleans it up.
  // Only wipe the categories the user actually selected - a whitelisted domain
  // must never lose data types the user never opted into clearing in the
  // first place (e.g. leaving "cookies" unchecked must mean its cookies are
  // never touched, whitelisted or not).
  // While a scrape is active, skip this entirely so Amazon (and any whitelisted
  // search-tier domains) keep their session for the whole run. This is the only
  // thing that must never be cleared mid-scrape - it resumes on the next idle
  // cycle once the scrape ends.
  if (scrapeActive) {
    await addLog("Whitelisted domains spared (scrape active) - TTL wipe deferred to next idle cycle.");
  } else if (whitelist.length > 0 && (wantCookies || Object.keys(originScoped).length > 0)) {
    try {
      await sweepWhitelistTtl(whitelist, ttlMs, wantCookies, originScoped);
    } catch (e) {
      await addLog(`Error clearing whitelisted TTL data: ${e.message || e}`);
    }
  }

  const timeString = new Date().toLocaleTimeString();
  await bumpStats((st) => {
    st.lastCleared = timeString;
    st.clearCount = (st.clearCount || 0) + 1;
  });
  await addLog("Data clearing cycle complete.");
}

function sweepCookies(whitelist = []) {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve();
    chrome.cookies.getAll({}, (cookies) => {
      if (chrome.runtime.lastError || !cookies || cookies.length === 0) {
        return resolve();
      }
      // Skip whitelisted domains - they're handled by sweepWhitelistTtl().
      const targets = cookies.filter(
        (c) => !isWhitelisted(c.domain, whitelist)
      );
      if (targets.length === 0) return resolve();

      let pending = targets.length;
      for (const c of targets) {
        chrome.cookies.remove(cookieRemoveArgs(c), () => {
          void chrome.runtime.lastError; // ignore per-cookie failures
          if (--pending === 0) resolve();
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Whitelist: delayed-wipe helpers
// ---------------------------------------------------------------------------

function normalizeDomain(d) {
  return String(d || "").trim().toLowerCase().replace(/^\.+/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// A cookie/site domain is whitelisted if it equals, or is a subdomain of, any
// whitelist entry (so "amazon.com" also covers "www.amazon.com").
function isWhitelisted(domain, whitelist = []) {
  const d = normalizeDomain(domain);
  return whitelist.some((w) => {
    const ww = normalizeDomain(w);
    return ww && (d === ww || d.endsWith("." + ww));
  });
}

function cookieRemoveArgs(c) {
  const protocol = c.secure ? "https:" : "http:";
  const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  return { url: `${protocol}//${domain}${c.path}`, name: c.name, storeId: c.storeId };
}

function getAllCookies() {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve([]);
    chrome.cookies.getAll({}, (cookies) => resolve(cookies || []));
  });
}

// Build the excludeOrigins list that spares whitelisted sites' storage during
// the immediate wipe. Two sources:
//   1. The whitelist base domains + their www host, ALWAYS - so a site is
//      spared even when it doesn't have a cookie yet (e.g. only localStorage /
//      IndexedDB). Without this, such storage was wiped instantly, defeating
//      the grace window.
//   2. The exact origins of any subdomains currently holding cookies, to catch
//      hosts like www2. / smile. / signin. that we couldn't predict.
async function getWhitelistOrigins(whitelist) {
  const origins = new Set();
  for (const w of whitelist) {
    const dom = normalizeDomain(w);
    if (!dom) continue;
    origins.add(`https://${dom}`);
    origins.add(`http://${dom}`);
    origins.add(`https://www.${dom}`);
    origins.add(`http://www.${dom}`);
  }
  const cookies = await getAllCookies();
  for (const c of cookies) {
    if (!isWhitelisted(c.domain, whitelist)) continue;
    const dom = normalizeDomain(c.domain);
    origins.add(`https://${dom}`);
    origins.add(`http://${dom}`);
  }
  return [...origins];
}

// For each whitelisted domain that currently has cookies, track when its data
// first appeared. Once `ttlMs` has elapsed, wipe that domain's cookies + site
// storage. Data that reappears restarts the grace window.
async function sweepWhitelistTtl(whitelist, ttlMs, wipeCookies, originTypes) {
  const cookies = await getAllCookies();
  const byDomain = new Map();
  for (const c of cookies) {
    if (!isWhitelisted(c.domain, whitelist)) continue;
    const dom = normalizeDomain(c.domain);
    if (!byDomain.has(dom)) byDomain.set(dom, []);
    byDomain.get(dom).push(c);
  }

  const seen = await getWlSeen();
  const now = Date.now();
  const next = {};

  for (const [dom, cs] of byDomain) {
    const firstSeen = seen[dom];
    if (!firstSeen) {
      next[dom] = now;                 // just appeared - start the grace window
    } else if (now - firstSeen >= ttlMs) {
      await wipeDomain(dom, cs, wipeCookies, originTypes); // grace elapsed - wipe it
      // omit from `next` so a fresh appearance restarts the window
    } else {
      next[dom] = firstSeen;            // still within grace - leave it alone
    }
  }
  // Domains no longer present simply drop out of `next`.
  await setWlSeen(next);
}

async function wipeDomain(dom, cookies, wipeCookies, originTypes) {
  await addLog(`Wiping whitelisted domain ${dom} (grace period elapsed)...`);

  // Only clear the categories the user actually selected - never wipe cookies
  // or storage types that were left unchecked, whitelisted domain or not.
  if (wipeCookies) {
    for (const c of cookies) {
      await new Promise((r) =>
        chrome.cookies.remove(cookieRemoveArgs(c), () => {
          void chrome.runtime.lastError;
          r();
        })
      );
    }
  }

  if (originTypes && Object.keys(originTypes).length > 0) {
    const origins = [`https://${dom}`, `http://${dom}`];
    if (!dom.startsWith("www.")) {
      origins.push(`https://www.${dom}`);
      origins.push(`http://www.${dom}`);
    }

    try {
      await chrome.browsingData.remove(
        {
          since: 0,
          originTypes: { unprotectedWeb: true, protectedWeb: true },
          origins: origins
        },
        originTypes
      );
      await addLog(`Whitelisted domain ${dom} cleared.`);
    } catch (e) {
      // origins filtering unsupported for some types on older Chrome; ignore.
      await addLog(`Note: origins filtering partial support for ${dom}: ${e.message || e}`);
    }
  }
}

function getWlSeen() {
  return new Promise((resolve) =>
    chrome.storage.local.get({ [WL_SEEN_KEY]: {} }, (d) => resolve(d[WL_SEEN_KEY] || {}))
  );
}

function setWlSeen(map) {
  return new Promise((resolve) =>
    chrome.storage.local.set({ [WL_SEEN_KEY]: map }, resolve)
  );
}

// ---------------------------------------------------------------------------
// Job 2: Optimize tabs (free RAM by discarding idle tabs)
// ---------------------------------------------------------------------------
// A discarded tab is unloaded from memory but stays visible in the tab strip
// and reloads automatically when the user switches back to it. This is the
// same mechanism Chrome's own Memory Saver uses.

async function optimizeTabs(force = false) {
  const s = await getSettings();
  if (!force && !s.optimizer.enabled) return 0;

  // Skip overlapping runs (e.g. the 1-min alarm firing while a slow discard
  // pass is still awaiting). A manual "Optimize Now" overrides so the popup
  // always gets a real answer.
  if (optimizeRunning && !force) return 0;
  optimizeRunning = true;
  try {
    return await _optimizeTabs(force, s);
  } finally {
    optimizeRunning = false;
  }
}

async function _optimizeTabs(force, s) {
  // Source Genius handshake: never discard tabs during an active scrape run.
  // Discarding a helper/recovery tab mid-scrape breaks Source Genius's
  // tab-recovery fallback. A manual "Optimize Now" (force) still overrides.
  if (!force && await isScrapeGuardActive()) {
    await addLog("Source Genius scrape active (sg_active) - tab optimize paused.");
    return 0;
  }

  const idleMs = Math.max(1, Number(s.optimizer.idleMinutes) || 5) * 60 * 1000;
  const now = Date.now();
  let discarded = 0;

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    // Never discard: the active tab, already-discarded tabs, tabs playing
    // audio, or tabs Chrome can't discard (e.g. chrome:// pages).
    if (tab.active || tab.discarded || tab.audible) continue;
    if (tab.pinned && !s.optimizer.discardPinned) continue;
    // Only discard real web pages. chrome://, edge://, about:, file://,
    // devtools://, view-source: and extension pages can't be discarded.
    if (!/^https?:\/\//i.test(tab.url || "")) continue;
    // Never discard Amazon tabs: Source Genius uses live Amazon tabs for brand
    // recovery/session seeding, and discarding one reloads it (re-triggering
    // bot-detection). The whitelisted scrape site is left loaded on purpose.
    if (/^https?:\/\/([^/]*\.)?amazon\.[a-z.]+\//i.test(tab.url)) continue;

    const lastUsed = tab.lastAccessed || 0;
    // On "Optimize Now" (force) discard everything eligible immediately.
    if (force || now - lastUsed > idleMs) {
      try {
        await chrome.tabs.discard(tab.id);
        discarded++;
      } catch (e) {
        // Tab may have closed or be undiscardable; ignore.
      }
    }
  }

  if (discarded > 0) {
    await bumpStats((st) => {
      st.tabsDiscarded = (st.tabsDiscarded || 0) + discarded;
    });
    await addLog(`Tab Optimizer: discarded ${discarded} idle tab(s).`);
  }
  return discarded;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function updateBadge(enabled) {
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#f38ba8" : "#6c7086" });
  chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
}
