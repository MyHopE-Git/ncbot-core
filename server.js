const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createScriptRunner } = require('./src/runner/scriptRunner');
const {
  PUBLIC_DIR,
  SCRIPTS_FILE,
  ensureStorageFiles,
  readJsonSafe
} = require('./src/utils/storage');
const { createPortsRouter } = require('./src/routes/ports.routes');
const { createScriptStudioRouter } = require('./src/routes/scriptStudio.routes');

const PORT = 3000;
ensureStorageFiles();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(raw);
    }
  }
}

function pushLog(targetKey, message, level = 'info') {
  broadcast({
    type: 'log',
    data: {
      time: new Date().toLocaleTimeString('th-TH', { hour12: false }),
      target: targetKey,
      level,
      message
    }
  });
}

const runner = createScriptRunner({
  getScripts: () => readJsonSafe(SCRIPTS_FILE, {}),
  onLog: (targetKey, message, level) => pushLog(targetKey, message, level),
  onStatusChange: (runningKeys) => broadcast({ type: 'status', running: runningKeys })
});

// โมดูล Tab 1: Port Manager & Global Control
app.use('/api', createPortsRouter({
  runner,
  onTargetsChange: (targets) => broadcast({ type: 'targets', targets })
}));

// โมดูล Tab 2: Script Studio (สคริปต์, ทดสอบ, ถ่ายรูป/Crop ขนาดต้นฉบับ, คลังรูป, พิกัด X,Y)
app.use('/api/script-studio', createScriptStudioRouter({
  onLog: pushLog
}));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', running: runner.getRunningKeys() }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NCBot Core running at http://127.0.0.1:${PORT}`);
});