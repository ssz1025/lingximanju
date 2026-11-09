/* ============================================================================
 * 音色抽卡：候选池数据层 + TTS 工作流语义单元测试。
 *
 * 覆盖四条产品规则的「可实现性」：
 *   1. 音色可以选择 —— 预设音色仍走 voices.mjs（已有 voice.test.mjs 覆盖，这里只验归一不回归）；
 *   2. 可以 ComfyUI 抽卡 —— normalizeDraft 只收真实音频，drawVoiceCandidates 只收音频产物；
 *   3. 绑定必须保存 —— draftToVoice 产出 vox_ 正式 id（isDraftId 为假），保证绑定不悬空；
 *   4. 合适可直接保存 —— draftToVoice 携带 audio + draw，转正后仍能播放与复现。
 *
 * 纯逻辑为主 + 临时数据目录轻量 I/O，不连接真实 ComfyUI。
 * 运行：node --test tests/voice-draw.test.mjs
 * ==========================================================================*/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-voice-draw-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  DRAFT_PREFIX, DRAFT_CAPACITY, DRAFT_TTL_MS, DRAFT_KEEP_PER_PROJECT,
  isDraftId, normalizeDraft, loadDrafts, addDrafts, getDraft, removeDraft,
  clearDrafts, draftToVoice, draftStats,
} = await import('../src/core/voice-drafts.mjs');
const { normalizeVoice, VOICE_SOURCES } = await import('../src/core/voices.mjs');
const { describeAudioWorkflow, injectWorkflow, drawVoiceCandidates } = await import('../src/core/comfyui.mjs');
const { WORKFLOW_KINDS, kindOf, DEFAULT_COMFY, comfySummary } = await import('../src/core/comfy-config.mjs');

const DRAFT_FILE = path.join(TMP, 'voice-drafts.json');
const ASSET_DIR = path.join(TMP, 'assets');
fs.mkdirSync(ASSET_DIR, { recursive: true });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 造一段「真实存在」的音频资产：路径合法 + 文件真的落盘，便于验证回收逻辑 */
function audioAsset(name = `draft_${Math.random().toString(36).slice(2, 8)}.mp3`, bytes = 4096) {
  const file = name;
  fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.alloc(bytes, 1));
  return { url: `/assets/${file}`, file, bytes, durationSec: 2.4, source: 'comfyui', at: Date.now() };
}

const rawDraft = (patch = {}) => ({
  characterId: 'c1', characterName: '阿杰', projectId: 'prj_a',
  gender: '男', ageGroup: '青年', tags: ['活泼', '少年'],
  sampleText: '交给我吧，这条路我熟。',
  nameHint: '阿杰·抽卡',
  audio: audioAsset(),
  draw: { seed: 42, voiceValue: 'male-qn-qingse', workflowName: 'TTS 抽卡', prompt: '交给我吧' },
  ...patch,
});

const reset = () => { fs.rmSync(DRAFT_FILE, { force: true }); };
const closeServer = (server) => new Promise((res) => server.close(res));

/* ---------------------------------------------------------------- 数据层 */

test('isDraftId / DRAFT_PREFIX：只有 vdr_ 前缀算候选', () => {
  assert.equal(DRAFT_PREFIX, 'vdr_');
  assert.equal(isDraftId('vdr_abc123'), true);
  assert.equal(isDraftId('vox_abc123'), false, '正式音色不是候选');
  assert.equal(isDraftId(''), false);
  assert.equal(isDraftId(null), false);
  assert.equal(isDraftId(undefined), false);
});

test('normalizeDraft：没有真实音频直接丢弃（空音色不算抽卡结果）', () => {
  assert.equal(normalizeDraft({}), null);
  assert.equal(normalizeDraft({ audio: null }), null);
  assert.equal(normalizeDraft({ audio: { url: 'https://example.com/a.mp3' } }), null, '外链音频不入库');
  assert.equal(normalizeDraft({ audio: { url: '/assets/a.png', file: 'a.png' } }), null, '图片不是音色');
  assert.equal(normalizeDraft({ audio: { url: '/assets/a' } }), null, '无扩展名不算音频');
});

