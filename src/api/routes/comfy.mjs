// ComfyUI 接入域：配置 / 探测 / 工作流测试 / 工作流库 / 单项与批量试跑
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems, kindOf, WORKFLOW_KINDS } from '../../core/comfy-config.mjs';
import { parseWorkflow, analyzeWorkflow, describeWorkflow, describeAudioWorkflow, testConnection, runWorkflow } from '../../core/comfyui.mjs';
import { emit } from '../../core/events.mjs';

const TEST_PROMPT = 'cinematic test shot, consistent character, soft light';
const TEST_AUDIO_TEXT = '这是一段音色试听，用来判断声线是否适合这个角色。';
const PROBE_TIMEOUT_MS = 8000;   // 连接探测上限：地址被代理吞掉时不能让面板无限转圈

/** 把一次 runWorkflow 的结果压成前端可读的详情（不回传二进制内容） */
function testResultDetails(r) {
  const plan = r?.promptInjection || {};
  const brief = (p) => (p ? {
    node: p.node, input: p.input, strategy: p.strategy || '',
    title: p.title || '', preview: String(p.preview || '').slice(0, 80),
  } : null);
  return {
    promptId: r?.promptId || null,
    applied: Array.isArray(r?.applied) ? r.applied.length : 0,
    assets: (r?.assets || []).map((a) => ({
      url: a.url, kind: a.kind, bytes: a.bytes, filename: a.filename,
    })),
    promptInjection: {
      ok: Boolean(plan.ok ?? plan.positive),
      positive: brief(plan.positive),
      negative: brief(plan.negative),
      warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    },
  };
}

/**
 * 串行试跑指定的库项：连接探测 → 逐项 runWorkflow → 每项即时写回 lastTest。
 * 「单独测试」与「测试全部」共用本函数，保证判定、日志、落盘行为完全一致。
 * @returns {Promise<{connectionError?:string, clientGone?:boolean, results?:Array, config?:Object}>}
 */
