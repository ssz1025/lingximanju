/* ============================================================================
 * 单集剧本的构建 / 归一 / 统计 / 编辑合并 / Markdown 导出（纯函数层）
 *
 * 为什么单独一层：
 *  - 剧本从「项目级一个 script 节点」扩展为「每集一份」，需要统一的口径：
 *    场次、对白、字数、角色、质量告警都要能在生成、编辑、导出、UI 展示处复用；
 *  - 这些函数不读写磁盘、不发请求，可被 node --test 直接导入，
 *    避免「只有跑一遍大模型才知道剧本长什么样」。
 *
 * 剧本数据契约（与前端 episode-view / 工作台剧本台一致）：
 *   {
 *     episodeNo, title, genre, logline, style,
 *     characters: [{ name, role, appearance }],
 *     scenes: [{ id, location, time, summary, script: [string] }],
 *     source: 'llm' | 'mock' | 'manual',
 *     provider, generatedAt, editedAt,
 *     stats: { sceneCount, lineCount, dialogueCount, chars, speakerCount, characterCount },
 *     issues: [{ level, code, message }],
 *     continuity: { prevNo, nextNo, prevRecap, nextHook }
 *   }
 * ==========================================================================*/
import { resolveRuntimeSpec } from './runtime-spec.mjs';
import { parseScriptLine, parseScriptLineRich, guessInterior, formatDuration, SCENE_EXTRA_KEYS,
  screenplayContinuity, episodeCodeOf, sceneCodeFor, continuityOf } from './screenplay.mjs';

const str = (v) => String(v ?? '');
const cut = (s, n) => { const t = str(s).trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const SCRIPT_SOURCE_LABEL = { llm: '大模型', mock: '内置模板', manual: '人工编辑', heuristic: '启发式' };

/** 场次标题里常见的前缀噪声，归一成干净的地点 */
function cleanLocation(v) {
  return cut(str(v).replace(/^[\s【\[]+|[\s】\]]+$/g, ''), 40);
}

/** 一行剧本：去掉列表符号，限制单行长度（防止模型一次吐一千字） */
export function cleanScriptLine(line, max = 220) {
  return cut(str(line).replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, ''), max);
}

/** 剧本文本统计：场次 / 行数 / 对白数 / 字数 / 说话人数 */
export function scriptStats(script = {}) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const speakers = new Set();
  let lineCount = 0;
  let dialogueCount = 0;
  let chars = 0;
  let offscreenCount = 0;
  let screenTextCount = 0;
  let continuityCount = 0;
  for (const s of scenes) {
    chars += str(s?.location).length + str(s?.time).length + str(s?.summary).length;
    const lines = Array.isArray(s?.script) ? s.script : str(s?.script).split('\n');
    for (const raw of lines) {
      const line = cleanScriptLine(raw);
      if (!line) continue;
      lineCount += 1;
      chars += line.length;
      // v3：[OS] 仍算该角色的对白；[VO] / [SFX] / [画面文字] / [连续性] 不算现场对白
      const parsed = parseScriptLineRich(line);
      if (parsed.kind === 'dialogue' && parsed.speaker) {
        dialogueCount += 1;
        speakers.add(parsed.speaker);
        if (parsed.tag === 'OS') offscreenCount += 1;
      } else if (parsed.kind === 'subtitle') screenTextCount += 1;
      else if (parsed.kind === 'continuity') continuityCount += 1;
    }
  }
  return {
    sceneCount: scenes.length,
    lineCount,
    dialogueCount,
    offscreenCount,
    screenTextCount,
    continuityCount,
    chars,
    speakerCount: speakers.size,
    characterCount: Array.isArray(script?.characters) ? script.characters.length : 0,
    speakers: [...speakers].slice(0, 24),
  };
}

/**
 * 时长口径：剧本自己声明的 durationSec 优先，缺失时按行数估（每行约 4 秒）。
 * 与分镜「片段数 × 单片段时长」是两套口径——这里只回答「这集写的内容拍出来大概多长」，
 * 不参与成片时间线，避免把剧本预估误当成可交付时长。
 */
