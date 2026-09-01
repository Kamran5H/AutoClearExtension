// Popup control panel. All state lives in chrome.storage.local; the background
// worker reacts to changes via storage.onChanged.

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const toggleBtn = $('toggleBtn');
  const wipeBtn = $('wipeBtn');
  const optimizeBtn = $('optimizeBtn');
  const intervalSel = $('interval');
  const optEnabled = $('optEnabled');
  const idleSel = $('idleMinutes');
  const discardPinned = $('discardPinned');
  const whitelistBox = $('whitelist');
  const whitelistTtl = $('whitelistTtl');
  const flash = $('flash');
  const catBoxes = [...document.querySelectorAll('#categories input[data-cat]')];

  const DEFAULTS = {
    enabled: true,
    intervalMinutes: 2,
    whitelist: ['amazon.com'],
    whitelistTtlMinutes: 2,
    categories: {},
    optimizer: { enabled: true, idleMinutes: 5, discardPinned: false },
    stats: { lastCleared: 'Never', clearCount: 0, tabsDiscarded: 0 },
    logs: []
  };

  let state = null;

  chrome.storage.local.get(DEFAULTS, (data) => {
    // Deep-merge nested objects so a partial/older stored value can't leave
    // optimizer or stats missing keys (which would blank the UI controls).
    state = {
      ...DEFAULTS,
      ...data,
      categories: { ...DEFAULTS.categories, ...(data.categories || {}) },
      optimizer: { ...DEFAULTS.optimizer, ...(data.optimizer || {}) },
      stats: { ...DEFAULTS.stats, ...(data.stats || {}) }
    };
    render();
  });

  function render() {
    // Master toggle
    toggleBtn.textContent = state.enabled ? 'Pause Auto-Clear' : 'Resume Auto-Clear';
    toggleBtn.className = 'toggle ' + (state.enabled ? 'on' : 'off');

    // Interval
    intervalSel.value = String(state.intervalMinutes);

    // Categories
    catBoxes.forEach((b) => { b.checked = !!state.categories[b.dataset.cat]; });

    // Whitelist
    whitelistBox.value = (state.whitelist || []).join('\n');
    whitelistTtl.value = String(state.whitelistTtlMinutes || 2);

    // Optimizer
    optEnabled.checked = !!state.optimizer.enabled;
    idleSel.value = String(state.optimizer.idleMinutes);
    discardPinned.checked = !!state.optimizer.discardPinned;

    // Stats
    $('clearCount').textContent = state.stats.clearCount || 0;
    $('tabsDiscarded').textContent = state.stats.tabsDiscarded || 0;
    $('lastCleared').textContent = state.stats.lastCleared || 'Never';

    // Logs
    const logsDiv = $('logs');
    if (logsDiv) {
      const logs = state.logs || [];
      logsDiv.textContent = logs.length ? logs.join('\n') : 'No logs yet.';
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }
  }

  function save(patch) {
    Object.assign(state, patch);
    chrome.storage.local.set(patch);
  }

  function showFlash(text, ok = true) {
    flash.textContent = text;
    flash.className = ok ? 'ok-flash' : 'muted warn';
    setTimeout(() => { flash.textContent = ''; }, 2500);
  }

  // --- Wiring -------------------------------------------------------------

  toggleBtn.addEventListener('click', () => {
    save({ enabled: !state.enabled });
    render();
  });

  intervalSel.addEventListener('change', () => {
    save({ intervalMinutes: parseFloat(intervalSel.value) });
  });

  catBoxes.forEach((b) => {
    b.addEventListener('change', () => {
      const categories = { ...state.categories, [b.dataset.cat]: b.checked };
      save({ categories });
    });
  });

  function parseWhitelist(text) {
    return text
      .split(/[\n,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^\.+/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  }

  // Save on blur so we don't thrash storage on every keystroke.
  whitelistBox.addEventListener('blur', () => {
    const whitelist = parseWhitelist(whitelistBox.value);
    save({ whitelist });
    whitelistBox.value = whitelist.join('\n');
  });
  whitelistTtl.addEventListener('change', () => {
    save({ whitelistTtlMinutes: parseInt(whitelistTtl.value, 10) });
  });

  optEnabled.addEventListener('change', () => {
    save({ optimizer: { ...state.optimizer, enabled: optEnabled.checked } });
  });
  idleSel.addEventListener('change', () => {
    save({ optimizer: { ...state.optimizer, idleMinutes: parseInt(idleSel.value, 10) } });
  });
  discardPinned.addEventListener('change', () => {
    save({ optimizer: { ...state.optimizer, discardPinned: discardPinned.checked } });
  });

  wipeBtn.addEventListener('click', () => {
    wipeBtn.disabled = true;
    wipeBtn.textContent = 'Clearing...';
    chrome.runtime.sendMessage({ action: 'wipeNow' }, () => {
      wipeBtn.disabled = false;
      wipeBtn.textContent = 'Wipe Data Now';
      showFlash('Data wiped.');
    });
  });

  optimizeBtn.addEventListener('click', () => {
    optimizeBtn.disabled = true;
    optimizeBtn.textContent = 'Freeing...';
    chrome.runtime.sendMessage({ action: 'optimizeNow' }, (res) => {
      optimizeBtn.disabled = false;
      optimizeBtn.textContent = 'Free RAM Now';
      const n = res && res.discarded ? res.discarded : 0;
      showFlash(n ? `Freed ${n} tab(s).` : 'No idle tabs to free.');
    });
  });

  // Live-update stats and logs while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !state) return;
    if (changes.stats) {
      state.stats = changes.stats.newValue;
      $('clearCount').textContent = state.stats.clearCount || 0;
      $('tabsDiscarded').textContent = state.stats.tabsDiscarded || 0;
      $('lastCleared').textContent = state.stats.lastCleared || 'Never';
    }
    if (changes.logs) {
      state.logs = changes.logs.newValue || [];
      const logsDiv = $('logs');
      if (logsDiv) {
        logsDiv.textContent = state.logs.length ? state.logs.join('\n') : 'No logs yet.';
        logsDiv.scrollTop = logsDiv.scrollHeight;
      }
    }
  });
});
