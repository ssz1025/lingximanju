// 资源域：data/assets/ 下已生成资源的统一索引、打标共享与删除（资源库弹窗取数）
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { deleteAsset, assetPath, ASSET_DIR, PROJECT_DIR } from '../../core/store.mjs';
import { listAssets, updateAsset, forgetAsset, reindex, assetStats } from '../../core/assets.mjs';

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
