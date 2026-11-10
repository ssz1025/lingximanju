/* 导演 Agent 一键全流程 · 端到端测试（真实编排，不走 HTTP）
 *
 * 从「只有项目名、没有原著」的骨架项目出发，验证导演智能体真的把最终产物跑出来：
 *   自动生成演示原著 → 能力（阐述 / 角色 / 音色）→ 六步制作链 → 导演包 → 逐项验收。
 * 再验证换技能（交接包 / 视觉一致性）会真实改变交付设置与打包结果，以及缺原著时诚实阻断。
 *
 * 运行：node --test tests/director-run.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-director-run-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { runDirector } = await import('../src/agents/director-agent.mjs');
const { saveProject, ASSET_DIR } = await import('../src/core/store.mjs');
const { stepProgress } = await import('../src/core/project-steps.mjs');
const { verifyDirectorDeliverables, planDirectorRun } = await import('../src/core/director-skills.mjs');
const { executeSteps } = await import('../src/core/step-runner.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const finalOf = (p) => p.nodes.find((n) => n.type === 'final');
let shared = null;

test('全流程导演：从空项目一键跑到最终产物，验收清单逐一落地', async () => {
  const { project } = buildNovelProject({ name: '雨夜来信 · 导演全流程验收' });
  // 本机没有 ComfyUI，显式选择「关键帧预览」策略：这是唯一允许走通流程的模式。
  // 默认的 real 策略下零 Key 环境必须判缺失，那段行为由 film-policy.test.mjs 单测覆盖。
  project.management.runtime.filmPolicy = 'preview';
  // 同 filmPolicy：零 Key 环境只能产出 mock 分镜图，测试夹具显式放行，
  // 让「流程能否跑通」与「真实出图口径」两件事各自被独立验证。
  project.testFlags = { allowMockArtifacts: true };
  saveProject(project);
  const r = await runDirector({
    project, skillId: 'full',
    idea: '退役刑警在雨夜收到一封十年前的信，揭开一桩被遗忘的旧案',
  });

  assert.equal(r.ok, true, `${r.error || ''} / ${r.message || ''}`);
  assert.equal(r.skillId, 'full');
  assert.equal(r.complete, true, r.summary);
  assert.equal(r.missing, 0);
  assert.equal(r.degraded, 2,
    '预览策略下「成片」与「ComfyUI 真实片段」两项如实降级，不冒充真实 AI 视频');
  assert.equal(r.source.source, 'mock', '零 Key 生成的演示小说必须标注模板来源');
  assert.ok(r.source.chapters >= 2 && r.source.episodes >= 1);

  // 能力确实执行并写回项目
  const cap = Object.fromEntries((r.capabilities || []).map((c) => [c.id, c]));
  assert.equal(cap.treatment.status, 'ran');
  assert.equal(cap.treatment.source, 'heuristic', '零 Key 的导演阐述不能冒充 LLM');
  assert.equal(cap.characters.status, 'ran');
  assert.ok(project.management.director.treatment.continuityRules.length >= 3);
  assert.ok((project.management.characters || []).length > 0, '角色库应有内容');
  assert.ok((project.management.characters || []).some((c) => c.voiceId),
    '音色能力应写回 voiceId（首次使用自动播种默认音色库）');
  assert.equal(cap.voices.status, 'ran', JSON.stringify(cap.voices));

  // 六步状态机与画布产物
  const prog = stepProgress(project.management);
  assert.equal(prog.allDone, true, JSON.stringify(prog));
  assert.equal(r.steps.length, 4, '①② 在注入原著时已由服务端完成，只需跑智能体四步');
  assert.ok(r.steps.every((s) => s.status === 'done'));
  assert.ok(project.nodes.filter((n) => n.type === 'shot').length > 0, '分镜链应生成镜头节点');
  assert.ok(project.nodes.filter((n) => n.type === 'keyframe').length > 0, '应生成关键帧');
  assert.ok(project.nodes.filter((n) => n.type === 'video').length > 0, '应生成视频片段节点');

  // 短剧时长规格：30s / 每片段 3s → 精确 10 个片段
  const spec = project.management.runtime;
  assert.equal(spec.clipSeconds, 3);
  assert.equal(spec.clipCount, 10);
  assert.equal(spec.totalSeconds, 30);
  const videos = project.nodes.filter((n) => n.type === 'video');
  assert.equal(videos.length, 10, '片段数必须精确等于 clipCount');
  assert.ok(videos.every((n) => Number(n.data.duration) === 3), '每个片段都必须严格 3s');
  assert.equal(finalOf(project).data.timeline.length, 10);
  assert.equal(finalOf(project).data.duration, 30, '时间线总时长必须是 30s');
  assert.equal(r.checklist.find((i) => i.id === 'runtime').level, 'ok', '时长规格应通过验收');

  // 最终产物：导演包真实落盘 + 真实可播放成片（如实标注为关键帧预览）
  const pack = finalOf(project).data.directorPack;
  assert.ok(pack?.file, '导演包未生成');
  assert.ok(pack.fileCount > 10, `导演包文件数异常：${pack.fileCount}`);
  assert.equal(pack.shotCount, 10, '导演包镜头组数必须与片段数一致');
  assert.ok(fs.existsSync(path.join(ASSET_DIR, pack.file)), '导演包文件不在资产目录');
  assert.equal(r.checklist.find((i) => i.id === 'pack').level, 'ok');
  // 导演包内 timeline.json 与成片规格同源：10 段 × 3s，24fps → 720 帧
  const unzip = spawnSync('unzip', ['-p', path.join(ASSET_DIR, pack.file), 'timeline.json'], { encoding: 'utf8' });
  if (!unzip.error && unzip.status === 0) {
    const packTimeline = JSON.parse(unzip.stdout);
    assert.equal(packTimeline.segments.length, 10, '导演包时间线应有 10 段');
    assert.ok(packTimeline.segments.every((s) => s.durationSec === 3), '每段必须是 3s');
    assert.equal(packTimeline.frameRate, 24);
    assert.equal(packTimeline.totalFrames, 720, '总帧数必须是 10 × 72');
  }
  const film = finalOf(project).data.film;
  assert.ok(film?.file, '应产出可播放的 MP4');
  assert.equal(film.source, 'preview-frames', '必须诚实标注这不是 AI 生成视频');
  assert.equal(film.measured, true, '应使用 ffprobe 实测成片时长');
  assert.equal(film.duration, 30, 'ffprobe 实测时长必须是 30s');
  assert.equal(film.clips, 10);
  assert.ok(fs.existsSync(path.join(ASSET_DIR, film.file)), '成片文件不在资产目录');
  // 预览策略：成片项降级（不冒充真实 AI 视频），但时长规格这一硬指标必须 ok
  assert.equal(r.checklist.find((i) => i.id === 'film').level, 'degraded',
    '预览成片只能判降级，不能判达成');
  assert.equal(verifyDirectorDeliverables(project, 'full').degraded, 2);

  // 运行报告随项目持久化，刷新后仍可查
  assert.equal(project.management.director.lastRun.skillId, 'full');
  assert.equal(project.management.director.lastRun.complete, true);
  assert.equal(verifyDirectorDeliverables(project, 'full').complete, true);
  shared = project;
});

test('交接包导演：换技能同步交付设置，验收不再要求成片视频', async () => {
  assert.ok(shared, '依赖上一测试的项目');
  const r = await runDirector({ project: shared, skillId: 'pack' });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(shared.management.deliverables, { video: false, pack: true });
  assert.equal(shared.management.director.skillId, 'pack');
  assert.ok(!r.checklist.some((i) => i.id === 'film'), '只出导演包时不该列成片验收项');
  assert.equal(r.missing, 0);
  assert.equal(r.degraded, 0);
  assert.equal(shared.management.director.treatment.skillId, 'pack', '沿用的阐述归属应跟随新技能');
  assert.equal(r.capabilities.length, 1, '交接包技能只跑导演阐述一项能力');
});

test('视觉一致性导演：锁定双产物并强制按当前画布重打包', async () => {
  assert.ok(shared, '依赖上一测试的项目');
  const before = finalOf(shared).data.directorPack.file;
  const plan = planDirectorRun({ project: shared, m: shared.management, skillId: 'visual' });
  assert.equal(plan.plan.steps.length, 4, 'visual 只编排智能体四步');
  assert.deepEqual(plan.plan.deliverables, { video: true, pack: true });

  const r = await runDirector({ project: shared, skillId: 'visual' });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(shared.management.deliverables, { video: true, pack: true });
  const after = finalOf(shared).data.directorPack.file;
  assert.notEqual(after, before, 'repackForce 应按当前画布重新打包生成新文件');
  assert.ok(fs.existsSync(path.join(ASSET_DIR, after)));
  assert.equal(r.checklist.find((i) => i.id === 'film').level, 'degraded',
    '预览策略沿用上一轮设置，成片项仍是降级而非达成');
});

test('缺少原著且没有构想：明确阻断，不产生假成功', async () => {
  const { project } = buildNovelProject({ name: '空项目' });
  const r = await runDirector({ project, skillId: 'full' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'source');
  assert.match(r.error, /原著/);
  assert.equal(stepProgress(project.management).allDone, false, '阻断时不能把步骤标成已完成');
});

test('步骤执行器：显式空步骤链不报错，也不伪造执行记录', async () => {
  const { project } = buildNovelProject({ name: '空步骤链' });
  const out = await executeSteps(project, { steps: [] });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.executed, []);
});

test('残留 running 自愈：服务重启留下的死状态不再永久挡住全流程', async () => {
  const { project } = buildNovelProject({ name: '残留状态自愈' });
  // 模拟进程被杀：步骤被标记成 running，但本进程里根本没有对应的活动运行
  const stuck = project.management.steps.find((s) => s.id === 'script');
  stuck.status = 'running';
  stuck.note = '智能体执行中…';
  assert.equal(stepProgress(project.management).running, 1);

  const out = await executeSteps(project, { steps: ['script'] });
  assert.equal(out.ok, true, `应自动复位并继续执行：${out.error || ''}`);
  // 复位后真的跑了这一步，而不是被 isRunning 挡回
  assert.equal(stuck.status, 'done', `步骤应执行完成，实际 ${stuck.status}: ${stuck.note}`);
  assert.equal(stepProgress(project.management).running, 0, '不允许残留 running');
  // 中断的痕迹要留档，方便回看「上次为什么断了」
  const log = stuck.runLog.map((x) => `${x.ok}|${x.note}`).join(' || ');
  assert.match(log, /上次执行被中断/, `复位审计应保留，实际：${log}`);
});

test('报告要说真原因：步骤链没启动时不能只报「产物未达成」', async () => {
  const { project } = buildNovelProject({ name: '报告原因' });
  project.management.runtime.filmPolicy = 'preview';
  // 把步骤链声明的步骤全部占成 running，本进程却无活动运行——
  // 上次请求被中断就是这个形状。导演智能体若只报清单，用户永远不知道真正原因。
  for (const s of project.management.steps) {
    if (s.status !== 'done') s.status = 'running';
  }
  const r = await runDirector({ project, skillId: 'full' });
  assert.ok(r.status !== 'blocked', '不该被当成用户输入缺失而阻断');
  // 无论最终成败，报告必须给出可行动的原因，而不是甩一张清单
  if (!r.ok) {
    assert.ok(String(r.error || r.message || '').length > 0, '失败时必须给出原因');
    assert.doesNotMatch(String(r.message || ''), /^有 \d+ 项最终产物未达成：/,
      `不能只报产物清单而藏起真正原因，实际：${r.message}`);
  }
});
