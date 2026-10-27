const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DAEMON_SETTINGS = {
  port: 8317,
  host: '0.0.0.0',
  autoSwitchPort: true,
  autoStartOS: true,
  autoStartServer: true,
  minimizeToTray: true,
  crashGuard: true,
  pluginsEnabled: true,
  localModel: false,
  allowRemoteManagement: true,
  managementKey: 'cpa-admin-8888',
  clientApiKey: 'sk-cpa-local-8888',
  proxyUrl: '',
  debugLog: false,
  requestLog: true
};

class ConfigManager {
  constructor(options = {}) {
    this.resourcesDir = options.resourcesDir || this.resolveResourcesDir();
    this.baseDir = options.baseDir || this.resolvePortableBaseDir();

    this.dataDir = path.join(this.baseDir, 'data');
    this.authsDir = path.join(this.dataDir, 'auths');
    this.logsDir = path.join(this.dataDir, 'logs');
    this.pluginsDir = path.join(this.dataDir, 'plugins');
    this.staticDir = path.join(this.dataDir, 'static');
    this.localBinDir = path.join(this.baseDir, 'bin');

    this.configYamlPath = path.join(this.dataDir, 'config.yaml');
    this.daemonSettingsPath = path.join(this.dataDir, 'daemon-settings.json');
    this.managementHtmlPath = path.join(this.staticDir, 'management.html');
    this.pidFilePath = path.join(this.dataDir, 'cpa-core.pid');
  }

  resolvePortableBaseDir() {
    if (process.env.CPA_DESKTOP_BASE_DIR) {
      return path.resolve(process.env.CPA_DESKTOP_BASE_DIR);
    }
    let candidate = process.env.PORTABLE_EXECUTABLE_DIR
      ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
      : (() => {
          const execName = path.basename(process.execPath).toLowerCase();
          if (!execName.startsWith('electron') && !execName.startsWith('node')) {
            return path.dirname(process.execPath);
          }
          return path.resolve(__dirname, '../..');
        })();

    if (process.platform === 'win32' && candidate.startsWith('\\\\')) {
      const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Public';
      return path.join(localAppData, 'CPA-Desktop');
    }
    return candidate;
  }

