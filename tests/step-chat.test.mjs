/* 工作台分步对话 · 单元测试
 *
 * 覆盖用户诉求「工作台每一步都可以和 Agent 对话修改；所有对话记录保留；
 * 可查看每一步 token 消耗」的三条保证：
 *   1) 会话存储：按步分桶、全量保留、老项目惰性兼容、封顶不失控；
 *   2) 意图 → 真实业务动作：改创作设定 / 分集 / 集标题 / 角色属性 / 成片规格 / 交付物；
 *   3) token 分账：执行（含对话触发的重跑）与对话分开计，合计与占比可解释。
 *
 * 运行：node --test tests/step-chat.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-stepchat-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { buildNovelProject, attachSource } = await import('../src/pipelines/novel-project.mjs');
const { saveProject, loadProject, DATA_DIR } = await import('../src/core/store.mjs');
const {
  ensureManagement, createManagement, stepTokenReport, addChatTokens, STEP_BY_ID,
} = await import('../src/core/project-steps.mjs');
const {
  STEP_CHAT_SCOPE, STEP_CHAT_ACTIONS, ensureStepChats, stepChatOf, appendStepMessage,
  stepChatContext, stepChatHistory, stepChatIndex, classifyStepMessage, replayOfStepChat,
  runStepChat, exportStepChat, stepChatLabel, MAX_MESSAGES_PER_STEP,
} = await import('../src/core/step-chat.mjs');

const NOVEL = Array.from({ length: 6 }, (_, i) => `第${i + 1}章 雨夜\n${'雨水沿着屋檐落下，林晚站在便利店门口，手里握着一封没有署名的信。'.repeat(12)}`).join('\n\n');

/** 建一个已经上传原著、①② 已完成的创作项目 */
function novelProject(name = '分步对话测试') {
  const { project } = buildNovelProject({ name });
  attachSource(project, { text: NOVEL, filename: 'n.txt' });
  attachSource(project, { text: NOVEL, filename: 'n.txt' });   // 幂等：不重复拆集
  saveProject(project);
  return project;
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ---------------------------------------------------------------- 会话存储 */

test('STEP_CHAT_SCOPE 覆盖六步 + 项目级总助理，且每步都有可用动作', () => {
  assert.deepEqual(STEP_CHAT_SCOPE, ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver', 'project']);
  for (const id of STEP_CHAT_SCOPE) {
    const list = STEP_CHAT_ACTIONS[id];
    assert.ok(Array.isArray(list) && list.length >= 3, `${id} 应至少有 3 个快捷动作`);
    for (const a of list) {
      assert.ok(a.id && a.label && a.say, `${id}/${a.id} 需要 id / label / say`);
    }
  }
  // 每一步都必须能「重跑本步」：这是兜底动作，缺了就会出现「说了没反应」
  for (const id of ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver']) {
    assert.ok(STEP_CHAT_ACTIONS[id].some((a) => a.id === 'rerun'), `${id} 缺少 rerun 兜底动作`);
  }
});

test('stepChatLabel：步骤会话显示「第 N 步 · 标题」，项目级显示「项目总助理」', () => {
  for (const def of Object.values(STEP_BY_ID)) {
    assert.equal(stepChatLabel(def.id), `第 ${def.no} 步 · ${def.title}`);
  }
  assert.equal(stepChatLabel('project'), '项目总助理');
});

test('ensureStepChats：老项目惰性补容器；脏数据（数组 / null）被重置而不是崩溃', () => {
  const p = { id: 'p1', name: '老项目', management: createManagement({ kind: 'novel', title: '老项目' }) };
  const m = ensureManagement(p);
  assert.deepEqual(m.stepChats, {});

  m.stepChats = null;
  assert.deepEqual(ensureStepChats(m), {});
  m.stepChats = [];
  assert.deepEqual(ensureStepChats(m), {});
  m.stepChats = { upload: { messages: [] } };
  assert.equal(ensureStepChats(m).upload.messages.length, 0, '已有容器不被覆盖');
});

test('stepChatOf：按步独立分桶，各自有 schema / 时间戳 / token 容器', () => {
  const project = novelProject('分桶');
  const a = stepChatOf(project, 'script');
  const b = stepChatOf(project, 'deliver');
  assert.equal(a.stepId, 'script');
  assert.equal(b.stepId, 'deliver');
  assert.notEqual(a, b);
  assert.equal(a.schema, 1);
  assert.deepEqual(a.tokens, { prompt: 0, completion: 0, total: 0, calls: 0 });
  assert.ok(a.createdAt > 0 && a.updatedAt > 0);
  // 两次取到的是同一个对象（惰性创建的幂等性）
  assert.equal(stepChatOf(project, 'script'), a);
});

test('appendStepMessage：全量保留（不按 300 条截断），token 逐条累加到会话', () => {
  const project = novelProject('保留');
  for (let i = 1; i <= 12; i += 1) {
    appendStepMessage(project, 'script', {
      role: i % 2 ? 'user' : 'assistant',
      text: `第 ${i} 条`,
      tokens: { prompt: 10, completion: 5, total: 15, calls: 1 },
    });
  }
  const chat = stepChatOf(project, 'script');
  assert.equal(chat.messages.length, 12);
  assert.equal(chat.messages[0].seq, 1);
  assert.equal(chat.messages[11].seq, 12);
  assert.equal(chat.tokens.total, 12 * 15);
  assert.equal(chat.tokens.calls, 12);
  assert.equal(chat.messages[1].role, 'assistant');
  // 过长的单条文本会被截断，避免一条脏输入撑爆 JSON
  const rec = appendStepMessage(project, 'script', { role: 'user', text: 'x'.repeat(20000) });
  assert.ok(rec.text.length <= 8000);
});

test('appendStepMessage：超过上限时只丢最旧的，seq 保持连续递增', () => {
  const project = novelProject('封顶');
  const chat = stepChatOf(project, 'deliver');
  const over = MAX_MESSAGES_PER_STEP + 5;
  for (let i = 1; i <= over; i += 1) appendStepMessage(project, 'deliver', { role: 'user', text: `m${i}` });
  assert.equal(chat.messages.length, MAX_MESSAGES_PER_STEP);
  assert.equal(chat.messages[chat.messages.length - 1].seq, over, 'seq 用累计写入条数，不受裁剪影响');
});

test('stepChatHistory 与 stepChatOf.messages 是同一份数据（无副本漂移）', () => {
  const project = novelProject('历史');
  appendStepMessage(project, 'upload', { role: 'user', text: '你好' });
  const hist = stepChatHistory(project, 'upload');
  hist.push({ seq: 99, role: 'user', text: '外部篡改' });
  assert.equal(stepChatOf(project, 'upload').messages.length, 2, '取到的是引用，不是浅拷贝');
});

/* ---------------------------------------------------------------- 意图识别 */

test('classifyStepMessage：upload 步识别创作设定 / 分集参数 / 粘贴原著', () => {
  const bible = classifyStepMessage('upload', '把片名改成《雨夜便利店》，类型悬疑，画风用冷调水墨');
  assert.equal(bible.action, 'bible');
  assert.equal(bible.params.title, '雨夜便利店');
  assert.equal(bible.params.genre, '悬疑');
  assert.equal(bible.params.stylePrompt, '冷调水墨');

  const split = classifyStepMessage('upload', '按 1500 字一集，最多 6 集');
  assert.equal(split.action, 'split');
  assert.deepEqual(split.params, { targetChars: 1500, maxEpisodes: 6 });

  const pasted = classifyStepMessage('upload', '雨'.repeat(200));
  assert.equal(pasted.action, 'source');
  assert.equal(pasted.params.text.length, 200);
});

test('classifyStepMessage：episodes 步识别集标题 / 总集数 / 重拆', () => {
  const quoted = classifyStepMessage('episodes', '把第 2 集改名为「雨夜的来信」');
  assert.equal(quoted.action, 'episode-title');
  assert.equal(quoted.params.no, 2);
  assert.equal(quoted.params.title, '雨夜的来信', '不能把「为」字吃进标题');

  const bare = classifyStepMessage('episodes', '把第 1 集标题改为 雨夜初遇');
  assert.equal(bare.action, 'episode-title');
  assert.equal(bare.params.title, '雨夜初遇');

  const total = classifyStepMessage('episodes', '整部剧做成 8 集');
  assert.equal(total.action, 'total-episodes');
  assert.equal(total.params.totalEpisodes, 8);

  const rerun = classifyStepMessage('episodes', '重新拆一遍分集');
  assert.equal(rerun.action, 'rerun');
});

test('classifyStepMessage：context 步识别角色提取 / 属性修改 / 音色', () => {
  const upsert = classifyStepMessage('context', '把林晚改成：月白长裙、清冷眉眼');
  assert.equal(upsert.action, 'char-upsert');
  assert.equal(upsert.params.name, '林晚');
  assert.ok(upsert.params.detail.includes('月白长裙'));

  // 没有「角色」二字也要能认出来（用户更常说人名）
  const noKeyword = classifyStepMessage('context', '林晚改为 玄色劲装');
  assert.equal(noKeyword.action, 'char-upsert');
  assert.equal(noKeyword.params.name, '林晚');

  assert.equal(classifyStepMessage('context', '从原著里提取角色').action, 'characters');
  assert.equal(classifyStepMessage('context', '给角色分配音色').action, 'voices');
  // 说话的方式别把「改分集」误判成改角色
  assert.notEqual(classifyStepMessage('context', '改成分集方式，每集 800 字').action, 'char-upsert');
});

test('classifyStepMessage：storyboard / deliver 步识别规格、策略与交付物', () => {
  const rt = classifyStepMessage('storyboard', '做成 45 秒短剧，每个片段 3 秒');
  assert.equal(rt.action, 'runtime');
  assert.equal(rt.params.totalSeconds, 45);
  assert.equal(rt.params.clipSeconds, 3);

  const real = classifyStepMessage('deliver', '使用真实 AI 视频模式');
  assert.equal(real.action, 'policy');
  assert.equal(real.params.filmPolicy, 'real');

  const preview = classifyStepMessage('deliver', '使用关键帧预览模式');
  assert.equal(preview.params.filmPolicy, 'preview');

  const del = classifyStepMessage('deliver', '只要导演包，不要成片视频');
  assert.equal(del.action, 'deliverables');
  assert.deepEqual(del.params, { video: false, pack: true });
});

test('classifyStepMessage：通用意图（状态 / token / 帮助）优先于步骤动作', () => {
  assert.equal(classifyStepMessage('script', '这一步现在什么情况？').action, 'status');
  assert.equal(classifyStepMessage('storyboard', '各步 token 花了多少？').action, 'tokens');
  assert.equal(classifyStepMessage('deliver', '能做什么').action, 'help');
});

test('classifyStepMessage：认不出具体动作时兜底 rerun，并标 freeform', () => {
  const r = classifyStepMessage('script', '把气质再压一压，别那么热闹');
  assert.equal(r.action, 'rerun');
  assert.equal(r.freeform, true, '兜底重跑要标 freeform，回复里才能诚实说明「这次只是重跑」');
});

test('replayOfStepChat：每个动作都能给出等价 HTTP 复刻命令', () => {
  for (const action of ['bible', 'split', 'runtime', 'deliverables', 'characters', 'voices', 'rerun', 'pack', 'tokens']) {
    const http = replayOfStepChat('script', action, { no: 1 }, 'prj_x');
    assert.ok(http.method && http.path, `${action} 缺少 method/path`);
    assert.ok(http.path.startsWith('/api/projects/prj_x'), `${action} 路径未带项目 id`);
  }
});

/* ---------------------------------------------------------------- 现状摘要 */

test('stepChatContext：每步摘要包含真实数据，不是模板文案', () => {
  const project = novelProject('摘要');
  const m = ensureManagement(project);
  m.bible.title = '雨夜便利店';
  m.bible.genre = '悬疑';
  m.characters = [{ name: '林晚', voiceId: 'v1' }, { name: '沈默' }];
  saveProject(project);

  const up = stepChatContext(project, 'upload');
  assert.ok(up.lines.some((l) => l.includes('雨夜便利店')));
  assert.ok(up.lines.some((l) => l.includes(`${m.split.targetChars} 字/集`)));
  assert.ok(up.actions.length >= 3);
  assert.ok(up.styleLock && up.styleLock.source, '摘要要带风格锁来源，方便解释「为什么这批图是这个画风」');

  const ctx = stepChatContext(project, 'context');
  assert.ok(ctx.lines.some((l) => l.includes('角色 2 位')));
  assert.ok(ctx.lines.some((l) => l.includes('已配音色 1/2')));

  const proj = stepChatContext(project, 'project');
  assert.ok(proj.lines.some((l) => l.includes('项目「摘要」')));
  assert.equal(proj.def, null);
});

/* ---------------------------------------------------------------- 真实动作 */

test('runStepChat：改创作设定真的写进 bible，并留下 user/assistant 两条记录', async () => {
  const project = novelProject('改设定');
  const m = ensureManagement(project);
  const out = await runStepChat({ project, stepId: 'upload', message: '把片名改成《雨夜便利店》，类型悬疑，画风用冷调水墨' });

  assert.equal(out.ok, true);
  assert.equal(out.action, 'bible');
  assert.equal(out.changed, true);
  assert.equal(m.bible.title, '雨夜便利店');
  assert.equal(m.bible.genre, '悬疑');
  assert.equal(m.bible.stylePrompt, '冷调水墨');
  // 风格串要进角色定妆的风格锁，否则「改画风」只是写了个字段
  assert.equal(out.context.styleLock.source, 'stylePrompt');

  const chat = stepChatOf(project, 'upload');
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].role, 'user');
  assert.equal(chat.messages[1].role, 'assistant');
  assert.equal(chat.messages[1].action, 'bible');
  assert.ok(chat.messages[1].calls.length >= 1, '助手消息要带实际调用记录');
});

