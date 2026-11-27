(() => {
  const Core = window.NCBotCore;
  if (!Core) return;

  const portTableBody = document.getElementById('portTableBody');
  const portStatuses = new Map(); // "host:port" -> { text, meta, cls }
  let isMutating = false;

  function cloneTargets(list) {
    return (Array.isArray(list) ? list : []).map((t) => ({ ...t }));
  }

  function renderTable() {
    if (!portTableBody) return;
    const targets = Core.getTargets();
    const runningKeys = Core.getRunningKeys();
    portTableBody.innerHTML = '';

    if (!targets.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="9" style="text-align:center; color:#9fb0c2; padding:18px;">ยังไม่มีรายการ Port — กด + Add Port ด้านบนเพื่อเพิ่ม</td>`;
      portTableBody.appendChild(tr);
      return;
    }

    targets.forEach((t, index) => {
      const key = `${t.host}:${t.port}`;
      const isActiveMode = t.enabled !== false;
      const isRunning = runningKeys.includes(key);
      const st = portStatuses.get(key) || { text: 'ยังไม่ตรวจเช็ก', meta: '-', cls: 'status-idle' };

      const usageColHtml = isActiveMode
        ? `<span class="badge active">เปิดใช้งาน</span>`
        : `<span class="badge paused">พักงาน</span>`;

      const tr = document.createElement('tr');
      if (!isActiveMode) tr.className = 'row-paused';

      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>${usageColHtml}</td>
        <td>${Core.escapeHtml(t.name)}</td>
        <td><code>${Core.escapeHtml(key)}</code> ${isRunning ? '<span class="badge active">กำลังรัน</span>' : ''}</td>
        <td class="${st.cls}">
          ${Core.escapeHtml(st.text)}
          <span class="sub-meta">${Core.escapeHtml(st.meta)}</span>
        </td>
        <td>
          <button class="btn-check" data-action="check" data-idx="${index}" ${isMutating ? 'disabled' : ''}>ตรวจเช็ก</button>
        </td>
        <td>
          <button class="btn-open-mode" data-action="set-open" data-idx="${index}" ${isMutating || isActiveMode ? 'disabled' : ''}>เปิด</button>
          <button class="btn-pause-mode" data-action="set-pause" data-idx="${index}" ${isMutating || !isActiveMode ? 'disabled' : ''}>พักงาน</button>
        </td>
        <td>
          <button class="btn-move" data-action="up" data-idx="${index}" ${isMutating || index === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn-move" data-action="down" data-idx="${index}" ${isMutating || index === targets.length - 1 ? 'disabled' : ''}>▼</button>
        </td>
        <td>
          <button class="btn-del" data-action="del" data-idx="${index}" ${isMutating ? 'disabled' : ''}>ลบ</button>
        </td>
      `;
      portTableBody.appendChild(tr);
    });
  }

  async function saveTargets(updatedTargets) {
    isMutating = true;
    renderTable();
    try {
      const res = await fetch('/api/targets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: updatedTargets })
      });
      const data = await res.json();
      if (!res.ok) {
        Core.appendLog({ target: 'PORT-MGR', level: 'error', message: data.error || 'บันทึกข้อมูลไม่สำเร็จ' });
        await Core.syncFromServer();
        return false;
      }
      await Core.syncFromServer();
      return true;
    } catch (err) {
      Core.appendLog({ target: 'PORT-MGR', level: 'error', message: `บันทึกข้อมูลผิดพลาด: ${err.message}` });
      return false;
    } finally {
      isMutating = false;
      renderTable();
    }
  }

  async function checkSinglePort(index) {
    const targets = cloneTargets(Core.getTargets());
    const t = targets[index];
    if (!t) return;
    const key = `${t.host}:${t.port}`;
    portStatuses.set(key, { text: 'กำลังตรวจเช็ก...', meta: Core.nowTime(), cls: 'status-idle' });
    renderTable();

    try {
      const res = await fetch('/api/targets/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: t.host, port: t.port })
      });
      const data = await res.json();
      const checkedAt = Core.nowTime();

      if (data.ok) {
        const msText = typeof data.latencyMs === 'number' ? `${data.latencyMs} ms` : '-';
        portStatuses.set(key, {
          text: `Online (${msText})`,
          meta: `เช็กล่าสุด ${checkedAt}`,
          cls: 'status-ok'
        });
        Core.appendLog({ target: key, level: 'success', message: data.detail || `Port online (${msText})` });
      } else {
        portStatuses.set(key, {
          text: 'Offline / ปิดอยู่',
          meta: `เช็กล่าสุด ${checkedAt}`,
          cls: 'status-err'
        });
        Core.appendLog({ target: key, level: 'error', message: data.detail || data.error || 'Port check failed' });
      }
    } catch (err) {
      portStatuses.set(key, {
        text: 'ตรวจสอบไม่สำเร็จ',
        meta: `เช็กล่าสุด ${Core.nowTime()}`,
        cls: 'status-err'
      });
      Core.appendLog({ target: key, level: 'error', message: `เช็กพอร์ตผิดพลาด: ${err.message}` });
    }
    renderTable();
  }

  async function checkAllPorts() {
    const targets = cloneTargets(Core.getTargets());
    const chkOnly = document.getElementById('chkOnlyEnabled');
    const onlyEnabled = chkOnly ? chkOnly.checked : true;
    const indices = targets
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => !onlyEnabled || t.enabled !== false)
      .map(({ idx }) => idx);

    if (!indices.length) {
      Core.appendLog({ target: 'PORT-CHECK', level: 'warn', message: 'ไม่มี Port ที่เข้าเงื่อนไขให้ตรวจเช็ก' });
      return;
    }

    Core.appendLog({ target: 'PORT-CHECK', level: 'info', message: `เริ่มตรวจเช็ครวม ${indices.length} Port...` });
    for (const idx of indices) {
      await checkSinglePort(idx);
    }
    Core.appendLog({ target: 'PORT-CHECK', level: 'info', message: 'ตรวจเช็ครวมเสร็จสิ้น' });
  }

  function init() {
    Core.onStateChange(renderTable);

    document.getElementById('btnAddPort')?.addEventListener('click', async () => {
      if (isMutating) return;
      const nameInput = document.getElementById('newName');
      const hostInput = document.getElementById('newHost');
      const portInput = document.getElementById('newPort');

      const rawName = (nameInput?.value || '').trim();
      const host = (hostInput?.value || '').trim() || '127.0.0.1';
      const port = Number((portInput?.value || '').trim());

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        Core.appendLog({ target: 'PORT-MGR', level: 'error', message: 'กรุณาใส่เลข Port (1-65535) ให้ถูกต้อง' });
        return;
      }

      const defaultName = `Bot-Port-${port}`;
      isMutating = true;
      renderTable();
      try {
        const res = await fetch('/api/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: rawName || defaultName, host, port })
        });
        const data = await res.json();

        if (!res.ok) {
          Core.appendLog({ target: `${host}:${port}`, level: 'error', message: data.error || 'เพิ่ม Port ไม่สำเร็จ' });
          return;
        }

        if (nameInput) nameInput.value = '';
        if (portInput) portInput.value = '';
        await Core.syncFromServer();
        Core.appendLog({
          target: `${data.target.host}:${data.target.port}`,
          level: 'success',
          message: `เพิ่ม "${data.target.name}" และบันทึกลง targets.json แล้ว`
        });
      } catch (err) {
        Core.appendLog({ target: `${host}:${port}`, level: 'error', message: `เพิ่ม Port ผิดพลาด: ${err.message}` });
      } finally {
        isMutating = false;
        renderTable();
      }
    });

    portTableBody?.addEventListener('click', async (e) => {
      if (isMutating) return;
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;

      const action = btn.dataset.action;
      const idx = Number(btn.dataset.idx);
      const targets = cloneTargets(Core.getTargets());
      const t = targets[idx];
      if (!t) return;
      const key = `${t.host}:${t.port}`;

      if (action === 'set-open') {
        t.enabled = true;
        if (await saveTargets(targets)) {
          Core.appendLog({ target: key, level: 'success', message: `ตั้ง "${t.name}" เป็น เปิดใช้งาน (Start All จะทำงานที่ Port นี้)` });
        }
      } else if (action === 'set-pause') {
        t.enabled = false;
        if (Core.getRunningKeys().includes(key)) {
          await Core.stopTargetByKey(key);
        }
        if (await saveTargets(targets)) {
          Core.appendLog({ target: key, level: 'warn', message: `ตั้ง "${t.name}" เป็น พักงาน (Start All จะไม่ทำงานที่ Port นี้)` });
        }
      } else if (action === 'check') {
        await checkSinglePort(idx);
      } else if (action === 'up' && idx > 0) {
        [targets[idx - 1], targets[idx]] = [targets[idx], targets[idx - 1]];
        if (await saveTargets(targets)) {
          Core.appendLog({ target: 'PORT-MGR', level: 'info', message: `เลื่อนลำดับที่ ${idx + 1} ขึ้นเป็น ${idx} (บันทึกแล้ว)` });
        }
      } else if (action === 'down' && idx < targets.length - 1) {
        [targets[idx + 1], targets[idx]] = [targets[idx], targets[idx + 1]];
        if (await saveTargets(targets)) {
          Core.appendLog({ target: 'PORT-MGR', level: 'info', message: `เลื่อนลำดับที่ ${idx + 1} ลงเป็น ${idx + 2} (บันทึกแล้ว)` });
        }
      } else if (action === 'del') {
        if (Core.getRunningKeys().includes(key)) {
          await Core.stopTargetByKey(key);
        }
        targets.splice(idx, 1);
        if (await saveTargets(targets)) {
          Core.appendLog({ target: key, level: 'warn', message: `ลบ "${t.name}" และอัปเดต targets.json แล้ว` });
        }
      }
    });

    document.getElementById('btnCheckAll')?.addEventListener('click', checkAllPorts);
    renderTable();
  }

  Core.registerTab('1', {
    init,
    onActivate: renderTable
  });

  Core.syncFromServer();
})();