test('normalizeDraft：合法音频归一，字段截断 + 枚举兜底 + 自动补 vdr_ id', () => {
  const d = normalizeDraft(rawDraft({
    gender: '不明', ageGroup: '不详', language: 'xx',
    tags: 'a,b，c、d', draw: { seed: '7', voiceValue: 'v1', workflowName: 'w', prompt: 'p' },
  }));
  assert.ok(d, '合法音频应保留');
  assert.match(d.id, /^vdr_/, '无 id 时自动生成候选 id');
  assert.equal(d.gender, '中性', '非法性别回退中性');
  assert.equal(d.ageGroup, '青年', '非法年龄层回退青年');
  assert.equal(d.language, 'xx', '语言按传入值保留（候选不强制白名单，转正时才校验）');
  assert.deepEqual(d.tags, ['a', 'b', 'c', 'd'], '多种分隔符都认');
  assert.equal(d.draw.seed, 7, 'seed 转数字');
  assert.equal(d.source, 'comfyui');
  assert.equal(d.audio.file, d.audio.url.replace('/assets/', ''), 'file 可从 url 反推');
});

test('normalizeDraft：保留合法候选 id，未知 id 重新生成', () => {
  const keep = normalizeDraft(rawDraft({ id: 'vdr_keep' }));
  assert.equal(keep.id, 'vdr_keep');
  const regen = normalizeDraft(rawDraft({ id: 'vox_wrongprefix' }));
  assert.match(regen.id, /^vdr_/, '非 vdr_ 前缀的 id 不会被候选池接受');
});

test('addDrafts / loadDrafts：追加候选并落盘，池内可查', () => {
  reset();
  const pool = addDrafts([rawDraft(), rawDraft({ characterId: 'c2', characterName: '小柔', gender: '女' })]);
  assert.equal(pool.length, 2);
  assert.equal(draftStats(pool).total, 2);
  const json = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
  assert.equal(json.schema, 1);
  assert.equal(json.drafts.length, 2, '确实落盘');
  assert.ok(getDraft(pool[0].id), '按 id 可取回');
  assert.equal(getDraft('vdr_nope'), null);
});

test('loadDrafts：超过 TTL 的候选被淘汰并回收音频文件', () => {
  reset();
  const old = audioAsset('old.mp3');
  const fresh = audioAsset('fresh.mp3');
  fs.writeFileSync(DRAFT_FILE, JSON.stringify({
    schema: 1,
    drafts: [
      { ...normalizeDraft(rawDraft({ audio: old })), createdAt: Date.now() - DRAFT_TTL_MS - 1000 },
      { ...normalizeDraft(rawDraft({ audio: fresh })), createdAt: Date.now() },
    ],
  }));
  const pool = loadDrafts();
  assert.equal(pool.length, 1, '只留未过期的');
  assert.equal(pool[0].audio.file, 'fresh.mp3');
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'old.mp3')), false, '过期候选的音频被回收');
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'fresh.mp3')), true);
});

test('loadDrafts：容量上限与单项目配额都会触发淘汰', () => {
  reset();
  // 灌满容量：全部属于同一项目，验证「容量」先于「单项目配额」生效的那条边界
  const many = [];
  for (let i = 0; i < DRAFT_CAPACITY + 3; i += 1) {
    many.push({ ...normalizeDraft(rawDraft({ projectId: 'prj_bulk', audio: audioAsset() })), createdAt: Date.now() + i });
  }
  fs.writeFileSync(DRAFT_FILE, JSON.stringify({ schema: 1, drafts: many }));
  const capped = loadDrafts();
  assert.equal(capped.length, DRAFT_KEEP_PER_PROJECT,
    `单项目最多留 ${DRAFT_KEEP_PER_PROJECT} 条（${DRAFT_CAPACITY} 条容量下按项目配额裁剪）`);
  // 配额只按项目计算：换一批项目 id 就能各自占到自己的配额
  const spread = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < DRAFT_KEEP_PER_PROJECT; j += 1) {
      spread.push({ ...normalizeDraft(rawDraft({ projectId: `prj_${i}`, audio: audioAsset() })), createdAt: Date.now() + j });
    }
  }
  fs.writeFileSync(DRAFT_FILE, JSON.stringify({ schema: 1, drafts: spread }));
  assert.equal(loadDrafts().length, DRAFT_CAPACITY, '多项目合计不超过全局容量');
});

