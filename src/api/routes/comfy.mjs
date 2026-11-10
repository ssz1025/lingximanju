// ComfyUI 接入域：配置 / 探测 / 工作流测试 / 工作流库 / 单项与批量试跑
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import {
  loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems, kindOf, WORKFLOW_KINDS,
  resolveInterface, findInterface, interfaceOverview, MEDIA_SCOPES, scopeKind, applyInputOrder,
} from '../../core/comfy-config.mjs';
import {
  parseWorkflow, analyzeWorkflow, describeWorkflow, describeAudioWorkflow,
  describeInterfaceInputs, BUILTIN_INPUT_VARS, testConnection, runWorkflow, uploadFile,
} from '../../core/comfyui.mjs';
import { emit } from '../../core/events.mjs';
import { writeAssetBinary, readAsset } from '../../core/store.mjs';
import { registerAsset } from '../../core/assets.mjs';

const TEST_PROMPT = 'cinematic test shot, consistent character, soft light';
const TEST_AUDIO_TEXT = '这是一段音色试听，用来判断声线是否适合这个角色。';
const PROBE_TIMEOUT_MS = 8000;   // 连接探测上限：地址被代理吞掉时不能让面板无限转圈
const KIND_SCOPE = { image: 'keyframe', video: 'video', audio: 'voice' };

/** 把解析结果折叠成 runWorkflow 需要的 config（附带本次接口信息，供日志留痕） */
function resolvedRunConfig(resolved) {
  return {
    ...resolved.config,
    resolvedInterface: {
      id: resolved.interfaceId, name: resolved.interfaceName, kind: resolved.kind,
      scope: resolved.scope, via: resolved.via, warnings: resolved.warnings,
    },
  };
}

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

/* ---------------- 参数表媒体槽位：上传 / 资源库复用（本地资源库 + ComfyUI 双写） ---------------- */

const MEDIA_LABEL = { image: '图片', video: '视频', audio: '音频' };
const MEDIA_EXT = {
  image: /^(png|jpg|jpeg|webp|bmp|gif|tif|tiff)$/i,
  video: /^(mp4|webm|mov|mkv|m4v)$/i,
  audio: /^(mp3|wav|ogg|m4a|flac|aac|opus)$/i,
};
/** 上传体积上限：视频素材常比图大得多，32MB 足够覆盖参考片段 */
const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || ['', ''])[1];

