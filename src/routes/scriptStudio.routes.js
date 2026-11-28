const fs = require('fs');
const path = require('path');
const express = require('express');
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

function createScriptStudioRouter({ onLog }) {
  const router = express.Router();
  const log = (target, message, level = 'info') => {
    if (typeof onLog === 'function') onLog(target, message, level);
  };

  /* ดึงรายชื่อสคริปต์ทั้งหมด */
  router.get('/scripts', (req, res) => {
    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    res.json({ ok: true, scripts });
  });

  /* สร้างหรือบันทึกสคริปต์ (รองรับเปลี่ยนชื่อด้วย oldName) */
  router.post('/scripts', (req, res) => {
    const { name, oldName, lines } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'กรุณาระบุชื่อสคริปต์' });
    }
    if (!Array.isArray(lines)) {
      return res.status(400).json({ error: 'รูปแบบ lines ต้องเป็น array' });
    }

    const scripts = readJsonSafe(SCRIPTS_FILE, {});
    const cleanOld = String(oldName || '').trim();

    if (cleanOld && cleanOld !== cleanName && Object.prototype.hasOwnProperty.call(scripts, cleanOld)) {
      if (Object.prototype.hasOwnProperty.call(scripts, cleanName)) {
        return res.status(409).json({ error: `มีสคริปต์ชื่อ "${cleanName}" อยู่แล้ว` });
      }
      delete scripts[cleanOld];
    }

    scripts[cleanName] = lines.map((l) => String(l));
    writeJsonSafe(SCRIPTS_FILE, scripts);
    log('SCRIPT', `บันทึกสคริปต์ "${cleanName}" (${scripts[cleanName].length} บรรทัด)`, 'success');
    res.json({ ok: true, name: cleanName, scripts });
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
    const tag = targetKey || 'CAPTURE';
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
    const targets = readJsonSafe(TARGETS_FILE, []);
    const target = targets.find(
      (t) => `${normalizeHost(t.host)}:${Number(t.port)}` === String(targetKey || '').trim()
    );

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
    const targets = readJsonSafe(TARGETS_FILE, []);
    const target = targets.find(
      (t) => `${normalizeHost(t.host)}:${Number(t.port)}` === String(targetKey || '').trim()
    );

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