test('removeDraft：默认回收音频；keepAudio 保留（转正后正主仍在用同一文件）', () => {
  reset();
  const audio = audioAsset('keepme.mp3');
  const pool = addDrafts([rawDraft({ audio })]);
  const id = pool[0].id;

  const removed = removeDraft(id);
  assert.equal(removed.ok, true);
  assert.equal(loadDrafts().length, 0);
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'keepme.mp3')), false, '丢弃候选 → 音频一起回收');

  const audio2 = audioAsset('promote.mp3');
  const pool2 = addDrafts([rawDraft({ audio: audio2 })]);
  const out = removeDraft(pool2[0].id, { keepAudio: true });
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'promote.mp3')), true, '转正 → 音频必须留着');

  assert.equal(removeDraft('vdr_ghost').ok, false, '不存在的候选返回失败而不是抛错');
});

test('clearDrafts：整池清空并回收全部音频', () => {
  reset();
  const a1 = audioAsset('c1.mp3');
  const a2 = audioAsset('c2.mp3');
  addDrafts([rawDraft({ audio: a1 }), rawDraft({ audio: a2 })]);
  const r = clearDrafts();
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.equal(loadDrafts().length, 0);
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'c1.mp3')), false);
  assert.equal(fs.existsSync(path.join(ASSET_DIR, 'c2.mp3')), false);
});

/* ------------------------------------------------------- 转正（保存为音色） */

test('draftToVoice：id 迁到 vox_、source=draw、audio 与 draw 原样带走', () => {
  const d = normalizeDraft(rawDraft());
  const voice = draftToVoice(d, { name: '我的抽卡音色' });
  assert.match(voice.id, /^vox_/, '转正后换正式 id');
  assert.equal(isDraftId(voice.id), false, '正式音色不能带候选前缀');
  assert.equal(voice.name, '我的抽卡音色');
  assert.equal(voice.source, 'draw');
  assert.equal(voice.audio.file, d.audio.file, '音频跟着转正，播放不丢');
  assert.equal(voice.audio.url, d.audio.url);
  assert.equal(voice.draw.seed, d.draw.seed, 'seed 保留，随时可复现');
  assert.equal(voice.draw.voiceValue, 'male-qn-qingse');
  assert.deepEqual(voice.tags, ['活泼', '少年']);
  assert.equal(voice.tts.provider, 'comfyui', '有说话人值时把 TTS 绑定也带上');
  assert.equal(voice.tts.voiceId, 'male-qn-qingse');
  assert.ok(voice.note.includes('seed 42'), '备注写明复现来源');
});

test('draftToVoice：无说话人值时 tts 为 null、名称回退 nameHint 或时间戳', () => {
  const d = normalizeDraft(rawDraft({ draw: { seed: 1, voiceValue: '', workflowName: 'W' } }));
  const noName = draftToVoice(d);
  assert.equal(noName.tts, null, '没有说话人就不伪造 tts 绑定');
  assert.equal(noName.name, '阿杰·抽卡', '优先用抽卡时记的角色名');
  const bare = draftToVoice(normalizeDraft(rawDraft({ nameHint: '', draw: { seed: 1 } })));
  assert.equal(bare.name.includes('抽卡音色'), true, '什么都没有时给一个可读默认名');
  assert.equal(draftToVoice(null), null, '空候选不产出音色');
});