async function executeLibraryTests({ res, config, kind, ids, prompt, scope = 'batch' }) {
  try {
    await testConnection(config.baseUrl, AbortSignal.timeout(PROBE_TIMEOUT_MS));
  } catch (err) {
    // 连不上整批返回，不让每一项空等到 15 分钟超时
    return {
      connectionError: /abort|timeout/i.test(err.message)
        ? `无法连接 ${config.baseUrl}：探测 ${PROBE_TIMEOUT_MS / 1000}s 超时，请确认 ComfyUI 已启动且地址正确`
        : err.message,
    };
  }
  const libKey = `${kind}WorkflowLib`;
  const lib = config[libKey] || [];
  const log = (level, message, extra = {}) =>
    emit('log', { source: 'wf-test', scope, level, message, ...extra });
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
    log('info', `▶ 试跑 ${i + 1}/${ids.length} ·「${entry.name}」`, { entryId: entry.id });
    const t0 = Date.now();
    let lastTest;
    try {
      // 音频工作流用朗读文案 + 语言，图片 / 视频用画面提示词：
      // 传错会让 TTS 工作流把画面描述当成要念的话，试跑结果不可信。
      const vars = kind === 'audio'
        ? { audioText: prompt || TEST_AUDIO_TEXT, language: 'zh-CN', filenamePrefix: 'lingximanju_test', cfg: config }
        : { prompt: prompt || TEST_PROMPT, filenamePrefix: 'lingximanju_test', cfg: config };
      const r = await runWorkflow(config, entry.workflow, vars, {
        bindings: config.bindings?.[kind] || [],
        signal: ac.signal,
        log: (lv, msg) => log(lv, `「${entry.name}」${msg}`, { entryId: entry.id }),
      });
      lastTest = { ok: true, durationMs: r.durationMs, at: Date.now(), error: null };
      results.push({ id: entry.id, name: entry.name, ok: true, durationMs: r.durationMs, error: null, ...testResultDetails(r) });
      log('info', `✓「${entry.name}」 ${(r.durationMs / 1000).toFixed(1)}s`, { entryId: entry.id });
    } catch (err) {
      if (clientGone) {
        // 面板被关掉 / 请求断开导致的取消不算工作流失败，不污染该行的「上次试跑」徽标
        log('warn', `「${entry.name}」试跑已取消，保留原有测试状态`, { entryId: entry.id });
        break;
      }
      const error = /执行超时/.test(err.message) ? '超时' : err.message;
      lastTest = { ok: false, durationMs: Date.now() - t0, at: Date.now(), error };
      results.push({ id: entry.id, name: entry.name, ok: false, durationMs: lastTest.durationMs, error });
      log('error', `✕「${entry.name}」 ${error}`, { entryId: entry.id });
    }
    writeLastTest(entry.id, lastTest);
  }
  return { results, clientGone, config: loadComfyConfig() };
}

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
    for (const key of ['imageWorkflow', 'videoWorkflow', 'audioWorkflow']) {
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
    const kind = kindOf(body.kind);
    // 不传 workflow 时按 kind 取「当前生效」的工作流，方便设置页直接自检
    const raw = body.workflow !== undefined
      ? body.workflow : (body.kind ? config[`${kind}Workflow`] : null);
    if (!raw) return json(res, { error: '没有可分析的工作流，请先导入「导出(API)」工作流' }, 400), true;
    const wf = parseWorkflow(raw);
    // 音频工作流走 TTS 语义的自检（朗读文案 + 说话人），图片 / 视频走提示词语义
    const plan = kind === 'audio'
      ? { audio: describeAudioWorkflow(wf, { audioText: body.prompt, language: 'zh-CN', cfg: config }, config.bindings?.audio || []) }
      : { promptInjection: describeWorkflow(wf, { prompt: body.prompt, negative: config.negativePrompt, cfg: config }, config.bindings?.[kind] || []) };
    return json(res, {
      kind,
      nodes: Object.keys(wf).length,
      detected: analyzeWorkflow(wf),
      ...plan,
    }), true;
  }
  // 提示词注入自检：不连 ComfyUI，纯本地干跑，一次返回出图 / 视频 / 音色三份工作流的注入计划
  if (pathname === '/api/comfyui/inject-check' && method === 'POST') {
    const config = loadComfyConfig();
    const result = {};
    for (const kind of WORKFLOW_KINDS) {
      const raw = config[`${kind}Workflow`];
      if (!raw) { result[kind] = null; continue; }
      try {
        const base = { name: config[`${kind}WorkflowName`] || '未命名工作流', nodes: Object.keys(raw).length };
        result[kind] = kind === 'audio'
          ? { ...base, ...describeAudioWorkflow(parseWorkflow(raw, '音频 工作流'), { audioText: TEST_AUDIO_TEXT, language: 'zh-CN', cfg: config }, config.bindings?.audio || []) }
          : {
            ...base,
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
    const kind = kindOf(body.kind);
    const wf = parseWorkflow(body.workflow || config[`${kind}Workflow`], `${kind} 工作流`);
    const vars = kind === 'audio'
      ? { audioText: body.prompt || TEST_AUDIO_TEXT, language: 'zh-CN', filenamePrefix: 'lingximanju_test', cfg: config }
      : { prompt: body.prompt || TEST_PROMPT, filenamePrefix: 'lingximanju_test', cfg: config };
    const result = await runWorkflow(config, wf, vars, { bindings: config.bindings?.[kind] || [] });
    return json(res, {
      ok: true, promptId: result.promptId, durationMs: result.durationMs,
      applied: result.applied, assets: result.assets, promptInjection: result.promptInjection,
    }), true;
  }

  // ---------- 工作流库：批量导入 / 切换选中 / 重命名 / 删除 ----------
  if (pathname === '/api/comfyui/library' && method === 'POST') {
    const body = await readBody(req);
    const kind = kindOf(body.kind);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json(res, { error: '没有可导入的工作流' }, 400), true;
    const { added, failed, lib } = addLibraryItems(loadComfyConfig(), kind, items);
    if (added.length) saveComfyConfig({ [`${kind}WorkflowLib`]: lib });
    const config = loadComfyConfig();
    return json(res, { added, failed, config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/library' && method === 'PUT') {
    const body = await readBody(req);
    const kind = kindOf(body.kind);
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
    const kind = kindOf(libHit[1]);
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

  // ---------- 单个库项独立试跑：设置页每行「▶ 测试」 ----------
  if (pathname === '/api/comfyui/test-one' && method === 'POST') {
    const body = await readBody(req);
    const kind = kindOf(body.kind);
    const config = loadComfyConfig();
    const entry = (config[`${kind}WorkflowLib`] || []).find((e) => e.id === body.id);
    if (!entry) return json(res, { error: '库项不存在' }, 404), true;
    const prompt = String(body.prompt || '').trim().slice(0, 2000) || undefined;
    const out = await executeLibraryTests({ res, config, kind, ids: [entry.id], prompt, scope: 'one' });
    if (out.connectionError) {
      return json(res, { ok: false, connectionError: out.connectionError, results: [] }), true;
    }
    if (out.clientGone) return true;
    return json(res, {
      ok: true, result: out.results[0] || null, results: out.results,
      config: out.config, summary: comfySummary(out.config),
    }), true;
  }

  // ---------- 批量串行试跑：设置页「▶ 测试全部」 ----------
  if (pathname === '/api/comfyui/test-batch' && method === 'POST') {
    const body = await readBody(req);
    const kind = kindOf(body.kind);
    const config = loadComfyConfig();
    const lib = config[`${kind}WorkflowLib`] || [];
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => lib.some((e) => e.id === id));
    if (!ids.length) return json(res, { error: '没有匹配的库项' }, 400), true;
    const out = await executeLibraryTests({ res, config, kind, ids });
    if (out.connectionError) {
      return json(res, { ok: false, connectionError: out.connectionError, results: [] }), true;
    }
    if (out.clientGone) return true;   // 对端已断开，无需再写响应
    return json(res, {
      ok: true, results: out.results, config: out.config, summary: comfySummary(out.config),
    }), true;
  }

  return false;
}
