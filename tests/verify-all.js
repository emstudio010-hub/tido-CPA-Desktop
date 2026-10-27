const assert = require('assert');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { ConfigManager } = require('../src/main/config-manager');
const { ProcessSupervisor } = require('../src/main/process-supervisor');
const { analyzeAllPorts, findNextAvailablePort } = require('../src/main/port-analyzer');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function runTests() {
  console.log('=== [1/4] Testing ConfigManager & YAML Sync ===');
  const testBase = path.join(__dirname, '../.test-runtime');
  fs.rmSync(testBase, { recursive: true, force: true });

  const cfgMgr = new ConfigManager({
    baseDir: testBase,
    resourcesDir: path.join(__dirname, '../resources')
  });
  const settings = cfgMgr.loadSettings();
  assert.strictEqual(settings.port, 8317);
  assert.strictEqual(settings.autoStartOS, true, 'autoStartOS should be true by default');
  assert.strictEqual(settings.autoStartServer, true, 'autoStartServer should be true by default');
  assert.strictEqual(settings.pluginsEnabled, true, 'pluginsEnabled should be true by default');
  assert.ok(fs.existsSync(cfgMgr.configYamlPath), 'config.yaml should be generated');
  const rawYaml = fs.readFileSync(cfgMgr.configYamlPath, 'utf8');
  assert.ok(/plugins:\s*\n\s*enabled:\s*true/m.test(rawYaml), 'plugins.enabled must be true in config.yaml');
  assert.ok(/model-alias:\s*\{\}/m.test(rawYaml), 'oauth.model-alias must be present');
  assert.ok(/excluded-models:\s*\{\}/m.test(rawYaml), 'oauth.excluded-models must be present as a map');
  assert.ok(/client:\s*\n\s*codex:/m.test(rawYaml), 'client.codex section must be present');
  assert.ok(/upstream:\s*\n\s*codex:/m.test(rawYaml), 'upstream.codex section must be present');
  assert.ok(/save-cooldown-status:\s*false/m.test(rawYaml), 'save-cooldown-status must be false');
  assert.ok(fs.existsSync(cfgMgr.managementHtmlPath), 'offline management.html should be copied');

  console.log('=== [2/4] Testing PortAnalyzer & Conflict Auto-Switch ===');
  const basePort = await findNextAvailablePort(18317);
  // Occupy basePort with a dummy server to force auto-switch!
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((r) => blocker.listen(basePort, '127.0.0.1', r));

  const diag = await analyzeAllPorts(basePort, null);
  assert.strictEqual(diag.mainPort.available, false, 'Occupied port must be detected as unavailable');
  assert.ok(diag.recommendedMainPort > basePort, 'Must recommend next free port');

  console.log(`=== [3/4] Testing ProcessSupervisor Auto-Switch (${basePort} -> ${diag.recommendedMainPort}) & Real CPA Kernel ===`);
  const supervisor = new ProcessSupervisor(cfgMgr);
  const testEnv = supervisor.buildChildEnv({ proxyUrl: 'http://127.0.0.1:9999' });
  assert.strictEqual(testEnv.env.HTTP_PROXY, 'http://127.0.0.1:9999');
  assert.ok(testEnv.env.NO_PROXY.includes('127.0.0.1'), 'NO_PROXY must include 127.0.0.1 loopback protection');

  const state = await supervisor.start({
    port: basePort,
    autoSwitchPort: true,
    localModel: true
  });

  assert.strictEqual(state.status, 'running', 'Supervisor should be running');
  assert.notStrictEqual(state.activePort, basePort, 'Active port must have auto-switched away from blocked port');
  assert.ok(state.portSwitchNotice, 'Port switch notice should be populated');
  console.log(`   -> Switched from ${basePort} to ${state.activePort} (PID: ${state.pid})`);

  console.log('=== [4/4] Verifying Offline WebUI & /v1/models API ===');
  const webuiRes = await httpGet(state.webUiUrl);
  assert.strictEqual(webuiRes.statusCode, 200, 'WebUI management.html should return 200');
  assert.ok(webuiRes.body.length > 10000, 'WebUI HTML should be non-empty');

  const modelsRes = await httpGet(`${state.apiBaseUrl}/models`, {
    Authorization: `Bearer ${settings.clientApiKey}`
  });
  assert.strictEqual(modelsRes.statusCode, 200, '/v1/models should return 200 with clientApiKey');

  const pluginsRes = await httpGet(`http://127.0.0.1:${state.activePort}/v0/management/plugins`, {
    Authorization: `Bearer ${settings.managementKey}`
  });
  assert.strictEqual(pluginsRes.statusCode, 200, '/v0/management/plugins should return 200');
  const pluginsData = JSON.parse(pluginsRes.body);
  assert.strictEqual(pluginsData.plugins_enabled, true, 'Management API must report plugins_enabled: true');

  const modelAliasRes = await httpGet(`http://127.0.0.1:${state.activePort}/v8/management/config/oauth/model-alias`, {
    Authorization: `Bearer ${settings.managementKey}`
  });
  assert.strictEqual(modelAliasRes.statusCode, 200, '/v8/management/config/oauth/model-alias must return 200');

  const excludedModelsRes = await httpGet(`http://127.0.0.1:${state.activePort}/v8/management/config/oauth/excluded-models`, {
    Authorization: `Bearer ${settings.managementKey}`
  });
  assert.strictEqual(excludedModelsRes.statusCode, 200, '/v8/management/config/oauth/excluded-models must return 200');

  await supervisor.stop(true);
  await new Promise((r) => blocker.close(r));
  fs.rmSync(testBase, { recursive: true, force: true });
  console.log('✅ ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