test('转正后的音色能被音色库归一接受，且 audio/draw 不被清掉', () => {
  const voice = normalizeVoice(draftToVoice(normalizeDraft(rawDraft())));
  assert.ok(VOICE_SOURCES.includes(voice.source), 'source 在白名单内');
  assert.equal(voice.source, 'draw');
  assert.ok(voice.audio, 'normalizeVoice 保留音频');
  assert.ok(voice.draw, 'normalizeVoice 保留复现参数');
  assert.match(voice.id, /^vox_/);
  // 旧的 seed / manual 音色不受影响：没有 audio 就是 null，不强行补齐
  const plain = normalizeVoice({ name: '预设', gender: '女' });
  assert.equal(plain.audio, null);
  assert.equal(plain.draw, null);
  assert.equal(plain.source, 'manual');
});

/* --------------------------------------------------- ComfyUI 音频工作流语义 */

const TTS_WF = {
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '默认朗读文案' } },
  '2': { class_type: 'IndexTTS', inputs: { text: ['1', 0], voice: 'male-qn-qingse', language: 'zh-CN', seed: 0 } },
  '3': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: 'tts' } },
};
const TTS_WF_NO_VOICE = {
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '默认朗读文案' } },
  '2': { class_type: 'IndexTTS', inputs: { text: ['1', 0] } },
  '3': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: 'tts' } },
};
const TTS_WF_NO_OUTPUT = {
  '1': { class_type: 'IndexTTS', inputs: { text: 'hello', voice: 'v' } },
};

test('describeAudioWorkflow：识别朗读文案 / 说话人 / 音频输出节点', () => {
  const d = describeAudioWorkflow(TTS_WF, { audioText: '这是试听文案', voice: 'v1', language: 'zh-CN' });
  assert.equal(d.ok, true, '有文案注入点 + 音频输出节点才算就绪');
  assert.ok(d.text, '找到朗读文案落点');
  assert.equal(d.text.preview, '这是试听文案', '注入值就是本次要念的文案');
  assert.ok(d.voice, '找到说话人字段');
  assert.equal(d.text.node, '1', '写进上游文本源节点（不是把连线改成字符串）');
  assert.equal(d.text.strategy, 'auto:ttsText', '标注注入来源，便于用户核对');
  assert.equal(d.audioNodes.length, 1);
  assert.equal(d.audioNodes[0].classType, 'SaveAudio');
  assert.deepEqual(d.warnings, [], '零告警：这份工作流是抽卡理想形态');
});

test('describeAudioWorkflow：波形图产物不影响音频输出识别', () => {
  const wf = { ...TTS_WF, '4': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'wave' } } };
  const d = describeAudioWorkflow(wf, { audioText: 'x', voice: 'v' });
  assert.equal(d.audioNodes.length, 1, '只有 SaveAudio 被认作音频输出');
  assert.equal(d.audioNodes[0].classType, 'SaveAudio');
  assert.equal(d.ok, true);
});

test('describeAudioWorkflow：缺说话人字段时按有无 seed 给出不同的降级告警', () => {
  // 有 seed：差异确实存在，只是不是「不同音色」而是「同音色的不同采样」
  const withSeed = describeAudioWorkflow({ ...TTS_WF_NO_VOICE, '2': { class_type: 'IndexTTS', inputs: { text: ['1', 0], seed: 0 } } }, { audioText: 'x' });
  assert.equal(withSeed.ok, true, '没有说话人字段仍可抽卡（靠 seed）');
  assert.equal(withSeed.voice, null);
  assert.equal(withSeed.seed.node, '2');
  assert.ok(
    withSeed.warnings.some((w) => /说话人/.test(w) && /seed/.test(w)),
    `有 seed 时应说明差异来自 seed，实际：${withSeed.warnings.join(' | ')}`,
  );
  // 既无 voice 也无 seed：多次抽卡几乎必然得到同一段音频，必须明确劝阻
  const bare = describeAudioWorkflow(TTS_WF_NO_VOICE, { audioText: 'x' });
  assert.equal(bare.ok, true, '不阻断抽卡');
  assert.equal(bare.seed, null);
  assert.ok(
    bare.warnings.some((w) => /seed/.test(w) && /几乎相同|加一个/.test(w)),
    `无 voice 且无 seed 时应警示抽卡可能无差异，实际：${bare.warnings.join(' | ')}`,
  );
});