test('runStepChat：改分集参数会真的重拆，并把这次运行记成「对话触发」', async () => {
  const project = novelProject('改分集');
  const m = ensureManagement(project);
  const before = m.episodes.length;

  const out = await runStepChat({ project, stepId: 'episodes', message: '按 800 字一集，最多 2 集，重新拆' });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'split');
  assert.ok(out.reran, '改分集参数必须触发第 ② 步重跑');
  assert.equal(out.reran.stepId, 'episodes');
  assert.equal(m.split.targetChars, 800);
  assert.equal(m.split.maxEpisodes, 2);

  const st = m.steps.find((s) => s.id === 'episodes');
  assert.equal(st.status, 'done');
  assert.ok(st.runLog.length >= 1);
  assert.equal(st.runLog[0].action, 'chat', '重跑要记成 chat 触发，才能在面板上与手动执行区分');
  assert.ok(st.runLog[0].trigger.includes('800'), '触发理由要留原话，便于回溯「为什么又跑了一遍」');
  assert.ok(m.episodes.length >= 1 && m.episodes.length <= before + 6);
});

test('runStepChat：改集标题只改该集，不动其他集', async () => {
  const project = novelProject('改标题');
  const m = ensureManagement(project);
  if (!m.episodes.length) return;   // 极端情况下没有分集则跳过
  const otherBefore = m.episodes.slice(1).map((e) => e.title);

  const out = await runStepChat({ project, stepId: 'episodes', message: '把第 1 集改名为「雨夜的来信」' });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'episode-title');
  assert.equal(m.episodes[0].title, '雨夜的来信');
  assert.deepEqual(m.episodes.slice(1).map((e) => e.title), otherBefore);

  // 不存在的集要给明确提示，而不是静默成功
  const miss = await runStepChat({ project, stepId: 'episodes', message: '把第 99 集改名为「无」' });
  assert.equal(miss.ok, false);
  assert.ok(miss.reply.includes('不存在'));
});

