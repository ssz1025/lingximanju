// 导演风格统一管理域（项目无关）：清单 / 保存自定义 / 删除自定义 / AI 对话生成
//
// 与 routes/director.mjs（项目技能选择 + 一键全流程）的分工：
//   director.mjs   —— 「项目用哪个风格」
//   本文件         —— 「风格库本身长什么样、怎么增删、怎么用 AI 造一个新的」
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import {
  ensureCustomStylesLoaded, listAllStyleCards, listCustomStyles,
  saveCustomStyle, deleteCustomStyle,
} from '../../core/director-style-store.mjs';
import { styleForgeChat, draftToStyle } from '../../core/style-forge-chat.mjs';
import { getDirectorStyle } from '../../core/director-styles.mjs';

/** 完整档案投影：管理详情页要看全部美学字段；内置档案也一并下发（本来就是公开设计文档） */
function fullStyle(id) {
  const st = getDirectorStyle(id);
  return st ? { ...st } : null;
}

export async function handleDirectorStyles(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const chatMatch = pathname.match(MATCH.directorStyleChat);
  const itemMatch = pathname.match(MATCH.directorStyleItem);
  const rootMatch = MATCH.directorStylesRoot.test(pathname);
  if (!rootMatch && !chatMatch && !itemMatch) return false;

  ensureCustomStylesLoaded();

  // ---------- AI 对话生成：无状态一轮（历史 + 草稿 进，reply + 草稿 出） ----------
  if (chatMatch && method === 'POST') {
    const body = await readBody(req);
    try {
      const out = await styleForgeChat({
        messages: body.messages,
        draft: body.draft,
        modelId: String(body.modelId || ''),
        log: (level, msg) => console.log(`[style-forge][${level}] ${msg}`),
      });
      return json(res, { ok: true, ...out }), true;
    } catch (err) {
      return json(res, { error: `风格设计对话失败：${err.message}` }, 502), true;
    }
  }

  // ---------- 全量清单：卡片投影 + 自定义完整档案 ----------
  if (rootMatch && method === 'GET') {
    return json(res, {
      ok: true,
      styles: listAllStyleCards(),
      customs: listCustomStyles(),
    }), true;
  }

  // ---------- 保存自定义风格（新增 / 更新） ----------
  if (rootMatch && method === 'POST') {
    const body = await readBody(req);
    try {
      const { style, created } = saveCustomStyle(body?.style || body);
      return json(res, {
        ok: true, created, style, full: fullStyle(style.id),
        message: `${created ? '已新增' : '已更新'}导演风格「${style.label}」`,
      }), true;
    } catch (err) {
      return json(res, { error: err.message }, 400), true;
    }
  }

  // ---------- 删除自定义风格 ----------
  if (itemMatch && method === 'DELETE') {
    const removed = deleteCustomStyle(decodeURIComponent(itemMatch[1]));
    if (!removed) return json(res, { error: '自定义风格不存在（内置档案不可删除）' }, 404), true;
    return json(res, { ok: true, removed: removed.id, message: `已删除自定义风格「${removed.label}」` }), true;
  }

  // ---------- 单个风格详情（内置 + 自定义都可查） ----------
  if (itemMatch && method === 'GET') {
    const st = fullStyle(decodeURIComponent(itemMatch[1]));
    if (!st) return json(res, { error: '风格不存在' }, 404), true;
    return json(res, { ok: true, style: st }), true;
  }

  // 草稿预校验：保存前端让用户先看归一化结果
  if (MATCH.directorStylesRoot.test(pathname) && method === 'PUT') {
    const body = await readBody(req);
    try {
      return json(res, { ok: true, style: draftToStyle(body?.draft || body) }), true;
    } catch (err) {
      return json(res, { error: err.message }, 400), true;
    }
  }

  return json(res, { error: `不支持的请求 ${method} ${pathname}` }, 405), true;
}
