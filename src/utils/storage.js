const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');

function ensureStorageFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  if (!fs.existsSync(TARGETS_FILE)) {
    fs.writeFileSync(TARGETS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(SCRIPTS_FILE)) {
    fs.writeFileSync(
      SCRIPTS_FILE,
      JSON.stringify({ sample_flow: ['ping', 'log เริ่มต้นรอบการทำงาน', 'wait 1'] }, null, 2),
      'utf8'
    );
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeHost(host) {
  const h = String(host || '').trim();
  if (h.toLowerCase() === 'localhost') return '127.0.0.1';
  return h;
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  CAPTURES_DIR,
  PUBLIC_DIR,
  TARGETS_FILE,
  SCRIPTS_FILE,
  ensureStorageFiles,
  readJsonSafe,
  writeJsonSafe,
  normalizeHost
};