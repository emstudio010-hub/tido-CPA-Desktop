const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, session } = require('electron');
const fs = require('fs');
const path = require('path');

// Prevent Chromium Sandbox & GPU crashes when running from Windows UNC paths (\\wsl.localhost\...) or VM/RDP
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

// Ensure Electron userData is always on a local disk so Chromium lockfiles/caches never fail on UNC shares
try {
  const localBase = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Public', 'CPA-Desktop');
  if (process.platform === 'win32' && (__dirname.startsWith('\\\\') || process.execPath.startsWith('\\\\'))) {
    const userDataDir = path.join(localBase, 'electron-userdata');
    fs.mkdirSync(userDataDir, { recursive: true });
    app.setPath('userData', userDataDir);
  }
} catch (_) {}

const { ConfigManager } = require('./config-manager');
const { ProcessSupervisor } = require('./process-supervisor');
const { AutoStartManager } = require('./autostart-manager');
const {
  analyzeAllPorts,
  findNextAvailablePort,
  killProcessByPid
} = require('./port-analyzer');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const configManager = new ConfigManager();
const supervisor = new ProcessSupervisor(configManager);
const autoStartManager = new AutoStartManager(app);

process.on('uncaughtException', (err) => {
  try {
    supervisor.appendLog('ERROR', `未捕获异常: ${err && err.stack ? err.stack : err}`);
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  try {
    supervisor.appendLog('ERROR', `未处理 Promise 异常: ${reason && reason.stack ? reason.stack : reason}`);
  } catch (_) {}
});

function createStatusIcon(status = 'stopped') {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  let r = 100, g = 116, b = 139;
  if (status === 'running') {
    r = 16; g = 185; b = 129;
  } else if (status === 'starting') {
    r = 245; g = 158; b = 11;
  } else if (status === 'error') {
    r = 239; g = 68; b = 68;
  }

  const center = (size - 1) / 2;
  const radius = 6.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist <= radius) {
        buf[idx] = b;
        buf[idx + 1] = g;
        buf[idx + 2] = r;
        buf[idx + 3] = 255;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTrayMenu() {
  if (!tray) return;
  const state = supervisor.getState();
  const settings = configManager.loadSettings();
  const isRunning = state.status === 'running';

  try {
    tray.setImage(createStatusIcon(state.status));
  } catch (_) {}

  const statusLabel = isRunning
    ? `🟢 运行中 (端口: ${state.activePort} | PID: ${state.pid})`
    : state.status === 'starting'
    ? '🟡 正在启动服务...'
    : state.status === 'error'
    ? '🔴 服务异常'
    : '⚪ 服务未启动 (待命)';

  tray.setToolTip(`CLIProxyAPI Desktop - ${statusLabel}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'CLIProxyAPI Desktop Daemon', enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: '打开守护主控台 (选端口/WebUI/配置)',
      click: () => {
        showMainWindow();
      }
    },
    {
      label: `在浏览器打开 WebUI (${state.activePort})`,
      enabled: isRunning,
      click: () => {
        shell.openExternal(state.webUiUrl);
      }
    },
    { type: 'separator' },
    {
      label: isRunning ? '重启 CPA 服务' : '启动 CPA 服务',
      click: async () => {
        try {
          if (isRunning) {
            await supervisor.restart();
          } else {
            await supervisor.start();
          }
        } catch (_) {}
      }
    },
    {
      label: '停止 CPA 服务',
      enabled: isRunning,
      click: async () => {
        await supervisor.stop();
      }
    },
    { type: 'separator' },
    {
      label: '开机自动启动 (Windows)',
      type: 'checkbox',
      checked: Boolean(settings.autoStartOS),
      click: async (menuItem) => {
        await autoStartManager.setEnabled(menuItem.checked);
        configManager.saveSettings({ autoStartOS: menuItem.checked });
        broadcastStatus();
      }
    },
    { type: 'separator' },
    {
      label: '彻底退出并关闭反代服务',
      click: async () => {
        isQuitting = true;
        await supervisor.stop(true);
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(false);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    tray = new Tray(createStatusIcon('stopped'));
    tray.on('double-click', () => {
      showMainWindow();
    });
    updateTrayMenu();
  } catch (err) {
    supervisor.appendLog('WARN', `托盘初始化跳过: ${err.message}`);
  }
}

function createMainWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: !startHidden,
    backgroundColor: '#0b0f19',
    title: 'CLIProxyAPI Desktop Daemon (v8.0.44)',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')).catch((err) => {
    supervisor.appendLog('ERROR', `加载界面失败: ${err.message}`);
  });

  mainWindow.on('close', (event) => {
    const settings = configManager.loadSettings();
    if (!isQuitting && settings.minimizeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
      supervisor.appendLog('INFO', '主窗口已最小化至系统托盘，后台服务保持运行。');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcastStatus() {
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:status-changed', {
      state: supervisor.getState(),
      settings: configManager.loadSettings(),
      credentials: configManager.listAuthCredentials()
    });
  }
}

supervisor.on('status', () => {
  broadcastStatus();
});

supervisor.on('log', (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:log-entry', entry);
  }
});

supervisor.on('logs-cleared', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:logs-cleared');
  }
});

supervisor.on('oauth-url', (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:oauth-url', payload);
  }
});

supervisor.on('oauth-exit', (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:oauth-exit', payload);
  }
  broadcastStatus();
});

function setupIpcHandlers() {
  ipcMain.handle('daemon:get-snapshot', async () => {
    const settings = configManager.loadSettings();
    const state = supervisor.getState();
    const portAnalysis = await analyzeAllPorts(state.activePort || settings.port, state.pid);
    const credentials = configManager.listAuthCredentials();
    return {
      state,
      settings,
      portAnalysis,
      credentials,
      logs: supervisor.logs.slice(-250)
    };
  });

  ipcMain.handle('daemon:scan-ports', async (_event, targetPort) => {
    const settings = configManager.loadSettings();
    const state = supervisor.getState();
    const portToScan = Number(targetPort) || settings.port || 8317;
    return analyzeAllPorts(portToScan, state.pid);
  });

  ipcMain.handle('daemon:find-free-port', async (_event, startPort) => {
    const freePort = await findNextAvailablePort(Number(startPort) || 8317);
    return { freePort };
  });

  ipcMain.handle('daemon:kill-process', async (_event, pid) => {
    await killProcessByPid(pid);
    supervisor.appendLog('WARN', `已终止占用端口的进程 PID=${pid}`);
    return { ok: true };
  });

  ipcMain.handle('daemon:save-settings', async (_event, partialSettings) => {
    const prev = configManager.loadSettings();
    const saved = configManager.saveSettings(partialSettings);

    if (partialSettings.autoStartOS !== undefined && partialSettings.autoStartOS !== prev.autoStartOS) {
      await autoStartManager.setEnabled(saved.autoStartOS);
      supervisor.appendLog('INFO', `Windows 开机自启已${saved.autoStartOS ? '开启' : '关闭'}`);
    }

    broadcastStatus();
    return { ok: true, settings: saved, state: supervisor.getState() };
  });

  ipcMain.handle('daemon:start-server', async (_event, overrideSettings) => {
    const state = await supervisor.start(overrideSettings);
    const portAnalysis = await analyzeAllPorts(state.activePort, state.pid);
    return { ok: true, state, settings: configManager.loadSettings(), portAnalysis };
  });

  ipcMain.handle('daemon:stop-server', async () => {
    const state = await supervisor.stop();
    const portAnalysis = await analyzeAllPorts(state.configuredPort, null);
    return { ok: true, state, portAnalysis };
  });

  ipcMain.handle('daemon:restart-server', async (_event, overrideSettings) => {
    const state = await supervisor.restart(overrideSettings);
    const portAnalysis = await analyzeAllPorts(state.activePort, state.pid);
    return { ok: true, state, settings: configManager.loadSettings(), portAnalysis };
  });

  ipcMain.handle('daemon:oauth-login', async (_event, providerId) => {
    return supervisor.startOAuthLogin(providerId);
  });

  ipcMain.handle('daemon:read-raw-yaml', async () => {
    return { yaml: configManager.readRawConfigYaml(), path: configManager.configYamlPath };
  });

  ipcMain.handle('daemon:save-raw-yaml', async (_event, yamlContent) => {
    configManager.writeRawConfigYaml(yamlContent);
    supervisor.appendLog('INFO', '已保存 config.yaml 原始配置（CPA 文件监听器将自动热重载）');
    return { ok: true };
  });

  ipcMain.handle('daemon:clear-logs', async () => {
    supervisor.clearLogs();
    return { ok: true };
  });

  ipcMain.handle('daemon:open-external', async (_event, url) => {
    if (url && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  ipcMain.handle('daemon:open-folder', async (_event, folderType) => {
    configManager.ensureDirectories();
    const map = {
      data: configManager.dataDir,
      auths: configManager.authsDir,
      logs: configManager.logsDir,
      plugins: configManager.pluginsDir,
      config: configManager.configYamlPath
    };
    const targetPath = map[folderType] || configManager.dataDir;
    if (folderType === 'config') {
      shell.showItemInFolder(targetPath);
    } else {
      await shell.openPath(targetPath);
    }
    return { ok: true, path: targetPath };
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('app:quit', async () => {
    isQuitting = true;
    await supervisor.stop(true);
    app.quit();
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(true);
      });
      session.defaultSession.setPermissionCheckHandler(() => true);
    } catch (_) {}

    configManager.ensureDirectories();
    const settings = configManager.loadSettings();
    const isOsAutoStart = process.argv.includes('--autostart');

    setupIpcHandlers();
    createTray();
    createMainWindow(isOsAutoStart && settings.minimizeToTray);

    supervisor.appendLog('INFO', `CPA Desktop Daemon 已就绪 (数据目录: ${configManager.dataDir})`);

    if (settings.autoStartOS) {
      autoStartManager.setEnabled(true).catch(() => {});
    }

    if (isOsAutoStart || settings.autoStartServer) {
      supervisor.appendLog(
        'INFO',
        '已启用自动启动服务，正在自检端口并启动 CPA 核心与 WebUI...'
      );
      supervisor.start().catch((err) => {
        supervisor.appendLog('ERROR', `自动启动服务失败: ${err.message}`);
      });
    } else {
      supervisor.appendLog('INFO', '当前处于待命模式：请先在面板确认端口与配置，然后点击【启动 CPA 服务】。');
    }
  });

  app.on('before-quit', async () => {
    isQuitting = true;
    await supervisor.stop(true);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && isQuitting) {
      app.quit();
    }
  });
}
