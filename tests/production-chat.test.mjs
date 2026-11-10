/* 项目级制片对话（production-chat）· 单元测试
 *
 * 分工：step-chat 挂在六步上改「这一步」的事；production-chat 是一个跨步的
 * 自由会话，并用「等价 curl 命令」把整段流程变成他人可复刻的记录。
 *
 * 运行：node --test tests/production-chat.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-prod-chat-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { saveProject, loadProject } = await import('../src/core/store.mjs');
const { classify, replayOf, curlOf, runProductionChat, chatHistory, exportChat, CHAT_STEPS } =
  await import('../src/core/production-chat.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const project = buildNovelProject({ name: '制片对话测试' }).project;
saveProject(project);

test('意图清单完整：覆盖从准备小说到导出复刻记录的全流程', () => {
  const ids = CHAT_STEPS.map((s) => s.id);
  for (const id of ['status', 'novel', 'bible', 'runtime', 'policy', 'comfy', 'skill',
    'characters', 'voices', 'step', 'steps', 'director', 'verify', 'pack', 'film', 'export']) {
    assert.ok(ids.includes(id), `缺指令 ${id}`);
    const def = CHAT_STEPS.find((s) => s.id === id);
    assert.ok(def.say, `${id} 要带示范语`);
  }
});

test('classify：中文自然语言 → 意图与参数', () => {
  assert.deepEqual(classify('做成 30 秒短剧，每个片段 3 秒'), { id: 'runtime', params: { totalSeconds: 30, clipSeconds: 3 } });
  assert.deepEqual(classify('每个片段 5 秒'), { id: 'runtime', params: { clipSeconds: 5 } });
  assert.equal(classify('使用真实 AI 视频模式').id, 'policy');
  assert.equal(classify('使用真实 AI 视频模式').params.filmPolicy, 'real');
  assert.equal(classify('关键帧预览模式').params.filmPolicy, 'preview');
  assert.equal(classify('检查 ComfyUI 连接和工作流').id, 'comfy');
  assert.equal(classify('一键完成最终产物全流程').id, 'director');
  assert.equal(classify('依次跑完全部六个步骤').id, 'steps');
  assert.equal(classify('执行第 3 步：剧本生成').params.stepId, 'script');
  assert.equal(classify('选择全流程导演技能').params.skillId, 'full');
  assert.equal(classify('选择交接包导演技能').params.skillId, 'pack');
  assert.equal(classify('给出最终产物验收报告').id, 'verify');
  assert.equal(classify('现在做到哪一步了？').id, 'status');
  assert.equal(classify('导出完整对话记录').id, 'export');
  const novel = classify('根据「雨夜便利店的相遇」生成小说');
  assert.equal(novel.id, 'novel');
  assert.equal(novel.params.idea, '雨夜便利店的相遇');
});

test('replayOf / curlOf：每个意图都给出等价 HTTP 请求与 curl', () => {
  for (const intent of ['status', 'verify', 'runtime', 'skill', 'director', 'pack', 'film', 'export']) {
    const http = replayOf(intent, {}, project.id);
    assert.ok(http.path && http.method, `${intent} 要有等价请求`);
    if (['runtime', 'skill', 'director'].includes(intent)) {
      assert.ok(http.body !== undefined, `${intent} 是写操作应带 body`);
    }
  }
  const curl = curlOf(replayOf('runtime', { totalSeconds: 30, clipSeconds: 3 }, project.id), 'http://127.0.0.1:4599');
  assert.match(curl, /^curl -s -X POST 'http:\/\/127\.0\.0\.1:4599\/api\/projects\//);
  assert.match(curl, /totalSeconds/);
});

test('runProductionChat · 短意图：状态查询即时返回并写进会话记录', async () => {
  const out = await runProductionChat({ project, message: '现在做到哪一步了？' });
  assert.equal(out.ok, true);
  assert.equal(out.pending, false);
  assert.equal(out.intent, 'status');
  assert.match(out.reply, /项目「|六步进度|成片规格/);
  const msgs = chatHistory(project);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.ok(msgs[1].calls.some((c) => c.curl), '助手消息要带 curl 复刻命令');
  assert.ok(out.suggestions.length >= 2, '要给下一步建议');
});

test('runProductionChat · 规格指令真实落库 management.runtime', async () => {
  const out = await runProductionChat({ project, message: '做成 30 秒短剧，每个片段 3 秒' });
  assert.equal(out.ok, true);
  const spec = project.management.runtime;
  assert.equal(spec.totalSeconds, 30);
  assert.equal(spec.clipSeconds, 3);
  assert.equal(spec.clipCount, 10);
  assert.match(out.reply, /时间线/);
});

test('runProductionChat · 策略与技能指令真实生效', async () => {
  const p1 = await runProductionChat({ project, message: '使用关键帧预览模式' });
  assert.equal(p1.ok, true);
  assert.equal(project.management.runtime.filmPolicy, 'preview');
  const p2 = await runProductionChat({ project, message: '选择交接包导演技能' });
  assert.equal(p2.ok, true);
  assert.equal(project.management.director.skillId, 'pack');
  assert.match(p2.reply, /交接包导演|计划步骤/);
  // 切回全流程，后续用例依赖
  await runProductionChat({ project, message: '选择全流程导演技能' });
});

test('runProductionChat · 验收报告如实披露（零 ComfyUI 时不得冒充真实成片）', async () => {
  const out = await runProductionChat({ project, message: '给出最终产物验收报告' });
  assert.equal(out.ok, true);
  assert.match(out.reply, /原著|验收|✗|△|✓/);
  // 空项目验收必须指出缺失项
  assert.ok(/missing|缺失|尚未/.test(out.reply) || out.state.verification.missing > 0 || out.state.verification.passed < out.state.verification.items?.length,
    '空项目不应全绿');
});

test('runProductionChat · 长意图转后台任务，重复触发被拒', async () => {
  const first = await runProductionChat({ project, message: '根据「雨夜便利店的相遇」生成小说' });
  assert.equal(first.ok, true);
  assert.equal(first.pending, true, 'novel 是长意图应转后台任务');
  assert.ok(first.taskId);
  // 同一时刻第二条长意图被拒
  const second = await runProductionChat({ project, message: '一键完成最终产物全流程' });
  assert.equal(second.ok, false);
  assert.match(second.error, /长任务/);
  // 等后台任务完成（mock 生成小说很快）
  for (let i = 0; i < 100 && first.pending; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const hist = chatHistory(loadProject(project.id));
    const last = hist[hist.length - 1];
    if (last?.role === 'assistant' && /✓|✗/.test(last.text)) first.pending = false;
  }
  const fresh = loadProject(project.id);
  const hist = chatHistory(fresh);
  const done = hist.filter((m) => m.intent === 'novel' && m.role === 'assistant' && /✓|✗/.test(m.text));
  assert.ok(done.length >= 1, '后台任务完成后应把结果写回对话记录');
  assert.ok(fresh.management.source?.text, '演示小说应真实写进项目');
}, { timeout: 20000 });

test('exportChat：Markdown 含对话全文 + 一键复刻命令串，JSON 可重放', async () => {
  const md = exportChat(project, 'md');
  assert.equal(md.contentType, 'text/markdown; charset=utf-8');
  assert.match(md.body, /复刻记录/);
  assert.match(md.body, /完整对话流程/);
  assert.match(md.body, /一键复刻命令串/);
  assert.match(md.body, /curl -s -X POST/);
  assert.match(md.body, /环境要求|诚实化/);
  const json = exportChat(project, 'json');
  const parsed = JSON.parse(json.body);
  assert.ok(parsed.projectId === project.id);
  assert.ok(Array.isArray(parsed.steps) && parsed.steps.length >= 6);
  assert.ok(parsed.steps.every((s) => s.role && s.text !== undefined));
  assert.ok(parsed.steps.some((s) => s.curl), '至少一条带 curl');
});
