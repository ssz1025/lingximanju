// Electron 主进程：以 ELECTRON_RUN_AS_NODE 方式拉起 server.mjs 子进程，
// 复用零依赖后端，窗口内加载本地服务。数据写入 OS 用户数据目录。
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

// ── 在线更新（轻量自实现，无需签名/第三方依赖）────────────────────────
// 更新源优先级：环境变量 LINGXIMANJU_UPDATE_FEED > userData/update-feed.txt > 禁用
// 值为关键字「local」时使用内置本地服务的 /updates/ 目录作为更新源
// （开发态 <项目>/data/updates，打包后 <userData>/updates）；
// 其余值为静态文件目录根地址。其下的 version.json 格式：
//   { "version": "1.0.1", "url": "lingximanju-1.0.1-arm64.dmg", "notes": "更新说明" }
// url 支持相对文件名（相对更新源根地址解析）或完整 http(s) 地址。
let serverUrl = null;

const resolveFeedUrl = () => {
  if (process.env.LINGXIMANJU_UPDATE_FEED) {
    return process.env.LINGXIMANJU_UPDATE_FEED === 'local'
      ? (serverUrl ? `${serverUrl}/updates` : null)
      : process.env.LINGXIMANJU_UPDATE_FEED.replace(/\/+$/, '');
  }
  try {
    const file = path.join(app.getPath('userData'), 'update-feed.txt');
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return value === 'local' ? (serverUrl ? `${serverUrl}/updates` : null) : value.replace(/\/+$/, '');
  } catch { /* 未配置即禁用 */ }
  return null;
};

const compareVersions = (a, b) => {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

const fetchVersionManifest = (feedUrl) => new Promise((resolve, reject) => {
  const mod = feedUrl.startsWith('https:') ? https : http;
  const req = mod.get(`${feedUrl}/version.json`, { timeout: 10000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('version.json 格式错误')); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('请求超时')));
  req.on('error', reject);
});

const checkForUpdates = async (interactive) => {
  const feedUrl = resolveFeedUrl();
  if (!feedUrl) {
    if (interactive) dialog.showMessageBox(win, { type: 'info', message: '未配置更新源', detail: `请在数据目录创建 update-feed.txt 写入更新源地址，或设置环境变量 LINGXIMANJU_UPDATE_FEED。\n当前数据目录：${app.getPath('userData')}` });
    return;
  }
  let manifest;
  try {
    manifest = await fetchVersionManifest(feedUrl);
  } catch (err) {
    if (interactive) dialog.showMessageBox(win, { type: 'warning', message: '检查更新失败', detail: String(err.message || err) });
    return;
  }
  const cmp = compareVersions(manifest.version, app.getVersion());
  if (cmp > 0) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `发现新版本 v${manifest.version}（当前 v${app.getVersion()}）`,
      detail: manifest.notes || '点击「前往下载」打开下载页面，下载后手动安装。',
      buttons: ['前往下载', '以后再说'],
      defaultId: 0,
    });
    if (response === 0 && manifest.url) {
      // 相对文件名按更新源根地址解析，完整 http(s) 地址直接使用
      const target = /^https?:\/\//i.test(manifest.url) ? manifest.url : `${feedUrl}/${manifest.url}`;
      shell.openExternal(target);
    }
  } else if (interactive) {
    dialog.showMessageBox(win, { type: 'info', message: '已是最新版本', detail: `当前版本 v${app.getVersion()}` });
  }
};

let serverProc = null;
let win = null;

// 单实例锁：二次启动时聚焦已有窗口，避免两个服务抢数据目录。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // 服务端数据目录：macOS ~/Library/Application Support/lingximanju，
  // Windows %APPDATA%/lingximanju，Linux ~/.config/lingximanju。
  process.env.LINGXIMANJU_DATA_DIR = app.getPath('userData');

  const startServer = () => {
    // 打包后 process.execPath 是 Electron 二进制，用 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 运行，
    // 无需为各平台额外捆绑 Node。
    serverProc = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'server.mjs')],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    serverProc.stdout.on('data', (chunk) => { process.stdout.write(chunk); });
    serverProc.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    serverProc.on('exit', (code) => {
      // 服务进程意外退出时结束应用（正常退出由我们主动 kill，code 为 null）。
      if (code !== null && win && !win.isDestroyed()) {
        dialog.showErrorBox('服务已退出', `lingximanju 后端服务异常退出（code ${code}），应用即将关闭。`);
        app.quit();
      }
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 15000);
      const onData = (chunk) => {
        const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      };
      serverProc.stdout.on('data', onData);
      serverProc.once('exit', () => { clearTimeout(timer); reject(new Error('服务进程提前退出')); });
    });
  };

  const createWindow = (url) => {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      title: 'lingximanju · 无限画布智能体影像工坊',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // 外部链接（README 里的论文/项目链接等）交给系统浏览器，不在窗口内跳走。
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      shell.openExternal(target);
      return { action: 'deny' };
    });
    win.loadURL(url);
  };

  app.whenReady().then(async () => {
    try {
      const url = await startServer();
      serverUrl = url;
      createWindow(url);
      // 应用菜单（macOS 菜单栏）提供手动「检查更新」入口。
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.name, submenu: [
          { role: 'about' },
          { label: '检查更新', click: () => checkForUpdates(true) },
          { type: 'separator' },
          { role: 'quit' },
        ] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
      // 启动后静默检查一次更新（已配置更新源才生效）。
      setTimeout(() => { checkForUpdates(false); }, 3000);
    } catch (err) {
      dialog.showErrorBox('启动失败', String(err.message || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (serverProc) serverProc.kill();
    app.quit();
  });

  app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
}