test('runStepChat：改角色属性按语义拆分到 costume / staticFeatures', async () => {
  const project = novelProject('改角色');
  const m = ensureManagement(project);
  m.characters = [{ id: 'c1', name: '林晚', role: '女主' }];
  saveProject(project);

  const out = await runStepChat({ project, stepId: 'context', message: '把林晚改成：月白长裙、清冷眉眼' });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'char-upsert');
  const c = m.characters[0];
  assert.equal(c.name, '林晚');
  assert.ok(c.costume.includes('月白长裙'), '衣物类要进 costume');
  assert.ok(c.staticFeatures.includes('清冷眉眼'), '五官类要进 staticFeatures');
  assert.ok(!c.costume.includes('眉眼'), '两栏不能互相污染');
  assert.equal(c.edited, true, '手改过的角色要打 edited，重新提取时不覆盖');
});

test('runStepChat：只有一个角色时可以省略名字；多个角色时明确要求指明', async () => {
  const project = novelProject('省略名字');
  const m = ensureManagement(project);
  m.characters = [{ id: 'c1', name: '林晚' }];
  saveProject(project);
  const ok = await runStepChat({ project, stepId: 'context', message: '改成：青色斗篷' });
  assert.equal(ok.ok, true);
  assert.ok(m.characters[0].costume.includes('青色斗篷'));

  m.characters = [{ id: 'c1', name: '林晚' }, { id: 'c2', name: '沈默' }];
  saveProject(project);
  const ask = await runStepChat({ project, stepId: 'context', message: '改成：黑色长袍' });
  assert.equal(ask.ok, false);
  assert.ok(ask.reply.includes('林晚') && ask.reply.includes('沈默'), '要把候选角色名报给用户');
});

