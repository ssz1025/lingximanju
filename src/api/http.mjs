// REST 共用基础件：JSON 响应 / 请求体 / 资产流式下发
import fs from 'node:fs';
import { assetPath } from '../core/store.mjs';

export function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    const withStatus = (err, statusCode) => Object.assign(err, { statusCode });   // 让 server.mjs 回 4xx 而非 500
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(withStatus(new Error('请求体过大'), 413)); req.destroy(); }
      else parts.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(withStatus(new Error('JSON 解析失败'), 400)); }
    });
    req.on('error', reject);
  });
}

/** 资产磁盘绝对路径（存在且为文件才返回），避免为判存在性把整个 zip/mp4 读进内存 */
export function assetFile(name) {
  const file = name ? assetPath(name) : null;
  try { return file && fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/** 流式下发资产：成片/导演包可达数百 MB，整读内存会放大峰值且客户端断开后无法释放 */
export function streamAsset(res, name, filename, type = 'application/octet-stream') {
  const file = assetFile(name);
  if (!file) return json(res, { error: '文件不存在或已被清理' }, 404), true;
  const safe = String(filename).replace(/[^A-Za-z0-9_.-]/g, '_');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());   // 客户端中途断开即释放文件句柄
  stream.pipe(res);
  return true;
}