test('describeAudioWorkflow：没有音频输出节点 → ok=false 并明确告警（不谎报就绪）', () => {
  const d = describeAudioWorkflow(TTS_WF_NO_OUTPUT, { audioText: 'x' });
  assert.equal(d.ok, false);
  assert.equal(d.audioNodes.length, 0);
  assert.ok(d.warnings.some((w) => /SaveAudio/.test(w)), '告警里给节点名，便于用户改工作流');
});

test('describeAudioWorkflow：不因「没有正向提示词」而误报（TTS 工作流本来就没有）', () => {
  const d = describeAudioWorkflow(TTS_WF, { audioText: 'x' });
  assert.equal(d.ok, true);
  assert.equal(d.warnings.some((w) => /未找到提示词注入点/.test(w)), false, '图片注入语义的告警必须被过滤掉');
});

test('injectWorkflow：voice / language / ttsText 只注入一次，出图工作流不被污染', () => {
  const built = injectWorkflow(TTS_WF, { audioText: '文案', voice: 'spk', language: 'zh-CN' });
  const byVoice = built.applied.filter((a) => a.by === 'auto:voice');
  assert.equal(byVoice.length, 1, '说话人不重复注入');
  assert.equal(byVoice[0].node, '2');
  const byLang = built.applied.filter((a) => a.by === 'auto:language');
  assert.equal(byLang.length, 1);
  assert.equal(byLang[0].value, 'zh-CN');

  // 出图工作流：不传 voice/audioText 时，这两个分支一次都不触发
  const imageWf = { '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', voice: 'x' } }, '2': { class_type: 'SaveImage', inputs: {} } };
  const img = injectWorkflow(imageWf, { prompt: '雨夜街头' });
  assert.equal(img.applied.some((a) => a.by === 'auto:voice'), false, '未传 voice 就不注入');
  assert.equal(img.applied.some((a) => a.by === 'auto:ttsText'), false, '未传 audioText 就不注入');
  assert.equal(img.promptInjection.positive.preview, '雨夜街头', '提示词注入不受影响');
});

test('drawVoiceCandidates：没有音频产物时全部记失败，绝不伪造成功', async () => {
  // 假 ComfyUI 直接返回 404：runWorkflow 抛错 → 全部进 failures
  const cfg = { baseUrl: 'http://127.0.0.1:1', timeoutMs: 3000, pollIntervalMs: 500 };
  const r = await drawVoiceCandidates(cfg, TTS_WF, { count: 2, text: 'x', voiceValues: ['v'] });
  assert.equal(r.draws.length, 0);
  assert.equal(r.failures.length, 2, '每一次尝试都必须有交代');
  assert.ok(r.failures[0].error);
  assert.equal(r.workflowName, '');
});

/** 假 TTS ComfyUI：记录每次提交的说话人 / 文案（文案在上游文本源节点）/ 种子，返回一段 wav 产物 */
function startTtsComfy(outputs) {
  const state = { voices: [], texts: [], seeds: [], prompts: 0 };
  const server = http.createServer((req, res) => {
    const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system_stats') return send({ system: { comfyui_version: 'mock' } });
    if (url.pathname === '/prompt') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const nodes = Object.values(body.prompt || {});
        state.prompts += 1;
        const tts = nodes.find((n) => n.class_type === 'IndexTTS') || {};
        state.voices.push(tts.inputs?.voice ?? null);
        // 朗读文案被写进上游 PrimitiveStringMultiline.value（TTS 的 text 仍是连线），
        // 所以这里按「所有字符串 litereal」收集，验证文案确实被换掉了
        const textNode = nodes.find((n) => n.class_type === 'PrimitiveStringMultiline');
        state.texts.push(tts.inputs?.text !== undefined && typeof tts.inputs.text === 'string'
          ? tts.inputs.text
          : (textNode?.inputs?.value ?? ''));
        const seedNode = nodes.find((n) => 'seed' in (n.inputs || {}));
        state.seeds.push(seedNode?.inputs?.seed ?? null);
        send({ prompt_id: `p${state.prompts}` });
      });
      return;
    }
    const m = url.pathname.match(/^\/history\/(\w+)$/);
    if (m) return send({ [m[1]]: { outputs, status: { status_str: 'success' } } });
    if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(Buffer.alloc(64, 7)); }
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, state, baseUrl: `http://127.0.0.1:${server.address().port}`,
  })));
}

