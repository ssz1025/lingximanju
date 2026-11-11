/* ============================================================================
 * 统一 AI 对话线程 · 单元测试
 *
 * 覆盖统一化最容易埋坑的五件事：
 *   1) 档位注册表形状完整（每档都有提示 / 快捷指令 / 功能按钮）；
 *   2) 合并时间线：分步会话 + 制片会话 + 新增档位按时间交织，来源标签正确；
 *   3) 「仅看当前档」筛选正确；
 *   4) **分页游标稳定**：新消息到达后，旧游标仍指向同一条（向上翻历史不重不漏）；
 *   5) 新增档位持久化：落 management.aiScopes + 分享副本，重载项目仍在；
 *   6) 统一派发：按档位回到各自业务函数（制片 17 意图 / 六步 / 封面）。
 *
 * 运行：node --test tests/ai-thread.test.mjs
 * ==========================================================================*/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxmj-ai-thread-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { buildNovelProject, attachSource } = await import('../src/pipelines/novel-project.mjs');
const { saveProject, loadProject, DATA_DIR } = await import('../src/core/store.mjs');
const { ensureManagement } = await import('../src/core/project-steps.mjs');
const {
  AI_SCOPE_IDS, STEP_SCOPE_IDS, NEW_SCOPE_IDS, scopeCatalog, readThread, threadCounts,
  appendAiMessage, commitAiScope, dispatchAiChat, appendClientMessage, threadExport,
  aiScopeOf, encodeCursor, decodeCursor,
} = await import('../src/core/ai-thread.mjs');
const { runStepChat } = await import('../src/core/step-chat.mjs');

const NOVEL = Array.from({ length: 4 }, (_, i) => `第${i + 1}章 雨夜\n${'雨水沿着屋檐落下，林晚站在便利店门口，手里握着一封没有署名的信。'.repeat(10)}`).join('\n\n');

