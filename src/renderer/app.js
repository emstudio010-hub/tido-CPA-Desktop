(function () {
  const api = window.cpaDaemon;
  let currentState = null;
  let currentSettings = null;
  let lastLoadedWebUiUrl = '';

  const $ = (id) => document.getElementById(id);

  function showToast(msg) {
    const container = $('toast-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = msg;
    container.appendChild(item);
    setTimeout(() => item.remove(), 2600);
  }

  async function copyText(text, label = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`✅ ${label}: ${text}`);
    } catch (_) {
      showToast('复制失败，请手动选中复制');
    }
  }

  function formatUptime(sec) {
    if (!sec || sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function applySettingsToForm(settings) {
    if (!settings) return;
    currentSettings = settings;
    $('input-main-port').value = settings.port || 8317;
    $('select-bind-host').value = settings.host || '0.0.0.0';
    $('chk-auto-switch-port').checked = Boolean(settings.autoSwitchPort);
    $('chk-autostart-os').checked = Boolean(settings.autoStartOS);
    $('chk-autostart-server').checked = Boolean(settings.autoStartServer);
    $('chk-minimize-tray').checked = Boolean(settings.minimizeToTray);
    $('chk-crash-guard').checked = Boolean(settings.crashGuard);
    $('input-mgmt-key').value = settings.managementKey || 'cpa-admin-8888';
    $('input-client-key').value = settings.clientApiKey || 'sk-cpa-local-8888';
    $('input-proxy-url').value = settings.proxyUrl || '';
    if ($('chk-plugins-enabled')) $('chk-plugins-enabled').checked = settings.pluginsEnabled !== false;
    $('chk-allow-remote').checked = Boolean(settings.allowRemoteManagement);
    $('chk-local-model').checked = Boolean(settings.localModel);
    $('chk-debug-log').checked = Boolean(settings.debugLog);

    $('metric-client-key').textContent = settings.clientApiKey || 'sk-cpa-local-8888';
    $('metric-mgmt-key').textContent = settings.managementKey || 'cpa-admin-8888';
    $('webui-toolbar-key').textContent = settings.managementKey || 'cpa-admin-8888';
  }

  function collectSettingsFromForm() {
    return {
      port: Number($('input-main-port').value) || 8317,
      host: $('select-bind-host').value || '0.0.0.0',
      autoSwitchPort: $('chk-auto-switch-port').checked,
      autoStartOS: $('chk-autostart-os').checked,
      autoStartServer: $('chk-autostart-server').checked,
      minimizeToTray: $('chk-minimize-tray').checked,
      crashGuard: $('chk-crash-guard').checked,
      managementKey: $('input-mgmt-key').value.trim() || 'cpa-admin-8888',
      clientApiKey: $('input-client-key').value.trim() || 'sk-cpa-local-8888',
      proxyUrl: $('input-proxy-url').value.trim(),
      pluginsEnabled: $('chk-plugins-enabled') ? $('chk-plugins-enabled').checked : true,
      allowRemoteManagement: $('chk-allow-remote').checked,
      localModel: $('chk-local-model').checked,
      debugLog: $('chk-debug-log').checked
    };
  }

  function renderState(state) {
    if (!state) return;
    currentState = state;
    const isRunning = state.status === 'running';
    const isStarting = state.status === 'starting';

    const pill = $('header-status-pill');
    pill.className = `status-pill status-${state.status}`;
    $('header-status-text').textContent = isRunning
      ? `运行中 :${state.activePort}`
      : isStarting
      ? '启动自检中...'
      : state.status === 'error'
      ? '启动异常'
      : '待命 (未启动)';

    const toggleBtn = $('btn-primary-toggle');
    const restartBtn = $('btn-restart-server');
    toggleBtn.disabled = isStarting;

    if (isRunning) {
      toggleBtn.className = 'btn btn-danger btn-lg';
      toggleBtn.textContent = '⏹ 停止 CPA 服务';
      restartBtn.style.display = 'inline-block';
      $('metric-status').textContent = `🟢 运行中 (端口 ${state.activePort})`;
      $('metric-pid').textContent = `PID: ${state.pid || '-'} · 已运行 ${formatUptime(state.uptimeSeconds)}`;
    } else if (isStarting) {
      toggleBtn.className = 'btn btn-secondary btn-lg';
      toggleBtn.textContent = '⏳ 正在启动...';
      restartBtn.style.display = 'none';
      $('metric-status').textContent = '🟡 正在检测端口并启动...';
      $('metric-pid').textContent = '请稍候';
    } else {
      toggleBtn.className = 'btn btn-success btn-lg';
      toggleBtn.textContent = '▶ 启动 CPA 服务';
      restartBtn.style.display = 'none';
      $('metric-status').textContent = state.status === 'error' ? '🔴 服务异常退出' : '⚪ 待命选端口';
      $('metric-pid').textContent = '确认下方端口后点击启动';
    }

    $('metric-api-url').textContent = state.apiBaseUrl || `http://127.0.0.1:${state.activePort}/v1`;
    $('webui-tab-port').textContent = `:${state.activePort}`;
    $('webui-current-url').textContent = state.webUiUrl || `http://127.0.0.1:${state.activePort}/management.html`;

    // Port switch notice banner
    if (state.portSwitchNotice) {
      $('port-switch-banner').style.display = 'flex';
      $('port-switch-text').textContent = state.portSwitchNotice.message;
      $('input-main-port').value = state.activePort;
    }

    // Error banner
    if (state.lastError) {
      $('error-banner').style.display = 'flex';
      $('error-banner-text').textContent = state.lastError;
    } else {
      $('error-banner').style.display = 'none';
    }

    // WebUI iframe handling
    const placeholder = $('webui-placeholder');
    const iframe = $('webui-iframe');
    if (isRunning) {
      placeholder.style.display = 'none';
      iframe.style.display = 'block';
      if (lastLoadedWebUiUrl !== state.webUiUrl) {
        lastLoadedWebUiUrl = state.webUiUrl;
        iframe.src = state.webUiUrl;
      }
    } else {
      placeholder.style.display = 'flex';
      iframe.style.display = 'none';
      lastLoadedWebUiUrl = '';
    }
  }

  function renderPortAnalysis(report) {
    if (!report) return;
    const tbody = $('port-radar-tbody');
    const rows = [report.mainPort, ...(report.oauthPorts || [])];

    tbody.innerHTML = rows
      .map((item) => {
        let badgeHtml = '';
        let actionHtml = '<span style="color:var(--text-muted)">正常</span>';

        if (item.available) {
          badgeHtml = '<span class="badge badge-free">🟢 空闲可用</span>';
        } else if (item.occupiedByManaged) {
          badgeHtml = `<span class="badge badge-self">🔵 本程序运行中 (PID ${item.owner?.pid || '-'})</span>`;
        } else {
          const proc = item.owner?.processName || '未知进程';
          const pid = item.owner?.pid;
          badgeHtml = `<span class="badge badge-busy">🔴 已占用 (${proc}${pid ? ' / PID:' + pid : ''})</span>`;

          const btns = [];
          if (item.role === 'main' && item.suggestedPort) {
            btns.push(
              `<button class="btn btn-xs btn-accent" data-use-port="${item.suggestedPort}">切换至 ${item.suggestedPort}</button>`
            );
          }
          if (pid) {
            btns.push(`<button class="btn btn-xs btn-danger" data-kill-pid="${pid}">结束进程</button>`);
          }
          actionHtml = btns.join(' ') || '<span style="color:#fbbf24">启动时将自动避让</span>';
        }

        return `
          <tr>
            <td><strong>${item.port}</strong></td>
            <td>${item.label}</td>
            <td>${badgeHtml}</td>
            <td style="text-align:right;">${actionHtml}</td>
          </tr>
        `;
      })
      .join('');
  }

  function renderCredentials(creds = []) {
    $('cred-count-badge').textContent = String(creds.length);
    const listEl = $('credentials-list');
    if (!creds.length) {
      listEl.innerHTML = '<div style="color:var(--text-muted);padding:16px;text-align:center;">暂无已保存的 OAuth 凭据文件，可在守护面板或 WebUI 发起登录授权</div>';
      return;
    }
    listEl.innerHTML = creds
      .map(
        (c) => `
        <div class="cred-item">
          <div>
            <strong>${c.fileName}</strong>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              平台: ${c.type} ${c.email ? '· 账号: ' + c.email : ''} · 更新于 ${new Date(c.updatedAt).toLocaleString()}
            </div>
          </div>
          <span class="badge badge-free">${Math.ceil((c.size || 100) / 1024)} KB</span>
        </div>
      `
      )
      .join('');
  }

  function appendLogLine(entry) {
    if (!entry) return;
    const container = $('log-container');
    const div = document.createElement('div');
    div.className = 'log-line';
    const time = (entry.timestamp || '').split('T')[1]?.slice(0, 8) || '';
    const lvl = entry.level || 'INFO';
    div.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-${lvl}">[${lvl}]</span> ${entry.message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  async function refreshYamlEditor() {
    const res = await api.readRawYaml();
    if (res) {
      $('textarea-raw-yaml').value = res.yaml || '';
      $('yaml-file-path').textContent = res.path || 'data/config.yaml';
    }
  }

  // Event bindings
  function bindEvents() {
    // Tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const tabId = btn.getAttribute('data-tab');
        $(`tab-${tabId}`).classList.add('active');
        if (tabId === 'yaml') refreshYamlEditor();
      });
    });

    // Copy buttons
    document.querySelectorAll('[data-copy-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-copy-target');
        const text = $(targetId)?.textContent?.trim();
        if (text) copyText(text);
      });
    });

    // Folder open buttons
    document.querySelectorAll('[data-folder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        api.openFolder(btn.getAttribute('data-folder'));
      });
    });

    // Start / Stop primary button
    $('btn-primary-toggle').addEventListener('click', async () => {
      if (currentState && currentState.status === 'running') {
        const res = await api.stopServer();
        renderState(res.state);
        renderPortAnalysis(res.portAnalysis);
        showToast('已停止 CPA 服务');
      } else {
        const settings = collectSettingsFromForm();
        const res = await api.startServer(settings);
        applySettingsToForm(res.settings);
        renderState(res.state);
        renderPortAnalysis(res.portAnalysis);
        showToast(`🚀 CPA 服务已在端口 ${res.state.activePort} 启动`);
      }
    });

    $('btn-start-from-webui').addEventListener('click', async () => {
      const settings = collectSettingsFromForm();
      const res = await api.startServer(settings);
      applySettingsToForm(res.settings);
      renderState(res.state);
      renderPortAnalysis(res.portAnalysis);
    });

    $('btn-restart-server').addEventListener('click', async () => {
      const settings = collectSettingsFromForm();
      const res = await api.restartServer(settings);
      applySettingsToForm(res.settings);
      renderState(res.state);
      renderPortAnalysis(res.portAnalysis);
      showToast(`🔄 CPA 服务已重启 (:${res.state.activePort})`);
    });

    // Port scan & auto-pick
    $('btn-scan-ports').addEventListener('click', async () => {
      const port = Number($('input-main-port').value) || 8317;
      const report = await api.scanPorts(port);
      renderPortAnalysis(report);
      showToast(`已完成端口 ${port} 及其回调端口扫描`);
    });

    $('btn-auto-pick-port').addEventListener('click', async () => {
      const currentPort = Number($('input-main-port').value) || 8317;
      const { freePort } = await api.findFreePort(currentPort);
      $('input-main-port').value = freePort;
      const saved = await api.saveSettings({ port: freePort });
      applySettingsToForm(saved.settings);
      const report = await api.scanPorts(freePort);
      renderPortAnalysis(report);
      showToast(`✨ 已优选并保存空闲端口: ${freePort}`);
    });

    $('btn-apply-port').addEventListener('click', async () => {
      const settings = collectSettingsFromForm();
      const res = await api.saveSettings(settings);
      applySettingsToForm(res.settings);
      renderState(res.state);
      const report = await api.scanPorts(settings.port);
      renderPortAnalysis(report);
      showToast(`💾 端口配置 (${settings.port}) 已保存`);
    });

    $('btn-save-settings').addEventListener('click', async () => {
      const settings = collectSettingsFromForm();
      const res = await api.saveSettings(settings);
      applySettingsToForm(res.settings);
      renderState(res.state);
      showToast('💾 系统守护与核心参数已保存至 config.yaml');
    });

    // Port table delegation
    $('port-radar-tbody').addEventListener('click', async (e) => {
      const usePortBtn = e.target.closest('[data-use-port]');
      if (usePortBtn) {
        const newPort = Number(usePortBtn.getAttribute('data-use-port'));
        $('input-main-port').value = newPort;
        const res = await api.saveSettings({ port: newPort });
        applySettingsToForm(res.settings);
        const report = await api.scanPorts(newPort);
        renderPortAnalysis(report);
        showToast(`已切换主端口至 ${newPort}`);
        return;
      }

      const killBtn = e.target.closest('[data-kill-pid]');
      if (killBtn) {
        const pid = Number(killBtn.getAttribute('data-kill-pid'));
        await api.killProcess(pid);
        const report = await api.scanPorts(Number($('input-main-port').value) || 8317);
        renderPortAnalysis(report);
        showToast(`已终止占用进程 PID=${pid}`);
      }
    });

    // OAuth buttons
    document.querySelectorAll('[data-oauth]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const provider = btn.getAttribute('data-oauth');
        const res = await api.startOAuthLogin(provider);
        $('oauth-active-box').style.display = 'block';
        $('oauth-box-title').textContent = `已拉起 ${provider} 授权 (回调端口: ${res.callbackPort || '动态'})，请完成浏览器登录`;
        showToast(`已启动 ${provider} 授权流程`);
      });
    });

    $('btn-open-oauth-url').addEventListener('click', () => {
      const url = $('oauth-url-input').value.trim();
      if (url) api.openExternal(url);
    });

    $('btn-copy-oauth-url').addEventListener('click', () => {
      const url = $('oauth-url-input').value.trim();
      if (url) copyText(url, '授权链接已复制');
    });

    // WebUI toolbar
    $('btn-copy-webui-key').addEventListener('click', () => {
      copyText($('webui-toolbar-key').textContent.trim(), '管理密钥已复制');
    });

    $('btn-reload-webui').addEventListener('click', () => {
      const iframe = $('webui-iframe');
      if (iframe && iframe.src) iframe.src = iframe.src;
    });

    $('btn-external-webui').addEventListener('click', () => {
      if (currentState?.webUiUrl) api.openExternal(currentState.webUiUrl);
    });

    // YAML actions
    $('btn-reload-yaml').addEventListener('click', () => {
      refreshYamlEditor();
      showToast('已重新读取 config.yaml');
    });

    $('btn-save-yaml').addEventListener('click', async () => {
      await api.saveRawYaml($('textarea-raw-yaml').value);
      showToast('💾 config.yaml 已保存并触发热重载');
    });

    $('btn-clear-logs').addEventListener('click', () => api.clearLogs());
    $('btn-dismiss-switch').addEventListener('click', () => {
      $('port-switch-banner').style.display = 'none';
    });

    // IPC Listeners
    api.onStatusChange((payload) => {
      if (payload.settings) applySettingsToForm(payload.settings);
      if (payload.state) renderState(payload.state);
      if (payload.credentials) renderCredentials(payload.credentials);
    });

    api.onLog((entry) => appendLogLine(entry));
    api.onLogsCleared(() => {
      $('log-container').innerHTML = '';
    });

    api.onOAuthUrl((payload) => {
      if (payload?.url) {
        $('oauth-active-box').style.display = 'block';
        $('oauth-url-input').value = payload.url;
      }
    });

    api.onOAuthExit((payload) => {
      if (payload?.code === 0) {
        showToast('✅ OAuth 账号授权已完成并落盘！');
      }
    });
  }

  async function init() {
    bindEvents();
    const snap = await api.getDashboardSnapshot();
    applySettingsToForm(snap.settings);
    renderState(snap.state);
    renderPortAnalysis(snap.portAnalysis);
    renderCredentials(snap.credentials);
    (snap.logs || []).forEach(appendLogLine);

    setInterval(async () => {
      if (currentState && currentState.status === 'running') {
        currentState.uptimeSeconds = (currentState.uptimeSeconds || 0) + 1;
        $('metric-pid').textContent = `PID: ${currentState.pid || '-'} · 已运行 ${formatUptime(currentState.uptimeSeconds)}`;
      }
    }, 1000);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