test('drawVoiceCandidates：跑 N 次、说话人按列表轮换、只收音频产物', async () => {
  const { server, state, baseUrl } = await startTtsComfy({
    out: { audio: [{ filename: 'draft.wav', subfolder: '', type: 'output' }], images: [{ filename: 'wave.png', subfolder: '', type: 'output' }] },
  });
  try {
    const cfg = { baseUrl, timeoutMs: 5000, pollIntervalMs: 50 };
    const r = await drawVoiceCandidates(cfg, TTS_WF, {
      count: 3, text: '这是试听文案', voiceValues: ['a', 'b'], language: 'zh-CN', workflowName: 'TTS 抽卡',
    });
    assert.equal(r.draws.length, 3, '每次都产出 1 段音频');
    assert.equal(r.failures.length, 0);
    assert.equal(r.workflowName, 'TTS 抽卡');
    assert.equal(state.prompts, 3, '提交次数 = count');
    assert.deepEqual(state.voices, ['a', 'b', 'a'], '说话人按候选列表轮换');
    assert.ok(state.texts.every((t) => t === '这是试听文案'), '朗读文案每次都注入');
    assert.equal(state.seeds.filter(Boolean).length, 3, '每次换 seed，抽卡才有差异');
    assert.equal(new Set(state.seeds).size, 3, '三次 seed 互不相同');
    assert.ok(r.draws.every((d) => /^\/assets\/.*\.wav$/.test(d.url)), '只收真实音频 url');
    assert.equal(r.draws[0].seed, state.seeds[0], 'draw.seed 记的是真正注入工作流的种子，可据此复现');
    assert.ok(r.draws.every((d) => Number.isFinite(d.seed) && d.seed > 0), '种子必须是真实数字，不是 prompt_id 里凑出的碎片');
    assert.equal(r.draws[0].promptId, 'p1', '同时保留 prompt_id 供回溯');
    assert.equal(r.draws[1].voiceValue, 'b', '候选携带自己的说话人');
  } finally { await closeServer(server); }
});

test('drawVoiceCandidates：工作流只有图片产物 → 每次记失败，候选池为空', async () => {
  const { server, state, baseUrl } = await startTtsComfy({
    out: { images: [{ filename: 'wave.png', subfolder: '', type: 'output' }] },
  });
  try {
    const r = await drawVoiceCandidates({ baseUrl, timeoutMs: 5000, pollIntervalMs: 50 }, TTS_WF, { count: 2, text: 'x' });
    assert.equal(state.prompts, 2, '仍然真的跑了两次，不是提前放弃');
    assert.equal(r.draws.length, 0, '波形图不算抽卡结果');
    assert.equal(r.failures.length, 2);
    assert.match(r.failures[0].error, /SaveAudio/, '错误提示指向缺失的音频输出节点');
  } finally { await closeServer(server); }
});

