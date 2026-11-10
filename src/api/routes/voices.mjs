// 音色库与角色音色分配路由域。
//   全局音色库（data/voices.json）：GET/POST /api/voices、PUT/DELETE /api/voices/:id、POST /api/voices/seed
//   试听样品：POST /api/voices/sample（默认回传浏览器 SpeechSynthesis 参数；配 TTS_ENDPOINT 时生成真实音频）
//   音色抽卡：POST /api/voices/draw（本地 ComfyUI TTS 工作流跑 N 次）→ 候选池 data/voice-drafts.json
//             GET /api/voices/drafts（候选列表）/ POST /drafts/:id/save（转正入库）/ DELETE /drafts/:id
//   项目级：POST /api/projects/:id/voices/assign（运行音色分配 Agent）、GET .../voices/status、
//           POST .../voices/set（手动指定）、POST .../voices/draw（按角色条件抽卡）
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, writeAsset, PROJECT_DIR, ASSET_DIR } from '../../core/store.mjs';
import { ensureManagement } from '../../core/project-steps.mjs';
import { emit } from '../../core/events.mjs';
import { broadcastMeta } from '../../core/step-runner.mjs';
import {
  loadVoices, saveVoices, seedVoices, normalizeVoice, getVoice, DEFAULT_VOICES,
} from '../../core/voices.mjs';
import {
  loadDrafts, addDrafts, getDraft, removeDraft, draftToVoice, draftStats, isDraftId, DRAFT_TTL_MS,
} from '../../core/voice-drafts.mjs';
import { loadComfyConfig, resolveInterface } from '../../core/comfy-config.mjs';
import { drawVoiceCandidates } from '../../core/comfyui.mjs';
import { assignVoices } from '../../agents/voice-agent.mjs';

/** 把音色库限制在 LLM/前端需要的字段，隐藏内部标记 */
function publicVoice(v) {
  return {
    id: v.id, name: v.name, gender: v.gender, ageGroup: v.ageGroup, tags: v.tags,
    language: v.language, sampleText: v.sampleText, rate: v.rate, pitch: v.pitch,
    note: v.note, hasTts: Boolean(v.tts && v.tts.voiceId), updatedAt: v.updatedAt,
    // 抽卡音色带真实音频样本与可复现参数；前端据此播放真实声线而不是浏览器合成
    source: v.source, audio: v.audio || null, draw: v.draw || null,
  };
}

/** 候选对外的精简视图（audio 有 url 即可直接 <audio src> 试听） */
function publicDraft(d) {
  return {
    id: d.id, characterId: d.characterId, characterName: d.characterName, projectId: d.projectId,
    gender: d.gender, ageGroup: d.ageGroup, tags: d.tags, language: d.language,
    sampleText: d.sampleText, nameHint: d.nameHint,
    audio: d.audio, draw: d.draw, createdAt: d.createdAt,
    expiresAt: d.createdAt + DRAFT_TTL_MS,
  };
}

function listPublic() {
  return loadVoices().map(publicVoice);
}

const ASSET_AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;

/**
 * 抽卡核心：按角色条件跑本地 TTS 工作流 N 次，产出候选并写入候选池。
 * 项目级与全局两个入口共用，保证候选口径一致。
 * @returns {Promise<{ok:boolean, drafts:Array, workflowName:string, message:string}>}
 */
