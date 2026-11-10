/* 六步任务的产物校验 / 残留节点自愈 / 分镜角色传递回归 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.LINGXIMANJU_DATA_DIR = '/tmp/lxmj-test-step-artifacts';
fs.rmSync(process.env.LINGXIMANJU_DATA_DIR, { recursive: true, force: true });

const ROOT = new URL('..', import.meta.url).pathname;
const { buildNovelProject } = await import(`${ROOT}src/pipelines/novel-project.mjs`);
const { executeSteps } = await import(`${ROOT}src/core/step-runner.mjs`);
const { saveProject } = await import(`${ROOT}src/core/store.mjs`);
const { createProviders } = await import(`${ROOT}src/core/providers.mjs`);

const SAMPLE = `雨夜来信\n\n第一章 没有署名的信\n\n雨下了整夜。沈砚把车停在巷口，推开侦探社的木门，门缝里夹着一封没有署名的信。\n\n沈砚：「这张照片，是十年前拍的。」\n\n第二章 旧码头的第二个人\n\n天亮时雨停了。守夜的老周坐在岗亭里，说十年前这里出过一桩案子。\n\n老周：「那天我值班，可监控里什么都没有。」\n`;

function buildProject(name) {
  const { project } = buildNovelProject({ name, text: SAMPLE, filename: 'sample.txt' });
  // 离线测试没有 ComfyUI，只能产出 mock 占位图；夹具显式允许它算产物，
  // 否则「第⑤步必须 done」的流程测试会被真实口径判失败（生产项目不会带这个开关）。
  project.testFlags = { allowMockArtifacts: true };
  saveProject(project);
  return project;
}

test('残留 running 节点自愈：剧本节点卡死也能重跑并产出结构化剧本', async () => {
  const project = buildProject('节点自愈');
  const node = project.nodes.find((n) => n.type === 'script');
  delete node.data.script;
  node.status = 'running';       // 模拟服务重启留下的死状态
  node.progress = 0.05;

  const out = await executeSteps(project, { stepId: 'script', force: true });
  const step = out.management.steps.find((s) => s.id === 'script');
  assert.equal(step.status, 'done', `应自愈并执行完成：${step.note}`);
  assert.ok(node.data.script?.scenes?.length, '剧本应有结构化场景');
  assert.notEqual(node.status, 'running', '节点不能残留 running');
});

test('没有镜头时第⑤步必须失败并指路，不允许 0 节点标绿', async () => {
  const project = buildProject('无镜头');
  const out = await executeSteps(project, { stepId: 'storyboard', force: true });
  const step = out.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'error');
  assert.match(step.note, /第④步|镜头/);
});

test('重跑第④步不残留重复节点，镜头数稳定', async () => {
  const project = buildProject('重跑不重复');
  const first = await executeSteps(project, { stepId: 'context', force: true });
  assert.equal(first.executed[0].status, 'done', first.executed[0].note);
  const shots1 = project.nodes.filter((n) => n.type === 'shot').length;
  assert.ok(shots1 > 0, '应展开出镜头');

  const second = await executeSteps(project, { stepId: 'context', force: true });
  assert.equal(second.executed[0].status, 'done', second.executed[0].note);
  const shots2 = project.nodes.filter((n) => n.type === 'shot').length;
  assert.equal(shots2, shots1, `重跑后镜头数不应翻倍：${shots1} -> ${shots2}`);
});

test('Mock 分镜使用剧本自带角色，不落入主题模板的玩具角色', async () => {
  const providers = createProviders({ provider: 'mock', style: 'cinematic' }, () => {}, () => {});
  const res = await providers.generate('shots', {
    scene: { location: '雨夜旧城区', summary: 'x', characters: ['老周'] },
    count: 4, clipSeconds: 3,
    characters: [{ name: '沈砚' }, { name: '林夏' }],
    idea: '测试',
  });
  const names = new Set(res.shots.flatMap((s) => s.characters || []));
  for (const n of names) assert.ok(['沈砚', '林夏', '老周'].includes(n), `出现模板角色：${n}`);
});

test('第⑤步重跑会复位关键帧等产出节点，而不是 0 节点空跑', async () => {
  const project = buildProject('第⑤步重跑');
  await executeSteps(project, { stepId: 'context', force: true });
  const kf = project.nodes.filter((n) => n.type === 'keyframe');
  assert.ok(kf.length, '第④步应建立关键帧链');
  for (const n of kf) n.status = 'done';   // 模拟上一轮已跑完

  const out = await executeSteps(project, { stepId: 'storyboard', force: true });
  const step = out.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'done', step.note);
  assert.ok(out.executed[0].note.includes('节点') && !/0 节点/.test(out.executed[0].note),
    `重跑应真的执行节点：${out.executed[0].note}`);
  const withImage = project.nodes.filter((n) => n.type === 'keyframe' && (n.data?.candidates || []).some((c) => c?.url));
  assert.ok(withImage.length, '重跑后关键帧应有图片产物');
});

test('第⑤步只出分镜提示词与分镜图（含分镜板），不生成任何视频片段', async () => {
  const project = buildProject('只出图');
  await executeSteps(project, { stepId: 'context', force: true });
  const out = await executeSteps(project, { stepId: 'storyboard', force: true });
  const step = out.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'done', step.note);

  const kf = project.nodes.filter((n) => n.type === 'keyframe');
  assert.ok(kf.length && kf.every((n) => (n.data?.candidates || []).some((c) => c?.url)),
    '每个关键帧都应有分镜图');
  const videos = project.nodes.filter((n) => n.type === 'video');
  assert.ok(videos.length, '视频节点应在第④步就建好，只是不在第⑤步执行');
  assert.equal(videos.filter((n) => n.data?.clip).length, 0, '第⑤步不允许产出任何视频片段');
  assert.ok(videos.every((n) => n.status !== 'done'), '视频节点不能在第⑤步被标成完成');

  const segs = (project.management.episodes || []).flatMap((ep) => ep.segments || []);
  assert.ok(segs.some((s) => s.gridUrl), '每段分镜板应随第⑤步一起生成');
  assert.match(step.note, /分镜板/);
});

test('第⑥步才逐镜头出视频，并拼成片交付', async () => {
  const project = buildProject('视频步');
  project.management.runtime.filmPolicy = 'preview';   // 零 Key 环境走可验收的预览成片
  saveProject(project);
  await executeSteps(project, { stepId: 'context', force: true });
  await executeSteps(project, { stepId: 'storyboard', force: true });
  assert.equal(project.nodes.filter((n) => n.type === 'video' && n.data?.clip).length, 0);

  const out = await executeSteps(project, { stepId: 'deliver', force: true });
  const step = out.management.steps.find((s) => s.id === 'deliver');
  assert.equal(step.status, 'done', step.note);

  const videos = project.nodes.filter((n) => n.type === 'video');
  assert.ok(videos.every((n) => n.data?.clip), '所有镜头都应在第⑥步生成片段');
  const final = project.nodes.find((n) => n.type === 'final');
  assert.ok(final.data?.film?.file, '片段齐了应拼出成片');
  assert.ok(final.data?.directorPack?.file, '导演包应一并导出');
});

test('只交付导演包时（video=false）第⑥步跳过视频渲染', async () => {
  const project = buildProject('只打包');
  project.management.deliverables = { video: false, pack: true };
  project.settings = { ...(project.settings || {}), comfy: { outputMode: 'director-pack' } };
  saveProject(project);
  await executeSteps(project, { stepId: 'context', force: true });
  await executeSteps(project, { stepId: 'storyboard', force: true });

  const out = await executeSteps(project, { stepId: 'deliver', force: true });
  const step = out.management.steps.find((s) => s.id === 'deliver');
  assert.equal(step.status, 'done', step.note);
  assert.equal(project.nodes.filter((n) => n.type === 'video' && n.data?.clip).length, 0,
    '只出导演包时不应调用图生视频');
  assert.ok(project.nodes.find((n) => n.type === 'final')?.data?.directorPack?.file);
});

test('只有 mock 占位图时第⑤步必须失败，不能把占位当已完成', async () => {
  const project = buildProject('占位不算完成');
  delete project.testFlags;          // 关掉测试放行，走真实产品口径
  saveProject(project);
  await executeSteps(project, { stepId: 'context', force: true });

  const out = await executeSteps(project, { stepId: 'storyboard', force: true });
  const step = out.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'error', `只有占位图不能标绿：${step.note}`);
  assert.match(step.note, /占位/);

  // 占位图仍留在画布上（供预览提示词），只是不再被当成真实产物
  const kf = project.nodes.filter((n) => n.type === 'keyframe');
  assert.ok(kf.some((n) => (n.data?.candidates || []).length), '占位候选应保留，便于排查');
});
