// 资源域：data/assets/ 下已生成资源的统一索引、打标共享与删除（资源库弹窗取数）
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { deleteAsset, assetPath, ASSET_DIR, PROJECT_DIR } from '../../core/store.mjs';
import { listAssets, updateAsset, forgetAsset, reindex, assetStats, getAsset } from '../../core/assets.mjs';

/** 资源是否被项目引用：原文扫描各项目 JSON（含封面、节点数据里的 /assets/ 引用） */
function findReferencing(name) {
  const hit = [];
  for (const f of fs.readdirSync(PROJECT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      if (fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8').includes(name)) hit.push(f.replace(/\.json$/, ''));
    } catch { /* 单个项目读失败不阻塞删除 */ }
  }
  return hit;
}

/** 孤儿资源扫描：项目 JSON 原文各读一次，再对全部资源名做包含判断（避免 N×M 次读文件） */
function findOrphans(assets) {
  const texts = [];
  for (const f of fs.readdirSync(PROJECT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { texts.push(fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8')); } catch { /* 跳过坏文件 */ }
  }
  return assets.filter((a) => !texts.some((t) => t.includes(a.file)));
}

export async function handleAssets(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // 全量列表：磁盘定存在、index.json 定类型/名称/标签/来源项目
  if (pathname.match(MATCH.assets) && method === 'GET') {
    return json(res, { assets: listAssets(), stats: assetStats() }), true;
  }

  // 重扫目录：收录新文件、剔除已删除文件（手动往 data/assets/ 丢文件后的同步入口）
  if (pathname.match(MATCH.assetReindex) && method === 'POST') {
    return json(res, { ok: true, ...reindex(), assets: listAssets(), stats: assetStats() }), true;
  }

  // 孤儿资源：未被任何项目 JSON 引用的文件（一键清理的目标清单）
  if (pathname.match(MATCH.assetOrphans) && method === 'GET') {
    const orphans = findOrphans(listAssets());
    return json(res, {
      orphans: orphans.map((a) => ({ file: a.file, url: a.url, name: a.name, bytes: a.bytes, type: a.type })),
      count: orphans.length, bytes: orphans.reduce((s, a) => s + (a.bytes || 0), 0),
    }), true;
  }

  // 批量删除：逐个走「穿越校验 + 引用检查 + 落盘删除」，被引用的不阻塞其余文件
  if (pathname.match(MATCH.assetBatch) && method === 'POST') {
    const body = await readBody(req);
    const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 500) : [];
    if (!files.length) return json(res, { error: 'files 不能为空' }, 400), true;
    const deleted = [];
    const blocked = [];
    let bytes = 0;
    for (const name of files) {
      if (!path.resolve(assetPath(name)).startsWith(ASSET_DIR + path.sep)) { blocked.push({ file: name, error: '非法的资源名' }); continue; }
      const refs = findReferencing(name);
      if (refs.length) { blocked.push({ file: name, error: `被 ${refs.length} 个项目引用`, refs }); continue; }
      bytes += getAsset(name)?.bytes || 0;
      if (deleteAsset(name)) { forgetAsset(name); deleted.push(name); }
      else blocked.push({ file: name, error: '文件不存在' });
    }
    return json(res, { ok: true, deleted, blocked, bytes, assets: listAssets(), stats: assetStats() }), true;
  }

  const assetMatch = pathname.match(MATCH.asset);
  if (assetMatch && (method === 'PATCH' || method === 'PUT')) {
    const name = assetMatch[1];
    const body = await readBody(req);
    const out = updateAsset(name, body || {});
    return json(res, out.ok ? { ok: true, asset: out.asset } : { error: out.message }, out.ok ? 200 : 400), true;
  }

  if (assetMatch && method === 'DELETE') {
    const name = assetMatch[1];
    // 正则允许 `.`，需在 resolve 后确认仍位于 ASSET_DIR 内，杜绝 `..` 目录穿越
    if (!path.resolve(assetPath(name)).startsWith(ASSET_DIR + path.sep)) {
      return json(res, { error: '非法的资源名' }, 400), true;
    }
    const refs = findReferencing(name);
    if (refs.length) {
      return json(res, { error: `资源仍被 ${refs.length} 个项目引用：${refs.join('、')}`, refs }, 409), true;
    }
    forgetAsset(name);
    return json(res, { ok: true, deleted: deleteAsset(name) }), true;
  }

  return false;
}