async function drawFor({ res, body, project = null, character = null, log = () => {} }) {
  const cfg = loadComfyConfig();
  // 音色板块统一走接口解析：本次指定 > 板块绑定 > 类别默认。
  // 档案自带的请求参数 / 节点覆盖 / 显式绑定随 config 一起进入工作流。
  const workflowId = String(body.workflowId || body.interfaceId || '');
  const resolved = resolveInterface(cfg, { kind: 'audio', scope: 'voice', interfaceId: workflowId });
  if (workflowId && !resolved.interfaceId) return { error: '指定的音频工作流不存在', status: 404 };
  const workflow = resolved.workflow;
  const workflowName = resolved.interfaceName || cfg.audioWorkflowName || '音频工作流';
  const config = {
    ...resolved.config,
    resolvedInterface: {
      id: resolved.interfaceId, name: workflowName, kind: 'audio', scope: 'voice',
      via: resolved.via, warnings: resolved.warnings,
    },
  };
  if (!workflow) {
    return {
      error: '还没有可用的音色抽卡工作流。请在「设置 → 本地 ComfyUI」导入一份 TTS 工作流（导出(API) 格式），或改用音色库里的预设音色。',
      status: 400,
    };
  }
  const count = Math.max(1, Math.min(8, Number(body.count) || 4));
  const text = String(body.text || character?.voiceSampleText || '').trim().slice(0, 200)
    || `这是一段音色试听，用来判断声线是否适合${character?.name || '这个角色'}。`;
  // 说话人候选值：用户显式给的优先；否则从工作流里已配置的 voice 字段读一个作锚点，
  // 具体差异靠 seed 采样 —— 绝大多数 TTS 工作流（IndexTTS / CosyVoice / MiniMax）
  // 都是「同一说话人 + 不同随机采样」产出不同音色。
  const voiceValues = Array.isArray(body.voiceValues)
    ? body.voiceValues.map((v) => String(v).slice(0, 80)).filter(Boolean).slice(0, 8)
    : [];
  const gender = ['男', '女', '中性'].includes(body.gender) ? body.gender : (character?.gender || '中性');
  const ageGroup = ['儿童', '青年', '中年', '老年'].includes(body.ageGroup)
    ? body.ageGroup : guessAgeGroup(character?.age || '');
  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 8) : splitTags(character?.personality || '');
  const language = String(body.language || 'zh-CN').slice(0, 12);

  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });

  const result = await drawVoiceCandidates(config, workflow, {
    count, text, voiceValues, language, workflowName,
    bindings: resolved.bindings,
    signal: ac.signal,
    filenamePrefix: 'lingximanju_voice',
    log: (lvl, msg) => { log(lvl, msg); emit('log', { source: 'voice-draw', level: lvl, message: msg }); },
  });
  if (clientGone) return { clientGone: true };

  const drafts = addDrafts(result.draws.map((d) => ({
    characterId: character?.id || '',
    characterName: character?.name || '',
    projectId: project?.id || '',
    gender, ageGroup, tags, language,
    sampleText: text,
    nameHint: character?.name ? `${character.name}·抽卡` : '',
    audio: { url: d.url, file: d.file, bytes: d.bytes, source: 'comfyui', at: Date.now() },
    draw: {
      seed: Number(d.seed) || 0,
      voiceValue: d.voiceValue || '',
      workflowName,
      prompt: text,
      at: Date.now(),
    },
    createdAt: Date.now(),
  })));

  if (!result.draws.length) {
    return {
      ok: false,
      drafts: [],
      workflowName,
      failures: result.failures,
      message: `抽卡没有产出音频：${result.failures[0]?.error || '工作流没有音频输出节点'}`,
      status: 200,
    };
  }
  return {
    ok: true,
    drafts: drafts.map(publicDraft),
    added: result.draws.length,
    failures: result.failures,
    workflowName,
    message: `抽到 ${result.draws.length} 段候选音色（${workflowName}）· 满意就保存，不保存 ${DRAFT_TTL_MS / 3600000} 小时内自动清理`,
  };
}

function splitTags(text) {
  return String(text || '').split(/[,，、；;]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
}
function guessAgeGroup(age) {
  const a = String(age || '');
  if (/(儿童|小[朋孩]|幼|童)/.test(a)) return '儿童';
  if (/(中年|成[年熟])/.test(a)) return '中年';
  if (/(老年|老|长辈|爷爷|奶奶)/.test(a)) return '老年';
  return '青年';
}

/**
 * 候选转正：写进全局音色库并清掉候选记录。
 * 音频文件保留（keepAudio），因为正主音色仍在引用它。
 * @returns {{ok:boolean, voice?:object, message?:string}}
 */
function promoteDraftToVoice(draftId, patch = {}) {
  const draft = getDraft(draftId);
  if (!draft) return { ok: false, message: '候选不存在或已被清理（候选默认 24 小时过期）' };
  const voices = loadVoices();
  const voice = normalizeVoice(draftToVoice(draft, patch));
  // 同名冲突：自动补后缀，不阻断保存（用户可能想保留两次抽卡的同名结果）
  let name = voice.name;
  if (voices.some((v) => v.name === name)) {
    let n = 2;
    while (voices.some((v) => v.name === `${name} (${n})`)) n += 1;
    name = `${name} (${n})`;
  }
  voice.name = name;
  voices.push(voice);
  saveVoices(voices);
  removeDraft(draftId, { keepAudio: true });
  return { ok: true, voice };
}

/** 删除音色时把引用它的角色一并置空，避免项目里留下悬空 voiceId */
function detachVoiceFromProjects(voiceId) {
  let affected = 0;
  for (const f of fs.readdirSync(PROJECT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const file = path.join(PROJECT_DIR, f);
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.includes(voiceId)) continue;
      const project = JSON.parse(raw);
      const chars = project?.management?.characters;
      if (!Array.isArray(chars)) continue;
      let changed = false;
      for (const c of chars) {
        if (c.voiceId === voiceId) {
          c.voiceId = ''; c.voiceName = ''; c.voiceReason = ''; c.voiceScore = 0;
          changed = true;
        }
      }
      if (changed) { saveProject(project); affected += 1; }
    } catch { /* 单个项目读失败不影响删除 */ }
  }
  return affected;
}