/** dataURL（base64）→ {buf, ext}；格式与声明不符直接拒绝，避免把坏文件推进 ComfyUI */
function parseMediaPayload(dataUrl, media, prefix = '') {
  const m = /^data:(image|video|audio)\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) throw new Error(`${prefix}仅支持 base64 dataURL（图片 / 视频 / 音频）`);
  const declared = m[1].toLowerCase();
  if (media && declared !== media) throw new Error(`${prefix}该槽位要${MEDIA_LABEL[media]}，收到的是${MEDIA_LABEL[declared] || declared}`);
  const sub = m[2].toLowerCase();
  const ext = sub === 'jpeg' ? 'jpg' : sub === 'quicktime' ? 'mov' : sub === 'mpeg' ? 'mp3'
    : sub === 'x-matroska' ? 'mkv' : sub === 'x-m4v' ? 'm4v' : sub.split('+')[0];
  if (!(MEDIA_EXT[media] || MEDIA_EXT.image).test(ext) && !Object.values(MEDIA_EXT).some((re) => re.test(ext))) {
    throw new Error(`${prefix}不支持的文件格式 .${ext}`);
  }
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) throw new Error(`${prefix}文件内容为空`);
  if (buf.length > MEDIA_MAX_BYTES) {
    throw new Error(`${prefix}文件 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${MEDIA_MAX_BYTES / 1048576}MB 上限`);
  }
  return { buf, ext };
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
      // 按接口档案解析：档案自带的请求参数 / 节点覆盖 / 显式绑定都会在试跑中生效，
      // 这样「改完参数点 ▶ 测试」验证的就是本次真正会提交的工作流。
      const resolved = resolveInterface(config, { kind, scope: KIND_SCOPE[kind], interfaceId: entry.id });
      const runCfg = resolvedRunConfig(resolved);
      const vars = kind === 'audio'
        ? { audioText: prompt || TEST_AUDIO_TEXT, language: 'zh-CN', filenamePrefix: 'lingximanju_test', cfg: runCfg }
        : { prompt: prompt || TEST_PROMPT, filenamePrefix: 'lingximanju_test', cfg: runCfg };
      const r = await runWorkflow(runCfg, resolved.workflow || entry.workflow, vars, {
        bindings: resolved.bindings,
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

  // ---------- 媒体生成接口档案：一个档案 = 一份 ComfyUI 导出的 API 工作流 + 一套请求参数 ----------
  if (pathname === '/api/comfyui/interfaces' && method === 'GET') {
    const config = loadComfyConfig();
    return json(res, {
      interfaces: interfaceOverview(config),
      scopeBindings: { ...(config.scopeBindings || {}) },
      scopes: MEDIA_SCOPES.map((id) => ({ id, kind: scopeKind(id) })),
      summary: comfySummary(config),
    }), true;
  }
  if (pathname === '/api/comfyui/interfaces' && method === 'POST') {
    const body = await readBody(req);
    const kind = kindOf(body.kind);
    const items = Array.isArray(body.items) ? body.items : (body.workflow ? [body] : []);
    if (!items.length) return json(res, { error: '没有可导入的接口文件（workflow）' }, 400), true;
    const { added, failed, lib } = addLibraryItems(loadComfyConfig(), kind, items);
    if (added.length) saveComfyConfig({ [`${kind}WorkflowLib`]: lib });
    const config = loadComfyConfig();
    return json(res, { added, failed, config, summary: comfySummary(config) }), true;
  }
  // 板块绑定：整表 {bindings:{cover:'wf_x'}} 或单条 {scope, interfaceId}；传空 id 解绑
  if (pathname === '/api/comfyui/bindings' && method === 'PUT') {
    const body = await readBody(req);
    const cfg = loadComfyConfig();
    const incoming = (body.bindings && typeof body.bindings === 'object' && !Array.isArray(body.bindings))
      ? body.bindings
      : (body.scope ? { [String(body.scope)]: body.interfaceId ?? null } : null);
    if (!incoming) return json(res, { error: '请提供 bindings 或 scope + interfaceId' }, 400), true;
    const next = { ...(cfg.scopeBindings || {}) };
    for (const [scope, id] of Object.entries(incoming)) {
      if (!MEDIA_SCOPES.includes(scope)) continue;
      if (id === null || id === undefined || id === '') { delete next[scope]; continue; }
      const found = findInterface(cfg, String(id));
      if (!found) return json(res, { error: `接口档案 ${String(id).slice(0, 40)} 不存在` }, 404), true;
      if (found.kind !== scopeKind(scope)) {
        return json(res, { error: `板块 ${scope} 只能绑定 ${scopeKind(scope)} 类接口` }, 400), true;
      }
      next[scope] = String(id);
    }
    const config = saveComfyConfig({ scopeBindings: next });
    return json(res, {
      ok: true, scopeBindings: config.scopeBindings,
      config, summary: comfySummary(config),
    }), true;
  }
  // ---------- 接口 JSON 本体与输入参数清单：设置页「编辑接口 JSON / 可视化输入参数」 ----------
  const schemaHit = pathname.match(MATCH.interfaceSchema);
  if (schemaHit && method === 'GET') {
    const id = decodeURIComponent(schemaHit[1]);
    const found = findInterface(loadComfyConfig(), id);
    if (!found) return json(res, { error: '接口档案不存在' }, 404), true;
    const { entry, kind } = found;
    return json(res, {
      id, name: entry.name, kind, capability: entry.capability || '',
      workflow: entry.workflow,
      inputs: applyInputOrder(describeInterfaceInputs(entry.workflow), entry.inputOrder || []),
      inputSchema: entry.inputSchema || [],
      inputOrder: entry.inputOrder || [],
      builtinVars: BUILTIN_INPUT_VARS,
    }), true;
  }
  const workflowHit = pathname.match(MATCH.interfaceWorkflow);  if (workflowHit && method === 'PUT') {
    const id = decodeURIComponent(workflowHit[1]);
    const cfg = loadComfyConfig();
    const found = findInterface(cfg, id);
    if (!found) return json(res, { error: '接口档案不存在' }, 404), true;
    const body = await readBody(req);
    let wf;
    try { wf = parseWorkflow(body.workflow, '接口工作流'); }
    catch (err) { return json(res, { error: `接口 JSON 无效：${err.message}` }, 400), true; }
    const { kind, entry } = found;
    const libKey = `${kind}WorkflowLib`;
    const activeKey = `${kind}ActiveId`;
    const flowKey = `${kind}Workflow`;
    const patch = { [libKey]: (cfg[libKey] || []).map((e) => (e.id === id ? { ...e, workflow: wf } : e)) };
    // 选中项放进补丁即触发 saveComfyConfig 的镜像回填；老配置只留镜像时按内容同源同步
    if (cfg[activeKey] === id) patch[activeKey] = id;
    else if (cfg[flowKey] && JSON.stringify(cfg[flowKey]) === JSON.stringify(entry.workflow)) {
      patch[flowKey] = wf;
      patch[`${kind}WorkflowName`] = entry.name;
    }
    const config = saveComfyConfig(patch);
    const inputs = describeInterfaceInputs(wf);
    const warnings = (entry.inputSchema || []).filter((r) =>
      !inputs.some((i) => i.node === r.node && i.input === r.input))
      .map((r) => `参数表里的 ${r.node}.${r.input} 在新接口 JSON 中不存在，已自动跳过`);
    return json(res, {
      ok: true, id, workflow: wf, inputs, warnings,
      config, summary: comfySummary(config),
    }), true;
  }
  // ---------- 参数表媒体槽位：一次上传双写「本地资源库 + ComfyUI 输入目录」 ----------
  const mediaHit = pathname.match(MATCH.interfaceMedia);
  if (mediaHit && method === 'POST') {
    const id = decodeURIComponent(mediaHit[1]);
    const cfg = loadComfyConfig();
    const found = findInterface(cfg, id);
    if (!found) return json(res, { error: '接口档案不存在' }, 404), true;
    const body = await readBody(req, MEDIA_MAX_BYTES + 4 * 1024 * 1024);
    const media = MEDIA_LABEL[body.media] ? String(body.media) : 'image';
    const node = String(body.node || '').trim().slice(0, 40);
    const input = String(body.input || '').trim().slice(0, 60);

    // 来源一：资源库已有素材（只给文件名），只推 ComfyUI，不重复落盘
    // 来源二：本地上传的 dataURL，先写 data/assets 并登记索引，再推 ComfyUI
    let buf = null;
    let assetName = '';
    let assetUrl = '';
    let warning = '';
    try {
      if (body.asset) {
        assetName = String(body.asset).trim();
        if (!/^[a-zA-Z0-9_.-]+$/.test(assetName)) throw new Error('资源名不合法');
        const ext = extOf(assetName);
        if (!MEDIA_EXT[media].test(ext) && !Object.values(MEDIA_EXT).some((re) => re.test(ext))) {
          throw new Error(`「${assetName}」不是${MEDIA_LABEL[media]}文件`);
        }
        buf = readAsset(assetName);
        if (!buf) throw new Error(`资源「${assetName}」不存在或已被删除`);
        assetUrl = `/assets/${assetName}`;
      } else if (body.dataUrl) {
        const parsed = parseMediaPayload(body.dataUrl, media, `${MEDIA_LABEL[media]}上传：`);
        buf = parsed.buf;
        assetName = `iface_${id}_${Date.now().toString(36)}_${String(body.name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(-40) || `m.${parsed.ext}`}`;
        if (!MEDIA_EXT[media].test(extOf(assetName))) assetName = `${assetName.replace(/\.$/, '')}.${parsed.ext}`;
        assetUrl = writeAssetBinary(assetName, buf);
        assetName = assetUrl.slice('/assets/'.length);
        registerAsset({ file: assetName, kind: media === 'audio' ? 'audio' : media, name: String(body.name || '').slice(0, 60) || assetName, tags: ['接口参数'] });
      } else {
        return json(res, { error: '需要 asset（资源库文件名）或 dataUrl（上传内容）' }, 400), true;
      }
    } catch (err) {
      return json(res, { error: err.message }, 400), true;
    }

    // 推到 ComfyUI 输入目录：失败不阻断，参数表写回本地名并提示（ComfyUI 起来后重传即可）
    let comfyName = assetName;
    try {
      const up = await uploadFile(cfg, buf, assetName, AbortSignal.timeout(30000));
      comfyName = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    } catch (err) {
      warning = `已保存到本地资源库，但推送到 ComfyUI 失败：${err.message}。ComfyUI 恢复后重新上传即可。`;
    }
    emit('log', { source: 'comfy-media', level: warning ? 'warn' : 'info',
      message: `参数素材 ${node || '?'}.${input || '?'} ← ${assetName}${warning ? '（未推送）' : ''}` });
    return json(res, {
      ok: true, media, node, input,
      asset: assetName, url: assetUrl,
      comfyName, warning: warning || null,
    }), true;
  }
  const ifaceHit = pathname.match(MATCH.interfaceItem);
  if (ifaceHit && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(ifaceHit[1]);
    const cfg = loadComfyConfig();
    const found = findInterface(cfg, id);
    if (!found) return json(res, { error: '接口档案不存在' }, 404), true;
    const libKey = `${found.kind}WorkflowLib`;
    const activeKey = `${found.kind}ActiveId`;
    if (method === 'DELETE') {
      const patch = { [libKey]: (cfg[libKey] || []).filter((e) => e.id !== id) };
      if (cfg[activeKey] === id) patch[activeKey] = null;
      // 删档案时解绑所有指向它的板块，避免残留死绑定
      const bindings = { ...(cfg.scopeBindings || {}) };
      for (const [scope, bid] of Object.entries(bindings)) if (bid === id) delete bindings[scope];
      patch.scopeBindings = bindings;
      const config = saveComfyConfig(patch);
      return json(res, { ok: true, config, summary: comfySummary(config) }), true;
    }
    const body = await readBody(req);
    const lib = (cfg[libKey] || []).map((e) => {
      if (e.id !== id) return e;
      const next = { ...e };
      if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 60) || e.name;
      if (body.params !== undefined) {
        // 局部合并：没提交的字段保持原值；显式传 null / '' 表示清空该参数
        const merged = { ...(e.params || {}), ...(body.params || {}) };
        for (const [k, v] of Object.entries(body.params || {})) {
          if (v === null || v === '') delete merged[k];
        }
        next.params = merged;
      }
      if (body.nodeOverrides !== undefined) next.nodeOverrides = body.nodeOverrides;
      if (body.bindings !== undefined) next.bindings = body.bindings;
      if (body.inputSchema !== undefined) next.inputSchema = body.inputSchema;
      if (body.inputOrder !== undefined) next.inputOrder = body.inputOrder;
      if (body.capability !== undefined) next.capability = String(body.capability).trim().slice(0, 40);
      return next;
    });
    const patch = { [libKey]: lib };
    // 改的是当前选中项时，顺带刷新镜像名 / 工作流；body.active=true 可直接设为默认
    if (body.active === true || cfg[activeKey] === id) patch[activeKey] = id;
    const config = saveComfyConfig(patch);
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
    const resolved = resolveInterface(config, {
      kind, scope: String(body.scope || KIND_SCOPE[kind]),
      interfaceId: String(body.interfaceId || body.workflowId || ''),
    });
    const runCfg = resolvedRunConfig(resolved);
    // 不传 workflow 时按 kind / interfaceId 取「当前生效」的工作流，方便设置页直接自检
    const raw = body.workflow !== undefined
      ? body.workflow : (body.interfaceId ? resolved.workflow : (body.kind ? config[`${kind}Workflow`] : null));
    if (!raw) return json(res, { error: '没有可分析的工作流，请先导入「导出(API)」工作流' }, 400), true;
    const wf = parseWorkflow(raw);
    // 音频工作流走 TTS 语义的自检（朗读文案 + 说话人），图片 / 视频走提示词语义
    const plan = kind === 'audio'
      ? { audio: describeAudioWorkflow(wf, { audioText: body.prompt, language: 'zh-CN', cfg: runCfg }, resolved.bindings) }
      : { promptInjection: describeWorkflow(wf, { prompt: body.prompt, negative: runCfg.negativePrompt, cfg: runCfg }, resolved.bindings) };
    return json(res, {
      kind,
      interfaceId: resolved.interfaceId, interfaceName: resolved.interfaceName,
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
      // 自检按该类别默认板块解析：板块绑定 / 档案参数与真实生成保持同一口径
      const resolved = resolveInterface(config, { kind, scope: KIND_SCOPE[kind] });
      const raw = resolved.workflow;
      if (!raw) { result[kind] = null; continue; }
      const runCfg = resolvedRunConfig(resolved);
      try {
        const base = {
          name: resolved.interfaceName || '未命名工作流',
          interfaceId: resolved.interfaceId, nodes: Object.keys(raw).length,
        };
        result[kind] = kind === 'audio'
          ? { ...base, ...describeAudioWorkflow(parseWorkflow(raw, '音频 工作流'), { audioText: TEST_AUDIO_TEXT, language: 'zh-CN', cfg: runCfg }, resolved.bindings) }
          : {
            ...base,
            ...describeWorkflow(parseWorkflow(raw, `${kind} 工作流`), {
              negative: runCfg.negativePrompt, cfg: runCfg,
            }, resolved.bindings),
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
    const resolved = resolveInterface(config, {
      kind, scope: String(body.scope || KIND_SCOPE[kind]),
      interfaceId: String(body.interfaceId || body.workflowId || ''),
    });
    const runCfg = resolvedRunConfig(resolved);
    const wf = parseWorkflow(body.workflow || resolved.workflow, `${kind} 工作流`);
    const vars = kind === 'audio'
      ? { audioText: body.prompt || TEST_AUDIO_TEXT, language: 'zh-CN', filenamePrefix: 'lingximanju_test', cfg: runCfg }
      : { prompt: body.prompt || TEST_PROMPT, filenamePrefix: 'lingximanju_test', cfg: runCfg };
    const result = await runWorkflow(runCfg, wf, vars, { bindings: resolved.bindings });
    return json(res, {
      ok: true, promptId: result.promptId, durationMs: result.durationMs,
      interfaceId: resolved.interfaceId, interfaceName: resolved.interfaceName,
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
