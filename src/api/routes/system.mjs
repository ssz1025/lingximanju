// 系统域：SSE 事件流 / 健康检查 / 启动引导 / 示例原著 / 分集预览
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from '../http.mjs';
import { subscribe } from '../../core/events.mjs';
import { listProjects, saveProject, EXAMPLES_DIR } from '../../core/store.mjs';
import { buildTemplate, TEMPLATE_META } from '../../pipelines/templates.mjs';
import { listAgents } from '../../agents/index.mjs';
import { loadComfyConfig, comfySummary } from '../../core/comfy-config.mjs';
import { STEPS } from '../../core/project-steps.mjs';
import { validateNovelInput, novelPreview } from '../../core/novel.mjs';

export async function handleSystem(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/events' && method === 'GET') { subscribe(req, res); return true; }
  if (pathname === '/api/health') return json(res, { ok: true, ts: Date.now() }), true;

  if (pathname === '/api/bootstrap' && method === 'GET') {
    let projects = listProjects();
    if (!projects.length) {
      const demo = buildTemplate('idea2video');
      saveProject(demo);
      projects = listProjects();
    }
    const active = projects.filter((p) => !p.archived);
    return json(res, {
      projects, templates: TEMPLATE_META, agents: listAgents(),
      recent: projects[0]?.id || null, serverTime: Date.now(),
      comfy: comfySummary(loadComfyConfig()),
      steps: STEPS,
      stats: {
        total: projects.length, active: active.length,
        novels: projects.filter((p) => p.kind === 'novel').length,
        done: projects.filter((p) => p.status === 'done').length,
        running: projects.filter((p) => p.status === 'running').length,
        archived: projects.length - active.length,
        favorite: projects.filter((p) => p.favorite).length,
      },
    }), true;
  }

  /** 向导「载入示例小说」：示例文本随仓库自包含，不依赖外部网络 */
  if (pathname === '/api/novel/sample' && method === 'GET') {
    try {
      const text = fs.readFileSync(path.join(EXAMPLES_DIR, 'sample-novel.txt'), 'utf8');
      return json(res, { ok: true, filename: 'sample-novel.txt', text }), true;
    } catch {
      return json(res, { error: '示例小说不存在（examples/sample-novel.txt）' }, 404), true;
    }
  }

  /** 新建项目向导的实时分集预览（不落盘） */
  if (pathname === '/api/novel/preview' && method === 'POST') {
    const body = await readBody(req);
    const checked = validateNovelInput(body.text, { filename: body.filename, split: body.split });
    if (!checked.ok) return json(res, { ok: false, message: checked.message }), true;
    return json(res, { ok: true, message: checked.message, preview: novelPreview(checked.novel, checked.episodes) }), true;
  }

  return false;
}
