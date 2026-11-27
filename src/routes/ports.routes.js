const express = require('express');
const { checkPort } = require('../edge/portEdge');
const {
  TARGETS_FILE,
  SCRIPTS_FILE,
  readJsonSafe,
  writeJsonSafe,
  normalizeHost
} = require('../utils/storage');

function createPortsRouter({ runner, onTargetsChange }) {
  const router = express.Router();

  function notifyTargets(targets) {
    if (typeof onTargetsChange === 'function') {
      onTargetsChange(targets);
    }
  }

  router.get('/state', (req, res) => {
    res.json({
      targets: readJsonSafe(TARGETS_FILE, []),
      scripts: readJsonSafe(SCRIPTS_FILE, {}),
      running: runner.getRunningKeys()
    });
  });

  router.post('/targets', (req, res) => {
    const { name, host, port } = req.body || {};
    const cleanHost = normalizeHost(host);
    const numPort = Number(port);

    if (!cleanHost || !Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
      return res.status(400).json({ error: 'Valid host and port (1-65535) are required' });
    }

    const targets = readJsonSafe(TARGETS_FILE, []);
    const duplicate = targets.find(
      (t) => normalizeHost(t.host) === cleanHost && Number(t.port) === numPort
    );
    if (duplicate) {
      return res.status(409).json({ error: `Target ${cleanHost}:${numPort} already exists` });
    }

    const newTarget = {
      id: `t-${Date.now()}`,
      name: String(name || '').trim() || `Bot-Port-${numPort}`,
      host: cleanHost,
      port: numPort,
      enabled: true
    };

    targets.push(newTarget);
    writeJsonSafe(TARGETS_FILE, targets);
    notifyTargets(targets);
    res.status(201).json({ ok: true, target: newTarget, targets });
  });

  router.put('/targets', (req, res) => {
    const { targets } = req.body || {};
    if (!Array.isArray(targets)) {
      return res.status(400).json({ error: 'targets array is required' });
    }

    const normalized = targets
      .map((t, idx) => ({
        id: t.id || `t-${Date.now()}-${idx}`,
        name: String(t.name || '').trim() || `Bot-Port-${Number(t.port) || idx + 1}`,
        host: normalizeHost(t.host || '127.0.0.1'),
        port: Number(t.port),
        enabled: t.enabled !== false
      }))
      .filter((t) => t.host && Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535);

    writeJsonSafe(TARGETS_FILE, normalized);
    notifyTargets(normalized);
    res.json({ ok: true, targets: normalized });
  });

  router.post('/targets/check', async (req, res) => {
    const { host, port } = req.body || {};
    const cleanHost = normalizeHost(host);
    const numPort = Number(port);
    if (!cleanHost || !Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
      return res.status(400).json({ error: 'Valid host and port are required' });
    }
    const result = await checkPort(cleanHost, numPort, 2000);
    res.json(result);
  });

  router.post('/control/start', async (req, res) => {
    const { targetKey, scriptName } = req.body || {};
    const targets = readJsonSafe(TARGETS_FILE, []);
    const target = targets.find(
      (t) => `${normalizeHost(t.host)}:${Number(t.port)}` === targetKey
    );

    if (!target) {
      return res.status(404).json({ error: `Target "${targetKey}" not found` });
    }
    if (target.enabled === false) {
      return res.status(400).json({ error: `Target "${targetKey}" is disabled` });
    }

    const result = await runner.start(target, scriptName);
    if (!result.ok) {
      return res.status(400).json(result);
    }

    res.json({ ok: true, running: runner.getRunningKeys() });
  });

  router.post('/control/stop', (req, res) => {
    const { targetKey } = req.body || {};
    if (!targetKey) {
      return res.status(400).json({ error: 'targetKey is required' });
    }
    const result = runner.stop(targetKey);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json({ ok: true, running: runner.getRunningKeys() });
  });

  return router;
}

module.exports = { createPortsRouter };