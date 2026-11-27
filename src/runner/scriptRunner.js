const { sendCommand } = require('../edge/portEdge');

function createScriptRunner({ getScripts, onLog, onStatusChange }) {
  const activeJobs = new Map(); // key: "host:port" -> { stopped: boolean }

  function getTargetKey(target) {
    return `${target.host}:${target.port}`;
  }

  function getRunningKeys() {
    return Array.from(activeJobs.keys());
  }

  function sleepInterruptible(ms, jobState) {
    return new Promise((resolve) => {
      if (jobState.stopped || ms <= 0) return resolve();
      const step = 100;
      let elapsed = 0;

      const timer = setInterval(() => {
        elapsed += step;
        if (jobState.stopped || elapsed >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, step);
    });
  }

  async function start(target, scriptName) {
    const key = getTargetKey(target);
    if (activeJobs.has(key)) {
      return { ok: false, error: `Target ${key} is already running` };
    }

    const scripts = getScripts();
    const lines = scripts[scriptName];
    if (!Array.isArray(lines)) {
      return { ok: false, error: `Script "${scriptName}" not found` };
    }

    const jobState = { stopped: false };
    activeJobs.set(key, jobState);
    onStatusChange(getRunningKeys());
    onLog(key, `Started script "${scriptName}"`, 'success');

    (async () => {
      try {
        while (!jobState.stopped) {
          const currentScripts = getScripts();
          const currentLines = currentScripts[scriptName] || [];

          for (const line of currentLines) {
            if (jobState.stopped) break;
            const cmd = String(line).trim();
            if (!cmd || cmd.startsWith('#')) continue;

            if (cmd.startsWith('wait ')) {
              const sec = Number(cmd.split(/\s+/)[1]);
              const waitSec = Number.isFinite(sec) && sec >= 0 ? sec : 1;
              onLog(key, `Waiting ${waitSec}s...`, 'info');
              await sleepInterruptible(waitSec * 1000, jobState);
              continue;
            }

            if (cmd.startsWith('log ')) {
              onLog(key, cmd.slice(4), 'info');
              continue;
            }

            const result = await sendCommand(target, cmd);
            if (result.ok) {
              onLog(key, result.data || `OK: ${cmd}`, 'success');
            } else {
              onLog(key, result.error || `Failed: ${cmd}`, 'error');
            }
          }

          if (!jobState.stopped) {
            await sleepInterruptible(500, jobState);
          }
        }
      } catch (err) {
        onLog(key, `Runner error: ${err.message}`, 'error');
      } finally {
        activeJobs.delete(key);
        onStatusChange(getRunningKeys());
        onLog(key, 'Stopped', 'warn');
      }
    })();

    return { ok: true };
  }

  function stop(targetKey) {
    const job = activeJobs.get(targetKey);
    if (!job) {
      return { ok: false, error: `Target ${targetKey} is not running` };
    }
    job.stopped = true;
    onLog(targetKey, 'Stop signal sent...', 'warn');
    return { ok: true };
  }

  return {
    start,
    stop,
    getRunningKeys
  };
}

module.exports = {
  createScriptRunner
};