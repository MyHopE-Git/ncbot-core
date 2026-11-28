const fs = require('fs');
const path = require('path');
const net = require('net');
const express = require('express');
const { chromium } = require('playwright');
const { sendCommand } = require('../edge/portEdge');
const { runPlaywrightScript } = require('../edge/playwrightEdge');
const {
  CAPTURES_DIR,
  TARGETS_FILE,
  SCRIPTS_FILE,
  readJsonSafe,
  writeJsonSafe,
  normalizeHost
} = require('../utils/storage');

function sanitizePngName(rawName) {
  const base = String(rawName || '')
    .trim()
    .replace(/\.png$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = base || `cap_${Date.now()}`;
  return `${safeBase}.png`;
}

function resolveSafeCapturePath(filename) {
  const clean = path.basename(String(filename || ''));
  if (!clean || !clean.toLowerCase().endsWith('.png')) return null;
  const fullPath = path.resolve(CAPTURES_DIR, clean);
  if (!fullPath.startsWith(path.resolve(CAPTURES_DIR) + path.sep)) return null;
  return fullPath;
}

function findTargetByKey(targetKey) {
  const key = String(targetKey || '').trim();
  if (!key) return null;
  const targets = readJsonSafe(TARGETS_FILE, []);
  return targets.find((t) => `${normalizeHost(t.host)}:${Number(t.port)}` === key) || null;
}

function pickTargetPage(browser) {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('ไม่พบ Browser Context จาก CDP');
  }
  const pages = context.pages();
  if (!pages.length) {
    throw new Error('ไม่พบแท็บหน้าเว็บใน CDP Target');
  }
  return pages.find((p) => (p.url() || '').includes('nightcamp.app')) || pages[0];
}

function checkTcpPortOpen(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(port), normalizeHost(host));
  });
}