test('runStepChat：改成片规格 / 交付物 / 成片策略都落到项目字段', async () => {
  const project = novelProject('改规格');
  const m = ensureManagement(project);

  const rt = await runStepChat({ project, stepId: 'storyboard', message: '做成 45 秒短剧，每个片段 3 秒' });
  assert.equal(rt.ok, true);
  assert.equal(m.runtime.totalSeconds, 45);
  assert.equal(m.runtime.clipSeconds, 3);
  assert.equal(m.runtime.clipCount, 15);
  assert.ok(rt.reply.includes('时间线'), '回复要给出实际时间线，用户才知道改成什么样了');

  const del = await runStepChat({ project, stepId: 'deliver', message: '只要导演包，不要成片视频' });
  assert.equal(del.ok, true);
  assert.deepEqual(m.deliverables, { video: false, pack: true });

  const pol = await runStepChat({ project, stepId: 'deliver', message: '使用关键帧预览模式' });
  assert.equal(pol.ok, true);
  assert.equal(m.runtime.filmPolicy, 'preview');
  assert.ok(pol.reply.includes('降级'), '切到预览模式必须说清验收会降级');
});

test('runStepChat：读取类意图（状态 / token / 帮助）不改项目，也不写 changed', async () => {
  const project = novelProject('只读');
  const before = JSON.stringify(ensureManagement(project).bible);
  for (const [step, msg] of [['script', '这一步现在什么情况？'], ['project', '各步 token 花了多少？'], ['deliver', '能做什么']]) {
    const out = await runStepChat({ project, stepId: step, message: msg });
    assert.equal(out.ok, true);
    assert.equal(out.changed, false, `${msg} 不应改动项目`);
    assert.ok(out.reply.length > 10);
  }
  assert.equal(JSON.stringify(ensureManagement(project).bible), before);
});

