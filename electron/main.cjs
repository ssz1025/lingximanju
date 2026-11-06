// Electron 主进程：以 ELECTRON_RUN_AS_NODE 方式拉起 server.mjs 子进程，
// 复用零依赖后端，窗口内加载本地服务。数据写入 OS 用户数据目录。
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

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
      createWindow(url);
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
