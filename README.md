# tido-CPA Desktop

<p align="center">
  <strong>桌面端的 CLIProxyAPI (CPA) —— 彻底脱离 Docker，双击一键运行，开箱即用。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows_x64-0078D6?style=flat-square" alt="Windows x64" />
  <img src="https://img.shields.io/badge/CPA_Core-v8.0.44-10B981?style=flat-square" alt="CPA v8.0.44" />
  <img src="https://img.shields.io/badge/WebUI-CPAMC_v1.26.7-3B82F6?style=flat-square" alt="WebUI v1.26.7" />
  <img src="https://img.shields.io/badge/License-MIT-F59E0B?style=flat-square" alt="MIT License" />
</p>

---

## ✨ 项目简介

**tido-CPA Desktop** 是专为 Windows 打造的桌面端 **CLIProxyAPI (CPA)** 守护与管理程序。

原版 CPA 往往依赖 Docker 部署、手动编写 `config.yaml` 以及映射多个 OAuth 回调端口。本项目将其封装为原生的 Windows 桌面应用，**无需安装 Docker 或 WSL**，双击即可一键启动反代服务与可视化管理中心，极其方便。

---

## 🚀 核心亮点

- **⚡ 一键运行，彻底告别 Docker**：内置原生无黑框 `cli-proxy-api.exe` 内核与离线版 `management.html` 管理台，打开软件即自动完成自检并启动服务。
- **🎯 端口自分析与自动顺延切换**：实时扫描主端口（默认 `8317`）及各平台 OAuth 回调端口占用状态；若端口被占用，自动顺延切换至空闲端口并同步配置。
- **🎛️ 内嵌完整 WebUI（免密直连）**：内置最新 CPA 业务管理中心，自动注入当前端口与管理密钥，切页即用，无需重复输入密码。
- **🔌 插件系统权限全开**：默认解锁 `plugins.enabled: true` 并内置 `gemini-cli`、`jshandler` 等官方插件支持，直接在插件商店与插件管理页管理扩展。
- **🛡️ 原生系统守护能力**：支持 **Windows 开机自启**、**打开软件自动启动服务**、**关闭窗口最小化到系统托盘**、**进程崩溃自动重启自愈**。
- **📂 便携式数据目录**：所有配置（`data/config.yaml`）、授权凭据（`data/auths/`）、插件（`data/plugins/`）与日志（`data/logs/`）均集中存放在 `data/` 目录，清晰易维护。

---

## 📦 快速使用

### 方式一：直接使用安装包 / 便携版（推荐）
1. 前往 [Releases](../../releases) 下载最新版的 **`CPA-Desktop-Setup-v1.0.0-x64.exe`** 安装程序。
2. 安装后双击桌面图标即可一键运行：
   - **默认 API Base URL**：`http://127.0.0.1:8317/v1`
   - **默认客户端 API Key**：`sk-cpa-local-8888`
   - **默认管理密钥**：`cpa-admin-8888`（内置面板已自动免密登录）

### 方式二：从源码构建
1. 克隆仓库并安装依赖：
   ```bash
   git clone https://github.com/emstudio010-hub/tido-CPA-Desktop.git
   cd tido-CPA-Desktop
   npm install
   ```
2. 将官方 `cli-proxy-api.exe` 放入 `resources/bin/`，执行打包：
   ```bash
   npm run pack:win
   ```
3. 使用 Inno Setup 编译 `installer.iss` 即可生成单文件安装包。

---

## 📄 开源协议与致谢

- **署名与维护**：**tido-CPA Desktop**
- **开源协议**：本项目基于 [MIT License](LICENSE) 开源。
- **上游致谢**：内核与管理中心基于 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 与 [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)。