test('runStepChat：空消息与未知步骤直接拒绝，不写脏记录', async () => {
  const project = novelProject('拒绝');
  const empty = await runStepChat({ project, stepId: 'script', message: '   ' });
  assert.equal(empty.ok, false);
  const bad = await runStepChat({ project, stepId: 'nope', message: '你好' });
  assert.equal(bad.ok, false);
  assert.equal(stepChatOf(project, 'script').messages.length, 0);
});

/* ---------------------------------------------------------------- token 分账 */

test('addChatTokens：只累加对话消耗，不碰执行账；对齐四字段', () => {
  const project = novelProject('对话 token');
  const m = ensureManagement(project);
  addChatTokens(m, 'script', { prompt: 100, completion: 40, total: 140, calls: 1 });
  addChatTokens(m, 'script', { prompt: 20, completion: 10, total: 30, calls: 2 });
  const st = m.steps.find((s) => s.id === 'script');
  assert.deepEqual(st.chatTokens, { prompt: 120, completion: 50, total: 170, calls: 3 });
  assert.equal(st.tokens.total, 0, '执行账不被对话污染');
  // 未知步骤静默返回 null，不制造半个对象
  assert.equal(addChatTokens(m, 'nope', { total: 10 }), null);
});

test('stepTokenReport：执行 + 对话 = 合计，占比按合计分摊且总和为 100%', () => {
  const project = novelProject('报表');
  const m = ensureManagement(project);
  const st = m.steps.find((s) => s.id === 'script');
  st.tokens = { prompt: 1000, completion: 400, total: 1400, calls: 6 };
  st.chatTokens = { prompt: 200, completion: 100, total: 300, calls: 2 };
  const ct = m.steps.find((s) => s.id === 'context');
  ct.tokens = { prompt: 300, completion: 100, total: 400, calls: 2 };

  const rep = stepTokenReport(m);
  const script = rep.steps.find((s) => s.id === 'script');
  assert.deepEqual(script.exec, { prompt: 1000, completion: 400, total: 1400, calls: 6 });
  assert.deepEqual(script.chat, { prompt: 200, completion: 100, total: 300, calls: 2 });
  assert.equal(script.sum.total, 1700);
  assert.equal(script.sum.calls, 8);
  assert.equal(rep.total.total, 2100);
  assert.equal(rep.anyUsage, true);
  assert.equal(script.share, Math.round(1700 / 2100 * 100));
  const shareSum = rep.steps.reduce((a, s) => a + s.share, 0);
  assert.ok(shareSum >= 99 && shareSum <= 101, `占比合计应接近 100%，实际 ${shareSum}`);
  // 每步都带运行明细数组，前端直接渲染
  assert.ok(Array.isArray(script.runLog));
});

