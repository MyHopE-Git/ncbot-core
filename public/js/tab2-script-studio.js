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
      '  console.log(`Wake done at (${cx}, ${cy})`);',
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
      'console.log(`Walk WASD done (${code}, ${ms}ms)`);'
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
      '  console.log(`Right click at (${tx}, ${ty})`);',
      '} finally {',
      '  await cdp.detach().catch(() => {});',
      '}'
    ]
  };

  let scriptsMap = {};
  let currentScriptName = '';
  let draggedScriptName = '';
  let isTesting = false;
  let stopTestRequested = false;
  let activeLineNum = null;

  let isPortReady = false;
  let portCheckSeq = 0;

  let isGalleryCollapsed = false;

  let toolMode = 'coord'; // 'coord' | 'crop'
  let zoomScale = 1.0;
  let pickedImgCoord = null;
  let pickedPwCoord = null;
  let cropRect = null;
  let dragStartOrig = null;
  let isDraggingCrop = false;

  let pwViewport = { vw: 0, vh: 0, dpr: 1 };

  let isStreaming = false;
  let isStreamPausedForCrop = false;
  let streamPollTimer = null;
  let isPollingFrame = false;
  let lastFrameTs = 0;
  let activeStreamKey = '';

  const sourceCanvas = document.createElement('canvas');
  const sourceCtx = sourceCanvas.getContext('2d');
  let hasSourceImage = false;

  const stageCanvas = document.getElementById('studioStageCanvas');
  const stageCtx = stageCanvas?.getContext('2d');
  const editorEl = document.getElementById('studioEditor');
  const gutterEl = document.getElementById('editorLineGutter');

  function getSelectedTargetKey() {
    const sel = document.getElementById('studioPortSelect');
    return sel ? sel.value : '';
  }

  function updateTestBadge() {
    const badge = document.getElementById('testStateBadge');
    if (!badge) return;

    if (isTesting) {
      badge.textContent = 'กำลังทดสอบ PW...';
      badge.className = 'badge active';
      return;
    }

    if (isPortReady) {
      badge.textContent = 'พร้อมทดสอบ';
      badge.className = 'badge active';
    } else {
      badge.textContent = 'ไม่พร้อมทดสอบ';
      badge.className = 'badge badge-danger';
    }
  }

  async function refreshSelectedPortStatus() {
    const key = getSelectedTargetKey();
    const seq = ++portCheckSeq;

    if (!key) {
      isPortReady = false;
      updateTestBadge();
      return;
    }

    const targetObj = Core.getTargets().find((t) => `${t.host}:${t.port}` === key);
    if (targetObj && targetObj.lastStatus === 'open') {
      isPortReady = true;
      updateTestBadge();
    }

    try {
      const res = await fetch('/api/script-studio/check-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: key })
      });
      const data = await res.json();
      if (seq !== portCheckSeq) return;
      isPortReady = Boolean(res.ok && data.open);
      updateTestBadge();
    } catch {
      if (seq !== portCheckSeq) return;
      isPortReady = false;
      updateTestBadge();
    }
  }

  function renderPortOptions() {
    const sel = document.getElementById('studioPortSelect');
    if (!sel) return;
    const prev = sel.value;
    const targets = Core.getTargets();
    sel.innerHTML = '';

    if (!targets.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '-- ยังไม่มี Port ในระบบ --';
      sel.appendChild(opt);
      refreshSelectedPortStatus();
      return;
    }

    for (const t of targets) {
      const key = `${t.host}:${t.port}`;
      const statusTag = t.enabled === false ? '[พักงาน]' : '[เปิดใช้งาน]';
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${t.name} (${key}) ${statusTag}`;
      sel.appendChild(opt);
    }

    if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    }
    refreshSelectedPortStatus();
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

  async function persistScriptOrder(orderedNames) {
    try {
      const res = await fetch('/api/script-studio/scripts/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedNames })
      });
      const data = await res.json();
      if (res.ok && data.scripts) {
        scriptsMap = data.scripts;
        await Core.syncFromServer();
      }
    } catch (err) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `บันทึกลำดับสคริปต์พลาด: ${err.message}` });
    }
  }

  function moveScriptInOrder(fromName, toName) {
    if (!fromName || !toName || fromName === toName) return;
    const keys = Object.keys(scriptsMap);
    const fromIdx = keys.indexOf(fromName);
    const toIdx = keys.indexOf(toName);
    if (fromIdx === -1 || toIdx === -1) return;

    keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, fromName);

    const nextMap = {};
    for (const k of keys) nextMap[k] = scriptsMap[k];
    scriptsMap = nextMap;
    renderScriptList();
    persistScriptOrder(keys);
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

    names.forEach((name, idx) => {
      const lineCount = Array.isArray(scriptsMap[name]) ? scriptsMap[name].length : 0;
      const item = document.createElement('div');
      item.className = `script-item ${name === currentScriptName ? 'active' : ''}`;
      item.draggable = true;
      item.title = `คลิกโหลด หรือคลิกค้างเพื่อลากเลื่อนลำดับ "${name}"`;
      item.innerHTML = `
        <span class="script-drag-handle" title="ลากขึ้น-ลง">⋮⋮</span>
        <span class="script-item-idx">${idx + 1}.</span>
        <span class="script-item-name">${Core.escapeHtml(name)}</span>
        <span class="script-item-meta">${lineCount}L</span>
      `;

      item.addEventListener('click', () => {
        currentScriptName = name;
        if (nameInput) nameInput.value = name;
        const lines = Array.isArray(scriptsMap[name]) ? scriptsMap[name] : [];
        if (editorEl) {
          editorEl.value = lines.join('\n');
          delete editorEl.dataset.dirty;
        }
        activeLineNum = null;
        renderLineGutter();
        renderScriptList();
      });

      item.addEventListener('dragstart', (e) => {
        draggedScriptName = name;
        item.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', name);
        }
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (draggedScriptName && draggedScriptName !== name) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const sourceName = draggedScriptName || e.dataTransfer?.getData('text/plain') || '';
        draggedScriptName = '';
        moveScriptInOrder(sourceName, name);
      });

      item.addEventListener('dragend', () => {
        draggedScriptName = '';
        item.classList.remove('dragging');
        box.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      });

      box.appendChild(item);
    });
  }

  async function loadScripts() {
    try {
      const res = await fetch('/api/script-studio/scripts', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'โหลดสคริปต์ไม่สำเร็จ');
      scriptsMap = data.scripts && typeof data.scripts === 'object' ? data.scripts : {};

      if (!currentScriptName || !Object.prototype.hasOwnProperty.call(scriptsMap, currentScriptName)) {
        currentScriptName = Object.keys(scriptsMap)[0] || '';
      }
      const nameInput = document.getElementById('scriptNameInput');
      if (currentScriptName && nameInput) {
        nameInput.value = currentScriptName;
        if (editorEl && !editorEl.dataset.dirty) {
          editorEl.value = (scriptsMap[currentScriptName] || []).join('\n');
        }
      }
      renderScriptList();
      renderLineGutter();
    } catch (err) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `โหลดรายชื่อสคริปต์พลาด: ${err.message}` });
    }
  }

  async function saveCurrentScript(forceOverwrite = false) {
    const nameInput = document.getElementById('scriptNameInput');
    const newName = (nameInput?.value || '').trim();
    if (!newName) {
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: 'กรุณาตั้งชื่อสคริปต์ก่อนบันทึก' });
      return;
    }

    const existsAlready = Object.prototype.hasOwnProperty.call(scriptsMap, newName);
    if (existsAlready && !forceOverwrite) {
      const msg =
        newName === currentScriptName
          ? `ต้องการบันทึกทับสคริปต์ชื่อ "${newName}" ใช่หรือไม่?`
          : `มีสคริปต์ชื่อ "${newName}" อยู่แล้ว ต้องการบันทึกทับใช่หรือไม่?`;
      if (!window.confirm(msg)) {
        Core.appendLog({ target: 'SCRIPT', level: 'warn', message: `ยกเลิกการบันทึกทับ "${newName}"` });
        return;
      }
      forceOverwrite = true;
    }

    const lines = (editorEl?.value || '').split(/\r?\n/);
    const orderedNames = Object.keys(scriptsMap);
    if (!orderedNames.includes(newName)) {
      orderedNames.push(newName);
    }

    try {
      const res = await fetch('/api/script-studio/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          currentName: currentScriptName,
          lines,
          forceOverwrite,
          orderedNames
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
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `บันทึกสคริปต์ผิดพลาด: ${err.message}` });
    }
  }

  async function deleteCurrentScript() {
    const targetName = ((document.getElementById('scriptNameInput')?.value || '') || currentScriptName).trim();
    if (!targetName) return;

    if (!window.confirm(`ต้องการลบสคริปต์ชื่อ "${targetName}" ใช่หรือไม่?`)) {
      Core.appendLog({ target: 'SCRIPT', level: 'warn', message: `ยกเลิกการลบสคริปต์ "${targetName}"` });
      return;
    }

    try {
      const res = await fetch(`/api/script-studio/scripts/${encodeURIComponent(targetName)}`, {
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
      Core.appendLog({ target: 'SCRIPT', level: 'error', message: `ลบสคริปต์ผิดพลาด: ${err.message}` });
    }
  }

  function setGalleryCollapsed(collapsed) {
    isGalleryCollapsed = Boolean(collapsed);
    const body = document.getElementById('galleryBody');
    const btn = document.getElementById('btnToggleGallery');
    if (body) body.style.display = isGalleryCollapsed ? 'none' : '';
    if (btn) btn.textContent = isGalleryCollapsed ? 'เปิดดู' : 'พับเก็บ';
  }

  async function loadGallery() {
    const box = document.getElementById('galleryBox');
    if (!box) return;
    try {
      const res = await fetch('/api/script-studio/captures', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'โหลดคลังรูปไม่สำเร็จ');

      const files = Array.isArray(data.files) ? data.files : [];
      box.innerHTML = '';
      if (!files.length) {
        box.innerHTML = `<div style="grid-column:1/-1; font-size:12px; color:#8b9bb0; padding:8px;">ยังไม่มีรูปในคลัง — ลาก Crop แล้วกดเซฟ .png</div>`;
        return;
      }

      for (const f of files) {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.innerHTML = `
          <img src="${Core.escapeHtml(f.url)}?t=${f.updatedAt}" alt="${Core.escapeHtml(f.name)}" title="คลิกเพื่อแทรกชื่อไฟล์ ${Core.escapeHtml(f.name)}" />
          <div class="gallery-name" title="${Core.escapeHtml(f.name)}">${Core.escapeHtml(f.name)}</div>
          <div class="gallery-actions">
            <button class="btn-chip" data-img-insert="${Core.escapeHtml(f.name)}">แทรก</button>
            <button class="btn-del" data-img-del="${Core.escapeHtml(f.name)}">ลบ</button>
          </div>
        `;

        card.querySelector('img')?.addEventListener('click', () => {
          insertAtCursor(f.name);
          Core.appendLog({ target: 'GALLERY', level: 'info', message: `ส่งชื่อรูป "${f.name}" ไปที่สคริปต์แล้ว` });
        });
        card.querySelector('.gallery-name')?.addEventListener('click', () => {
          insertAtCursor(f.name);
        });
        card.querySelector('[data-img-insert]')?.addEventListener('click', () => {
          insertAtCursor(f.name);
        });
        card.querySelector('[data-img-del]')?.addEventListener('click', async () => {
          if (!window.confirm(`ต้องการลบรูป "${f.name}" ออกจากคลังใช่หรือไม่?`)) return;
          await fetch(`/api/script-studio/captures/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
          await loadGallery();
        });

        box.appendChild(card);
      }
    } catch (err) {
      Core.appendLog({ target: 'GALLERY', level: 'error', message: `โหลดคลังรูปพลาด: ${err.message}` });
    }
  }

  function setTestUiState(running) {
    isTesting = running;
    const btnAll = document.getElementById('btnTestAll');
    const btnStep = document.getElementById('btnTestStep');
    const btnStop = document.getElementById('btnTestStop');

    updateTestBadge();
    if (btnAll) btnAll.disabled = running;
    if (btnStep) btnStep.disabled = running;
    if (btnStop) btnStop.disabled = !running;
  }

  async function executePlaywrightCode(codeText, modeLabel = 'FULL SCRIPT') {
    const key = getSelectedTargetKey();
    if (!key) {
      Core.appendLog({ target: 'PW-TEST', level: 'error', message: 'กรุณาเลือก Port เป้าหมายก่อนทดสอบสคริปต์ Playwright' });
      return false;
    }

    const cleanCode = String(codeText || '').trim();
    if (!cleanCode) {
      Core.appendLog({ target: key, level: 'warn', message: 'ไม่มีโค้ด Playwright ให้ทดสอบ' });
      return false;
    }

    Core.appendLog({ target: key, level: 'info', message: `ส่งสคริปต์ Playwright (${modeLabel}) ไปยัง ${key}...` });
    try {
      const res = await fetch('/api/script-studio/test-playwright', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetKey: key,
          code: cleanCode,
          timeoutMs: 30000
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        Core.appendLog({ target: key, level: 'error', message: data.error || 'รัน Playwright ไม่สำเร็จ' });
        return false;
      }
      return true;
    } catch (err) {
      Core.appendLog({ target: key, level: 'error', message: `เชื่อมต่อ API ทดสอบ Playwright พลาด: ${err.message}` });
      return false;
    }
  }

  async function runAllTestLines() {
    if (isTesting) return;
    stopTestRequested = false;
    setTestUiState(true);
    try {
      if (stopTestRequested) return;
      await executePlaywrightCode(editorEl?.value || '', 'FULL SCRIPT');
    } finally {
      setTestUiState(false);
    }
  }

  async function runNextStepLine() {
    if (isTesting) return;
    const lines = (editorEl?.value || '').split(/\r?\n/);
    if (!lines.length) return;

    const nextIdx = activeLineNum && activeLineNum < lines.length ? activeLineNum : 0;
    const lineNum = nextIdx + 1;
    const singleLine = lines[nextIdx];
    activeLineNum = lineNum;
    renderLineGutter();

    setTestUiState(true);
    try {
      await executePlaywrightCode(singleLine, `LINE ${lineNum}`);
    } finally {
      setTestUiState(false);
    }
  }

  function mapImgCoordToPlaywrightViewport(imgX, imgY) {
    const imgW = sourceCanvas.width || 1;
    const imgH = sourceCanvas.height || 1;
    const targetW = pwViewport.vw > 0 ? pwViewport.vw : imgW;
    const targetH = pwViewport.vh > 0 ? pwViewport.vh : imgH;

    const pwX = Math.round((imgX / imgW) * targetW);
    const pwY = Math.round((imgY / imgH) * targetH);
    return { x: pwX, y: pwY };
  }

  function updateCoordReadout() {
    const readout = document.getElementById('coordReadout');
    if (!readout) return;
    if (!pickedPwCoord) {
      readout.textContent = 'PW พิกัด: X = -, Y = -';
      return;
    }
    readout.textContent = `PW พิกัด: X = ${pickedPwCoord.x}, Y = ${pickedPwCoord.y}`;
  }

  function applyImageDataUrl(dataUrl, viewportInfo, { quiet = false, resetSelection = true, sourceTag = 'PW' } = {}) {
    return new Promise((resolve) => {
      if (viewportInfo && typeof viewportInfo === 'object') {
        pwViewport = {
          vw: Number(viewportInfo.vw) || 0,
          vh: Number(viewportInfo.vh) || 0,
          dpr: Number(viewportInfo.dpr) || 1
        };
      }

      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return resolve(false);

        sourceCanvas.width = w;
        sourceCanvas.height = h;
        sourceCtx.clearRect(0, 0, w, h);
        sourceCtx.drawImage(img, 0, 0, w, h);
        hasSourceImage = true;

        if (resetSelection) {
          pickedImgCoord = null;
          pickedPwCoord = null;
          cropRect = null;
          updateCoordReadout();
        } else if (pickedImgCoord) {
          pickedPwCoord = mapImgCoordToPlaywrightViewport(pickedImgCoord.x, pickedImgCoord.y);
          updateCoordReadout();
        }

        const dimEl = document.getElementById('origDimText');
        if (dimEl) {
          const vpText = pwViewport.vw && pwViewport.vh ? ` | VP ${pwViewport.vw}x${pwViewport.vh}` : '';
          dimEl.textContent = `${sourceTag}: ${w}x${h}px${vpText}`;
        }

        renderStageCanvas();
        if (!quiet) {
          Core.appendLog({
            target: getSelectedTargetKey() || 'PW-SHOT',
            level: 'success',
            message: `อัปเดตภาพ ${sourceTag} (${w}x${h}px) สำเร็จ`
          });
        }
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });
  }

  async function captureStillPng({ quiet = false, resetSelection = true } = {}) {
    const key = getSelectedTargetKey();
    if (!key) {
      if (!quiet) {
        Core.appendLog({ target: 'PW-SHOT', level: 'error', message: 'กรุณาเลือก Port เป้าหมายก่อนดึงภาพผ่าน Playwright' });
      }
      return false;
    }

    try {
      const res = await fetch('/api/script-studio/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: key, quiet })
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.dataUrl) {
        if (!quiet) {
          Core.appendLog({ target: key, level: 'error', message: data.error || 'ดึงภาพนิ่ง .png ไม่สำเร็จ' });
        }
        return false;
      }
      return await applyImageDataUrl(data.dataUrl, data.viewport, {
        quiet,
        resetSelection,
        sourceTag: 'PNG'
      });
    } catch (err) {
      if (!quiet) {
        Core.appendLog({ target: key, level: 'error', message: `เรียก API ถ่ายภาพนิ่งพลาด: ${err.message}` });
      }
      return false;
    }
  }

  async function pauseStreamForCropAndSnap() {
    const key = getSelectedTargetKey();
    if (isStreaming && key) {
      isStreamPausedForCrop = true;
      await fetch('/api/script-studio/stream/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: key, paused: true })
      }).catch(() => {});
      Core.appendLog({ target: key, level: 'info', message: 'พักสตรีมชั่วคราวเพื่อถ่ายภาพ Crop .png' });
    }
    if (key) {
      await captureStillPng({ quiet: true, resetSelection: true });
    }
  }

  async function resumeStreamAfterCrop() {
    const key = activeStreamKey || getSelectedTargetKey();
    if (!isStreaming || !isStreamPausedForCrop || !key) return;
    isStreamPausedForCrop = false;
    await fetch('/api/script-studio/stream/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKey: key, paused: false })
    }).catch(() => {});
    Core.appendLog({ target: key, level: 'info', message: 'กลับมาสตรีมต่อแล้ว' });
  }

  function updateLiveButtonUi() {
    const btnLive = document.getElementById('btnToggleLive');
    if (!btnLive) return;
    if (isStreaming) {
      btnLive.textContent = 'หยุดสตรีม';
      btnLive.className = 'btn-stop';
    } else {
      btnLive.textContent = 'สตรีมสด (CDP)';
      btnLive.className = 'btn-start';
    }
  }

  function clearStreamPollTimer() {
    if (streamPollTimer) {
      clearTimeout(streamPollTimer);
      streamPollTimer = null;
    }
  }

  async function stopStream() {
    clearStreamPollTimer();
    const keyToStop = activeStreamKey || getSelectedTargetKey();
    isStreaming = false;
    isStreamPausedForCrop = false;
    isPollingFrame = false;
    activeStreamKey = '';
    lastFrameTs = 0;
    updateLiveButtonUi();

    if (keyToStop) {
      await fetch('/api/script-studio/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKey: keyToStop })
      }).catch(() => {});
    }
  }

  async function pollStreamFrames() {
    if (!isStreaming || !activeStreamKey) return;
    let hadNewFrame = false;

    if (!isStreamPausedForCrop && !isPollingFrame) {
      isPollingFrame = true;
      try {
        const res = await fetch(
          `/api/script-studio/stream/frame?targetKey=${encodeURIComponent(activeStreamKey)}&afterTs=${lastFrameTs}`,
          { cache: 'no-store' }
        );
        const data = await res.json();
        if (res.ok && data.ok && data.frame && data.frame.ts > lastFrameTs) {
          lastFrameTs = data.frame.ts;
          hadNewFrame = true;
          await applyImageDataUrl(data.frame.dataUrl, data.frame.viewport, {
            quiet: true,
            resetSelection: false,
            sourceTag: 'STREAM'
          });
        }
      } catch {} finally {
        isPollingFrame = false;
      }
    }

    if (!isStreaming) return;
    streamPollTimer = setTimeout(pollStreamFrames, hadNewFrame ? 50 : 120);
  }

  async function toggleStream() {
    if (isStreaming) {
      await stopStream();
      return;
    }

    const key = getSelectedTargetKey();
    if (!key) {
      Core.appendLog({ target: 'PW-STREAM', level: 'error', message: 'กรุณาเลือก Port เป้าหมายก่อนเริ่มสตรีม' });
      return;
    }

    try {
      const res = await fetch('/api/script-studio/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetKey: key,
          quality: 42,
          maxWidth: 960,
          maxHeight: 540,
          everyNthFrame: 2
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        Core.appendLog({ target: key, level: 'error', message: data.error || 'เริ่มสตรีมไม่สำเร็จ' });
        return;
      }

      isStreaming = true;
      isStreamPausedForCrop = false;
      activeStreamKey = key;
      lastFrameTs = 0;
      updateLiveButtonUi();
      pollStreamFrames();
    } catch (err) {
      Core.appendLog({ target: key, level: 'error', message: `เรียก API เริ่มสตรีมพลาด: ${err.message}` });
    }
  }

  function renderStageCanvas() {
    if (!stageCanvas || !stageCtx) return;
    if (!hasSourceImage) {
      stageCanvas.width = 460;
      stageCanvas.height = 250;
      stageCtx.fillStyle = '#090c10';
      stageCtx.fillRect(0, 0, stageCanvas.width, stageCanvas.height);
      stageCtx.fillStyle = '#7d8fa3';
      stageCtx.font = '13px Tahoma, Arial, sans-serif';
      stageCtx.fillText('กด "สตรีมสด (CDP)" เพื่อหาพิกัด X,Y สด หรือ "ดึงภาพหน้าจอ (PW)"', 18, 125);
      return;
    }

    const dispW = Math.max(1, Math.round(sourceCanvas.width * zoomScale));
    const dispH = Math.max(1, Math.round(sourceCanvas.height * zoomScale));
    stageCanvas.width = dispW;
    stageCanvas.height = dispH;

    stageCtx.imageSmoothingEnabled = zoomScale <= 1;
    stageCtx.clearRect(0, 0, dispW, dispH);
    stageCtx.drawImage(sourceCanvas, 0, 0, dispW, dispH);

    if (toolMode === 'coord' && pickedImgCoord) {
      const px = pickedImgCoord.x * zoomScale;
      const py = pickedImgCoord.y * zoomScale;
      stageCtx.strokeStyle = '#7ee787';
      stageCtx.lineWidth = 1.5;
      stageCtx.beginPath();
      stageCtx.moveTo(px - 12, py);
      stageCtx.lineTo(px + 12, py);
      stageCtx.moveTo(px, py - 12);
      stageCtx.lineTo(px, py + 12);
      stageCtx.stroke();
    }

    if (toolMode === 'crop' && cropRect && cropRect.w > 0 && cropRect.h > 0) {
      const rx = cropRect.x * zoomScale;
      const ry = cropRect.y * zoomScale;
      const rw = cropRect.w * zoomScale;
      const rh = cropRect.h * zoomScale;
      stageCtx.strokeStyle = '#4ea1ff';
      stageCtx.lineWidth = 2;
      stageCtx.strokeRect(rx, ry, rw, rh);
      stageCtx.fillStyle = 'rgba(78, 161, 255, 0.16)';
      stageCtx.fillRect(rx, ry, rw, rh);
    }
  }

  function pointerToImageCoord(e) {
    const rect = stageCanvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const ox = Math.max(0, Math.min(sourceCanvas.width - 1, Math.floor(cx / zoomScale)));
    const oy = Math.max(0, Math.min(sourceCanvas.height - 1, Math.floor(cy / zoomScale)));
    return { x: ox, y: oy };
  }

  async function setToolMode(mode) {
    toolMode = mode;
    const pill = document.getElementById('toolModePill');
    const coordPanel = document.getElementById('coordPanel');
    const cropPanel = document.getElementById('cropPanel');

    if (mode === 'crop') {
      if (pill) pill.textContent = 'โหมด: Crop เซฟ .png (พักสตรีม)';
      if (coordPanel) coordPanel.style.display = 'none';
      if (cropPanel) cropPanel.style.display = '';
      await pauseStreamForCropAndSnap();
    } else {
      if (pill) pill.textContent = 'โหมด: หาพิกัด X,Y (PW)';
      if (coordPanel) coordPanel.style.display = '';
      if (cropPanel) cropPanel.style.display = 'none';
      await resumeStreamAfterCrop();
    }
    renderStageCanvas();
  }

  async function saveCropToPng() {
    if (!hasSourceImage || !cropRect || cropRect.w < 1 || cropRect.h < 1) {
      Core.appendLog({ target: 'PW-CROP', level: 'warn', message: 'กรุณาลากกรอบเลือกพื้นที่ก่อนเซฟ .png' });
      return;
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.round(cropRect.w);
    outCanvas.height = Math.round(cropRect.h);
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(
      sourceCanvas,
      Math.round(cropRect.x),
      Math.round(cropRect.y),
      Math.round(cropRect.w),
      Math.round(cropRect.h),
      0,
      0,
      outCanvas.width,
      outCanvas.height
    );

    const nameInput = document.getElementById('cropFilenameInput');
    const rawName = (nameInput?.value || '').trim() || `pw_crop_${Date.now()}.png`;
    const dataUrl = outCanvas.toDataURL('image/png');

    try {
      const res = await fetch('/api/script-studio/captures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: rawName,
          dataUrl,
          width: outCanvas.width,
          height: outCanvas.height,
          targetKey: getSelectedTargetKey()
        })
      });
      const data = await res.json();
      if (!res.ok) {
        Core.appendLog({ target: 'PW-CROP', level: 'error', message: data.error || 'เซฟ .png ไม่สำเร็จ' });
        return;
      }
      if (nameInput) nameInput.value = '';
      await loadGallery();

      await setToolMode('coord');
    } catch (err) {
      Core.appendLog({ target: 'PW-CROP', level: 'error', message: `เซฟ .png ผิดพลาด: ${err.message}` });
    }
  }

  function init() {
    Core.onStateChange(() => {
      renderPortOptions();
    });

    document.getElementById('studioPortSelect')?.addEventListener('change', async () => {
      if (isStreaming) {
        await stopStream();
      }
      refreshSelectedPortStatus();
    });

    editorEl?.addEventListener('input', () => {
      editorEl.dataset.dirty = '1';
      renderLineGutter();
    });
    editorEl?.addEventListener('click', renderLineGutter);
    editorEl?.addEventListener('keyup', renderLineGutter);

    document.getElementById('btnNewScript')?.addEventListener('click', () => {
      const idx = Object.keys(scriptsMap).length + 1;
      const suggested = `pw_script_${idx}`;
      currentScriptName = '';
      const nameInput = document.getElementById('scriptNameInput');
      if (nameInput) nameInput.value = suggested;
      if (editorEl) {
        editorEl.value = 'console.log("Page URL:", page.url());\nawait page.waitForTimeout(500);\n';
        editorEl.dataset.dirty = '1';
      }
      activeLineNum = null;
      renderLineGutter();
      renderScriptList();
      nameInput?.focus();
    });

    document.getElementById('btnLoadTemplate')?.addEventListener('click', () => {
      const tplKey = document.getElementById('templateSelect')?.value;
      if (!tplKey || !TEMPLATES[tplKey] || !editorEl) return;
      editorEl.value = TEMPLATES[tplKey].join('\n');
      editorEl.dataset.dirty = '1';
      renderLineGutter();
      Core.appendLog({ target: 'SCRIPT', level: 'info', message: `โหลดตัวอย่างสคริปต์ Playwright "${tplKey}" แล้ว` });
    });

    document.getElementById('btnSaveScript')?.addEventListener('click', () => saveCurrentScript(false));
    document.getElementById('btnDeleteScript')?.addEventListener('click', deleteCurrentScript);
    document.getElementById('btnToggleGallery')?.addEventListener('click', () => setGalleryCollapsed(!isGalleryCollapsed));
    document.getElementById('btnRefreshGallery')?.addEventListener('click', loadGallery);

    document.querySelectorAll('[data-snippet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const snippet = btn.dataset.snippet || '';
        insertAtCursor(`${snippet}\n`);
      });
    });

    document.getElementById('btnTestAll')?.addEventListener('click', runAllTestLines);
    document.getElementById('btnTestStep')?.addEventListener('click', runNextStepLine);
    document.getElementById('btnTestStop')?.addEventListener('click', () => {
      stopTestRequested = true;
    });
    document.getElementById('btnClearEditorLineMark')?.addEventListener('click', () => {
      activeLineNum = null;
      renderLineGutter();
    });

    document.getElementById('btnGrabScreen')?.addEventListener('click', () => {
      captureStillPng({ quiet: false, resetSelection: true });
    });
    document.getElementById('btnToggleLive')?.addEventListener('click', toggleStream);
    document.getElementById('btnSwitchToCoord')?.addEventListener('click', () => setToolMode('coord'));
    document.getElementById('btnSwitchToCrop')?.addEventListener('click', () => setToolMode('crop'));

    document.getElementById('zoomSelect')?.addEventListener('change', (e) => {
      zoomScale = Number(e.target.value) || 1;
      renderStageCanvas();
    });

    stageCanvas?.addEventListener('mousedown', (e) => {
      if (!hasSourceImage) return;
      const pt = pointerToImageCoord(e);
      if (toolMode === 'coord') {
        pickedImgCoord = pt;
        pickedPwCoord = mapImgCoordToPlaywrightViewport(pt.x, pt.y);
        updateCoordReadout();
        renderStageCanvas();
      } else {
        isDraggingCrop = true;
        dragStartOrig = pt;
        cropRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
        renderStageCanvas();
      }
    });

    stageCanvas?.addEventListener('mousemove', (e) => {
      if (!hasSourceImage || toolMode !== 'crop' || !isDraggingCrop || !dragStartOrig) return;
      const cur = pointerToImageCoord(e);
      const x = Math.min(dragStartOrig.x, cur.x);
      const y = Math.min(dragStartOrig.y, cur.y);
      const w = Math.max(1, Math.abs(cur.x - dragStartOrig.x));
      const h = Math.max(1, Math.abs(cur.y - dragStartOrig.y));
      cropRect = { x, y, w, h };
      const readout = document.getElementById('cropReadout');
      if (readout) readout.textContent = `กรอบ PW: (${x}, ${y}) ${w}x${h} px`;
      renderStageCanvas();
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingCrop) {
        isDraggingCrop = false;
      }
    });

    document.getElementById('btnInsertCoordMove')?.addEventListener('click', () => {
      if (!pickedPwCoord) return;
      insertAtCursor(`await page.mouse.move(${pickedPwCoord.x}, ${pickedPwCoord.y});\n`);
    });

    document.getElementById('btnInsertCoordClick')?.addEventListener('click', () => {
      if (!pickedPwCoord) return;
      insertAtCursor(`await page.mouse.click(${pickedPwCoord.x}, ${pickedPwCoord.y});\n`);
    });

    document.getElementById('btnSaveCropPng')?.addEventListener('click', saveCropToPng);

    renderPortOptions();
    renderLineGutter();
    renderStageCanvas();
    updateLiveButtonUi();
    setToolMode('coord');
  }

  Core.registerTab('2', {
    init,
    onActivate: async () => {
      renderPortOptions();
      await refreshSelectedPortStatus();
      await loadScripts();
      await loadGallery();
      renderStageCanvas();
    }
  });
})();