export function scriptTiming(script = {}) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  let dialogueLines = 0;
  let actionLines = 0;
  let narrationLines = 0;
  let screenTextLines = 0;
  let continuityLines = 0;
  let seconds = 0;
  const perScene = scenes.map((s, i) => {
    const lines = (Array.isArray(s?.script) ? s.script : str(s?.script).split('\n'))
      .map((l) => cleanScriptLine(l)).filter(Boolean);
    for (const line of lines) {
      const p = parseScriptLineRich(line);
      if (p.kind === 'dialogue') dialogueLines += 1;
      else if (p.kind === 'action') actionLines += 1;
      else if (p.kind === 'narration') narrationLines += 1;
      else if (p.kind === 'subtitle') screenTextLines += 1;
      else if (p.kind === 'continuity') continuityLines += 1;
    }
    const given = Number(s?.durationSec);
    const sec = Number.isFinite(given) && given > 0 ? given : Math.max(8, Math.min(90, lines.length * 4));
    seconds += sec;
    return { no: Number(s?.no) || i + 1, seconds: sec, lines: lines.length };
  });
  return {
    sceneCount: scenes.length, dialogueLines, actionLines, narrationLines,
    screenTextLines, continuityLines,
    estimatedSeconds: Math.round(seconds), perScene,
    declaredSeconds: Number(script?.durationSec) || 0,
  };
}

/**
 * 剧本质量检查：只产出「值得提醒用户」的问题，不阻断保存。
 * 目标是把「剧本看起来生成了，其实没对白 / 只有一场 / 出现了不存在的角色」暴露在界面上。
 */