test('stepTokenReport：零使用时不虚报 anyUsage（避免面板显示「有消耗」）', () => {
  const project = novelProject('零消耗');
  const rep = stepTokenReport(ensureManagement(project));
  assert.equal(rep.anyUsage, false);
  assert.equal(rep.total.total, 0);
  assert.equal(rep.steps.every((s) => s.share === 0 || s.sum.total === 0), true);
});

test('runStepChat：对话触发重跑时，token 记进执行账而不是重复记进对话账', async () => {
  const project = novelProject('分账');
  const m = ensureManagement(project);
  const before = JSON.parse(JSON.stringify(m.steps.find((s) => s.id === 'episodes').tokens));
  await runStepChat({ project, stepId: 'episodes', message: '重新拆一遍分集' });
  const st = m.steps.find((s) => s.id === 'episodes');
  // 零 Key 环境：本地拆集不调 LLM，两本账都不应被凭空加数
  assert.equal(st.chatTokens.total, 0);
  assert.ok(st.tokens.total >= before.total, '执行账只增不减');
  assert.equal(st.tokens.calls, before.calls, '本地拆集不产生 LLM 调用次数');
});

/* ---------------------------------------------------------------- 索引与导出 */

test('stepChatIndex：列出全部步骤的条数 / 最近一句 / token，未聊过的步骤也占位', async () => {
  const project = novelProject('索引');
  await runStepChat({ project, stepId: 'upload', message: '把片名改成《雨夜》' });
  const idx = stepChatIndex(project);
  assert.equal(idx.length, STEP_CHAT_SCOPE.length);
  const up = idx.find((x) => x.stepId === 'upload');
  assert.equal(up.messages, 2);
  assert.ok(up.lastText.includes('创作设定'), '最近一句取助手回复，便于列表里一眼看出结论');
  assert.ok(up.label.includes('第 1 步'));
  const script = idx.find((x) => x.stepId === 'script');
  assert.equal(script.messages, 0);
  assert.equal(script.updatedAt, null);
});