export async function handleVoices(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // ---------- 全局音色库 CRUD ----------
  const seedMatch = pathname.match(MATCH.voicesSeed);
  if (seedMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const voices = saveVoices(DEFAULT_VOICES);
    return json(res, { ok: true, seeded: true, voices: voices.map(publicVoice),
      message: `已重置音色库（${voices.length} 个默认音色）` }), true;
  }

  const sampleMatch = pathname.match(MATCH.voicesSample);
  if (sampleMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const body = await readBody(req);
    // 优先按 voiceId 取音色样例文案与发音参数；也允许直接传 text/lang/rate/pitch
    const voice = body.voiceId ? getVoice(body.voiceId) : null;
    // 抽卡音色自带真实音频样本：直接把它交给前端播放，不再合成
    if (voice?.audio?.url) {
      return json(res, {
        mode: 'asset', url: voice.audio.url, text: voice.sampleText, lang: voice.language,
        voiceId: voice.id, bytes: voice.audio.bytes,
      }), true;
    }
    const text = String(body.text || voice?.sampleText || '欢迎来到灵犀漫剧，这是一段音色试听。');
    const lang = String(body.lang || voice?.language || 'zh-CN');
    const rate = voice ? voice.rate : (Number(body.rate) || 1);
    const pitch = voice ? voice.pitch : (Number(body.pitch) || 1);
    // 可选：配置了 TTS_ENDPOINT 时生成真实音频样本（OpenAI /audio/speech 兼容）；
    // 否则回退浏览器 SpeechSynthesis，前端直接本地朗读，无需任何后端依赖。
    const ttsEp = process.env.TTS_ENDPOINT || '';
    if (ttsEp && voice?.tts?.voiceId) {
      try {
        const r = await fetch(ttsEp.replace(/\/+$/, ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: voice.tts.provider || 'tts-1', input: text, voice: voice.tts.voiceId }),
        });
        if (r.ok) {
          const ct = r.headers.get('content-type') || '';
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length) {
            const ext = /json/.test(ct) ? 'mp3' : (ct.includes('mpeg') ? 'mp3' : ct.includes('ogg') ? 'ogg' : 'mp3');
            const asset = writeAsset(`vox_${Date.now().toString(36)}.${ext}`, buf);
            return json(res, { mode: 'server', url: asset.url || `/assets/${asset.file}`, text, lang }), true;
          }
        }
      } catch (err) {
        // 真实 TTS 失败不致命：回退浏览器试听
        emit('log', { level: 'warn', message: `音色试听真实 TTS 失败，回退浏览器：${err.message}` });
      }
    }
    return json(res, { mode: 'browser', text, lang, rate, pitch, voiceId: voice?.id || null }), true;
  }

  // ---------- 音色抽卡：抽取 / 候选池 / 转正 / 丢弃 ----------
  const drawMatch = pathname.match(MATCH.voiceDraw);
  if (drawMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const body = await readBody(req);
    const out = await drawFor({
      res, body,
      log: (lvl, msg) => emit('log', { level: lvl, message: `音色抽卡 · ${msg}` }),
    });
    if (out.clientGone) return true;
    if (out.error) return json(res, { error: out.error }, out.status || 400), true;
    return json(res, out), true;
  }

  if (pathname.match(MATCH.voiceDrafts) && method === 'GET') {
    const drafts = loadDrafts();
    return json(res, {
      drafts: drafts.map(publicDraft),
      stats: draftStats(drafts),
      // 音频工作流是否就绪：未配置时前端把「抽卡」按钮置灰并给出配置指引
      workflow: loadComfyConfig().audioWorkflow
        ? { name: loadComfyConfig().audioWorkflowName, ready: true }
        : { ready: false },
    }), true;
  }

  const draftSaveMatch = pathname.match(MATCH.voiceDraftSave);
  if (draftSaveMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(draftSaveMatch[1]);
    if (!isDraftId(id)) return json(res, { error: '不是候选音色 id' }, 400), true;
    const body = await readBody(req);
    const out = promoteDraftToVoice(id, {
      name: body.name, tags: Array.isArray(body.tags) ? body.tags : splitTags(body.tags),
      note: body.note, language: body.language,
    });
    if (!out.ok) return json(res, { error: out.message }, 404), true;
    return json(res, {
      ok: true, voice: publicVoice(out.voice), voices: listPublic(),
      message: `已保存为音色「${out.voice.name}」，可直接绑定角色`,
    }), true;
  }

  const draftItemMatch = pathname.match(MATCH.voiceDraftItem);
  if (draftItemMatch && method === 'DELETE') {
    const id = decodeURIComponent(draftItemMatch[1]);
    const out = removeDraft(id);
    return json(res, out.ok
      ? { ok: true, removed: out.removed, drafts: loadDrafts().map(publicDraft), stats: draftStats() }
      : { error: out.message }, out.ok ? 200 : 404), true;
  }

  const itemMatch = pathname.match(MATCH.voiceItem);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      const voices = loadVoices();
      const idx = voices.findIndex((v) => v.id === id);
      if (idx < 0) return json(res, { error: '音色不存在' }, 404), true;
      // audio / draw / source 由服务端维护，不跟随前端表单覆盖，
      // 否则用户改个备注就会把抽卡音色的真实音频样本抹掉。
      const { audio, draw, source, ...editable } = body || {};
      const merged = normalizeVoice({ ...voices[idx], ...editable, id, audio: voices[idx].audio, draw: voices[idx].draw, source: voices[idx].source });
      voices[idx] = merged;
      saveVoices(voices);
      return json(res, { ok: true, voice: publicVoice(merged) }), true;
    }
    if (method === 'DELETE') {
      const voices = loadVoices();
      const target = voices.find((v) => v.id === id);
      const next = voices.filter((v) => v.id !== id);
      if (next.length === voices.length) return json(res, { error: '音色不存在' }, 404), true;
      saveVoices(next);
      const affected = detachVoiceFromProjects(id);
      // 抽卡音色的音频是它的本体：没有其它音色共用时才回收文件
      if (target?.audio?.file && !next.some((v) => v.audio?.file === target.audio.file)) {
        try { fs.unlinkSync(path.join(ASSET_DIR, target.audio.file)); } catch { /* 已不存在 */ }
      }
      return json(res, {
        ok: true, deleted: id, remaining: next.length, detachedProjects: affected,
        message: affected ? `已删除，并解绑 ${affected} 个项目里的角色引用` : '已删除',
      }), true;
    }
    return json(res, { error: '不支持的方法' }, 405), true;
  }

  const collMatch = pathname.match(MATCH.voices);
  if (collMatch) {
    if (method === 'GET') {
      const { voices, seeded } = seedVoices();
      return json(res, { voices: voices.map(publicVoice), seeded }), true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const voice = normalizeVoice(body);
      const voices = loadVoices();
      // 同名音色视为重复，提示但不强制拦截（允许用户建多个相似音色）
      if (voices.some((v) => v.name === voice.name)) {
        return json(res, { error: `已存在同名音色「${voice.name}」`, exists: true }, 409), true;
      }
      voices.push(voice);
      saveVoices(voices);
      return json(res, { ok: true, voice: publicVoice(voice) }), true;
    }
    return json(res, { error: '不支持的方法' }, 405), true;
  }

  // ---------- 项目级：角色音色分配 / 状态 / 手动指定 / 抽卡 ----------
  const assignMatch = pathname.match(MATCH.projectVoiceAssign);
  if (assignMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(assignMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    if (!Array.isArray(m.characters) || !m.characters.length) {
      return json(res, { error: '该项目还没有角色，请先在「角色」页提取或新增' }, 400), true;
    }
    const body = await readBody(req);
    try {
      const result = await assignVoices({
        project, m,
        modelId: body.modelId || '',
        // onlyMissing=true：只给还没音色的角色分配，手动指定的绑定不动（提取后自动补配用这个模式）
        onlyMissing: Boolean(body.onlyMissing),
        log: (lvl, msg) => emit('log', { projectId: id, level: lvl, message: `音色分配 · ${msg}` }),
      });
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      return json(res, {
        ok: true, ...result,
        characters: m.characters.map((c) => ({ id: c.id, name: c.name, voiceId: c.voiceId || null, voiceName: c.voiceName || null, voiceReason: c.voiceReason || '' })),
      }), true;
    } catch (err) {
      return json(res, { error: `音色分配失败：${err.message}` }, 500), true;
    }
  }

  // 项目级抽卡：按角色条件抽，候选自动归属于该项目
  const projectDrawMatch = pathname.match(MATCH.projectVoiceDraw);
  if (projectDrawMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(projectDrawMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const body = await readBody(req);
    const char = body.characterId
      ? (m.characters || []).find((c) => c.id === String(body.characterId))
      : null;
    if (body.characterId && !char) return json(res, { error: '角色不存在' }, 404), true;
    const out = await drawFor({
      res, body, project, character: char,
      log: (lvl, msg) => emit('log', { projectId: id, level: lvl, message: `音色抽卡 · ${msg}` }),
    });
    if (out.clientGone) return true;
    if (out.error) return json(res, { error: out.error }, out.status || 400), true;
    return json(res, out), true;
  }

  const statusMatch = pathname.match(MATCH.projectVoiceStatus);
  if (statusMatch) {
    if (method !== 'GET') return json(res, { error: '需要 GET' }, 405), true;
    const id = decodeURIComponent(statusMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const voices = loadVoices();
    const list = (m.characters || []).map((c) => {
      const v = c.voiceId ? getVoice(c.voiceId, voices) : null;
      return {
        id: c.id, name: c.name,
        voiceId: c.voiceId || null, voiceName: c.voiceName || null,
        voiceReason: c.voiceReason || '', voiceScore: c.voiceScore || 0,
        assigned: Boolean(v), gender: c.gender, age: c.age,
        hasAudio: Boolean(v?.audio?.url),
      };
    });
    return json(res, { characters: list, total: list.length, assigned: list.filter((x) => x.assigned).length }), true;
  }

  const setMatch = pathname.match(MATCH.projectVoiceSet);
  if (setMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(setMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const body = await readBody(req);
    const characterId = String(body.characterId || '');
    const char = (m.characters || []).find((c) => c.id === characterId);
    if (!char) return json(res, { error: '角色不存在' }, 404), true;
    const voiceId = String(body.voiceId || '').trim();
    if (voiceId) {
      let v = getVoice(voiceId);
      // 绑定候选音色时自动转正：角色不能引用一份 24 小时后会被清掉的候选，
      // 否则项目里会出现「音色名还在、音频文件已消失」的悬空绑定。
      let promoted = false;
      if (!v && isDraftId(voiceId)) {
        const out = promoteDraftToVoice(voiceId, {
          name: body.name || (char.name ? `${char.name}·抽卡` : ''), tags: body.tags,
        });
        if (!out.ok) return json(res, { error: out.message }, 404), true;
        v = out.voice; promoted = true;
      }
      if (!v) return json(res, { error: '音色不存在' }, 404), true;
      // 唯一性硬约束：一个音色在本项目里只能绑定一个角色。
      // 已被其它角色占用的音色不能选，明确告知被谁占用，前端下拉也会提前禁用。
      const occupied = (m.characters || []).find((c) => c.id !== char.id && c.voiceId === v.id);
      if (occupied) {
        return json(res, {
          error: `音色「${v.name}」已被角色「${occupied.name}」使用，不能重复绑定`,
          usedBy: { characterId: occupied.id, characterName: occupied.name },
        }, 409), true;
      }
      char.voiceId = v.id; char.voiceName = v.name;
      char.voiceReason = body.reason ? String(body.reason).slice(0, 200)
        : (promoted ? `抽卡音色已保存并绑定：${v.name}` : `手动指定：${v.name}`);
      char.voiceScore = 0;
      char.updatedAt = Date.now();
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      return json(res, {
        ok: true, promoted,
        voice: publicVoice(v),
        character: { id: char.id, name: char.name, voiceId: char.voiceId, voiceName: char.voiceName, voiceReason: char.voiceReason },
        voices: listPublic(),
        message: promoted ? `候选已保存为音色「${v.name}」并绑定到「${char.name}」` : `已绑定音色「${v.name}」`,
      }), true;
    }
    // 清空：释放绑定，但保留其它字段
    char.voiceId = ''; char.voiceName = ''; char.voiceReason = ''; char.voiceScore = 0;
    char.updatedAt = Date.now();
    saveProject(project);
    broadcastMeta(project);
    emit('state', { projectId: id, project, reason: 'characters' });
    return json(res, { ok: true, character: { id: char.id, name: char.name, voiceId: null, voiceName: null, voiceReason: '' } }), true;
  }

  return false;
}
