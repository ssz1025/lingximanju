/* 导演风格统一管理 · 单元测试（自定义风格持久化 + AI 对话生成 + 路由）
 * 运行：node --test tests/director-style-store.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-style-store-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const store = await import('../src/core/director-style-store.mjs');
const skillsMod = await import('../src/core/director-skills.mjs');
const stylesMod = await import('../src/core/director-styles.mjs');
const providersMod = await import('../src/core/providers.mjs');
const routeMod = await import('../src/api/routes/director-styles.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const GOOD_STYLE = {
  label: '雨夜霓虹 · 测试导演',
  director: '测试导演',
  workTitle: '雨夜霓虹',
  icon: '🌃',
  tagline: '都市暧昧测试',
  summary: '测试用风格档案',
  tone: '暧昧压抑',
  palettes: [
    { key: 'neon-red', name: '霓虹红', hex: '#C81D25', mood: '炽烈' },
    { key: 'ink', name: '墨黑', hex: '#12100F', mood: '隐忍' },
  ],
  defaultPalette: 'neon-red',
  light: '单一实用光源',
  composition: '框架构图',
  camera: '手持微晃',
  stylePrompt: '都市暧昧电影感，霓虹红主色调，胶片颗粒',
  negativePrompt: 'flat lighting, plastic skin',
  highlights: ['霓虹红', '手持'],
  pace: { minShotSec: 3, maxShotSec: 6, fixedShotRatio: 0.3, mode: 'fragment' },
};

/** 驱动 handleDirectorStyles：返回 { status, body }（不匹配时返回 null） */
async function run(method, pathname, body) {
  const res = {
    setHeader() {}, statusCode: 0,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = routeMod.handleDirectorStyles(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  const handled = await p;
  if (!handled) return null;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test('normalizeCustomStyle：必填校验 / id 冲突加后缀 / svg 由调色板推导', () => {
  assert.throws(() => store.normalizeCustomStyle({ palettes: GOOD_STYLE.palettes, stylePrompt: 'x' }), /label|风格名称/);
  assert.throws(() => store.normalizeCustomStyle({ label: 'X', stylePrompt: 'x' }), /palettes|主色调/);
  assert.throws(() => store.normalizeCustomStyle({ label: 'X', palettes: GOOD_STYLE.palettes }), /stylePrompt/);
  assert.throws(() => store.normalizeCustomStyle({ label: 'X', stylePrompt: 'x', palettes: [{ hex: 'red' }] }), /hex/);

  const s1 = store.normalizeCustomStyle({ ...GOOD_STYLE, id: 'zhangyimou' }, {});
  assert.notEqual(s1.id, 'zhangyimou', '自定义 id 不得与内置冲突');
  assert.equal(s1.icon, '🌃');
  assert.equal(s1.defaultPalette, 'neon-red');
  assert.equal(s1.custom, true);
  // svg 缺省时从主色推导（sky 三层 / ground / fog / accent / text 全为合法 hex）
  for (const c of s1.svg.sky) assert.match(c, /^#[0-9a-fA-F]{6}$/);
  assert.match(s1.svg.ground, /^#[0-9a-fA-F]{6}$/);
  assert.equal(s1.svg.accent, '#C81D25');
  // pace 越界收敛：max 不得小于 min
  const s2 = store.normalizeCustomStyle({ ...GOOD_STYLE, pace: { minShotSec: 9, maxShotSec: 2 } }, {});
  assert.ok(s2.pace.maxShotSec >= s2.pace.minShotSec);
});

test('save / list / delete：落盘重载后仍在，技能索引同步重建', async () => {
  const before = skillsMod.listDirectorSkills().length;
  const { style, created } = store.saveCustomStyle(GOOD_STYLE);
  assert.equal(created, true);
  assert.equal(store.listCustomStyles().length, 1);

  // 注册表生效：getDirectorStyle / normalizeStyleId 都能命中自定义 id
  assert.equal(stylesMod.normalizeStyleId(style.id), style.id);
  assert.equal(stylesMod.getDirectorStyle(style.id)?.label, style.label);
  // 技能清单 +1 且出现在 style 组
  const after = skillsMod.listDirectorSkills();
  assert.equal(after.length, before + 1);
  const skill = after.find((x) => x.id === style.id);
  assert.equal(skill.group, 'style');
  assert.equal(skill.custom, true);

  // 项目可直接解析出美学（resolveProjectAesthetic 的入口 getDirectorStyle → resolveAesthetic）
  const aesthetic = stylesMod.resolveAesthetic(style.id, {});
  assert.equal(aesthetic.id, style.id);
  assert.equal(aesthetic.paletteHex, '#C81D25');

  // 落盘 → 模拟重启（重新从文件加载）
  const FILE = path.join(TMP, 'director-styles.json');
  assert.ok(fs.existsSync(FILE));
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.schema, 1);
  assert.equal(raw.styles.length, 1);

  // 更新（同 id upsert）
  const upd = store.saveCustomStyle({ ...GOOD_STYLE, id: style.id, tagline: '更新后' });
  assert.equal(upd.created, false);
  assert.equal(upd.style.tagline, '更新后');
  assert.equal(store.listCustomStyles().length, 1);

  // 删除 → 技能清单回落
  const removed = store.deleteCustomStyle(style.id);
  assert.equal(removed.id, style.id);
  assert.equal(store.listCustomStyles().length, 0);
  assert.equal(skillsMod.listDirectorSkills().length, before);
  assert.equal(store.deleteCustomStyle(style.id), null, '重复删除返回 null');
});

test('POST/GET/DELETE /api/director-styles：清单含自定义、保存、内置不可删', async () => {
  const root0 = await run('GET', '/api/director-styles');
  assert.equal(root0.status, 200);
  assert.equal(root0.body.ok, true);
  const baseCount = root0.body.styles.length;
  assert.equal(baseCount, 10, '初始只有内置十位');
  assert.ok(root0.body.styles.every((x) => !x.custom));

  const saved = await run('POST', '/api/director-styles', { style: GOOD_STYLE });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.created, true);
  const sid = saved.body.style.id;

  const list1 = await run('GET', '/api/director-styles');
  assert.equal(list1.body.styles.length, baseCount + 1);
  assert.equal(list1.body.customs.length, 1);
  assert.equal(list1.body.styles.find((x) => x.id === sid).custom, true);

  // 详情：内置与自定义都可查
  const detail = await run('GET', `/api/director-styles/${sid}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.style.custom, true);
  const builtin = await run('GET', '/api/director-styles/zhangyimou');
  assert.equal(builtin.body.style.id, 'zhangyimou');

  // 非法风格 → 400
  const bad = await run('POST', '/api/director-styles', { style: { label: '' } });
  assert.equal(bad.status, 400);

  // 内置不可删；自定义可删
  const delBuiltin = await run('DELETE', '/api/director-styles/zhangyimou');
  assert.equal(delBuiltin.status, 404);
  const del = await run('DELETE', `/api/director-styles/${sid}`);
  assert.equal(del.status, 200);
  const list2 = await run('GET', '/api/director-styles');
  assert.equal(list2.body.styles.length, baseCount);
});

test('POST /api/director-styles/chat：零 Key 确定性生成，两轮收齐后 ready', async () => {
  const r1 = await run('POST', '/api/director-styles/chat', {
    messages: [{ role: 'user', content: '我想要《雨夜霓虹》风格，暗红和墨黑，节奏偏慢' }],
  });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.reply);
  assert.ok(r1.body.draft);
  assert.ok(['llm', 'template'].includes(r1.body.source), `source=${r1.body.source}`);

  // mock 路径下草稿一定含模板补齐的关键字段；真实 LLM 也必须能被保存口径接受
  const draft = r1.body.draft;
  assert.ok(draft.label || draft.tone || (draft.palettes || []).length, '草稿至少收集到一项');

  const r2 = await run('POST', '/api/director-styles/chat', {
    messages: [
      { role: 'user', content: '我想要《雨夜霓虹》风格，暗红和墨黑' },
      { role: 'assistant', content: '…' },
      { role: 'user', content: '基调暧昧压抑，光线用霓虹实用光源，构图框架构图，运镜手持微晃' },
    ],
    draft,
  });
  assert.equal(r2.status, 200);
  // ready 与 missing 自洽
  assert.equal(r2.body.ready, r2.body.missing.length === 0);
  // ready 后草稿可直接过保存校验（与「保存为导演风格」同一链路）
  if (r2.body.ready) {
    const st = store.normalizeCustomStyle(r2.body.draft, {});
    assert.equal(st.custom, true);
  }
});

test('providers mock styleForge：颜色词 / 命名 / 节奏线索都能收进草稿', async () => {
  const p = providersMod.createProviders({});
  assert.equal(p.mode, 'mock');
  const out = await p.generate('styleForge', {
    history: [{ role: 'user', content: '命名《寒山雪》，黑白灰，节奏快，致敬黑泽明' }],
    draft: {},
    existing: ['大风国色 · 张艺谋'],
  });
  assert.ok(out.draft.label, '命名线索应进草稿');
  assert.ok((out.draft.palettes || []).length >= 1, '颜色词应转成主色调');
  assert.ok(out.draft.stylePrompt, '零 Key 模板必须补齐正向提示词');
  assert.equal(typeof out.ready, 'boolean');
  assert.ok(Array.isArray(out.suggestions) && out.suggestions.length, '应给出下一步建议');
});
