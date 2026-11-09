/* 角色提取智能体优化 · 单元测试
 * 覆盖：候选边界修正 / 全书扫描 / 证据可回溯 / 片段区间去重 / 梗概预算 /
 *       零 Key 不编造人设且明示来源 / Agent 注册。
 * 运行：node --test tests/character-agent.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-char-agent-test-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { extractCharacters } = await import('../src/core/novel.mjs');
const { buildCharacterPassages, buildExtractVars, EXTRACT_CAP, verifyEvidence } = await import('../src/core/characters.mjs');
const { createProviders } = await import('../src/core/providers.mjs');
const { extractProjectCharacters } = await import('../src/agents/character-agent.mjs');
const { listAgents, getAgent } = await import('../src/agents/index.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FILLER = '雨下了一整夜，青石街上空无一人。'.repeat(200);

test('候选抽取：剥离身份修饰前缀，不把说话动词当成人名', () => {
  const src = '少年阿杰说：“走吧。”林晚笑道：“等等。”沈默问：“去哪？”阿杰点头。';
  const names = extractCharacters(src, 8).map((c) => c.name);
  assert.ok(names.includes('阿杰'), '「少年阿杰说」应归一为「阿杰」');
  assert.ok(names.includes('林晚'));
  assert.ok(names.includes('沈默'));
  assert.ok(!names.some((n) => /[说问答喊叫]/.test(n)), `不该把动词吞进名字：${names.join(',')}`);
  assert.ok(!names.some((n) => /(?:说|道|问|答|笑)$/.test(n)), `不该把动词尾留进名字：${names.join(',')}`);
});

test('候选抽取：全书扫描，长篇中后段的角色也能进候选', () => {
  // 旧实现只取前 60000 字；这里 filler 远超该上限
  const long = `林晚说：“下雨了。”${'雨下了一整夜，青石街上空无一人。'.repeat(5000)}顾长风说：“走吧。”`;
  assert.ok(long.length > 60000);
  const names = extractCharacters(long, 8).map((c) => c.name);
  assert.ok(names.includes('顾长风'), `中后段角色应被召回，实际 ${names.join(',')}`);
});

test('候选抽取：evidence 是能在原著逐字定位的原文句子', () => {
  const src = '雨夜。林晚推门而入，鹅蛋脸、剑眉深目，月白广袖长裙。林晚说：“走吧。”';
  const chars = extractCharacters(src, 4);
  const lin = chars.find((c) => c.name === '林晚');
  assert.ok(lin?.evidence?.length, '描写句里的角色也应带原文证据');
  assert.ok(src.includes(lin.evidence[0].quote), 'quote 必须是原文连续子串');
  const checked = verifyEvidence([lin], src);
  assert.equal(checked.dropped, 0);
  assert.equal(checked.verified, lin.evidence.length);
});

test('片段召回：原文字符区间去重，相邻窗口不再重复占位', () => {
  const src = `${FILLER}林晚说：“走吧。”林晚说：“等等。”${FILLER}`;
  const { fragments } = buildCharacterPassages(src, [{ name: '林晚' }], []);
  const windows = fragments.filter((f) => f.kind === 'window');
  assert.ok(windows.length >= 1 && windows.length <= 2, `窗口数应受控，实际 ${windows.length}`);
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i], b = windows[j];
      const lo = Math.max(a.start, b.start), hi = Math.min(a.start + a.text.length, b.start + b.text.length);
      const ratio = hi > lo ? (hi - lo) / Math.min(a.text.length, b.text.length) : 0;
      assert.ok(ratio <= 0.6, `窗口重叠 ${Math.round(ratio * 100)}% 应被去重`);
    }
  }
  assert.ok(fragments.some((f) => f.text.includes('走吧') || f.text.includes('等等')));
});

test('LLM 输入组装：长篇片段不会把分集梗概挤出预算', () => {
  const text = `林晚说：“下雨了。”${'正文'.repeat(9000)}沈默问：“要伞吗？”`;
  const m = {
    source: { title: '雨夜来信', text },
    episodes: Array.from({ length: 20 }, (_, i) => ({ no: i + 1, title: `第${i + 1}章`, summary: '雨夜来信'.repeat(20) })),
  };
  const vars = buildExtractVars({ name: 'x' }, m, 8);
  assert.ok(vars.novelText.includes('【分集梗概】'), '梗概必须保留在输入里');
  assert.ok(vars.novelText.includes('雨夜来信'));
  assert.ok(vars.novelText.length <= EXTRACT_CAP);
});

test('零 Key Mock：只给可溯源占位、不编造性别年龄、显式打 __mock', async () => {
  const providers = createProviders({ provider: 'mock' });
  const out = await providers.generate('charExtract', {
    candidates: [{ name: '林晚', hits: 2, hint: '林晚推门而入，鹅蛋脸、剑眉深目。' }],
    fragments: [{ text: '林晚推门而入，鹅蛋脸、剑眉深目。', kind: 'window', name: '林晚' }],
    novelText: '【「林晚」原文片段】\n林晚推门而入，鹅蛋脸、剑眉深目。',
  });
  assert.equal(out.__mock, true, 'Mock 抽取必须显式打标');
  assert.equal(out.characters.length, 1);
  const c = out.characters[0];
  assert.equal(c.gender, '', '原文没写性别就不编造');
  assert.equal(c.age, '');
  assert.equal(c.personality, '');
  assert.equal(c.palette.length, 0);
  assert.equal(c.evidence[0].quote, '林晚推门而入，鹅蛋脸、剑眉深目。');
  assert.ok(c.appearance.includes('原著依据'), '外观应来自原文而非模板');
});

test('extractProjectCharacters：零 Key 明示为启发式占位，统计可观测', async () => {
  const text = `${FILLER}林晚推门而入，鹅蛋脸、剑眉深目，月白广袖长裙。${FILLER}林晚说：“走吧。”沈默问：“去哪？”`;
  const project = { id: 'prj_char_agent', name: '验证', settings: {} };
  const m = { source: { title: '雨夜来信', text }, episodes: [{ no: 1, title: '第一章', summary: '雨夜来信' }], characters: [] };
  const r = await extractProjectCharacters({ project, m, mode: 'llm' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'heuristic', '零 Key 占位不能冒充 LLM 成果');
  assert.equal(r.fellBack, false, 'Mock 模式本身不算失败回退');
  assert.ok(r.message.includes('未配置模型'));
  assert.ok(r.stats.candidates > 0 && r.stats.fragments > 0);
  assert.equal(r.stats.dropped, 0, '占位证据应能逐字回溯');
  assert.ok(r.extracted.every((c) => !c.gender && !c.age));
  assert.ok(r.extracted.some((c) => c.evidence?.length));
});

test('extractProjectCharacters：主动启发式 / 无原著两条边界', async () => {
  const project = { id: 'prj_char_edge', name: '验证', settings: {} };
  const m = { source: { title: 't', text: '林晚说：“走吧。”' }, characters: [] };
  const h = await extractProjectCharacters({ project, m, mode: 'heuristic' });
  assert.equal(h.source, 'heuristic');
  assert.ok(h.message.includes('启发式'));

  const empty = await extractProjectCharacters({ project, m: { source: { text: '' }, characters: [] } });
  assert.equal(empty.ok, false);
  assert.ok(empty.error.includes('尚未上传小说'));
});

test('角色提取 Agent 已注册为一等公民', () => {
  const meta = listAgents().find((a) => a.id === 'character-extractor');
  assert.ok(meta, '智能体列表应包含 character-extractor');
  assert.equal(meta.group, '资产');
  assert.ok(meta.description.includes('检索'));
  assert.equal(typeof getAgent('character-extractor')?.run, 'function', '画布节点应能执行该 Agent');
});
