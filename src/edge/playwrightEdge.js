const vm = require('vm');
const { chromium } = require('playwright');
const { normalizeHost } = require('../utils/storage');

async function resolveNightcampPage(browser) {
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    throw new Error('ไม่พบ Browser Context จากการเชื่อมต่อ CDP');
  }
  const pages = context.pages();
  if (!pages.length) {
    throw new Error('ไม่พบแท็บ/หน้าเว็บที่เปิดอยู่ใน CDP Target');
  }
  const page = pages.find((p) => (p.url() || '').includes('nightcamp.app')) || pages[0];
  return { context, page };
}

async function runPlaywrightScript({ target, code, timeoutMs = 30000, onLog }) {
  if (!target || !target.host || !target.port) {
    return { ok: false, error: 'ไม่ได้ระบุ Port เป้าหมาย (host/port)' };
  }

  const host = normalizeHost(target.host);
  const port = Number(target.port);
  const targetKey = `${host}:${port}`;
  const endpoint = `http://${host}:${port}`;
  const scriptCode = String(code || '').trim();

  if (!scriptCode) {
    return { ok: false, error: 'สคริปต์ว่างเปล่า' };
  }

  const logFn = (msg, level = 'info') => {
    if (typeof onLog === 'function') {
      onLog(targetKey, msg, level);
    }
  };

  let browser = null;
  const activeCdpSessions = new Set();

  const createCdp = async (targetPage) => {
    const ctx = browser.contexts()[0];
    const session = await ctx.newCDPSession(targetPage);
    activeCdpSessions.add(session);
    return session;
  };

  try {
    logFn(`[PW] กำลังเชื่อมต่อ CDP ที่ ${endpoint}...`, 'info');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    const { context, page } = await resolveNightcampPage(browser);

    const title = await page.title().catch(() => '');
    const url = page.url() || '';
    logFn(`[PW] เชื่อมต่อสำเร็จ (${targetKey}) | ${title} | ${url}`, 'success');

    // แปลง import { chromium } from 'playwright' หรือ import ... ออกอัตโนมัติ หากผู้ใช้ก๊อปโค้ดไฟล์เดี่ยวมาวางตรงๆ
    const normalizedCode = scriptCode
      .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
      .replace(/\bprocess\.exit\s*\(\s*\d*\s*\)\s*;?/g, '/* process.exit ignored in runner */');

    const wrappedSource = `(async () => {\n${normalizedCode}\n})()`;

    const sandbox = {
      console: {
        log: (...args) => logFn(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), 'info'),
        info: (...args) => logFn(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), 'info'),
        warn: (...args) => logFn(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), 'warn'),
        error: (...args) => logFn(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), 'error')
      },
      chromium,
      browser,
      context,
      page,
      target: { ...target, host, port, targetKey, endpoint },
      createCdp,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      JSON,
      parseInt,
      parseFloat,
      Number,
      String,
      Boolean,
      Array,
      Object
    };

    const vmContext = vm.createContext(sandbox);
    const executionPromise = vm.runInContext(wrappedSource, vmContext, {
      filename: `pw-${targetKey}.js`,
      timeout: timeoutMs
    });

    let timerId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`หมดเวลาทำงานสคริปต์ (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    const result = await Promise.race([executionPromise, timeoutPromise]).finally(() => {
      if (timerId) clearTimeout(timerId);
    });

    logFn(`[PW] รันสคริปต์บน ${targetKey} เสร็จสิ้น`, 'success');
    return { ok: true, result };
  } catch (err) {
    logFn(`[PW] ผิดพลาดบน ${targetKey}: ${err.message}`, 'error');
    return { ok: false, error: err.message };
  } finally {
    for (const s of activeCdpSessions) {
      await s.detach().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  runPlaywrightScript
};