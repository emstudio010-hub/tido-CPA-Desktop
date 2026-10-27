const net = require('net');
const http = require('http');
const { exec, execFile } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);
const WIN_SAFE_CWD = process.env.SystemRoot || 'C:\\Windows';

const OAUTH_PORTS = [
  { port: 1455, id: 'codex', name: 'OpenAI Codex OAuth', flag: '--codex-login' },
  { port: 54545, id: 'claude', name: 'Claude Code OAuth', flag: '--claude-login' },
  { port: 51121, id: 'antigravity', name: 'Google Antigravity OAuth', flag: '--antigravity-login' },
  { port: 8085, id: 'gemini', name: 'Gemini CLI OAuth', flag: '--gemini-login' },
  { port: 11451, id: 'kimi', name: 'Kimi Code OAuth', flag: '--kimi-login' }
];

function checkPortBindable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => {
      resolve(false);
    });
    srv.listen({ port: Number(port), host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

function checkPortListening(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(port), '127.0.0.1');
  });
}

async function isPortAvailable(port) {
  const listening = await checkPortListening(port);
  if (listening) return false;
  const bindable0 = await checkPortBindable(port, '0.0.0.0');
  if (!bindable0) return false;
  const bindable127 = await checkPortBindable(port, '127.0.0.1');
  return bindable127;
}

async function findPortOwner(port) {
  const targetPort = Number(port);
  if (!Number.isInteger(targetPort) || targetPort <= 0) return null;

  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
        cwd: WIN_SAFE_CWD,
        windowsHide: true,
        timeout: 3000
      });
      const lines = stdout.split(/\r?\n/);
      let foundPid = null;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('TCP')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddr = parts[1];
        const state = parts[3];
        const pid = parseInt(parts[4], 10);
        if (state === 'LISTENING' && (localAddr.endsWith(`:${targetPort}`) || localAddr.endsWith(`]:${targetPort}`))) {
          foundPid = pid;
          break;
        }
      }
      if (!foundPid) return null;
      let processName = 'Unknown Process';
      try {
        const { stdout: taskOut } = await execFileAsync(
          'tasklist.exe',
          ['/FI', `PID eq ${foundPid}`, '/FO', 'CSV', '/NH'],
          {
            cwd: WIN_SAFE_CWD,
            windowsHide: true,
            timeout: 2500
          }
        );
        const firstLine = taskOut.trim().split(/\r?\n/)[0] || '';
        const match = firstLine.match(/^"([^"]+)"/);
        if (match && match[1]) {
          processName = match[1];
        }
      } catch (_) {}
      return { pid: foundPid, processName };
    } else {
      try {
        const { stdout } = await execAsync(`ss -tlpn "sport = :${targetPort}"`, { timeout: 2500 });
        const match = stdout.match(/users:\(\("([^"]+)",pid=(\d+)/);
        if (match) {
          return { pid: parseInt(match[2], 10), processName: match[1] };
        }
      } catch (_) {}
      return null;
    }
  } catch (_) {
    return null;
  }
}

function probeCPAInstance(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: Number(port),
        path: '/v8/management/config',
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        if (res.statusCode === 401 || res.statusCode === 200 || res.statusCode === 403) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function findNextAvailablePort(startPort = 8317, excludePorts = [], maxAttempts = 150) {
  const excluded = new Set(excludePorts.map((p) => Number(p)));
  for (const item of OAUTH_PORTS) {
    excluded.add(item.port);
  }

  let candidate = Number(startPort) || 8317;
  if (candidate < 1024 || candidate > 65500) candidate = 8317;

  for (let i = 0; i < maxAttempts; i++) {
    const port = candidate + i;
    if (port > 65535) break;
    if (excluded.has(port) && i > 0) continue;
    const free = await isPortAvailable(port);
    if (free) {
      return port;
    }
  }
  throw new Error(`Unable to find available port starting from ${startPort}`);
}

async function inspectSinglePort(port, role, label, managedPid = null) {
  const targetPort = Number(port);
  const available = await isPortAvailable(targetPort);
  if (available) {
    return {
      port: targetPort,
      role,
      label,
      available: true,
      occupiedByManaged: false,
      isCPAInstance: false,
      owner: null,
      suggestedPort: targetPort,
      status: 'free'
    };
  }

  const owner = await findPortOwner(targetPort);
  const occupiedByManaged = Boolean(managedPid && owner && Number(owner.pid) === Number(managedPid));
  const isCPAInstance = occupiedByManaged ? true : await probeCPAInstance(targetPort);
  let suggestedPort = targetPort;
  if (!occupiedByManaged) {
    try {
      suggestedPort = await findNextAvailablePort(targetPort + 1, [targetPort]);
    } catch (_) {}
  }

  return {
    port: targetPort,
    role,
    label,
    available: false,
    occupiedByManaged,
    isCPAInstance,
    owner: owner || { pid: null, processName: isCPAInstance ? 'cli-proxy-api' : 'Occupied (System/Other)' },
    suggestedPort,
    status: occupiedByManaged ? 'active-self' : isCPAInstance ? 'conflict-cpa' : 'conflict-other'
  };
}

async function analyzeAllPorts(mainPort = 8317, managedPid = null) {
  const mainReport = await inspectSinglePort(mainPort, 'main', 'CPA 主服务端口 (API & WebUI)', managedPid);
  const oauthReports = await Promise.all(
    OAUTH_PORTS.map((item) => inspectSinglePort(item.port, `oauth:${item.id}`, item.name, managedPid))
  );

  return {
    timestamp: new Date().toISOString(),
    mainPort: mainReport,
    oauthPorts: oauthReports,
    hasMainConflict: !mainReport.available && !mainReport.occupiedByManaged,
    recommendedMainPort:
      mainReport.available || mainReport.occupiedByManaged ? mainReport.port : mainReport.suggestedPort
  };
}

async function killProcessByPid(pid) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw new Error('Invalid PID');
  }
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/F', '/PID', String(targetPid), '/T'], {
      cwd: WIN_SAFE_CWD,
      windowsHide: true,
      timeout: 5000
    });
  } else {
    process.kill(targetPid, 'SIGKILL');
  }
  return true;
}

module.exports = {
  OAUTH_PORTS,
  checkPortBindable,
  checkPortListening,
  isPortAvailable,
  findPortOwner,
  probeCPAInstance,
  findNextAvailablePort,
  inspectSinglePort,
  analyzeAllPorts,
  killProcessByPid
};
