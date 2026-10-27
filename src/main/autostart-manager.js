const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = 'CLIProxyAPIDesktop';
const WIN_SAFE_CWD = process.env.SystemRoot || 'C:\\Windows';

class AutoStartManager {
  constructor(electronApp = null) {
    this.app = electronApp;
  }

  getExecutableCommand() {
    const exePath = process.execPath;
    return `"${exePath}" --autostart`;
  }

  async isEnabled() {
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync('reg.exe', ['query', REG_KEY, '/v', REG_VALUE_NAME], {
          cwd: WIN_SAFE_CWD,
          windowsHide: true,
          timeout: 3000
        });
        return stdout.includes(REG_VALUE_NAME);
      } catch (_) {
        if (this.app && typeof this.app.getLoginItemSettings === 'function') {
          try {
            return Boolean(this.app.getLoginItemSettings().openAtLogin);
          } catch (_) {}
        }
        return false;
      }
    }

    if (this.app && typeof this.app.getLoginItemSettings === 'function') {
      try {
        return Boolean(this.app.getLoginItemSettings().openAtLogin);
      } catch (_) {}
    }
    return false;
  }

  async setEnabled(enable) {
    const target = Boolean(enable);

    if (this.app && typeof this.app.setLoginItemSettings === 'function') {
      try {
        this.app.setLoginItemSettings({
          openAtLogin: target,
          path: process.execPath,
          args: ['--autostart']
        });
      } catch (_) {}
    }

    if (process.platform === 'win32') {
      try {
        if (target) {
          await execFileAsync(
            'reg.exe',
            ['add', REG_KEY, '/v', REG_VALUE_NAME, '/t', 'REG_SZ', '/d', this.getExecutableCommand(), '/f'],
            { cwd: WIN_SAFE_CWD, windowsHide: true, timeout: 3000 }
          );
        } else {
          await execFileAsync('reg.exe', ['delete', REG_KEY, '/v', REG_VALUE_NAME, '/f'], {
            cwd: WIN_SAFE_CWD,
            windowsHide: true,
            timeout: 3000
          });
        }
      } catch (_) {}
    }

    return target;
  }
}

module.exports = { AutoStartManager };