function createScriptStudioRouter({ onLog }) {
  const router = express.Router();
  const log = (target, message, level = 'info') => {
    if (typeof onLog === 'function') onLog(target, message, level);
  };

  /* เก็บ session สตรีมมิ่ง CDP ต่อ targetKey เพื่อไม่ต้องเปิด-ปิด CDP ซ้ำ */
  const streamSessions = new Map();

  async function stopStreamSession(key, { silent = false } = {}) {
    const session = streamSessions.get(key);
    if (!session) return;
    streamSessions.delete(key);

    try {
      if (session.cdp) {
        await session.cdp.send('Page.stopScreencast').catch(() => {});
        await session.cdp.detach().catch(() => {});
      }
    } catch {}

    try {
      if (session.browser) {
        await session.browser.close().catch(() => {});
      }
    } catch {}

    if (!silent) {
      log(key, `[PW-STREAM] ปิดสตรีมมิ่ง CDP แล้ว`, 'warn');
    }
  }

  /* ดึงรายชื่อสคริปต์ทั้งหมด */
  router.get('/scripts', (req, res) => {
    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    res.json({ ok: true, scripts });
  });

  /* บันทึกสคริปต์: ชื่อเดิมเซฟทับได้ / ชื่อใหม่ต่อท้ายเรียงจากเก่าไปใหม่ / ชื่อซ้ำให้ยืนยันก่อน */
  router.post('/scripts', (req, res) => {
    const { name, currentName, lines, forceOverwrite, orderedNames } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'กรุณาระบุชื่อสคริปต์' });
    }
    if (!Array.isArray(lines)) {
      return res.status(400).json({ error: 'รูปแบบ lines ต้องเป็น array' });
    }

    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    const activeName = String(currentName || '').trim();
    const existsAlready = Object.prototype.hasOwnProperty.call(scripts, cleanName);

    if (existsAlready && cleanName !== activeName && !forceOverwrite) {
      return res.status(409).json({
        error: `มีสคริปต์ชื่อ "${cleanName}" อยู่แล้ว`
      });
    }

    scripts[cleanName] = lines.map((l) => String(l));

    const finalScripts = {};
    if (Array.isArray(orderedNames) && orderedNames.length) {
      for (const k of orderedNames) {
        if (Object.prototype.hasOwnProperty.call(scripts, k)) {
          finalScripts[k] = scripts[k];
        }
      }
    }
    for (const k of Object.keys(scripts)) {
      if (!Object.prototype.hasOwnProperty.call(finalScripts, k)) {
        finalScripts[k] = scripts[k];
      }
    }

    writeJsonSafe(SCRIPTS_FILE, finalScripts);
    log('SCRIPT', `บันทึกสคริปต์ "${cleanName}" (${finalScripts[cleanName].length} บรรทัด)`, 'success');
    res.json({ ok: true, name: cleanName, scripts: finalScripts });
  });

  /* บันทึกลำดับสคริปต์ (ลากเลื่อนขึ้น-ลง) */
  router.post('/scripts/reorder', (req, res) => {
    const { orderedNames } = req.body || {};
    if (!Array.isArray(orderedNames)) {
      return res.status(400).json({ error: 'orderedNames ต้องเป็น array' });
    }
    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    const reordered = {};
    for (const name of orderedNames) {
      if (Object.prototype.hasOwnProperty.call(scripts, name)) {
        reordered[name] = scripts[name];
      }
    }
    for (const name of Object.keys(scripts)) {
      if (!Object.prototype.hasOwnProperty.call(reordered, name)) {
        reordered[name] = scripts[name];
      }
    }
    writeJsonSafe(SCRIPTS_FILE, reordered);
    res.json({ ok: true, scripts: reordered });
  });

  /* ลบสคริปต์ */
  router.delete('/scripts/:name', (req, res) => {
    const targetName = decodeURIComponent(req.params.name || '').trim();
    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    if (!Object.prototype.hasOwnProperty.call(scripts, targetName)) {
      return res.status(404).json({ error: `ไม่พบสคริปต์ "${targetName}"` });
    }
    delete scripts[targetName];
    writeJsonSafe(SCRIPTS_FILE, scripts);
    log('SCRIPT', `ลบสคริปต์ "${targetName}" แล้ว`, 'warn');
    res.json({ ok: true, scripts });
  });

  /* เช็กสถานะเปิด/ปิดของ Port เป้าหมายแบบรวดเร็ว */
  router.post('/check-port', async (req, res) => {
    const { targetKey } = req.body || {};
    const target = findTargetByKey(targetKey);
    if (!target) {
      return res.json({ ok: true, open: false, reason: 'ไม่พบ Port ในระบบ' });
    }
    const open = await checkTcpPortOpen(target.host, target.port, 1200);
    res.json({ ok: true, open });
  });

  /* เริ่มสตรีมมิ่ง CDP (Page.startScreencast) แบบไม่ต้องปิด-เปิด CDP ซ้ำ */
  router.post('/stream/start', async (req, res) => {
    const { targetKey, quality, maxWidth, maxHeight, everyNthFrame } = req.body || {};
    const target = findTargetByKey(targetKey);
    if (!target) {
      return res.status(404).json({ error: `ไม่พบ Port "${targetKey}" ในระบบ` });
    }

    const host = normalizeHost(target.host);
    const port = Number(target.port);
    const key = `${host}:${port}`;
    const endpoint = `http://${host}:${port}`;

    await stopStreamSession(key, { silent: true });

    let browser = null;
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 6000 });
      const page = pickTargetPage(browser);
      const vp = await page.evaluate(() => ({
        vw: window.innerWidth || document.documentElement.clientWidth || 0,
        vh: window.innerHeight || document.documentElement.clientHeight || 0,
        dpr: window.devicePixelRatio || 1
      }));

      const context = page.context();
      const cdp = await context.newCDPSession(page);

      const session = {
        key,
        browser,
        page,
        cdp,
        viewport: vp,
        latestFrame: null,
        paused: false,
        updatedAt: 0
      };

      cdp.on('Page.screencastFrame', async (ev) => {
        if (session.paused) {
          await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
          return;
        }
        session.latestFrame = {
          dataUrl: `data:image/jpeg;base64,${ev.data}`,
          frameWidth: Number(ev.metadata?.deviceWidth) || 0,
          frameHeight: Number(ev.metadata?.deviceHeight) || 0,
          viewport: session.viewport,
          ts: Date.now()
        };
        session.updatedAt = session.latestFrame.ts;
        await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      });

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: Math.max(25, Math.min(85, Number(quality) || 50)),
        maxWidth: Number(maxWidth) || 1280,
        maxHeight: Number(maxHeight) || 720,
        everyNthFrame: Math.max(1, Number(everyNthFrame) || 2)
      });

      streamSessions.set(key, session);
      log(key, `[PW-STREAM] เริ่มสตรีมมิ่ง CDP แล้ว (${endpoint})`, 'success');
      res.json({ ok: true, viewport: vp });
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      log(key, `[PW-STREAM] เปิดสตรีมมิ่งไม่สำเร็จ: ${err.message}`, 'error');
      res.status(400).json({ error: `เปิดสตรีมมิ่ง CDP ไม่สำเร็จ: ${err.message}` });
    }
  });

  /* ดึงเฟรมล่าสุดจากสตรีมมิ่ง (เบาเครื่องมาก ไม่ต้องถ่ายรูปใหม่ทุกรอบ) */
  router.get('/stream/frame', (req, res) => {
    const key = String(req.query.targetKey || '').trim();
    const afterTs = Number(req.query.afterTs || 0);
    const session = streamSessions.get(key);
    if (!session) {
      return res.status(404).json({ error: 'ยังไม่ได้เปิดสตรีมมิ่งสำหรับ Port นี้' });
    }
    if (!session.latestFrame) {
      return res.json({ ok: true, frame: null, paused: session.paused });
    }
    if (afterTs > 0 && session.latestFrame.ts <= afterTs) {
      return res.json({ ok: true, unchanged: true, ts: session.latestFrame.ts, paused: session.paused });
    }
    return res.json({
      ok: true,
      frame: session.latestFrame,
      paused: session.paused
    });
  });

  /* พัก/เล่นต่อสตรีมมิ่งชั่วคราว (เช่น ตอนกำลัง Crop รูป) */
  router.post('/stream/pause', async (req, res) => {
    const { targetKey, paused } = req.body || {};
    const key = String(targetKey || '').trim();
    const session = streamSessions.get(key);
    if (!session) {
      return res.json({ ok: true, paused: Boolean(paused) });
    }
    session.paused = Boolean(paused);
    if (session.paused) {
      await session.cdp.send('Page.stopScreencast').catch(() => {});
    } else {
      await session.cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 50,
          maxWidth: 1280,
          maxHeight: 720,
          everyNthFrame: 2
        })
        .catch(() => {});
    }
    res.json({ ok: true, paused: session.paused });
  });

  /* หยุดสตรีมมิ่ง CDP */
  router.post('/stream/stop', async (req, res) => {
    const { targetKey } = req.body || {};
    const key = String(targetKey || '').trim();
    if (key) {
      await stopStreamSession(key);
    } else {
      for (const k of Array.from(streamSessions.keys())) {
        await stopStreamSession(k);
      }
    }
    res.json({ ok: true });
  });

  /* ถ่ายภาพนิ่ง .png 1 รูปผ่าน Playwright (ใช้ตอนต้องการภาพคมเพื่อ Crop หรือแคปนิ่ง) */
  router.post('/screenshot', async (req, res) => {
    const { targetKey, quiet } = req.body || {};
    const target = findTargetByKey(targetKey);
    if (!target) {
      return res.status(404).json({ error: `ไม่พบ Port "${targetKey}" ในระบบ` });
    }

    const host = normalizeHost(target.host);
    const port = Number(target.port);
    const key = `${host}:${port}`;
    const endpoint = `http://${host}:${port}`;

    let browser = null;
    try {
      if (!quiet) {
        log(key, `[PW-SHOT] กำลังแคปภาพนิ่ง .png ผ่าน Playwright ที่ ${endpoint}...`, 'info');
      }
      browser = await chromium.connectOverCDP(endpoint, { timeout: 6000 });
      const page = pickTargetPage(browser);

      const vp = await page.evaluate(() => ({
        vw: window.innerWidth || document.documentElement.clientWidth || 0,
        vh: window.innerHeight || document.documentElement.clientHeight || 0,
        dpr: window.devicePixelRatio || 1
      }));

      const buf = await page.screenshot({ type: 'png' });

      if (!quiet) {
        log(key, `[PW-SHOT] แคปภาพนิ่ง .png สำเร็จ (${key})`, 'success');
      }

      res.json({
        ok: true,
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
        viewport: vp
      });
    } catch (err) {
      if (!quiet) {
        log(key, `[PW-SHOT] แคปภาพไม่สำเร็จ: ${err.message}`, 'error');
      }
      res.status(400).json({ error: `แคปภาพผ่าน Playwright ไม่สำเร็จ: ${err.message}` });
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  });

  /* รายการไฟล์รูป .png ในคลัง */
  router.get('/captures', (req, res) => {
    try {
      const files = fs
        .readdirSync(CAPTURES_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.png'))
        .map((d) => {
          const full = path.join(CAPTURES_DIR, d.name);
          const stat = fs.statSync(full);
          return {
            name: d.name,
            url: `/api/script-studio/captures/${encodeURIComponent(d.name)}`,
            sizeBytes: stat.size,
            updatedAt: stat.mtimeMs
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);

      res.json({ ok: true, files });
    } catch (err) {
      res.status(500).json({ error: `อ่านคลังรูปภาพไม่สำเร็จ: ${err.message}` });
    }
  });

  /* เปิดไฟล์รูป .png */
  router.get('/captures/:filename', (req, res) => {
    const fullPath = resolveSafeCapturePath(req.params.filename);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).send('Image not found');
    }
    res.type('image/png').sendFile(fullPath);
  });

  /* เซฟภาพ Crop ขนาดต้นฉบับเป็น .png */
  router.post('/captures', (req, res) => {
    const { filename, dataUrl, width, height, targetKey } = req.body || {};
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!match) {
      return res.status(400).json({ error: 'ข้อมูลภาพต้องเป็น data:image/png;base64' });
    }

    const safeName = sanitizePngName(filename);
    const fullPath = path.join(CAPTURES_DIR, safeName);
    const buf = Buffer.from(match[1], 'base64');
    if (!buf.length) {
      return res.status(400).json({ error: 'ไฟล์ภาพว่างเปล่า' });
    }

    fs.writeFileSync(fullPath, buf);
    const dimText = width && height ? ` (${width}x${height}px ต้นฉบับ)` : '';
    const tag = targetKey || 'PW-CROP';
    log(tag, `บันทึกรูป "${safeName}"${dimText} ลงคลังรูปแล้ว`, 'success');

    res.status(201).json({
      ok: true,
      file: {
        name: safeName,
        url: `/api/script-studio/captures/${encodeURIComponent(safeName)}`,
        sizeBytes: buf.length,
        updatedAt: Date.now()
      }
    });
  });

  /* ลบรูปออกจากคลัง */
  router.delete('/captures/:filename', (req, res) => {
    const fullPath = resolveSafeCapturePath(req.params.filename);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'ไม่พบไฟล์รูปภาพนี้' });
    }
    fs.unlinkSync(fullPath);
    log('CAPTURE', `ลบรูป "${path.basename(fullPath)}" แล้ว`, 'warn');
    res.json({ ok: true });
  });

  /* ทดสอบรัน 1 บรรทัดบน Port เป้าหมายที่เลือก */
  router.post('/test-line', async (req, res) => {
    const { targetKey, line, lineNumber } = req.body || {};
    const cmd = String(line || '').trim();
    const target = findTargetByKey(targetKey);

    if (!target) {
      return res.status(404).json({ error: `ไม่พบ Port "${targetKey}" ในระบบ` });
    }
    if (!cmd || cmd.startsWith('#')) {
      return res.json({ ok: true, skipped: true, detail: 'ข้ามบรรทัดว่าง/คอมเมนต์' });
    }

    const prefix = lineNumber ? ` [L${lineNumber}]` : '';
    if (cmd.startsWith('log ')) {
      const msg = cmd.slice(4);
      log(targetKey, `[TEST${prefix}] ${msg}`, 'info');
      return res.json({ ok: true, detail: msg });
    }

    if (cmd.startsWith('wait ')) {
      const sec = Number(cmd.split(/\s+/)[1]);
      const waitSec = Number.isFinite(sec) && sec >= 0 ? sec : 1;
      const ms = Math.min(waitSec * 1000, 10000);
      log(targetKey, `[TEST${prefix}] รอ ${waitSec}s...`, 'info');
      await new Promise((r) => setTimeout(r, ms));
      return res.json({ ok: true, detail: `Waited ${waitSec}s` });
    }

    const result = await sendCommand(target, cmd);
    if (result.ok) {
      log(targetKey, `[TEST${prefix}] ${result.data || cmd}`, 'success');
      return res.json({ ok: true, detail: result.data || cmd });
    }

    log(targetKey, `[TEST${prefix}] ${result.error || cmd}`, 'error');
    return res.status(400).json({ ok: false, error: result.error || 'คำสั่งทดสอบไม่สำเร็จ' });
  });

  /* รันสคริปต์ Playwright จริงบน Port เป้าหมายที่เลือกใน Tab 2 */
  router.post('/test-playwright', async (req, res) => {
    const { targetKey, code, timeoutMs } = req.body || {};
    const target = findTargetByKey(targetKey);

    if (!target) {
      return res.status(404).json({ error: `ไม่พบ Port "${targetKey}" ในระบบ` });
    }

    const result = await runPlaywrightScript({
      target,
      code,
      timeoutMs: Number(timeoutMs) || 30000,
      onLog: log
    });

    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json(result);
  });

  return router;
}

module.exports = { createScriptStudioRouter };