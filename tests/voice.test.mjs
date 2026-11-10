/* ============================================================================
 * 角色音色分配：音色库数据层 + 音色分配 Agent（启发式兜底）单元测试。
 * 纯逻辑 + 轻量 I/O（指向临时 DATA_DIR，不污染真实数据）。
 * 运行：npm test（node --test tests/voice.test.mjs）
 * ==========================================================================*/
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 在导入任何业务模块之前，把数据目录指到临时目录，避免触碰真实 data/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxmj-voice-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { normalizeVoice, seedVoices, loadVoices, saveVoices, getVoice, scoreVoiceForCharacter, matchVoice, matchAll, matchAllUnique, DEFAULT_VOICES }
  = await import('../src/core/voices.mjs');
const { normalizeCharacter } = await import('../src/core/characters.mjs');
const { assignVoices } = await import('../src/agents/voice-agent.mjs');

test('normalizeVoice：枚举兜底与数值钳制', () => {
  const v = normalizeVoice({ name: '测试', gender: '不明', ageGroup: '不详', tags: 'a,b，c、d', rate: 5, pitch: -1, language: 'xx' });
  assert.equal(v.gender, '中性');          // 非法性别回退
  assert.equal(v.ageGroup, '青年');        // 非法年龄层回退
  assert.deepEqual(v.tags, ['a', 'b', 'c', 'd']); // 多分隔符解析
  assert.equal(v.rate, 2);                 // 超过上限钳到 2
  assert.equal(v.pitch, 0);               // 小于下限钳到 0
  assert.equal(v.language, 'zh-CN');       // 非法语言回退
  assert.ok(/^vox_/.test(v.id));          // 无 id 时自动生成
  assert.equal(v.sampleText.length <= 200, true);
});

test('normalizeVoice：保留合法 id 与 tts 绑定', () => {
  const v = normalizeVoice({ id: 'vox_abc', name: '甲', tts: { provider: 'minimax', voiceId: 'speaker-1' } });
  assert.equal(v.id, 'vox_abc');
  assert.equal(v.tts.provider, 'minimax');
  assert.equal(v.tts.voiceId, 'speaker-1');
});

test('scoreVoiceForCharacter：性别 / 年龄 / 性格加权', () => {
  const maleYouth = { gender: '男', age: '20岁', personality: '活泼阳光少年', role: '男主' };
  const maleYouthVoice = { gender: '男', ageGroup: '青年', tags: ['活泼', '阳光', '少年'] };
  const femaleVoice = { gender: '女', ageGroup: '青年', tags: ['甜美'] };

  const hit = scoreVoiceForCharacter(maleYouth, maleYouthVoice);
  const miss = scoreVoiceForCharacter(maleYouth, femaleVoice);
  assert.ok(hit.score >= 90, `同性别同年齡同标签应高分，实际 ${hit.score}`);
  assert.ok(miss.score < hit.score, '性别不符应明显低于匹配项');
  assert.ok(hit.reasons.some((r) => r.includes('性别')), '命中理由应包含性别');
  assert.ok(hit.reasons.some((r) => r.includes('性格')), '命中理由应包含性格');
});

test('matchVoice / matchAll：从库中挑最佳，空库返回 null', () => {
  const lib = [
    { id: 'v1', name: '少男', gender: '男', ageGroup: '青年', tags: ['活泼', '少年'] },
    { id: 'v2', name: '老者', gender: '男', ageGroup: '老年', tags: ['智慧'] },
    { id: 'v3', name: '少女', gender: '女', ageGroup: '青年', tags: ['甜美'] },
  ];
  const { voice } = matchVoice({ gender: '男', age: '18岁', personality: '活泼的少年' }, lib);
  assert.equal(voice.id, 'v1');

  const all = matchAll([{ id: 'c1', name: '小明', gender: '男', age: '16岁', personality: '活泼少年' }], lib);
  assert.equal(all[0].voiceId, 'v1');
  assert.equal(all[0].voiceName, '少男');

  const empty = matchAll([{ name: 'x' }], []);
  assert.equal(empty[0].voiceId, null);
});

test('seedVoices：空库播种默认，二次调用不再播种', () => {
  const first = seedVoices();
  assert.equal(first.seeded, true);
  assert.equal(first.voices.length, DEFAULT_VOICES.length);
  const second = seedVoices();
  assert.equal(second.seeded, false);
  assert.equal(loadVoices().length, DEFAULT_VOICES.length);
});

test('saveVoices / getVoice：原子写与按 id 读取', () => {
  const saved = saveVoices([{ name: '自定义A', gender: '女', ageGroup: '中年', tags: ['知性'] }]);
  assert.equal(saved.length, 1);
  const id = saved[0].id;
  const got = getVoice(id);
  assert.ok(got && got.name === '自定义A');
  assert.equal(getVoice('不存在'), null);
});

test('assignVoices：启发式兜底为角色写回音色（无 LLM 配置时）', async () => {
  // 显式重置为完整默认音色库（与测试执行顺序解耦，避免被其它用例的 saveVoices 覆盖）
  const voices = saveVoices(DEFAULT_VOICES);
  const project = { id: 'prj_test', settings: {} };
  const m = {
    characters: [
      { id: 'c1', name: '少年阿杰', gender: '男', age: '17岁', personality: '活泼阳光的少年', role: '男主' },
      { id: 'c2', name: '姐姐小柔', gender: '女', age: '24岁', personality: '温柔甜美', role: '女主' },
    ],
  };
  const result = await assignVoices({ project, m, library: voices });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.applied, 2);
  assert.ok(m.characters[0].voiceId, '少年应分到某音色');
  assert.ok(m.characters[1].voiceId, '少女应分到某音色');
  assert.ok(m.characters[0].voiceName);
  assert.ok(m.characters[0].voiceReason);
  // 性别匹配：男角色不应分到女声（除非库里只有女声，这里默认库男女都有）
  const v0 = voices.find((v) => v.id === m.characters[0].voiceId);
  assert.equal(v0.gender, '男');
});