test('exportStepChat(md)：含现状、逐条对话、触发重跑标记与运行明细表', async () => {
  const project = novelProject('导出');
  await runStepChat({ project, stepId: 'episodes', message: '重新拆一遍分集' });
  const md = exportStepChat(project, 'episodes', 'md');
  assert.ok(md.contentType.includes('markdown'));
  assert.ok(md.filename.endsWith('-episodes-chat.md'));
  assert.ok(md.body.includes('# 导出 · 第 2 步'));
  assert.ok(md.body.includes('## 本步现状'));
  assert.ok(md.body.includes('🧑 用户'));
  assert.ok(md.body.includes('🤖 协作助手'));
  assert.ok(md.body.includes('等价 HTTP') || md.body.includes('实际调用'));
  assert.ok(md.body.includes('## 本步运行明细'), '运行明细表要一起导出，token 才可追溯');
});

test('exportStepChat(json)：结构化可重放（messages + tokens + 触发重跑信息）', async () => {
  const project = novelProject('导出 json');
  await runStepChat({ project, stepId: 'deliver', message: '只要导演包，不要成片视频' });
  const out = exportStepChat(project, 'deliver', 'json');
  const data = JSON.parse(out.body);
  assert.equal(data.stepId, 'deliver');
  assert.equal(data.label, '第 6 步 · 视频生成与成片交付');
  assert.ok(Array.isArray(data.messages) && data.messages.length >= 2);
  assert.ok(data.tokens && 'exec' in data.tokens && 'chat' in data.tokens && 'sum' in data.tokens);
  const assistant = data.messages.find((x) => x.role === 'assistant');
  assert.equal(assistant.action, 'deliverables');
  assert.ok(Array.isArray(assistant.calls));
});

/* ---------------------------------------------------------------- 持久化 */

test('对话记录随项目落盘，并同步写一份独立 JSON（换进程后仍能读到）', async () => {
  const project = novelProject('落盘');
  await runStepChat({ project, stepId: 'script', message: '把基调改成更冷峻' });
  const reloaded = loadProject(project.id);
  assert.ok(reloaded, '项目应能被重新读取');
  const chat = stepChatOf(reloaded, 'script');
  assert.ok(chat.messages.length >= 2, '消息要持久化在 management.stepChats 里');

  const file = path.join(DATA_DIR, 'conversations', `${project.id}.step-script.json`);
  assert.ok(fs.existsSync(file), `分享副本未落盘：${file}`);
  const shared = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(shared.projectId, project.id);
  assert.equal(shared.stepId, 'script');
  assert.ok(shared.messages.length >= 2);
  assert.ok(shared.tokens && 'total' in shared.tokens);
});

test('不同步骤的会话互不串台（同一项目下也不串）', async () => {
  const project = novelProject('隔离');
  await runStepChat({ project, stepId: 'upload', message: '把片名改成《只属于上传步》' });
  await runStepChat({ project, stepId: 'context', message: '给角色分配音色' });
  const up = stepChatHistory(project, 'upload').map((m) => m.text).join('\n');
  const ct = stepChatHistory(project, 'context').map((m) => m.text).join('\n');
  assert.ok(up.includes('只属于上传步'));
  assert.ok(!ct.includes('只属于上传步'));
});