  resolveResourcesDir() {
    if (process.env.CPA_DESKTOP_RESOURCES_DIR) {
      return path.resolve(process.env.CPA_DESKTOP_RESOURCES_DIR);
    }
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'bin'))) {
      return process.resourcesPath;
    }
    return path.resolve(__dirname, '../../resources');
  }

  getBinaryPath() {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'cli-proxy-api.exe' : 'cli-proxy-api';
    const resourceBin = path.join(this.resourcesDir, 'bin', binName);

    if (isWin && resourceBin.startsWith('\\\\') && fs.existsSync(resourceBin)) {
      try {
        if (!fs.existsSync(this.localBinDir)) {
          fs.mkdirSync(this.localBinDir, { recursive: true });
        }
        const localBin = path.join(this.localBinDir, binName);
        const srcStat = fs.statSync(resourceBin);
        const needCopy = !fs.existsSync(localBin) || fs.statSync(localBin).size !== srcStat.size;
        if (needCopy) {
          fs.copyFileSync(resourceBin, localBin);
        }
        return localBin;
      } catch (_) {}
    }

    if (fs.existsSync(resourceBin)) {
      return resourceBin;
    }
    return path.join(this.resourcesDir, 'bin', 'cli-proxy-api.exe');
  }

  ensureDirectories() {
    const dirs = [
      this.dataDir,
      this.authsDir,
      this.logsDir,
      this.pluginsDir,
      path.join(this.pluginsDir, 'windows', 'amd64'),
      path.join(this.pluginsDir, 'linux', 'amd64'),
      this.staticDir
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const bundledHtml = path.join(this.resourcesDir, 'static', 'management.html');
    if (fs.existsSync(bundledHtml) && !fs.existsSync(this.managementHtmlPath)) {
      fs.copyFileSync(bundledHtml, this.managementHtmlPath);
    }

    // Copy any bundled official plugins into data/plugins/windows/amd64
    const bundledWinPluginsDir = path.join(this.resourcesDir, 'plugins', 'windows', 'amd64');
    const targetWinPluginsDir = path.join(this.pluginsDir, 'windows', 'amd64');
    if (fs.existsSync(bundledWinPluginsDir)) {
      try {
        for (const file of fs.readdirSync(bundledWinPluginsDir)) {
          if (file.toLowerCase().endsWith('.dll')) {
            const srcFile = path.join(bundledWinPluginsDir, file);
            const dstFile = path.join(targetWinPluginsDir, file);
            if (!fs.existsSync(dstFile)) {
              fs.copyFileSync(srcFile, dstFile);
            }
          }
        }
      } catch (_) {}
    }
  }

  injectWebUiAutoLogin(managementKey) {
    try {
      const bundledHtml = path.join(this.resourcesDir, 'static', 'management.html');
      const sourcePath = fs.existsSync(bundledHtml) ? bundledHtml : this.managementHtmlPath;
      if (!fs.existsSync(sourcePath)) return;

      let html = fs.readFileSync(sourcePath, 'utf8');
      html = html.replace(/<!-- CPA-AUTOLOGIN-START -->[\s\S]*?<!-- CPA-AUTOLOGIN-END -->\s*/g, '');

      const keyVal = String(managementKey || 'cpa-admin-8888');
      const safeKey = JSON.stringify(keyVal);
      const snippet = `<!-- CPA-AUTOLOGIN-START -->
<script>
(function(){
  try {
    var origin = window.location.origin;
    if (origin && origin.indexOf('http') === 0) {
      var currentKey = ${safeKey};
      var storedAuth = localStorage.getItem('cli-proxy-auth');
      var needReset = false;
      if (storedAuth) {
        try {
          var parsed = JSON.parse(storedAuth);
          if (parsed && parsed.state && parsed.state.managementKey !== currentKey) {
            needReset = true;
          }
        } catch (_) {
          needReset = true;
        }
      }
      var plainKey = localStorage.getItem('managementKey');
      if (plainKey && plainKey !== currentKey && plainKey !== JSON.stringify(currentKey)) {
        needReset = true;
      }
      if (needReset) {
        ['cli-proxy-auth', 'isLoggedIn', 'apiBase', 'apiUrl', 'managementKey'].forEach(function(k){
          try { localStorage.removeItem(k); } catch (_) {}
        });
      }
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('apiBase', origin);
      localStorage.setItem('apiUrl', origin);
      localStorage.setItem('managementKey', JSON.stringify(currentKey));
      localStorage.setItem('cli-proxy-auth', JSON.stringify({
        state: {
          isAuthenticated: true,
          apiBase: origin,
          managementKey: currentKey,
          rememberPassword: true,
          connectionStatus: 'connected'
        },
        version: 0
      }));
    }
  } catch (e) {}
})();
</script>
<!-- CPA-AUTOLOGIN-END -->`;

      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n${snippet}`);
      } else {
        html = snippet + '\n' + html;
      }
      fs.writeFileSync(this.managementHtmlPath, html, 'utf8');
    } catch (_) {}
  }

  loadSettings() {
    this.ensureDirectories();
    let saved = {};
    if (fs.existsSync(this.daemonSettingsPath)) {
      try {
        saved = JSON.parse(fs.readFileSync(this.daemonSettingsPath, 'utf8'));
      } catch (_) {
        saved = {};
      }
    }
    const merged = { ...DEFAULT_DAEMON_SETTINGS, ...saved };
    if (saved.pluginsEnabled === undefined) {
      merged.pluginsEnabled = true;
    }
    merged.port = Number(merged.port) || 8317;
    if (!merged.managementKey) {
      merged.managementKey = 'cpa-admin-' + crypto.randomBytes(3).toString('hex');
    }
    if (!merged.clientApiKey) {
      merged.clientApiKey = 'sk-cpa-' + crypto.randomBytes(6).toString('hex');
    }

    if (!fs.existsSync(this.daemonSettingsPath)) {
      this.saveSettings(merged, true);
    } else if (!fs.existsSync(this.configYamlPath)) {
      this.syncToConfigYaml(merged, true);
    } else {
      // Ensure plugins.enabled is unlocked in existing config.yaml & WebUI autologin is fresh
      this.syncToConfigYaml(merged, false);
    }
    return merged;
  }

  saveSettings(newSettings, forceWriteSecret = false) {
    this.ensureDirectories();
    const current = fs.existsSync(this.daemonSettingsPath)
      ? (() => {
          try {
            return JSON.parse(fs.readFileSync(this.daemonSettingsPath, 'utf8'));
          } catch (_) {
            return {};
          }
        })()
      : {};

    const secretChanged =
      forceWriteSecret ||
      (newSettings.managementKey !== undefined && newSettings.managementKey !== current.managementKey);

    const merged = {
      ...DEFAULT_DAEMON_SETTINGS,
      ...current,
      ...newSettings
    };
    merged.port = Number(merged.port) || 8317;

    fs.writeFileSync(this.daemonSettingsPath, JSON.stringify(merged, null, 2), 'utf8');
    this.syncToConfigYaml(merged, secretChanged);
    return merged;
  }

  syncToConfigYaml(settings, writePlaintextSecret = false) {
    this.ensureDirectories();
    this.injectWebUiAutoLogin(settings.managementKey);
    const bindHost = settings.host === '127.0.0.1' ? '127.0.0.1' : '';
    const pluginsEnabledStr = settings.pluginsEnabled !== false ? 'true' : 'false';

    if (!fs.existsSync(this.configYamlPath)) {
      const initialYaml = this.buildDefaultConfigYaml(settings, './auths', 'plugins');
      fs.writeFileSync(this.configYamlPath, initialYaml, 'utf8');
      this.mirrorConfigNextToBinary(initialYaml);
      return;
    }

    let content = fs.readFileSync(this.configYamlPath, 'utf8');

    content = this.replaceYamlBlockField(content, 'server', 'host', `"${bindHost}"`);
    content = this.replaceYamlBlockField(content, 'server', 'port', String(settings.port));

    content = this.replaceYamlBlockField(
      content,
      'management',
      'allow-remote',
      settings.allowRemoteManagement ? 'true' : 'false'
    );
    content = this.replaceYamlBlockField(content, 'management', 'disable-control-panel', 'false');
    content = this.replaceYamlBlockField(content, 'management', 'disable-auto-update-panel', 'true');

    // If secret-key was explicitly changed or is empty in YAML, write it
    const hasEmptySecret = /management:[\s\S]*?^\s{2}secret-key:\s*""\s*$/m.test(content);
    if ((writePlaintextSecret || hasEmptySecret) && settings.managementKey) {
      content = this.replaceYamlBlockField(content, 'management', 'secret-key', `"${settings.managementKey}"`);
    }

    if (settings.proxyUrl !== undefined && settings.proxyUrl !== '') {
      content = this.replaceYamlBlockField(content, 'requests', 'proxy-url', `"${settings.proxyUrl}"`);
    }
    content = this.replaceYamlBlockField(content, 'oauth', 'auth-dir', '"./auths"');

    // Unlock plugin system permissions in config.yaml
    content = this.replaceYamlBlockField(content, 'plugins', 'enabled', pluginsEnabledStr);
    content = this.replaceYamlBlockField(content, 'plugins', 'dir', '"plugins"');

    content = this.replaceYamlNestedField(
      content,
      'observability',
      'logs',
      'debug',
      settings.debugLog ? 'true' : 'false'
    );
    content = this.replaceYamlNestedField(content, 'observability', 'logs', 'logging-to-file', 'true');
    content = this.replaceYamlNestedField(
      content,
      'observability',
      'logs',
      'request-log',
      settings.requestLog ? 'true' : 'false'
    );

    content = this.replaceYamlNestedField(
      content,
      'routing',
      'cooldown',
      'save-cooldown-status',
      'false'
    );
    content = this.replaceYamlNestedField(
      content,
      'routing',
      'cooldown',
      'transient-error-cooldown-seconds',
      '0'
    );

    if (settings.clientApiKey) {
      content = this.ensureClientApiKeyInYaml(content, settings.clientApiKey);
    }

    content = this.ensureCompatibilityBlocks(content);

    fs.writeFileSync(this.configYamlPath, content, 'utf8');
    this.mirrorConfigNextToBinary(content);
  }

  mirrorConfigNextToBinary(yamlContent) {
    try {
      const binDir = path.dirname(this.getBinaryPath());
      if (fs.existsSync(binDir)) {
        fs.writeFileSync(path.join(binDir, 'config.yaml'), yamlContent, 'utf8');
      }
    } catch (_) {}
  }

  buildDefaultConfigYaml(settings, normalizedAuthDir = './auths', normalizedPluginsDir = 'plugins') {
    const bindHost = settings.host === '127.0.0.1' ? '127.0.0.1' : '';
    const pluginsEnabledStr = settings.pluginsEnabled !== false ? 'true' : 'false';
    return `# CLIProxyAPI v8 Configuration (Managed by CPA Desktop Daemon)
config-version: 8

models:
  catalog: ""
  codex-catalog: ""
  devin-catalog: ""

server:
  host: "${bindHost}"
  port: ${Number(settings.port) || 8317}
  max-request-body-bytes: 0
  response-compression:
    enabled: true
    min-bytes: 1024
  github-token: ""
  trusted-proxies: []
  tls:
    enable: false
    cert: ""
    key: ""
  commercial-mode: false
  discovery:
    enabled: false

management:
  allow-remote: ${settings.allowRemoteManagement ? 'true' : 'false'}
  secret-key: "${settings.managementKey}"
  disable-control-panel: false
  disable-auto-update-panel: true
  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"

access:
  api-keys:
    - "${settings.clientApiKey}"

routing:
  strategy: "round-robin"
  session-affinity: false
  session-affinity-ttl: "1h"
  session-affinity-subagents: true
  session-affinity-rebind-on: "any"
  force-model-prefix: false
  retry:
    request-retry: 3
    max-retry-credentials: 0
    max-retry-interval: 30
  cooldown:
    disable-cooling: false
    save-cooldown-status: false
    transient-error-cooldown-seconds: 0

requests:
  proxy-url: "${settings.proxyUrl || ''}"
  tls-handshake-timeout-seconds: 15
  passthrough-headers: false
  nonstream-keepalive-interval: 0

oauth:
  auth-dir: "${normalizedAuthDir}"
  model-alias: {}
  excluded-models: {}

multimedia:
  disable-image-generation: false
  video-result-auth-cache-ttl: "3h"

client:
  codex:
    enable-apply-patch: true
    optimize-multi-agent-v2: true
    web-search-result-cache:
      enabled: true
      ttl: "24h"
      limit: 500

upstream:
  codex:
    orphan-delegation-compatibility: true
    model-level-cooling: true
    stream-bootstrap-buffering: true

observability:
  logs:
    debug: ${settings.debugLog ? 'true' : 'false'}
    logging-to-file: true
    logs-max-total-size-mb: 100
    error-logs-max-files: 10
    request-log: ${settings.requestLog ? 'true' : 'false'}
  usage:
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 60
  pprof:
    enable: false
    addr: "127.0.0.1:8316"

plugins:
  enabled: ${pluginsEnabledStr}
  dir: "${normalizedPluginsDir}"
  configs:
    gemini-cli:
      enabled: true
    jshandler:
      enabled: true
`;
  }

  ensureCompatibilityBlocks(content) {
    if (!/model-alias:/m.test(content)) {
      content = content.replace(/(oauth:[\s\S]*?auth-dir:\s*.*$)/m, '$1\n  model-alias: {}\n  excluded-models: {}');
    }
    if (!/client:\s*\n\s*codex:/m.test(content)) {
      content += `\nclient:\n  codex:\n    enable-apply-patch: true\n    optimize-multi-agent-v2: true\n    web-search-result-cache:\n      enabled: true\n      ttl: "24h"\n      limit: 500\n`;
    }
    if (!/upstream:\s*\n\s*codex:/m.test(content)) {
      content += `\nupstream:\n  codex:\n    orphan-delegation-compatibility: true\n    model-level-cooling: true\n    stream-bootstrap-buffering: true\n`;
    }
    return content;
  }

  replaceYamlBlockField(yamlText, blockName, fieldName, newValueStr) {
    const lines = yamlText.split(/\r?\n/);
    let inBlock = false;
    let replaced = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^[a-zA-Z0-9_-]+:\s*(#.*)?$/.test(line)) {
        const currentBlock = line.split(':')[0].trim();
        inBlock = currentBlock === blockName;
        continue;
      }
      if (inBlock) {
        const fieldRegex = new RegExp(`^(\\s{2}${fieldName}:)\\s*.*$`);
        const match = line.match(fieldRegex);
        if (match) {
          lines[i] = `${match[1]} ${newValueStr}`;
          replaced = true;
          break;
        }
      }
    }

    if (!replaced) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === `${blockName}:`) {
          lines.splice(i + 1, 0, `  ${fieldName}: ${newValueStr}`);
          replaced = true;
          break;
        }
      }
    }

    return lines.join('\n');
  }

  replaceYamlNestedField(yamlText, rootBlock, subBlock, fieldName, newValueStr) {
    const lines = yamlText.split(/\r?\n/);
    let inRoot = false;
    let inSub = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^[a-zA-Z0-9_-]+:\s*(#.*)?$/.test(line)) {
        inRoot = line.split(':')[0].trim() === rootBlock;
        inSub = false;
        continue;
      }
      if (inRoot && /^\s{2}[a-zA-Z0-9_-]+:\s*(#.*)?$/.test(line)) {
        inSub = line.trim().split(':')[0].trim() === subBlock;
        continue;
      }
      if (inRoot && inSub) {
        const fieldRegex = new RegExp(`^(\\s{4}${fieldName}:)\\s*.*$`);
        const match = line.match(fieldRegex);
        if (match) {
          lines[i] = `${match[1]} ${newValueStr}`;
          break;
        }
      }
    }
    return lines.join('\n');
  }

  ensureClientApiKeyInYaml(yamlText, apiKey) {
    const lines = yamlText.split(/\r?\n/);
    let inAccess = false;
    let inApiKeys = false;
    let apiKeysLineIdx = -1;
    const existingKeys = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^[a-zA-Z0-9_-]+:\s*(#.*)?$/.test(line)) {
        inAccess = line.split(':')[0].trim() === 'access';
        inApiKeys = false;
        continue;
      }
      if (inAccess && /^\s{2}api-keys:\s*(#.*)?$/.test(line)) {
        inApiKeys = true;
        apiKeysLineIdx = i;
        continue;
      }
      if (inAccess && inApiKeys) {
        if (/^\s{4}-\s*/.test(line)) {
          const val = line.replace(/^\s{4}-\s*/, '').replace(/^["']|["']$/g, '').trim();
          existingKeys.push({ index: i, value: val });
        } else if (/^\s*\S/.test(line) && !/^\s*#/.test(line)) {
          inApiKeys = false;
        }
      }
    }

    if (apiKeysLineIdx !== -1) {
      if (existingKeys.length === 0) {
        lines.splice(apiKeysLineIdx + 1, 0, `    - "${apiKey}"`);
      } else {
        lines[existingKeys[0].index] = `    - "${apiKey}"`;
      }
    }
    return lines.join('\n');
  }

  listAuthCredentials() {
    this.ensureDirectories();
    try {
      const files = fs.readdirSync(this.authsDir);
      const creds = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(this.authsDir, file);
        const stat = fs.statSync(fullPath);
        let meta = { type: 'unknown', email: '' };
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          meta.type = parsed.type || parsed.provider || file.split('-')[0] || 'oauth';
          meta.email = parsed.email || parsed.account || parsed.user || '';
        } catch (_) {}
        creds.push({
          fileName: file,
          type: meta.type,
          email: meta.email,
          updatedAt: stat.mtime.toISOString(),
          size: stat.size
        });
      }
      return creds;
    } catch (_) {
      return [];
    }
  }

  readRawConfigYaml() {
    this.ensureDirectories();
    if (!fs.existsSync(this.configYamlPath)) {
      this.loadSettings();
    }
    return fs.readFileSync(this.configYamlPath, 'utf8');
  }

  writeRawConfigYaml(rawContent) {
    this.ensureDirectories();
    fs.writeFileSync(this.configYamlPath, rawContent, 'utf8');
    this.mirrorConfigNextToBinary(rawContent);
    return true;
  }
}

module.exports = {
  ConfigManager,
  DEFAULT_DAEMON_SETTINGS
};