/** 建一个已上传原著、①② 已完成的创作项目 */
function novelProject(name = '统一对话测试') {
  const { project } = buildNovelProject({ name });
  attachSource(project, { text: NOVEL, filename: 'n.txt' });
  saveProject(project);
  return project;
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ---------------------------------------------------------------- 档位注册表 */

test('AI_SCOPE_IDS 覆盖制片助手 + 六步 + 封面/风格/画布，且顺序稳定', () => {
  assert.deepEqual(AI_SCOPE_IDS, [
    'project', 'upload', 'episodes', 'script', 'context', 'storyboard', 'deliver',
    'cover', 'style', 'canvas',
  ]);
  assert.deepEqual(STEP_SCOPE_IDS, ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver']);
  assert.deepEqual(NEW_SCOPE_IDS, ['cover', 'style', 'canvas']);
});

test('scopeCatalog：每档都有标签 / 占位提示 / 现状 / 快捷指令 / 功能按钮 / token 账目', () => {
  const project = novelProject('档位目录');
  const scopes = scopeCatalog(project);
  assert.equal(scopes.length, AI_SCOPE_IDS.length);
  for (const s of scopes) {
    assert.ok(s.id && s.label && s.icon, `${s.id} 需要 id / label / icon`);
    assert.ok(s.placeholder.length > 4, `${s.id} 需要占位提示`);
    assert.ok(s.hint.length > 4, `${s.id} 需要开场提示`);
    assert.ok(Array.isArray(s.context), `${s.id} 需要现状数组`);
    assert.ok(Array.isArray(s.suggestions), `${s.id} 需要快捷指令数组`);
    assert.ok(Array.isArray(s.actions), `${s.id} 需要功能按钮数组`);
    assert.ok(s.tokens && s.tokens.exec && s.tokens.chat && s.tokens.sum,
      `${s.id} 需要 token 账目（执行 / 对话 / 合计三本账）`);
    for (const k of ['exec', 'chat', 'sum']) {
      assert.ok('total' in s.tokens[k], `${s.id} 的 ${k} 账要含 total`);
    }
    for (const a of s.actions) assert.ok(a.id && a.label, `${s.id} 的按钮需要 id / label`);
    for (const g of s.suggestions) assert.ok(g.text, `${s.id} 的建议需要 text`);
  }
});

test('scopeCatalog：不同档位给出不同的提示与按钮（统一面板靠这个切换上下文）', () => {
  const project = novelProject('档位差异');
  const byId = Object.fromEntries(scopeCatalog(project).map((s) => [s.id, s]));
  assert.notEqual(byId.upload.placeholder, byId.script.placeholder, '不同步骤占位提示应不同');
  assert.notEqual(byId.upload.hint, byId.deliver.hint, '不同步骤开场提示应不同');
  assert.ok(byId.script.actions.some((a) => a.say && a.say.includes('剧本')), '剧本档应有剧本相关按钮');
  assert.ok(byId.cover.actions.some((a) => a.act === 'cover.one-click'), '封面档应有「一键生成封面」按钮');
  assert.ok(byId.style.actions.some((a) => a.act === 'style.save'), '风格档应有「保存为导演风格」按钮');
  assert.ok(byId.canvas.actions.some((a) => a.say === '整理画布'), '画布档应有「整理画布」按钮');
  assert.ok(byId.project.actions.some((a) => a.label.includes('跑完六步')), '总览档应有「跑完六步」按钮');
});

test('scopeCatalog：非创作项目里六步与总览档标记为不可用', () => {
  const { project } = buildNovelProject({ name: '标准项目' });
  project.management.kind = 'standard';
  const byId = Object.fromEntries(scopeCatalog(project).map((s) => [s.id, s]));
  assert.equal(byId.script.available, false);
  assert.ok(byId.script.unavailableReason, '不可用档位要说明原因');
  assert.equal(byId.cover.available, true, '封面档与项目类型无关');
});

/* ------------------------------------------------------------ 合并时间线 */

test('readThread：分步会话与制片会话按时间交织，来源标签正确', async () => {
  const project = novelProject('交织');
  // 三个档位各自留一条，时间戳递增 → 合并后按时间交织（而非按档位分组）
  await runStepChat({ project, stepId: 'script', message: '把基调改成更冷峻' });
  const m = ensureManagement(project);
  const base = Date.now();
  m.conversation = {
    schema: 1, startedAt: base, runs: [],
    messages: [{ seq: 1, at: base + 1000, role: 'user', text: '现在做到哪一步了？', intent: 'status' }],
  };
  appendAiMessage(project, 'cover', { role: 'user', text: '水墨风封面' });
  // 封面档的消息时间落在制片会话之后
  const coverRec = m.aiScopes.cover.messages[0];
  coverRec.at = base + 2000;

  const { messages } = readThread(project, { scope: 'all' });
  assert.equal(messages.length, 4, '2 条分步 + 1 条制片 + 1 条封面');
  assert.deepEqual(messages.map((x) => x.scope), ['script', 'script', 'project', 'cover']);
  assert.equal(messages[0].scopeLabel, '第 3 步 · 剧本生成与格式统一');
  assert.equal(messages[2].scopeLabel, '项目总览 · 制片助手');
  assert.equal(messages[3].scopeLabel, '项目封面');
  // 归一化后的消息形状是前端唯一认的一种
  for (const msg of messages) {
    assert.ok(msg.uid && msg.at > 0 && msg.role, '每条消息要有 uid / at / role');
    assert.ok(Array.isArray(msg.suggestions) && Array.isArray(msg.artifacts));
  }
});

test('readThread：「仅看当前档」筛选正确', async () => {
  const project = novelProject('筛选');
  await runStepChat({ project, stepId: 'script', message: '把基调改成更冷峻' });
  appendAiMessage(project, 'style', { role: 'user', text: '赛博朋克风' });

  assert.equal(readThread(project, { scope: 'script' }).messages.length, 2);
  assert.equal(readThread(project, { scope: 'style' }).messages.length, 1);
  assert.equal(readThread(project, { scope: 'cover' }).messages.length, 0);
  assert.equal(readThread(project, { scope: 'all' }).messages.length, 3);
});

test('readThread：同一毫秒内的消息也不错序（复合排序键）', () => {
  const project = novelProject('同毫秒');
  const m = ensureManagement(project);
  const at = Date.now();
  m.conversation = {
    schema: 1, startedAt: at, runs: [],
    messages: [
      { seq: 1, at, role: 'user', text: 'A' },
      { seq: 2, at, role: 'assistant', text: 'B' },
    ],
  };
  m.stepChats = {
    script: { schema: 1, stepId: 'script', messages: [{ seq: 1, at, role: 'user', text: 'C' }], tokens: {}, counter: 1 },
  };
  const { messages } = readThread(project, { scope: 'all' });
  const texts = messages.map((x) => x.text);
  assert.deepEqual(texts, ['C', 'A', 'B'], '按 (at, 桶序, seq) 排：分步桶在前');
});

/* ------------------------------------------------------------ 分页游标 */

test('readThread：向上翻历史用游标分页，不重不漏', () => {
  const project = novelProject('分页');
  for (let i = 1; i <= 25; i += 1) {
    appendAiMessage(project, 'canvas', { role: i % 2 ? 'user' : 'assistant', text: `m${i}` });
  }
  // 消息按时间升序返回（最新的在末尾，前端往下追加、往上翻历史）
  const first = readThread(project, { scope: 'canvas', limit: 10 });
  assert.equal(first.messages.length, 10);
  assert.equal(first.messages[0].text, 'm16', '首页取最新的一段');
  assert.equal(first.messages.at(-1).text, 'm25');
  assert.ok(first.nextCursor && first.hasMore);

  const second = readThread(project, { scope: 'canvas', before: first.nextCursor, limit: 10 });
  assert.equal(second.messages[0].text, 'm6', '第二页接在第一页之前');
  assert.equal(second.messages.at(-1).text, 'm15');

  const third = readThread(project, { scope: 'canvas', before: second.nextCursor, limit: 10 });
  assert.equal(third.messages[0].text, 'm1');
  assert.equal(third.messages.at(-1).text, 'm5');
  assert.equal(third.hasMore, false, '翻到底了');
  assert.equal(third.nextCursor, null);
});

test('readThread：新消息到达后，旧游标仍指向同一条边界', () => {
  const project = novelProject('游标稳定');
  for (let i = 1; i <= 10; i += 1) {
    appendAiMessage(project, 'canvas', { role: 'user', text: `m${i}` });
  }
  const first = readThread(project, { scope: 'canvas', limit: 5 });
  const cursor = first.nextCursor;
  const boundary = first.messages[0].text;
  assert.equal(boundary, 'm6', '首页最旧一条是 m6，游标指向它');

  // 游标语义：返回「比游标更早」的消息。m6 本身已被游标排除在内
  const before = readThread(project, { scope: 'canvas', before: cursor, limit: 5 });
  assert.equal(before.messages[0].text, 'm1');
  assert.equal(before.messages.at(-1).text, 'm5');

  // 新消息只追加到末尾，不应影响旧游标指向的历史
  appendAiMessage(project, 'canvas', { role: 'user', text: 'm11' });
  const after = readThread(project, { scope: 'canvas', before: cursor, limit: 5 });
  assert.deepEqual(after.messages.map((x) => x.text), before.messages.map((x) => x.text),
    '新消息到达后，旧游标翻出的历史完全不变');
  // 新消息出现在最新一页
  const newest = readThread(project, { scope: 'canvas', limit: 5 });
  assert.equal(newest.messages.at(-1).text, 'm11');
});

test('encodeCursor / decodeCursor 互逆，坏游标不炸', () => {
  const key = [1700000000000, 3, 7];
  assert.deepEqual([...decodeCursor(encodeCursor(key))], key);
  assert.equal(decodeCursor('garbage'), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('1|2'), null);
});

/* ------------------------------------------------------------ 持久化 */

test('新增档位消息落 management.aiScopes + 分享副本，重载项目仍在', () => {
  const project = novelProject('落盘');
  appendAiMessage(project, 'cover', { role: 'user', text: '水墨风封面' });
  appendAiMessage(project, 'cover', { role: 'assistant', text: '已写好封面提示词' });
  commitAiScope(project, 'cover');

  const file = path.join(DATA_DIR, 'conversations', `${project.id}.scope-cover.json`);
  assert.ok(fs.existsSync(file), `分享副本未落盘：${file}`);
  const shared = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(shared.projectId, project.id);
  assert.equal(shared.scope, 'cover');
  assert.equal(shared.messages.length, 2);
  assert.equal(shared.messages[0].seq, 1);
  assert.equal(shared.messages[1].seq, 2);
  assert.ok(shared.tokens && 'total' in shared.tokens);

  const reloaded = loadProject(project.id);
  const bucket = aiScopeOf(reloaded, 'cover');
  assert.equal(bucket.messages.length, 2, '重载项目后封面档历史仍在');
  assert.equal(reloaded.management.aiScopes.cover.messages[1].text, '已写好封面提示词');
});

test('aiScopeOf：脏数据被归一而不是崩溃；counter 与 seq 保持连续', () => {
  const project = novelProject('归一');
  const m = ensureManagement(project);
  m.aiScopes = null;
  const b1 = aiScopeOf(project, 'style');
  assert.deepEqual(b1.messages, []);
  assert.equal(b1.schema, 1);
  m.aiScopes.style = { messages: 'not-an-array' };
  const b2 = aiScopeOf(project, 'style');
  assert.ok(Array.isArray(b2.messages));
  for (let i = 1; i <= 3; i += 1) appendAiMessage(project, 'style', { role: 'user', text: `s${i}` });
  assert.equal(aiScopeOf(project, 'style').messages.map((x) => x.seq).join(','), '1,2,3');
});

test('threadCounts：各档位条数与总数正确', () => {
  const project = novelProject('计数');
  appendAiMessage(project, 'canvas', { role: 'user', text: 'a' });
  appendAiMessage(project, 'canvas', { role: 'user', text: 'b' });
  const c = threadCounts(project);
  assert.equal(c.canvas, 2);
  assert.equal(c.cover, 0);
  assert.equal(c.all, 2);
});

/* ------------------------------------------------------------ 派发 */

test('dispatchAiChat：六步档位落到分步会话（走既有业务函数）', async () => {
  const project = novelProject('派发-分步');
  const out = await dispatchAiChat({ project, scope: 'script', message: '把基调改成更冷峻' });
  assert.equal(out.ok, true);
  assert.equal(out.scope, 'script');
  assert.ok(out.appended.length >= 2, '应返回本轮追加的消息');
  assert.equal(out.appended[0].role, 'user');
  assert.equal(out.appended[1].role, 'assistant');
  assert.equal(out.appended[1].scope, 'script');
  // 真实落到了既有的分步会话桶里（老接口照样能读到）
  assert.equal(ensureManagement(project).stepChats.script.messages.length, 2);
  assert.equal(readThread(project, { scope: 'script' }).messages.length, 2);
});

test('dispatchAiChat：总览档落到制片会话（走既有 17 意图业务函数）', async () => {
  const project = novelProject('派发-总览');
  const out = await dispatchAiChat({ project, scope: 'project', message: '现在做到哪一步了？' });
  assert.equal(out.ok, true);
  assert.equal(out.scope, 'project');
  assert.ok(out.appended.length >= 2);
  // 制片会话在旧容器里（老接口不受影响）
  const conv = ensureManagement(project).conversation;
  assert.ok(conv && conv.messages.length >= 2, '制片会话应落在 management.conversation');
  assert.equal(conv.messages[0].intent, 'status');
  // 合并时间线里总览档能读到它们
  const t = readThread(project, { scope: 'project' });
  assert.equal(t.messages.length, conv.messages.length);
});

test('dispatchAiChat：封面档落到新增档位桶，并留下提示词块', async () => {
  const project = novelProject('派发-封面');
  const out = await dispatchAiChat({ project, scope: 'cover', message: '水墨风、留白多' });
  assert.equal(out.ok, true);
  const bucket = aiScopeOf(project, 'cover');
  assert.ok(bucket.messages.length >= 2, '封面档要有问有答');
  assert.equal(bucket.messages[0].role, 'user');
  const reply = bucket.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.ok(reply.promptBlock && reply.promptBlock.prompt, '封面回复要带提示词块');
});

test('dispatchAiChat：风格档的草稿随会话留存，关窗再打开不丢', async () => {
  const project = novelProject('派发-风格');
  const out = await dispatchAiChat({ project, scope: 'style', message: '赛博朋克霓虹都市，冷蓝与洋红' });
  assert.equal(out.ok, true);
  const bucket = aiScopeOf(project, 'style');
  assert.ok(bucket.messages.length >= 2);
  assert.ok(bucket.state.draft, '草稿要存在会话状态里');
  assert.ok(Array.isArray(bucket.state.missing));
  // 档位目录据此显示「草稿进行中」
  const s = scopeCatalog(project).find((x) => x.id === 'style');
  assert.ok(s.context.join('').includes('草稿进行中'));
});

test('dispatchAiChat：画布档落到新增档位桶', async () => {
  const project = novelProject('派发-画布');
  const out = await dispatchAiChat({ project, scope: 'canvas', message: '项目进度' });
  assert.equal(out.ok, true);
  const bucket = aiScopeOf(project, 'canvas');
  assert.equal(bucket.messages.length, 2);
  assert.equal(bucket.messages[0].role, 'user');
  assert.ok(bucket.messages[1].text.length > 0, '画布 Agent 要有回复');
});

test('dispatchAiChat：空消息 / 未知档位 / 非创作项目都拒绝，不写脏记录', async () => {
  const project = novelProject('拒绝');
  const empty = await dispatchAiChat({ project, scope: 'script', message: '   ' });
  assert.equal(empty.ok, false);
  const bad = await dispatchAiChat({ project, scope: 'nope', message: '你好' });
  assert.equal(bad.ok, false);
  assert.equal(aiScopeOf(project, 'script').messages.length, 0);

  const std = buildNovelProject({ name: '标准' }).project;
  std.management.kind = 'standard';
  const r = await dispatchAiChat({ project: std, scope: 'script', message: '你好' });
  assert.equal(r.ok, false);
});

test('appendClientMessage：客户端动作回写进同一条线程', () => {
  const project = novelProject('回写');
  const out = appendClientMessage(project, 'cover', {
    role: 'assistant', text: '✓ 封面已生成', images: ['/assets/cover.png'],
  });
  assert.equal(out.ok, true);
  assert.equal(out.message.scope, 'cover');
  assert.deepEqual(out.message.images, ['/assets/cover.png']);
  const t = readThread(project, { scope: 'cover' });
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].text, '✓ 封面已生成');
});

/* ------------------------------------------------------------ 导出 */

test('threadExport：Markdown 含全部档位与等价复刻命令', async () => {
  const project = novelProject('导出');
  await dispatchAiChat({ project, scope: 'script', message: '把基调改成更冷峻' });
  appendAiMessage(project, 'style', { role: 'user', text: '赛博朋克风' });

  const md = threadExport(project, 'md');
  assert.match(md.contentType, /markdown/);
  assert.match(md.body, /统一 AI 对话记录/);
  assert.match(md.body, /剧本生成与格式统一/, '应含步骤档位标签');
  assert.match(md.body, /导演风格设计/, '应含风格档位标签');
  assert.match(md.body, /一键复刻命令串/);
  assert.match(md.body, /curl -s -X POST/, '应含等价复刻命令');
  assert.match(md.body, /环境要求与诚实化说明/);

  const json = threadExport(project, 'json');
  assert.match(json.contentType, /json/);
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.projectId, project.id);
  assert.ok(parsed.messages.length >= 3);
  assert.ok(parsed.scopes.some((s) => s.id === 'style'));
  assert.ok(parsed.messages.some((m) => m.curl), '用户消息要带可重放的 curl');
});
