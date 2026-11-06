// ComfyUI 接入域：配置 / 探测 / 工作流测试 / 工作流库 / 批量试跑
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems } from '../../core/comfy-config.mjs';
import { parseWorkflow, analyzeWorkflow, describeWorkflow, testConnection, runWorkflow } from '../../core/comfyui.mjs';
import { emit } from '../../core/events.mjs';

export async function handleComfy(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // ---------- 本地 ComfyUI 配置 / 探测 / 工作流测试 ----------
  if (pathname === '/api/comfyui/config' && method === 'GET') {
    const config = loadComfyConfig();
    return json(res, { config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/config' && method === 'PUT') {
    const body = await readBody(req);
    for (const key of ['imageWorkflow', 'videoWorkflow']) {
      if (body[key] === '' || body[key] === null) body[key] = null;
      else if (body[key] !== undefined) body[key] = parseWorkflow(body[key], key);
    }
    const config = saveComfyConfig(body);
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/test' && method === 'POST') {
    const body = await readBody(req);
    const config = loadComfyConfig();
    try {
      const result = await testConnection(body.baseUrl || config.baseUrl);
      return json(res, { ok: true, ...result }), true;
    } catch (err) {
      return json(res, { ok: false, error: err.message }), true;
    }
  }
  if (pathname === '/api/comfyui/analyze' && method === 'POST') {
    const body = await readBody(req);
    const config = loadComfyConfig();
    // 不传 workflow 时按 kind 取「当前生效」的工作流，方便设置页直接自检
    const raw = body.workflow !== undefined
      ? body.workflow : (body.kind ? config[`${body.kind}Workflow`] : null);
    if (!raw) return json(res, { error: '没有可分析的工作流，请先导入「导出(API)」工作流' }, 400), true;
    const wf = parseWorkflow(raw);
    return json(res, {
      nodes: Object.keys(wf).length,
      detected: analyzeWorkflow(wf),
      promptInjection: describeWorkflow(wf, {
        prompt: body.prompt, negative: config.negativePrompt, cfg: config,
      }, config.bindings?.[body.kind] || []),
    }), true;
  }
  // 提示词注入自检：不连 ComfyUI，纯本地干跑，一次返回图片 / 视频两份工作流的注入计划
  if (pathname === '/api/comfyui/inject-check' && method === 'POST') {
    const config = loadComfyConfig();
    const result = {};
    for (const kind of ['image', 'video']) {
      const raw = config[`${kind}Workflow`];
      if (!raw) { result[kind] = null; continue; }
      try {
        result[kind] = {
          name: config[`${kind}WorkflowName`] || '未命名工作流',
          nodes: Object.keys(raw).length,
          ...describeWorkflow(parseWorkflow(raw, `${kind} 工作流`), {
            negative: config.negativePrompt, cfg: config,
          }, config.bindings?.[kind] || []),
        };
      } catch (err) {
        result[kind] = { ok: false, warnings: [`工作流解析失败：${err.message}`] };
      }
    }
    return json(res, { ok: true, ...result }), true;
  }
  if (pathname === '/api/comfyui/run-test' && method === 'POST') {
    const body = await readBody(req);
    const config = loadComfyConfig();
    const kind = body.kind === 'video' ? 'video' : 'image';
    const wf = parseWorkflow(body.workflow || config[`${kind}Workflow`], `${kind} 工作流`);
    const result = await runWorkflow(config, wf, {
      prompt: body.prompt || 'cinematic test shot, consistent character, soft light',
      filenamePrefix: 'lingximanju_test', cfg: config,
    }, { bindings: config.bindings?.[kind] || [] });
    return json(res, {
      ok: true, promptId: result.promptId, durationMs: result.durationMs,
      applied: result.applied, assets: result.assets, promptInjection: result.promptInjection,
    }), true;
  }

  // ---------- 工作流库：批量导入 / 切换选中 / 重命名 / 删除 ----------
  if (pathname === '/api/comfyui/library' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json(res, { error: '没有可导入的工作流' }, 400), true;
    const { added, failed, lib } = addLibraryItems(loadComfyConfig(), kind, items);
    if (added.length) saveComfyConfig({ [`${kind}WorkflowLib`]: lib });
    const config = loadComfyConfig();
    return json(res, { added, failed, config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/library' && method === 'PUT') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const cfg0 = loadComfyConfig();
    if (name) {
      // 重命名：只改名称不改选中；改的是选中项时把 activeId 放进补丁触发镜像名同步
      const libKey = `${kind}WorkflowLib`;
      const lib = cfg0[libKey] || [];
      const target = lib.find((e) => e.id === body.id);
      if (!target) return json(res, { error: '库项不存在' }, 404), true;
      const patch = { [libKey]: lib.map((e) => (e.id === target.id ? { ...e, name } : e)) };
      if (cfg0[`${kind}ActiveId`] === target.id) patch[`${kind}ActiveId`] = target.id;
      const config = saveComfyConfig(patch);
      return json(res, { ok: true, config, summary: comfySummary(config) }), true;
    }
    // 切换选中（id 不在库中由 saveComfyConfig 视为清空）
    const config = saveComfyConfig({ [`${kind}ActiveId`]: typeof body.id === 'string' ? body.id : null });
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }
  const libHit = pathname.match(MATCH.libItem);
  if (libHit && method === 'DELETE') {
    const kind = libHit[1];
    const id = decodeURIComponent(libHit[2]);
    const cfg = loadComfyConfig();
    const libKey = `${kind}WorkflowLib`;
    const before = Array.isArray(cfg[libKey]) ? cfg[libKey] : [];
    const lib = before.filter((e) => e.id !== id);
    if (lib.length === before.length) return json(res, { error: '库项不存在' }, 404), true;
    const patch = { [libKey]: lib };
    if (cfg[`${kind}ActiveId`] === id) patch[`${kind}ActiveId`] = null;   // 删选中项 → activeId/镜像一起清空
    const config = saveComfyConfig(patch);
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }

  if (pathname === '/api/comfyui/test-batch' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const config = loadComfyConfig();
    const libKey = `${kind}WorkflowLib`;
    const lib = config[libKey] || [];
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => lib.some((e) => e.id === id));
    if (!ids.length) return json(res, { error: '没有匹配的库项' }, 400), true;
    try {
      await testConnection(config.baseUrl);
    } catch (err) {
      // 连不上整批返回，不让每一项空等到 15 分钟超时
      return json(res, { ok: false, connectionError: err.message, results: [] }), true;
    }
    const log = (level, message) => emit('log', { source: 'wf-test', level, message });
    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });

    // 每项完成即写回 lastTest：重新读盘再改，避免覆盖试跑期间用户的其它修改
    const writeLastTest = (id, lastTest) => {
      try {
        const fresh = loadComfyConfig();
        const cur = fresh[libKey] || [];
        const target = cur.find((e) => e.id === id);
        if (!target) return;
        target.lastTest = lastTest;
        saveComfyConfig({ [libKey]: cur });
      } catch (err) { console.warn('[comfy] lastTest 写回失败：', err.message); }
    };

    const results = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (clientGone) break;   // 客户端断开 → 当前项被 signal 取消后停止后续项
      const entry = lib.find((e) => e.id === ids[i]);
      if (!entry) continue;
      log('info', `▶ 试跑 ${i + 1}/${ids.length} ·「${entry.name}」`);
      const t0 = Date.now();
      let lastTest;
      try {
        const r = await runWorkflow(config, entry.workflow, {
          prompt: 'cinematic test shot, consistent character, soft light',
          filenamePrefix: 'lingximanju_test', cfg: config,
        }, {
          bindings: config.bindings?.[kind] || [],
          signal: ac.signal,
          log: (lv, msg) => log(lv, `「${entry.name}」${msg}`),
        });
        lastTest = { ok: true, durationMs: r.durationMs, at: Date.now(), error: null };
        results.push({ id: entry.id, ok: true, durationMs: r.durationMs, error: null });
        log('info', `✓「${entry.name}」 ${(r.durationMs / 1000).toFixed(1)}s`);
      } catch (err) {
        const error = clientGone ? '已取消' : (/执行超时/.test(err.message) ? '超时' : err.message);
        lastTest = { ok: false, durationMs: Date.now() - t0, at: Date.now(), error };
        results.push({ id: entry.id, ok: false, durationMs: lastTest.durationMs, error });
        log('error', `✕「${entry.name}」 ${error}`);
      }
      writeLastTest(entry.id, lastTest);
    }
    if (clientGone) return true;   // 对端已断开，无需再写响应
    const final = loadComfyConfig();
    return json(res, { ok: true, results, config: final, summary: comfySummary(final) }), true;
  }

  return false;
}
