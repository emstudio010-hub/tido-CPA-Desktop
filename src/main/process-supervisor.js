const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  OAUTH_PORTS,
  inspectSinglePort,
  findNextAvailablePort,
  checkPortListening,
  analyzeAllPorts
} = require('./port-analyzer');

class ProcessSupervisor extends EventEmitter {
  constructor(configManager) {
    super();
    this.configManager = configManager;
    this.child = null;
    this.oauthChild = null;
    this.status = 'stopped'; // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
    this.activePort = null;
    this.pid = null;
    this.startedAt = null;
    this.lastError = null;
    this.portSwitchNotice = null;
    this.stoppingIntentionally = false;
    this.crashCount = 0;
    this.crashTimer = null;
    this.logs = [];
    this.maxLogs = 600;
  }

  appendLog(level, message, source = 'daemon') {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      timestamp: new Date().toISOString(),
      level,
      source,
      message: String(message).trimEnd()
    };
    if (!entry.message) return;

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    try {
      const logFile = path.join(this.configManager.logsDir, 'cpa-daemon.log');
      fs.appendFileSync(logFile, `[${entry.timestamp}] [${source.toUpperCase()}] [${level}] ${entry.message}\n`, 'utf8');
    } catch (_) {}

    this.emit('log', entry);
  }

  clearLogs() {
    this.logs = [];
    this.emit('logs-cleared');
  }

  getState() {
    const settings = this.configManager.loadSettings();
    const port = this.activePort || settings.port || 8317;
    return {
      status: this.status,
      pid: this.pid,
      activePort: port,
      configuredPort: settings.port,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      portSwitchNotice: this.portSwitchNotice,
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      webUiUrl: `http://127.0.0.1:${port}/management.html`,
      binaryPath: this.configManager.getBinaryPath(),
      binaryExists: fs.existsSync(this.configManager.getBinaryPath())
    };
  }

  setStatus(newStatus, extra = {}) {
    this.status = newStatus;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    this.emit('status', this.getState());
  }

  /**
   * Pre-flight port analysis & start CPA server
   */
  async start(overrideSettings = null) {
    if (this.status === 'running' || this.status === 'starting') {
      return this.getState();
    }

    if (this.crashTimer) {
      clearTimeout(this.crashTimer);
      this.crashTimer = null;
    }

    this.stoppingIntentionally = false;
    this.lastError = null;
    this.portSwitchNotice = null;
    this.setStatus('starting');

    try {
      let settings = overrideSettings
        ? this.configManager.saveSettings(overrideSettings)
        : this.configManager.loadSettings();

      const binaryPath = this.configManager.getBinaryPath();
      if (!fs.existsSync(binaryPath)) {
        throw new Error(`找不到核心程序: ${binaryPath}`);
      }

      // Clean up stale orphan CPA process if a previous session exited abnormally
      if (this.configManager.pidFilePath && fs.existsSync(this.configManager.pidFilePath)) {
        try {
          const oldPid = parseInt(fs.readFileSync(this.configManager.pidFilePath, 'utf8').trim(), 10);
          if (oldPid && oldPid !== this.pid) {
            if (process.platform === 'win32') {
              spawn('taskkill.exe', ['/PID', String(oldPid), '/T', '/F'], {
                cwd: process.env.SystemRoot || 'C:\\Windows',
                windowsHide: true
              });
            } else {
              try { process.kill(oldPid, 'SIGKILL'); } catch (_) {}
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          fs.unlinkSync(this.configManager.pidFilePath);
        } catch (_) {}
      }

      // Step 1: Analyze target main port before starting
      const requestedPort = Number(settings.port) || 8317;
      this.appendLog('INFO', `正在执行启动前端口自检 (目标主端口: ${requestedPort})...`);
      const portReport = await inspectSinglePort(requestedPort, 'main', 'CPA 主端口', this.pid);

      let finalPort = requestedPort;
      if (!portReport.available) {
        const ownerDesc = portReport.owner
          ? `${portReport.owner.processName} (PID: ${portReport.owner.pid || '未知'})`
          : '其他进程';

        if (settings.autoSwitchPort) {
          finalPort = await findNextAvailablePort(requestedPort + 1, [requestedPort]);
          this.portSwitchNotice = {
            fromPort: requestedPort,
            toPort: finalPort,
            reason: `原端口 ${requestedPort} 被 ${ownerDesc} 占用`,
            message: `原设定的端口 ${requestedPort} 已被 ${ownerDesc} 占用，守护进程已自动顺延切换至空闲端口 ${finalPort} 并更新配置。`,
            time: new Date().toISOString()
          };
          this.appendLog(
            'WARN',
            `[端口自分析切换] 检测到端口 ${requestedPort} 已被 ${ownerDesc} 占用，已自动顺延切换至空闲端口 ${finalPort}！`
          );
          settings = this.configManager.saveSettings({ port: finalPort });
        } else {
          throw new Error(
            `端口 ${requestedPort} 已被 ${ownerDesc} 占用！请开启“端口冲突自动切换”或手动更换/释放端口。`
          );
        }
      } else {
        this.configManager.syncToConfigYaml(settings, false);
      }

      this.activePort = finalPort;

      // Step 2: Build CLI arguments & environment
      const args = ['--config', this.configManager.configYamlPath];
      if (settings.localModel) {
        args.push('--local-model');
      }

      const env = {
        ...process.env,
        MANAGEMENT_STATIC_PATH: this.configManager.staticDir
      };

      this.appendLog('INFO', `启动内核: ${path.basename(binaryPath)} ${args.join(' ')}`);

      const child = spawn(binaryPath, args, {
        cwd: this.configManager.dataDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.child = child;
      this.pid = child.pid;
      if (this.configManager.pidFilePath && child.pid) {
        try {
          fs.writeFileSync(this.configManager.pidFilePath, String(child.pid), 'utf8');
        } catch (_) {}
      }

      child.stdout.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) this.appendLog('INFO', line, 'cpa-core');
        }
      });

      child.stderr.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) this.appendLog('WARN', line, 'cpa-core');
        }
      });

      child.on('error', (err) => {
        this.appendLog('ERROR', `内核进程错误: ${err.message}`);
        this.lastError = err.message;
      });

      child.on('exit', (code, signal) => {
        const wasRunning = this.status === 'running';
        this.child = null;
        this.pid = null;
        this.startedAt = null;

        if (this.stoppingIntentionally) {
          this.appendLog('INFO', `CPA 服务已正常停止 (code=${code}, signal=${signal})`);
          this.setStatus('stopped');
          return;
        }

        const errMsg = `CPA 进程异常退出 (code=${code}, signal=${signal})`;
        this.appendLog('ERROR', errMsg);
        this.setStatus('error', { lastError: errMsg });

        const currentSettings = this.configManager.loadSettings();
        if (wasRunning && currentSettings.crashGuard && this.crashCount < 5) {
          this.crashCount += 1;
          this.appendLog('WARN', `[守护自愈] 将在 2.5 秒后进行第 ${this.crashCount}/5 次自动重启...`);
          this.crashTimer = setTimeout(() => {
            this.start().catch((e) => {
              this.appendLog('ERROR', `自动重启失败: ${e.message}`);
            });
          }, 2500);
        }
      });

      // Step 3: Wait until the port is actively listening
      const ready = await this.waitForServerReady(finalPort, 10000);
      if (!ready) {
        throw new Error(`等待端口 ${finalPort} 监听超时，请检查日志输出`);
      }

      this.startedAt = Date.now();
      this.crashCount = 0;
      this.appendLog(
        'INFO',
        `CPA 服务启动成功！PID: ${this.pid} | API: http://127.0.0.1:${finalPort}/v1 | WebUI: http://127.0.0.1:${finalPort}/management.html`
      );
      this.setStatus('running');
      return this.getState();
    } catch (err) {
      this.appendLog('ERROR', `启动失败: ${err.message}`);
      await this.stop(true);
      this.setStatus('error', { lastError: err.message });
      throw err;
    }
  }

  async waitForServerReady(port, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.child || this.child.exitCode !== null) {
        return false;
      }
      const listening = await checkPortListening(port, 300);
      if (listening) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async stop(silent = false) {
    if (this.crashTimer) {
      clearTimeout(this.crashTimer);
      this.crashTimer = null;
    }

    if (!this.child) {
      if (!silent) this.setStatus('stopped');
      return this.getState();
    }

    this.stoppingIntentionally = true;
    if (!silent) this.setStatus('stopping');
    const targetChild = this.child;
    const targetPid = targetChild.pid;

    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        this.child = null;
        this.pid = null;
        this.startedAt = null;
        if (!silent) this.setStatus('stopped');
        resolve(this.getState());
      };

      targetChild.once('exit', done);

      try {
        if (process.platform === 'win32' && targetPid) {
          spawn('taskkill.exe', ['/PID', String(targetPid), '/T', '/F'], {
            cwd: process.env.SystemRoot || 'C:\\Windows',
            windowsHide: true
          });
        } else {
          targetChild.kill('SIGTERM');
        }
      } catch (_) {}

      setTimeout(() => {
        if (!finished && targetChild) {
          try {
            targetChild.kill('SIGKILL');
          } catch (_) {}
          done();
        }
      }, 3000);
    });
  }

  async restart(overrideSettings = null) {
    this.appendLog('INFO', '正在重启 CPA 服务...');
    await this.stop();
    await new Promise((r) => setTimeout(r, 350));
    return this.start(overrideSettings);
  }

  /**
   * Launch an OAuth login flow via CPA CLI with automatic callback port conflict resolution
   */
  async startOAuthLogin(providerId) {
    const providerMap = {
      codex: { flag: '--codex-login', defaultPort: 1455, name: 'OpenAI Codex' },
      'codex-device': { flag: '--codex-device-login', defaultPort: 0, name: 'OpenAI Codex (Device Code)' },
      claude: { flag: '--claude-login', defaultPort: 54545, name: 'Anthropic Claude' },
      antigravity: { flag: '--antigravity-login', defaultPort: 51121, name: 'Google Antigravity' },
      kimi: { flag: '--kimi-login', defaultPort: 11451, name: 'Kimi Code (.com)' },
      'kimi-ai': { flag: '--kimi-ai-login', defaultPort: 11451, name: 'Kimi Code (.ai)' },
      xai: { flag: '--xai-login', defaultPort: 8085, name: 'xAI Grok' },
      devin: { flag: '--devin-login', defaultPort: 8085, name: 'Devin' },
      meta: { flag: '--meta-login', defaultPort: 8085, name: 'Meta Muse' }
    };

    const target = providerMap[providerId];
    if (!target) {
      throw new Error(`不支持的 OAuth 渠道: ${providerId}`);
    }

    if (this.oauthChild) {
      try {
        this.oauthChild.kill();
      } catch (_) {}
      this.oauthChild = null;
    }

    const binaryPath = this.configManager.getBinaryPath();
    const args = ['--config', this.configManager.configYamlPath, target.flag];

    // Check if default callback port is occupied; if so, auto-allocate a free callback port
    let callbackPort = target.defaultPort;
    if (callbackPort > 0) {
      const report = await inspectSinglePort(callbackPort, 'oauth', target.name);
      if (!report.available) {
        callbackPort = await findNextAvailablePort(callbackPort + 1, [callbackPort]);
        args.push('--oauth-callback-port', String(callbackPort));
        this.appendLog(
          'WARN',
          `[OAuth 端口自适应] ${target.name} 默认回调端口 ${target.defaultPort} 被占用，已自动切换回调端口为 ${callbackPort}`
        );
      }
    }

    this.appendLog('INFO', `正在启动 ${target.name} OAuth 授权流程 (${args.join(' ')})...`);

    const child = spawn(binaryPath, args, {
      cwd: this.configManager.dataDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.oauthChild = child;

    const handleOutput = (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.appendLog('INFO', `[OAuth:${providerId}] ${line}`, 'oauth');
        const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/);
        if (urlMatch) {
          this.emit('oauth-url', {
            providerId,
            providerName: target.name,
            url: urlMatch[0],
            callbackPort
          });
        }
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('exit', (code) => {
      this.oauthChild = null;
      this.appendLog('INFO', `[OAuth:${providerId}] 授权子进程结束 (exit code=${code})`);
      this.emit('oauth-exit', { providerId, code });
    });

    return {
      providerId,
      providerName: target.name,
      callbackPort,
      pid: child.pid
    };
  }
}

module.exports = { ProcessSupervisor };