test('drawVoiceCandidates：count 钳制在 1–8 之间', async () => {
  const { server, state, baseUrl } = await startTtsComfy({
    out: { audio: [{ filename: 'd.wav', subfolder: '', type: 'output' }] },
  });
  try {
    const cfg = { baseUrl, timeoutMs: 5000, pollIntervalMs: 50 };
    await drawVoiceCandidates(cfg, TTS_WF, { count: 99, text: 'x' });
    assert.equal(state.prompts, 8, '上限 8 次，避免一次抽卡把队列塞满');
    const low = await drawVoiceCandidates(cfg, TTS_WF, { count: 0, text: 'x' });
    assert.equal(low.draws.length, 1, 'count=0 按 1 次处理');
  } finally { await closeServer(server); }
});

/* ------------------------------------------------- 工作流三分类与配置概览 */

test('WORKFLOW_KINDS / kindOf：三类工作流归一，非法值回退 image', () => {
  assert.deepEqual(WORKFLOW_KINDS, ['image', 'video', 'audio']);
  assert.equal(kindOf('audio'), 'audio');
  assert.equal(kindOf('video'), 'video');
  assert.equal(kindOf('sound'), 'image', '未知 kind 回退图片（不丢配置）');
  assert.equal(kindOf(undefined), 'image');
  assert.equal(kindOf(null), 'image');
});

test('DEFAULT_COMFY：音频工作流字段齐全，bindings 有 audio 槽位', () => {
  assert.equal(DEFAULT_COMFY.audioWorkflow, null);
  assert.equal(DEFAULT_COMFY.audioWorkflowName, '');
  assert.deepEqual(DEFAULT_COMFY.audioWorkflowLib, []);
  assert.equal(DEFAULT_COMFY.audioActiveId, null);
  assert.deepEqual(DEFAULT_COMFY.bindings.audio, [], '音频绑定独立，不混用图片绑定');
});

test('comfySummary：音频库概览与就绪标记', () => {
  const s = comfySummary({
    ...DEFAULT_COMFY,
    audioWorkflowLib: [{ id: 'a1', name: 'TTS', workflow: TTS_WF, createdAt: 1, lastTest: { ok: true, durationMs: 900, at: 9, error: null } }],
    audioActiveId: 'a1',
    audioWorkflow: TTS_WF,
    audioWorkflowName: 'TTS',
  });
  assert.equal(s.audioWorkflowLib.length, 1);
  assert.deepEqual(Object.keys(s.audioWorkflowLib[0]).sort(), ['createdAt', 'id', 'lastTest', 'name', 'nodes']);
  assert.equal(s.audioWorkflowLib[0].workflow, undefined, '概览不回传工作流本体');
  assert.deepEqual(s.audioWorkflow, { name: 'TTS', nodes: 3 });
  assert.equal(s.videoWorkflowLib.length, 0, '未配置的类别不受影响');
});

test('injectWorkflow：显式数值种子原样使用（抽卡种子真的可复现）', () => {
  const a = describeAudioWorkflow(TTS_WF, { audioText: 'x', voice: 'v', seed: 123456 });
  const b = describeAudioWorkflow(TTS_WF, { audioText: 'x', voice: 'v', seed: 123456 });
  assert.equal(a.seed.value, 123456, '数字种子必须原样落地，不能被混入时间戳');
  assert.equal(b.seed.value, 123456, '同一 seed 两次干跑结果一致 → 真能复现');
  // 字符串锚点（project-shot 那类）仍要随机，否则同一镜头重跑会得到完全相同的画面
  const c = describeAudioWorkflow(TTS_WF, { audioText: 'x', voice: 'v', seed: 'shot-1' });
  const d = describeAudioWorkflow(TTS_WF, { audioText: 'x', voice: 'v', seed: 'shot-1' });
  assert.notEqual(c.seed.value, d.seed.value, '字符串锚点仍应每次随机（抽卡才抽得出差异）');
});

test('候选池与音色库互不干扰：候选不会出现在 loadVoices 里', async () => {
  reset();
  const { loadVoices } = await import('../src/core/voices.mjs');
  addDrafts([rawDraft()]);
  assert.equal(loadDrafts().length, 1);
  assert.equal(loadVoices().some((v) => isDraftId(v.id)), false, '候选绝不混进全局音色库');
});
