(() => {
  const Core = window.NCBotCore;
  if (!Core) return;

  const TEMPLATES = {
    basic_loop: [
      '# ปลุกจอและทดสอบการเชื่อมต่อ CDP',
      'const holdMs = 3000;',
      'const cdp = await createCdp(page);',
      'try {',
      '  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));',
      '  const cx = Math.round(size.w / 2);',
      '  const cy = Math.round(size.h / 2);',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });',
      '  await page.waitForTimeout(holdMs);',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", buttons: 0, clickCount: 1 });',
      '  console.log(`Wake done at (${cx},${cy})`);',
      '} finally {',
      '  await cdp.detach().catch(() => {});',
      '}'
    ],
    click_find: [
      '# เดินด้วย WASD',
      'const code = "KeyW";',
      'const ms = 1000;',
      'await page.keyboard.down(code);',
      'try {',
      '  await page.waitForTimeout(ms);',
      '} finally {',
      '  await page.keyboard.up(code);',
      '}',
      'console.log(`Walk WASD done (${code},${ms}ms)`);'
    ],
    send_cmd: [
      '# คลิกขวาเดินอิงจากกลางจอ',
      'const offsetX = 120;',
      'const holdMs = 150;',
      'const cdp = await createCdp(page);',
      'try {',
      '  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));',
      '  const cx = Math.round(size.w / 2);',
      '  const cy = Math.round(size.h / 2);',
      '  const tx = Math.max(10, Math.min(size.w - 10, cx + offsetX));',
      '  const ty = cy;',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tx, y: ty, button: "none" });',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tx, y: ty, button: "right", buttons: 2, clickCount: 1 });',
      '  if (holdMs > 0) await page.waitForTimeout(holdMs);',
      '  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "right", buttons: 0, clickCount: 1 });',
      '  console.log(`Right click at (${tx}, ${ty})`);', '} finally {', '  await cdp.detach().catch(() => {});', '}' ] };  let scriptsMap = {}; let currentScriptName = ''; let isTesting = false; let stopTestRequested = false; let activeLineNum = null;  let toolMode = 'coord'; // 'coord' \vert{} 'crop' let zoomScale = 1.0; let pickedCoord = null; // { x, y } in original image pixels let cropRect = null; // { x, y, w, h } in original image pixels let dragStartOrig = null; let isDraggingCrop = false;  // ผืนผ้าใบต้นฉบับความละเอียดจริง (1:1) const sourceCanvas = document.createElement('canvas'); const sourceCtx = sourceCanvas.getContext('2d'); let hasSourceImage = false;  const stageCanvas = document.getElementById('studioStageCanvas'); const stageCtx = stageCanvas?.getContext('2d'); const editorEl = document.getElementById('studioEditor'); const gutterEl = document.getElementById('editorLineGutter');  function getSelectedTargetKey() { const sel = document.getElementById('studioPortSelect'); return sel ? sel.value : ''; }  function renderPortOptions() { const sel = document.getElementById('studioPortSelect'); if (!sel) return; const prev = sel.value; const targets = Core.getTargets(); sel.innerHTML = '';  if (!targets.length) { const opt = document.createElement('option'); opt.value = ''; opt.textContent = '-- ยังไม่มี Port ในระบบ --'; sel.appendChild(opt); return; }  for (const t of targets) { const key = `${t.host}:${t.port}`; const statusTag = t.enabled === false ? '[พักงาน]' : '[เปิดใช้งาน]'; const opt = document.createElement('option'); opt.value = key; opt.textContent = `${t.name} (${key})${statusTag}`;
      sel.appendChild(opt);
    }

    if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }

  function renderLineGutter() {
    if (!editorEl || !gutterEl) return;
    const lines = (editorEl.value || '').split('\n');
    const count = Math.max(lines.length, 15);
    let html = '';
    for (let i = 1; i <= count; i++) {
      const cls = activeLineNum === i ? 'line-num is-active' : 'line-num';
      html += `<div class="${cls}">${i}</div>`;
    }
    gutterEl.innerHTML = html;
  }

  function insertAtCursor(textToInsert) {
    if (!editorEl) return;
    const start = editorEl.selectionStart ?? editorEl.value.length;
    const end = editorEl.selectionEnd ?? editorEl.value.length;
    const before = editorEl.value.slice(0, start);
    const after = editorEl.value.slice(end);
    editorEl.value = before + textToInsert + after;
    const nextPos = start + textToInsert.length;
    editorEl.focus();
    editorEl.setSelectionRange(nextPos, nextPos);
    renderLineGutter();
  }

  function renderScriptList() {
    const box = document.getElementById('scriptListBox');
    const nameInput = document.getElementById('scriptNameInput');
    if (!box) return;

    const names = Object.keys(scriptsMap);
    box.innerHTML = '';

    if (!names.length) {
      box.innerHTML = `<div style="font-size:12px; color:#8b9bb0; padding:8px;">ยังไม่มีสคริปต์ — กด "+ ใหม่" เพื่อสร้าง</div>`;
      return;
    }

    for (const name of names) {
      const item = document.createElement('div');
      item.className = `script-item ${name === currentScriptName ? 'active' : ''}`;
      item.innerHTML = `<span class="script-item-name">${Core.escapeHtml(name)}</span>`; item.addEventListener('click', () => { currentScriptName = name; if (nameInput) nameInput.value = name; const lines = Array.isArray(scriptsMap[name]) ? scriptsMap[name] : []; if (editorEl) { editorEl.value = lines.join('\n'); delete editorEl.dataset.dirty; } activeLineNum = null; renderLineGutter(); renderScriptList(); }); box.appendChild(item); } }  async function loadScripts() { try { const res = await fetch('/api/script-studio/scripts', { cache: 'no-store' }); const data = await res.json(); if (!res.ok) throw new Error(data.error \vert{}\vert{} 'โหลดสคริปต์ไม่สำเร็จ'); scriptsMap = data.scripts && typeof data.scripts === 'object' ? data.scripts : {};  if (!currentScriptName \vert{}\vert{} !Object.prototype.hasOwnProperty.call(scriptsMap, currentScriptName)) { currentScriptName = Object.keys(scriptsMap)[0] \vert{}\vert{} ''; } const nameInput = document.getElementById('scriptNameInput'); if (currentScriptName && nameInput) { nameInput.value = currentScriptName; if (editorEl && !editorEl.dataset.dirty) { editorEl.value = (scriptsMap[currentScriptName] \vert{}\vert{} []).join('\n'); } } renderScriptList(); renderLineGutter(); } catch (err) { Core.appendLog({ target: 'SCRIPT', level: 'error', message: `โหลดรายชื่อสคริปต์พลาด: ${err.message}` });
    }
  }

  async function saveCurrentScript() {
    const nameInput = document.getElementById('scriptNameInput');
    const newName = (nameInput?.value || '').trim();
    if (!newName) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: 'กรุณาตั้งชื่อสคริปต์ก่อนบันทึก' });
      return;
    }
    const lines = (editorEl?.value || '').split(/\r?\n/);

    try {
      const res = await fetch('/api/script-studio/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          oldName: currentScriptName,
          lines
        })
      });
      const data = await res.json();
      if (!res.ok) {
        Core.appendLog({ target: 'SCRIPT', level: 'error', message: data.error || 'บันทึกสคริปต์ไม่สำเร็จ' });
        return;
      }
      currentScriptName = data.name;
      scriptsMap = data.scripts || scriptsMap;
      if (editorEl) delete editorEl.dataset.dirty;
      renderScriptList();
      await Core.syncFromServer();
    } catch (err) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `บันทึกสคริปต์ผิดพลาด: ${err.message}` }); } }  async function deleteCurrentScript() { const targetName = ((document.getElementById('scriptNameInput')?.value \vert{}\vert{} '') \vert{}\vert{} currentScriptName).trim(); if (!targetName) return;  try { const res = await fetch(`/api/script-studio/scripts/${encodeURIComponent(targetName)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) {
        Core.appendLog({ target: 'SCRIPT', level: 'error', message: data.error || 'ลบสคริปต์ไม่สำเร็จ' });
        return;
      }
      scriptsMap = data.scripts || {};
      currentScriptName = Object.keys(scriptsMap)[0] || '';
      const nameInput = document.getElementById('scriptNameInput');
      if (nameInput) nameInput.value = currentScriptName;
      if (editorEl) {
        editorEl.value = currentScriptName ? (scriptsMap[currentScriptName] || []).join('\n') : '';
        delete editorEl.dataset.dirty;
      }
      renderScriptList();
      await Core.syncFromServer();
    } catch (err) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `ลบสคริปต์ผิด