test('normalizeCharacter：携带 voice 字段且不丢值', () => {
  const c = normalizeCharacter({ name: '角色X', voiceId: 'vox_1', voiceName: '少男', voiceReason: '性别一致', voiceScore: 95 });
  assert.equal(c.voiceId, 'vox_1');
  assert.equal(c.voiceName, '少男');
  assert.equal(c.voiceReason, '性别一致');
  assert.equal(c.voiceScore, 95);
  // 非法 id 被清空
  const c2 = normalizeCharacter({ name: '角色Y', voiceId: '!!bad' });
  assert.equal(c2.voiceId, '');
});

test('matchAllUnique：同一批角色拿到的音色互不重复', () => {
  const lib = [
    { id: 'v1', name: '少男A', gender: '男', ageGroup: '青年', tags: ['活泼', '少年'] },
    { id: 'v2', name: '少男B', gender: '男', ageGroup: '青年', tags: ['热血'] },
    { id: 'v3', name: '少男C', gender: '男', ageGroup: '青年', tags: ['冷静'] },
  ];
  // 三个性别年龄性格几乎一样的角色：matchAll 会全部撞到 v1，matchAllUnique 必须各拿一个
  const chars = [
    { id: 'c1', name: '甲', gender: '男', age: '18岁', personality: '活泼少年' },
    { id: 'c2', name: '乙', gender: '男', age: '18岁', personality: '活泼少年' },
    { id: 'c3', name: '丙', gender: '男', age: '18岁', personality: '活泼少年' },
  ];
  const dup = matchAll(chars, lib).map((a) => a.voiceId);
  assert.equal(new Set(dup).size, 1, 'matchAll 允许重复（保持旧行为）');

  const uniq = matchAllUnique(chars, lib);
  const ids = uniq.map((a) => a.voiceId);
  assert.equal(new Set(ids).size, 3, `唯一匹配应互不重复，实际 ${ids.join(',')}`);
  assert.ok(ids.every(Boolean), '库够大时每个角色都应有音色');

  // 音色不够分：第 4 个角色拿不到（voiceId=null），不能把别人的抢过来
  const over = matchAllUnique([...chars, { id: 'c4', name: '丁', gender: '男', age: '18岁', personality: '活泼少年' }], lib);
  assert.equal(over[3].voiceId, null);
  assert.ok(over[3].reason.includes('用完') || over[3].reason.includes('不重复'), '应提示音色不足');
});

test('matchAllUnique：taken 预占用的音色不参与分配', () => {
  const lib = [
    { id: 'v1', name: '少男', gender: '男', ageGroup: '青年', tags: ['活泼'] },
    { id: 'v2', name: '大叔', gender: '男', ageGroup: '中年', tags: ['沉稳'] },
  ];
  const out = matchAllUnique([{ id: 'c1', name: '甲', gender: '男', age: '18岁', personality: '活泼少年' }], lib, { taken: new Set(['v1']) });
  assert.equal(out[0].voiceId, 'v2', 'v1 已被占用，只能分 v2');
});

test('assignVoices：全量重排时角色间音色不重复', async () => {
  const voices = saveVoices(DEFAULT_VOICES);
  const project = { id: 'prj_test', settings: {} };
  // 四个同性别同年齡角色：库里有 5 个男声（默认库 男6 个），足够一人一个
  const m = {
    characters: [
      { id: 'c1', name: '热血少年', gender: '男', age: '17岁', personality: '活泼阳光热血少年', role: '男主' },
      { id: 'c2', name: '沉稳队长', gender: '男', age: '28岁', personality: '沉稳威严', role: '队长' },
      { id: 'c3', name: '儒雅军师', gender: '男', age: '26岁', personality: '儒雅温和冷静', role: '军师' },
      { id: 'c4', name: '苍老宗主', gender: '男', age: '65岁', personality: '智慧长者', role: '宗主' },
    ],
  };
  const result = await assignVoices({ project, m, library: voices });
  assert.equal(result.applied, 4);
  const ids = m.characters.map((c) => c.voiceId);
  assert.equal(new Set(ids).size, 4, `角色间音色必须互不重复，实际 ${ids.join(',')}`);
  assert.ok(ids.every((id) => voices.some((v) => v.id === id)), '所有 voiceId 必须存在于库里');
});

test('assignVoices：onlyMissing 只补空缺，不动已绑定的角色', async () => {
  const voices = saveVoices(DEFAULT_VOICES);
  const project = { id: 'prj_test', settings: {} };
  const bound = voices.find((v) => v.gender === '男');
  const m = {
    characters: [
      { id: 'c1', name: '已绑定', gender: '男', age: '20岁', personality: '活泼', role: '男主', voiceId: bound.id, voiceName: bound.name, voiceReason: '手动指定' },
      { id: 'c2', name: '没绑定', gender: '男', age: '20岁', personality: '活泼少年', role: '男二' },
    ],
  };
  const result = await assignVoices({ project, m, library: voices, onlyMissing: true });
  assert.equal(result.applied, 1, '只有没绑定的角色被分配');
  assert.equal(m.characters[0].voiceId, bound.id, '已绑定的音色不被覆盖');
  assert.notEqual(m.characters[1].voiceId, bound.id, '新分配不能与已绑定的重复');
  assert.ok(m.characters[1].voiceId, '没绑定的角色应拿到音色');
});
