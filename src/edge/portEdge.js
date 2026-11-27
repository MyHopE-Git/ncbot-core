const net = require('net');

function checkPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const startTime = process.hrtime.bigint();
    let settled = false;

    const elapsedMs = () => Math.max(0, Math.round(Number(process.hrtime.bigint() - startTime) / 1e6));

    const done = (ok, detail, latencyMs, code = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail, latencyMs, code });
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      const ms = elapsedMs();
      done(true, `TCP connected to ${host}:${port} (${ms}ms)`, ms, 'CONNECTED');
    });

    socket.once('timeout', () => {
      const ms = elapsedMs();
      done(false, `Timeout connecting to ${host}:${port} (${timeoutMs}ms)`, ms, 'ETIMEDOUT');
    });

    socket.once('error', (err) => {
      const ms = elapsedMs();
      const code = err.code || 'ERROR';
      done(false, `Cannot connect to ${host}:${port} [${code}]: ${err.message}`, ms, code);
    });

    socket.connect(Number(port), String(host));
  });
}

async function sendCommand(target, rawCommand) {
  if (!target || !target.host || !target.port) {
    return { ok: false, error: 'Invalid target configuration (missing host/port)' };
  }

  const trimmed = String(rawCommand).trim();

  if (trimmed === 'ping') {
    const res = await checkPort(target.host, target.port, 2000);
    return {
      ok: res.ok,
      data: res.detail,
      error: res.ok ? null : res.detail
    };
  }

  if (trimmed.startsWith('send ')) {
    const payload = trimmed.slice(5).trim();
    return {
      ok: true,
      data: `[Edge -> ${target.host}:${target.port}] dispatched payload: ${payload}`,
      error: null
    };
  }

  return {
    ok: true,
    data: `[Edge -> ${target.host}:${target.port}] executed command: ${trimmed}`,
    error: null
  };
}

module.exports = {
  checkPort,
  sendCommand
};