export function scriptIssues(script = {}, opts = {}) {
  const stats = scriptStats(script);
  const known = new Set((opts.characterNames || []).map((n) => str(n).trim()).filter(Boolean));
  for (const c of (Array.isArray(script?.characters) ? script.characters : [])) {
    if (c?.name) known.add(str(c.name).trim());
  }
  const issues = [];
  const push = (level, code, message) => issues.push({ level, code, message });
  if (!stats.sceneCount) push('error', 'no_scene', '还没有任何场次');
  else if (stats.sceneCount < 2) push('warn', 'few_scenes', '只有 1 场，短剧通常需要 3 场以上才能形成起承转合');
  if (stats.sceneCount > 12) push('info', 'many_scenes', `${stats.sceneCount} 场偏多，单集拍不完时可考虑合并过场`);
  if (!stats.lineCount) push('error', 'no_line', '场次里没有正文或对白');
  if (!stats.dialogueCount) push('warn', 'no_dialogue', '全篇没有识别到对白，检查是否只写了概述');
  const thin = (script.scenes || []).filter((s) => (Array.isArray(s?.script) ? s.script : []).filter((x) => str(x).trim()).length < 2);
  if (thin.length) push('info', 'thin_scene', `${thin.length} 场只有 1 行内容，可补充动作与对白`);
  // v2 字段缺失检查：只提示，不阻断——「有场次但没写目标/冲突/转折」正是"看起来生成了、其实不能拍"的样子
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const noGoal = scenes.filter((s) => !str(s?.objective)).length;
  if (scenes.length && noGoal) {
    push('info', 'no_objective', `${noGoal} 场没写场景目标（objective），分镜只能靠猜人物想要什么，建议重跑第③步或补齐`);
  }
  const noTurn = scenes.filter((s) => !str(s?.turn)).length;
  if (scenes.length && noTurn) push('info', 'no_turn', `${noTurn} 场没写转折（turn），这一场结束时局面没有变化`);
  const noChars = scenes.filter((s) => !(Array.isArray(s?.characters) ? s.characters.length : 0)
    && !parseScriptLine((Array.isArray(s?.script) ? s.script : [])[0] || '').speaker).length;
  if (scenes.length && noChars === scenes.length) {
    push('info', 'no_scene_cast', '每场都没有标注出场人物，逐镜头生成时无法绑定角色参考图');
  }
  if (stats.lineCount >= 6 && stats.dialogueCount && stats.dialogueCount / stats.lineCount < 0.2) {
    push('info', 'few_dialogue', `对白只占 ${Math.round((stats.dialogueCount / stats.lineCount) * 100)}%，可检查是否写成了动作流水账`);
  }
  if (known.size) {
    const unknown = stats.speakers.filter((n) => !known.has(n) && !/^(画外音|众人|广播|电话|系统|旁白|未知)$/.test(n));
    if (unknown.length) push('info', 'unknown_speaker', `对白里出现未登记角色：${unknown.slice(0, 4).join('、')}`);
  }
  const last = (script.scenes || [])[script.scenes.length - 1];
  const tail = last && Array.isArray(last.script) ? last.script.join(' ') : '';
  if (script?.continuity?.nextHook && !tail.includes(cut(script.continuity.nextHook, 8).replace(/…$/, ''))) {
    // 只提示，不强制：钩子可以靠画面/字幕完成
    push('info', 'hook_unspoken', '结尾没有落到本集钩子，可检查是否留下了下一集的悬念');
  }
  // v3 契约检查：只对带新场次头的剧本提示，避免历史旧格式剧本被刷屏
  const isV3 = scenes.some((s) => (Array.isArray(s?.script) ? s.script : [])
    .some((l) => /^#{1,2}\s*EP\d{3}-SC\d{3}\b/.test(String(l))));
  if (isV3) {
    const lastScene = scenes[scenes.length - 1];
    const hasState = (Array.isArray(lastScene?.continuity) && lastScene.continuity.length)
      || (Array.isArray(lastScene?.script) ? lastScene.script : [])
        .some((l) => /^[\[［]连续性[\]］]/.test(String(l)));
    if (!hasState) {
      push('info', 'no_continuity', '本集末场没有 [连续性] 状态，下一集可能丢失道具归属 / 伤势 / 门锁等设定');
    }
    const noCode = scenes.filter((s) => !str(s?.sceneCode)).length;
    if (noCode) push('info', 'no_scene_code', `${noCode} 场缺 sceneCode，跨集引用与导出时无法定位场次`);
  }
  return issues;
}

/** 把模型输出 / 旧数据归一成统一剧本结构（不依赖磁盘，便于测试） */
export function normalizeEpisodeScript(out = {}, ctx = {}) {
  const { ep = {}, vars = {}, source = 'mock', provider = 'mock' } = ctx;
  const epNo = num(ep?.no, 0) || num(out?.episodeNo, 0) || num(vars?.episodeNo, 0) || 1;
  const characters = (() => {
    const list = Array.isArray(out?.characters) && out.characters.length
      ? out.characters
      : (Array.isArray(vars.characters) ? vars.characters : []);
    const seen = new Set();
    return list.map((c) => ({
      name: cut(c?.name || '', 24),
      role: cut(c?.role || '', 24),
      appearance: cut(c?.appearance || '', 120),
    })).filter((c) => c.name && !seen.has(c.name) && seen.add(c.name)).slice(0, 12);
  })();

  let scenes = (Array.isArray(out?.scenes) ? out.scenes : []).slice(0, 20).map((s, i) => {
    const lines = Array.isArray(s?.script) ? s.script : str(s?.script).split(/\n+/);
    const base = {
      ...s,
      id: cut(s?.id || `S${i + 1}`, 16),
      location: cleanLocation(s?.location || '') || `场景 ${i + 1}`,
      time: cut(s?.time, 24),
      summary: cut(s?.summary, 160),
      script: lines.map((l) => cleanScriptLine(l)).filter(Boolean).slice(0, 40),
    };
    // v2 结构字段：缺失时按可推导信息补（内外景 / 时长 / 场号），已有的值原样保留
    base.no = num(base.no) || i + 1;
    base.interior = /^(内景|外景|内外景)$/.test(str(base.interior)) ? base.interior : guessInterior(base.location);
    base.durationSec = num(base.durationSec) || Math.max(8, Math.min(90, base.script.length * 4));
    // v3 可拍摄契约：场次编号与 [连续性] 状态从正文行推导，缺了不给下游留空洞
    base.episodeNo = num(s?.episodeNo) || epNo;
    base.sceneCode = cut(s?.sceneCode, 16) || sceneCodeFor(epNo, base.no);
    base.continuity = Array.isArray(s?.continuity)
      ? s.continuity.map((x) => cut(x, 120)).filter(Boolean).slice(0, 8)
      : continuityOf(base.script);
    if (!Array.isArray(base.characters)) {
      base.characters = str(base.characters).split(/[,，、]/).map((c) => cut(c, 24)).filter(Boolean);
    }
    if (!Array.isArray(base.props)) {
      base.props = str(base.props).split(/[,，、]/).map((c) => cut(c, 24)).filter(Boolean);
    }
    for (const key of ['objective', 'conflict', 'turn', 'beat', 'mood', 'keyProp', 'transition', 'act']) {
      if (base[key] !== undefined) base[key] = cut(base[key], 120);
    }
    return base;
  });

  // 模型给了标题和梗概却没给场次：按原文补一场，保证「剧本」不是空的
  if (!scenes.length) {
    const text = str(vars.originalText || ep.text || '');
    const lines = text.split(/\n+/).map((l) => cleanScriptLine(l, 200)).filter(Boolean).slice(0, 12);
    const location = cut(ep.title || '本集开场', 30);
    scenes = [{
      id: 'S1', no: 1, location, time: '未指定', interior: guessInterior(location),
      episodeNo: epNo,
      sceneCode: sceneCodeFor(epNo, 1),
      continuity: continuityOf(lines),
      durationSec: Math.max(8, Math.min(90, lines.length * 4)),
      characters: [], summary: cut(ep.summary || '', 160), script: lines,
    }];
  }

  const script = {
    episodeNo: num(ep.no, 0) || num(out?.episodeNo, 0),
    episodeCode: cut(out?.episodeCode || vars.episodeCode, 16) || episodeCodeOf(epNo),
    title: cut(out?.title || vars.title || ep.title || '未命名剧本', 120),
    genre: cut(out?.genre || vars.genre || '', 60),
    logline: cut(out?.logline || vars.logline || '', 300),
    tone: cut(out?.tone || vars.tone || '', 60),
    theme: cut(out?.theme || '', 80),
    style: cut(out?.style || vars.style || '', 40),
    characters,
    scenes,
    // 剧本层时长口径：场次 durationSec 之和（缺失时已按行数补），供前端显示「预估 X 秒」
    durationSec: scenes.reduce((n, s) => n + (num(s.durationSec) || 0), 0),
    source,
    provider,
    generatedAt: Date.now(),
  };
  if (Array.isArray(out?.__mockKeys) && out.__mockKeys.length) script.filled = out.__mockKeys.slice(0, 24);
  script.continuity = {
    prevNo: num(vars.prevNo, 0) || null,
    nextNo: num(vars.nextNo, 0) || null,
    prevRecap: cut(vars.prevRecap || '', 160),
    nextHook: cut(vars.nextHook || '', 160),
  };
  script.stats = scriptStats(script);
  script.issues = scriptIssues(script, { characterNames: characters.map((c) => c.name) });
  return script;
}

/**
 * 单集生成剧本的上下文：把「上一集结尾 / 本集钩子 / 下一集走向 / 时长预算」
 * 交给编剧智能体，解决此前每集独立生成、彼此不衔接的问题。
 */
export function buildScriptVars(project = {}, m = {}, ep = {}, opts = {}) {
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  const idx = eps.findIndex((e) => num(e?.no) === num(ep?.no));
  const prev = idx > 0 ? eps[idx - 1] : null;
  const next = idx >= 0 && idx < eps.length - 1 ? eps[idx + 1] : null;
  const prevScenes = prev?.script?.scenes || [];
  const prevLast = prevScenes[prevScenes.length - 1];
  const prevTail = prevLast
    ? [...(prevLast.script || [])].slice(-2).join(' ')
    : '';
  const prevRecap = cut(prevLast?.summary || prev?.summary || prevTail || '', 180);
  const nextHook = cut(next?.hook || '', 180);
  const nextSummary = cut(next?.summary || '', 180);
  // v3：上一集正文里 [连续性] 留下的状态（伤势 / 道具归属 / 门锁 / 时间跳跃），
  // 注入下一集的编剧上下文，避免每集各自生成时把「上一集谁拿着东西」弄丢。
  const prevContinuity = screenplayContinuity(prev?.script || {}).slice(0, 8);
  const epCode = episodeCodeOf(num(ep?.no, 1));
  let spec = { totalSeconds: 30, clipCount: 10, clipSeconds: 3 };
  try { spec = resolveRuntimeSpec(project); } catch { /* 规格异常不影响写剧本 */ }
  const chars = num(ep?.chars, 0) || str(ep?.text).length;
  const byChars = Math.round(chars / 600);
  const byDuration = Math.round(num(spec.totalSeconds, 30) / 12);
  const targetScenes = clamp(Math.max(3, byChars, byDuration), 3, 10);
  const bible = m.bible || {};
  const involved = new Set(Array.isArray(ep?.characterIds) ? ep.characterIds.map(String) : []);
  const allChars = Array.isArray(m.characters) ? m.characters : [];
  const pickChars = allChars.filter((c) => involved.has(String(c.id)) || involved.size === 0);
  return {
    title: `${bible.title || project?.name || '未命名项目'} · 第 ${num(ep?.no, 1)} 集`,
    project: {
      name: project?.name || '', genre: bible.genre || '', tone: bible.tone || '',
      audience: bible.audience || '', logline: bible.logline || '', worldview: cut(bible.worldview || '', 240),
      artStyle: bible.artStyle || project?.settings?.style || '',
    },
    episodeNo: num(ep?.no, 1),
    episodeCode: epCode,
    sceneCodePrefix: `${epCode}-SC`,
    prevContinuity,
    episodeIndex: idx + 1,
    episodeCount: eps.length,
    episodeTitle: ep?.title || '',
    seasonNo: num(ep?.season, 1),
    logline: cut(ep?.summary || bible.logline || '', 220),
    hook: cut(ep?.hook || '', 160),
    prevRecap,
    prevTail: cut(prevTail, 160),
    nextHook,
    nextSummary,
    prevNo: num(prev?.no, 0) || null,
    nextNo: num(next?.no, 0) || null,
    originalText: cut(ep?.text || '', 6000),
    characters: pickChars.map((c) => ({
      name: c.name, role: c.role || '', gender: c.gender || '', age: c.age || '',
      personality: c.personality || '', appearance: c.appearance || '',
    })),
    chapters: (Array.isArray(ep?.chapters) ? ep.chapters : []).map((c) => c?.title).filter(Boolean),
    targetScenes,
    runtime: { totalSeconds: num(spec.totalSeconds, 30), clipCount: num(spec.clipCount, 10), clipSeconds: num(spec.clipSeconds, 3) },
  };
}

/** 人工编辑合并：只覆盖可编辑字段，保留来源、连续性线索与生成时间 */
export function mergeScriptEdit(existing = {}, patch = {}, ctx = {}) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const title = patch.title !== undefined ? cut(patch.title, 120) : str(base.title);
  const logline = patch.logline !== undefined ? cut(patch.logline, 300) : str(base.logline);
  const scenesIn = Array.isArray(patch.scenes) ? patch.scenes : (base.scenes || []);
  // 编辑器只提交 location / time / summary / script 四个字段；v2 的场景目标、节拍、转场
  // 若不在合并时从旧数据里带回来，用户「点一次保存」就会把这些信息清空。
  const prevScenes = Array.isArray(base.scenes) ? base.scenes : [];
  const prevById = new Map(prevScenes.map((s, i) => [str(s?.id || `S${i + 1}`), s]));
  const scenes = scenesIn.slice(0, 20).map((s, i) => {
    const lines = Array.isArray(s?.script) ? s.script : str(s?.script).split(/\n+/);
    const id = cut(s?.id || `S${i + 1}`, 16);
    const old = prevById.get(id) || prevScenes[i] || {};
    const next = { ...old, id };
    next.location = cleanLocation(s?.location || '') || `场景 ${i + 1}`;
    next.time = cut(s?.time, 24);
    next.summary = cut(s?.summary, 160);
    next.script = lines.map((l) => cleanScriptLine(l)).filter(Boolean).slice(0, 60);
    next.no = num(s?.no) || num(old.no) || i + 1;
    next.interior = /^(内景|外景|内外景)$/.test(str(s?.interior || old.interior))
      ? (s?.interior || old.interior) : guessInterior(next.location);
    next.durationSec = num(s?.durationSec) || num(old.durationSec) || Math.max(8, Math.min(90, next.script.length * 4));
    // 只接受显式提交的 v2 字段，其余从旧数据继承（不凭空生成内容）
    for (const key of SCENE_EXTRA_KEYS) {
      if (s?.[key] !== undefined) next[key] = Array.isArray(s[key]) ? s[key] : cut(s[key], 160);
    }
    // 正文行可能被人工增删：[连续性] 状态以最终 script 为准重算，不沿用过期数组
    if (s?.continuity === undefined) next.continuity = continuityOf(next.script);
    return next;
  });
  if (!scenes.length) throw new Error('剧本至少需要保留一场');
  const script = {
    ...base,
    episodeNo: num(ctx.ep?.no, num(base.episodeNo, 0)),
    title: title || str(base.title) || '未命名剧本',
    logline,
    scenes,
    durationSec: scenes.reduce((n, s) => n + (num(s.durationSec) || 0), 0),
    source: 'manual',
    editedAt: Date.now(),
    // 保留 generatedAt 以便区分「生成于」与「改于」，没有就用当前时间兜底
    generatedAt: num(base.generatedAt, 0) || Date.now(),
  };
  script.stats = scriptStats(script);
  script.issues = scriptIssues(script, { characterNames: (ctx.m?.characters || []).map((c) => c.name) });
  return script;
}

/** 单集剧本 → Markdown（导出 / 复制）：按专业剧本格式输出，场景元信息与正文分行 */
export function scriptToMarkdown(script = {}, opts = {}) {
  const lines = [];
  const title = script.title || '未命名剧本';
  // 片名本身已带「第 N 集」时不再重复前缀（模型两种写法都会出现）
  const hasNo = opts.episodeNo && new RegExp(`^第\\s*${opts.episodeNo}\\s*集`).test(title);
  const head = opts.episodeNo && !hasNo ? `第 ${opts.episodeNo} 集` : '';
  const epCode = cut(script.episodeCode, 16);
  lines.push(`# ${epCode ? `${epCode} · ` : ''}${head ? `${head} · ` : ''}${title}`);
  const timing = scriptTiming(script);
  const metas = [
    script.genre, script.tone ? `基调：${script.tone}` : '',
    script.source ? `来源：${SCRIPT_SOURCE_LABEL[script.source] || script.source}` : '',
    script.stats ? `${script.stats.sceneCount} 场 · ${script.stats.dialogueCount} 句对白 · ${script.stats.chars} 字` : '',
    timing.estimatedSeconds ? `预估 ${formatDuration(timing.estimatedSeconds)}` : '',
  ].filter(Boolean);
  if (metas.length) lines.push('', `> ${metas.join(' · ')}`);
  if (script.logline) lines.push('', `**梗概**：${script.logline}`);
  if (script.theme) lines.push('', `**主题**：${script.theme}`);
  if (Array.isArray(script.characters) && script.characters.length) {
    const rich = script.characters.some((c) => c.motivation || c.arc || c.identity || c.personality);
    if (rich) {
      lines.push('', '**角色**');
      for (const c of script.characters) {
        const bits = [
          c.role || '', c.identity, c.age ? `${c.age} 岁` : '', c.gender,
        ].filter(Boolean);
        const detail = [
          c.personality ? `性格：${c.personality}` : '',
          c.motivation ? `动机：${c.motivation}` : '',
          c.secret ? `秘密：${c.secret}` : '',
          c.arc ? `弧光：${c.arc}` : '',
        ].filter(Boolean).join('；');
        lines.push(`- ${c.name}${bits.length ? `（${bits.join(' · ')}）` : ''}${detail ? `：${detail}` : ''}`);
      }
    } else {
      lines.push('', `**角色**：${script.characters.map((c) => c.name + (c.role ? `（${c.role}）` : '')).join('、')}`);
    }
  }
  if (script.continuity?.prevRecap) lines.push('', `**上集回顾**：${script.continuity.prevRecap}`);
  (script.scenes || []).forEach((s, i) => {
    const sceneCode = cut(s.sceneCode, 16);
    const sceneHead = `## 第 ${i + 1} 场 · ${s.location || '未指定'}${s.time ? `（${s.time}）` : ''}${sceneCode ? ` · ${sceneCode}` : ''}`;
    lines.push('', sceneHead);
    const headBits = [
      /^(内景|外景|内外景)$/.test(str(s.interior)) ? s.interior : guessInterior(s.location),
      num(s.durationSec) ? formatDuration(s.durationSec) : '',
      Array.isArray(s.characters) && s.characters.length ? `人物：${s.characters.join('、')}` : '',
    ].filter(Boolean);
    if (headBits.length) lines.push('', `> ${headBits.join(' · ')}`);
    if (s.summary) lines.push('', `**本场**：${s.summary}`);
    const craft = [
      s.objective ? `**目标**：${s.objective}` : '',
      s.conflict ? `**冲突**：${s.conflict}` : '',
      s.turn ? `**转折**：${s.turn}` : '',
    ].filter(Boolean);
    if (craft.length) lines.push('', craft.join(' ｜ '));
    const notes = [
      s.beat ? `节拍：${s.beat}` : '',
      s.keyProp ? `道具：${s.keyProp}` : '',
      s.transition ? `转场：${s.transition}` : '',
    ].filter(Boolean);
    if (notes.length) lines.push('', notes.join(' ｜ '));
    for (const line of (s.script || [])) lines.push('', line);
  });
  const states = screenplayContinuity(script);
  if (states.length) lines.push('', `**跨集状态**：${states.slice(0, 8).join('；')}`);
  if (script.continuity?.nextHook) lines.push('', '---', '', `**下集钩子**：${script.continuity.nextHook}`);
  lines.push('');
  return lines.join('\n');
}

/** 全项目剧本 → Markdown（导出全部集） */
export function scriptsToMarkdown(project = {}, m = {}) {
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  const written = eps.filter((e) => e?.script);
  const out = [];
  out.push(`# ${m.bible?.title || project?.name || '未命名项目'} · 剧本集`);
  out.push('');
  out.push(`> 共 ${eps.length} 集，已完成 ${written.length} 集 · 导出时间 ${new Date().toLocaleString('zh-CN')}`);
  if (!written.length) {
    out.push('', '（还没有任何一集生成剧本）');
    return out.join('\n');
  }
  for (const ep of written) {
    out.push('', '---', '', scriptToMarkdown(ep.script, { episodeNo: ep.no }));
  }
  return out.join('\n');
}

/** 剧本覆盖率（后端 / 前端同一口径） */
export function scriptsCoverage(episodes = []) {
  const list = Array.isArray(episodes) ? episodes : [];
  const written = list.filter((e) => e?.script);
  const scenes = written.reduce((n, e) => n + num(e.script?.stats?.sceneCount, (e.script?.scenes || []).length), 0);
  const chars = written.reduce((n, e) => n + num(e.script?.stats?.chars, 0), 0);
  const bySource = { llm: 0, mock: 0, manual: 0 };
  for (const e of written) {
    const k = e.script?.source;
    if (bySource[k] !== undefined) bySource[k] += 1;
  }
  return {
    total: list.length, written: written.length, missing: list.length - written.length,
    percent: list.length ? Math.round(written.length / list.length * 100) : 0,
    scenes, chars, bySource,
    missingNos: list.filter((e) => !e?.script).map((e) => num(e?.no)),
  };
}
