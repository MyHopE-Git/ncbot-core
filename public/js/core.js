window.NCBotCore = (() => {
  const state = {
    targets: [],
    scripts: {},
    runningKeys: [],
    activeTab: '1'
  };

  const tabModules = new Map();
  const stateListeners = new Set();

  const logBox = document.getElementById('logBox');
  const globalStatusBadge = document.getElementById('globalStatusBadge');
  const globalScriptSelect = document.getElementById('globalScriptSelect');

  function nowTime() {
    return new Date().toLocaleTimeString('th-TH', { hour12: false });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function appendLog({ time, target, level, message }) {
    if (!logBox) return;
    const div = document.createElement('div');
    div.className = `log-${level || 'info'}`;
    div.textContent = `[${time || nowTime()}] [${target || 'SYSTEM'}] ${message}`;
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function renderGlobalStatus() {
    if (!globalStatusBadge) return;
    const activeCount = state.targets.filter((t) => t.enabled !== false).length;
    const pausedCount = state.targets.length - activeCount;

    if (state.runningKeys.length > 0) {
      globalStatusBadge.textContent = `Running (${state.runningKeys.length})`;
      globalStatusBadge.className = 'badge active';
    } else {
      globalStatusBadge.textContent = `ใช้งาน: ${activeCount} / พักงาน: ${pausedCount}`;
      globalStatusBadge.className = 'badge';
    }
  }

  function notifyStateChanged() {
    renderGlobalStatus();
    for (const fn of stateListeners) {
      try {
        fn({
          targets: [...state.targets],
          scripts: { ...state.scripts },
          runningKeys: [...state.runningKeys]
        });
      } catch (err) {
        appendLog({ target: 'UI-MODULE', level: 'error', message: `โมดูลอัปเดตสถานะผิดพลาด: ${err.message}` });
      }
    }
  }

  async function syncFromServer() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
      const data = await res.json();

      state.targets = Array.isArray(data.targets) ? data.targets : [];
      state.runningKeys = Array.isArray(data.running) ? data.running : [];
      state.scripts = data.scripts && typeof data.scripts === 'object' ? data.scripts : {};

      if (globalScriptSelect) {
        const prevScript = globalScriptSelect.value;
        globalScriptSelect.innerHTML = '';
        for (const name of Object.keys(state.scripts)) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = `Script: ${name}`;
          globalScriptSelect.appendChild(opt);
        }
        if (prevScript && state.scripts[prevScript]) {
          globalScriptSelect.value = prevScript;
        }
      }

      notifyStateChanged();
    } catch (err) {
      notifyStateChanged();
      appendLog({ target: 'SYNC', level: 'error', message: `ดึงข้อมูลจากเซิร์ฟเวอร์ไม่ได้: ${err.message}` });
    }
  }

  async function startTargetByKey(key, customScriptName) {
    const scriptName = customScriptName || (globalScriptSelect && globalScriptSelect.value) || 'sample_flow';
    try {
      const res = await fetch('/api/control/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: key, scriptName })
      });
      const data = await res.json();
      if (!res.ok) {
        appendLog({ target: key, level: 'error', message: data.error || 'สั่งงานไม่สำเร็จ' });
      }
    } catch (err) {
      appendLog({ target: key, level: 'error', message: `สั่ง Start ผิดพลาด: ${err.message}` });
    }
    await syncFromServer();
  }

  async function stopTargetByKey(key) {
    try {
      const res = await fetch('/api/control/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: key })
      });
      const data = await res.json();
      if (!res.ok) {
        appendLog({ target: key, level: 'error', message: data.error || 'หยุดงานไม่สำเร็จ' });
      }
    } catch (err) {
      appendLog({ target: key, level: 'error', message: `สั่ง Stop ผิดพลาด: ${err.message}` });
    }
    await syncFromServer();
  }

  function registerTab(tabId, handlers) {
    tabModules.set(String(tabId), handlers || {});
    if (typeof handlers?.init === 'function') {
      try {
        handlers.init();
      } catch (err) {
        appendLog({ target: `TAB-${tabId}`, level: 'error', message: `โหลดแท็บ ${tabId} ผิดพลาด: ${err.message}` });
      }
    }
  }

  function switchTab(tabId) {
    const id = String(tabId);
    state.activeTab = id;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === id);
    });
    document.querySelectorAll('.page-view').forEach((p) => {
      p.style.display = p.id === `page-${id}` ? '' : 'none';
    });

    const mod = tabModules.get(id);
    if (typeof mod?.onActivate === 'function') {
      try {
        mod.onActivate();
      } catch (err) {
        appendLog({ target: `TAB-${id}`, level: 'error', message: `เปิดแท็บ ${id} ผิดพลาด: ${err.message}` });
      }
    }
  }

  function initGlobalEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('btnGlobalStart')?.addEventListener('click', async () => {
      const activeTargets = state.targets.filter((t) => t.enabled !== false);
      const pausedTargets = state.targets.filter((t) => t.enabled === false);

      if (pausedTargets.length > 0) {
        appendLog({
          target: 'START-ALL',
          level: 'info',
          message: `ข้าม ${pausedTargets.length} Port ที่อยู่ในสถานะ พักงาน`
        });
      }

      for (const t of activeTargets) {
        const key = `${t.host}:${t.port}`;
        if (!state.runningKeys.includes(key)) {
          await startTargetByKey(key);
        }
      }
      await syncFromServer();
    });

    document.getElementById('btnGlobalStop')?.addEventListener('click', async () => {
      for (const key of [...state.runningKeys]) {
        await stopTargetByKey(key);
      }
      await syncFromServer();
    });

    document.getElementById('btnClearLog')?.addEventListener('click', () => {
      if (logBox) logBox.innerHTML = '';
    });

    window.addEventListener('error', (event) => {
      appendLog({
        target: 'JS-ERROR',
        level: 'error',
        message: `${event.message} (${event.filename || ''}:${event.lineno || ''})`
      });
    });

    try {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProtocol}//${location.host}`);

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'log') appendLog(msg.data);
          if (msg.type === 'status') {
            state.runningKeys = Array.isArray(msg.running) ? msg.running : [];
            notifyStateChanged();
          }
        } catch {
          // ignore malformed frame
        }
      });

      ws.addEventListener('open', () => syncFromServer());
    } catch (err) {
      appendLog({ target: 'WS', level: 'warn', message: `WebSocket warning: ${err.message}` });
    }
  }

  initGlobalEvents();

  return {
    nowTime,
    escapeHtml,
    appendLog,
    syncFromServer,
    startTargetByKey,
    stopTargetByKey,
    registerTab,
    switchTab,
    onStateChange: (fn) => stateListeners.add(fn),
    getTargets: () => [...state.targets],
    getScripts: () => ({ ...state.scripts }),
    getRunningKeys: () => [...state.runningKeys]
  };
})();