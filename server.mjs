// lingximanju 单进程服务：静态页面 + REST + SSE + 生成资产
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handleApi } from './src/api/routes.mjs';
import { PUBLIC_DIR, DATA_DIR, readAsset } from './src/core/store.mjs';
import { assetFile } from './src/api/http.mjs';
import { ensureCustomStylesLoaded } from './src/core/director-style-store.mjs';

// 启动即加载自定义导演风格（data/director-styles.json）：
// 项目选择自定义风格后重启，aesthetic 解析与技能索引必须立即可用。
ensureCustomStylesLoaded();

// 默认端口刻意避开 3000/4173/4174/5000/5173/8000/8080/8188 等常见开发端口，
// 也避开 macOS 临时端口段（49152–65535），降低与其他服务抢端口的概率。
const DEFAULT_PORT = 45367;
const HOST = process.env.HOST || '127.0.0.1';
const requested = Number(process.env.PORT);
const BASE_PORT = Number.isInteger(requested) && requested > 0 && requested <= 65535 ? requested : DEFAULT_PORT;
// 端口被占用时自动向后顺延；STRICT_PORT=1 可关闭该行为（便于脚本固定端口）。
const STRICT_PORT = process.env.STRICT_PORT === '1';
const MAX_TRIES = STRICT_PORT ? 1 : Math.max(1, Math.min(30, Number(process.env.PORT_SCAN) || 10));
let candidate = BASE_PORT;
let attempts = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  // 音色抽卡产物：<audio> 直接播放，缺 MIME 时浏览器会当成下载或静默失败
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

/** 视频资产按 Range 分段下发：<video> 的首帧封面（#t=0.1）/ 拖动进度条都依赖 206 响应，
 *  整文件 200 回给 seek 会退化为全量下载，几十 MB 的成片每拖一次就传一遍。 */
function serveAssetRange(req, res, file, type) {
  const size = fs.statSync(file).size;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  const m = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!m) {
    res.writeHead(200, { ...base, 'Content-Length': size });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }
  let start = m[1] === '' ? NaN : Number(m[1]);
  let end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  // 「bytes=-N」= 末尾 N 字节；起点越界一律 416，别把 0 塞回去
  if (Number.isNaN(start)) start = size - Number(m[2]);
  if (!Number.isFinite(start) || start < 0 || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

// 在线更新源：/updates/* 直接映射数据目录下 updates/（Electron 端 feed 填 local 即走这里）。
const UPDATES_DIR = path.join(DATA_DIR, 'updates');
fs.mkdirSync(UPDATES_DIR, { recursive: true });

function serveUpdates(req, res, pathname) {
  const name = decodeURIComponent(pathname.slice('/updates/'.length));
  // 只允许单层文件名，杜绝路径穿越
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return send(res, 403, '禁止访问');
  }
  const file = path.join(UPDATES_DIR, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, '更新文件不存在', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // dmg/zip 安装包体积大，走 Range 分段流式，version.json 等小文件整读直发
  if (ext === '.dmg' || ext === '.zip') return serveAssetRange(req, res, file, type);
  return send(res, 200, fs.readFileSync(file), type, { 'Cache-Control': 'no-cache' });
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/assets/')) {
    const name = decodeURIComponent(pathname.slice('/assets/'.length));
    const ext = path.extname(name).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 视频（成片 / 片段）走分段流式，其余小文件仍整读直发（PNG/JSON 等拿全量更快）
    if (ext === '.mp4' || ext === '.webm') {
      const file = assetFile(name);
      if (!file) return send(res, 404, '资产不存在', 'text/plain; charset=utf-8');
      return serveAssetRange(req, res, file, type);
    }
    const buf = readAsset(name);
    if (!buf) return send(res, 404, '资产不存在', 'text/plain; charset=utf-8');
    return send(res, 200, buf, type, { 'Cache-Control': 'public, max-age=86400' });
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, '禁止访问');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, '页面不存在', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  return send(res, 200, body, MIME[ext] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    // Host 必须是本机字面量（IP/localhost）：挡住 DNS rebinding——
    // 攻击者域名解析到 127.0.0.1 后浏览器仍带该域名 Host，会被这里直接 403。
    const host = String(req.headers.host || '');
    if (host && !/^(?:localhost|127(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/.test(host)) {
      return send(res, 403, JSON.stringify({ error: '拒绝非本机 Host 访问' }), 'application/json; charset=utf-8');
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/updates/')) {
      serveUpdates(req, res, url.pathname);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) send(res, 404, '{}', 'application/json; charset=utf-8');
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server]', err);
    // readBody 等处用 statusCode 标注的客户端错误按 4xx 返回，其余才是 500
    const status = Number(err.statusCode) || 500;
    if (!res.headersSent) send(res, status, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
    else res.end();
  }
});

// 目标端口被占用（或无权限绑定）时自动顺延，最多尝试 MAX_TRIES 个端口。
server.on('error', (err) => {
  if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts < MAX_TRIES && candidate < 65535) {
    console.warn(`  ⚠  端口 ${candidate} 不可用（${err.code}），尝试 ${candidate + 1}`);
    candidate += 1;
    attempts += 1;
    setTimeout(() => server.listen(candidate, HOST), 50);
    return;
  }
  console.error(`  ✗  启动失败：${err.code || err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`     端口 ${BASE_PORT} 起连续 ${MAX_TRIES} 个端口均被占用，可用 PORT=xxxxx 指定其他端口。`);
  }
  process.exit(1);
});

function onListening() {
  const port = server.address().port;
  const url = `http://${HOST}:${port}`;
  // 记录真实绑定端口，便于脚本/外部工具发现（自动顺延时尤其有用）。
  try {
    fs.writeFileSync(path.join(DATA_DIR, '.port'),
      JSON.stringify({ host: HOST, port, url, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  } catch { /* 端口文件写入失败不影响服务 */ }
  console.log('');
  console.log('  lingximanju · 无限画布智能体影像工坊');
  console.log(`  ➜  本地访问   ${url}${port !== BASE_PORT ? `  （默认 ${BASE_PORT} 被占用，已自动顺延）` : ''}`);
  console.log(`  ➜  端口配置   PORT=xxxxx ./start.sh ｜ STRICT_PORT=1 禁用自动顺延 ｜ 实际端口见 data/.port`);
  console.log('  ➜  生成后端  本地 ComfyUI（API 格式工作流）｜未配置时自动回退 Mock 自绘');
  console.log('  ➜  最终产物  成片 MP4 ｜ 导演包 mmxpack.zip（MiniMax H3 Director 等导演工作台）');
  console.log('  ➜  架构文档   docs/ARCHITECTURE.md ｜ 编排设计 docs/AGENTS.md');
  console.log('');
}

server.listen(candidate, HOST, onListening);
