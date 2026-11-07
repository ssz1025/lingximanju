/* ComfyUI 工作流库 · 配置层单元测试（数据模型 / 迁移 / 镜像回填 / 批量导入）
 * 运行：node --test tests/comfy-lib.test.mjs
 * 必须先把数据目录指到临时目录再动态导入被测模块（ESM import 会提升），避免污染真实 data/comfyui.json
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-comfy-lib-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  DEFAULT_COMFY, loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems, imageSpecFor, resolveComfyConfig,
} = await import('../src/core/comfy-config.mjs');

const FILE = path.join(TMP, 'comfyui.json');
const WF_A = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'a' } } };
const WF_B = { '2': { class_type: 'KSampler', inputs: { seed: 7, steps: 20 } } };
const writeCfg = (obj) => fs.writeFileSync(FILE, JSON.stringify(obj), 'utf8');
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const reset = () => fs.rmSync(FILE, { force: true });

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('DEFAULT_COMFY 含工作流库字段与选中态默认值', () => {
  assert.deepEqual(DEFAULT_COMFY.imageWorkflowLib, []);
  assert.deepEqual(DEFAULT_COMFY.videoWorkflowLib, []);
  assert.equal(DEFAULT_COMFY.imageActiveId, null);
  assert.equal(DEFAULT_COMFY.videoActiveId, null);
  assert.equal(DEFAULT_COMFY.imageWorkflow, null, '原有镜像字段保留');
});

test('图片规格由画幅自动决定：resolveComfyConfig 覆盖遗留 width/height/steps/cfg，fps/frames 保留手动', () => {
  reset();
  // 用户此前手填过规格（旧配置遗留）：消费端必须被画幅映射覆盖
  saveComfyConfig({ width: 1920, height: 1080, steps: 50, cfg: 7, fps: 30, frames: 96 });
  const landscape = resolveComfyConfig({ settings: { aspect: '16:9' } });
  assert.deepEqual(
    { width: landscape.width, height: landscape.height, steps: landscape.steps, cfg: landscape.cfg },
    { width: 864, height: 480, steps: 25, cfg: 1.0 },
    '16:9 → 864×480，步数/CFG 用内置最优',
  );
  const portrait = resolveComfyConfig({ settings: { aspect: '9:16' } });
  assert.equal(portrait.width, 480);
  assert.equal(portrait.height, 864);
  // 视频参数不受影响，项目 comfy 覆盖（如 outputMode）也保留
  assert.equal(portrait.fps, 30);
  assert.equal(portrait.frames, 96);
  const custom = resolveComfyConfig({ settings: { comfy: { outputMode: 'video' } } });
  assert.equal(custom.outputMode, 'video');
  assert.equal(custom.width, 864, '画幅缺省按 16:9');
  // imageSpecFor 纯函数直验
  assert.deepEqual(imageSpecFor('9:16'), { width: 480, height: 864, steps: 25, cfg: 1.0 });
  assert.deepEqual(imageSpecFor(undefined), { width: 864, height: 480, steps: 25, cfg: 1.0 });
});

test('normalize 防御清洗：库非数组清空、坏项丢弃、name/lastTest 兜底、非法 activeId 置 null', () => {
  reset();
  writeCfg({
    imageWorkflowLib: 'oops',
    videoWorkflowLib: [
      { id: 'x' },                                                    // 缺 workflow → 丢弃
      { workflow: WF_A },                                              // 缺 id → 丢弃
      { id: 'y', name: '', workflow: WF_A, createdAt: 'bad', lastTest: 'oops' },
      { id: 'z', workflow: WF_B, name: '  视频  ', lastTest: { ok: true, durationMs: '12', at: 0, error: null } },
    ],
    imageActiveId: 123,
    videoActiveId: '不存在',
  });
  const cfg = loadComfyConfig();
  assert.deepEqual(cfg.imageWorkflowLib, [], '非数组清空');
  assert.equal(cfg.videoWorkflowLib.length, 2);
  assert.equal(cfg.videoWorkflowLib[0].name, '未命名工作流');
  assert.equal(cfg.videoWorkflowLib[0].lastTest, null);
  assert.equal(cfg.videoWorkflowLib[0].createdAt, 0);
  assert.equal(cfg.videoWorkflowLib[1].name, '视频', 'trim 后的名称');
  assert.equal(cfg.videoWorkflowLib[1].lastTest.durationMs, 12);
  assert.equal(cfg.videoWorkflowLib[1].lastTest.error, null);
  assert.equal(cfg.imageActiveId, null, '非字符串 activeId 置 null');
  assert.equal(cfg.videoActiveId, null, '不在库中的 activeId 置 null');
});

test('迁移：旧配置单槽位镜像 → 库第一项并选中；镜像保留；幂等', () => {
  reset();
  writeCfg({
    imageWorkflow: WF_A, imageWorkflowName: '老出图',
    videoWorkflow: WF_B, videoWorkflowName: '老视频',
  });
  const cfg = loadComfyConfig();
  assert.equal(cfg.imageWorkflowLib.length, 1);
  assert.equal(cfg.imageWorkflowLib[0].name, '老出图');
  assert.deepEqual(cfg.imageWorkflowLib[0].workflow, WF_A);
  assert.equal(cfg.imageActiveId, cfg.imageWorkflowLib[0].id);
  assert.deepEqual(cfg.imageWorkflow, WF_A, '镜像必须保留，消费端零改动');
  assert.equal(cfg.videoWorkflowLib.length, 1);
  assert.equal(cfg.videoActiveId, cfg.videoWorkflowLib[0].id);

  // 幂等：再次加载重新迁移，id 必须稳定（否则「GET 拿到 id → PUT 切换选中」会丢匹配）
  const again = loadComfyConfig();
  assert.equal(again.imageWorkflowLib.length, 1, '不产生第二项');
  assert.equal(again.imageActiveId, cfg.imageActiveId, '迁移 id 稳定');

  // 迁移状态可随任意保存落盘，读回一致
  const saved = saveComfyConfig({ width: 800 });
  assert.equal(saved.imageWorkflowLib.length, 1);
  assert.equal(saved.width, 800);
  assert.equal(readCfg().imageActiveId, cfg.imageActiveId);
  assert.equal(readCfg().imageWorkflowLib.length, 1, '保存不重复迁移');
});

test('saveComfyConfig：切换选中回填镜像；id 不在库中 → 清空回退 Mock；普通保存不碰镜像', () => {
  reset();
  writeCfg({
    imageWorkflowLib: [
      { id: 'a', name: '海报', workflow: WF_A, createdAt: 1, lastTest: null },
      { id: 'b', name: '分镜', workflow: WF_B, createdAt: 1, lastTest: null },
    ],
    imageActiveId: 'a', imageWorkflow: WF_A, imageWorkflowName: '海报',
  });
  const switched = saveComfyConfig({ imageActiveId: 'b' });
  assert.equal(switched.imageActiveId, 'b');
  assert.deepEqual(switched.imageWorkflow, WF_B, '镜像回填为选中项 workflow');
  assert.equal(switched.imageWorkflowName, '分镜', '镜像名同步');
  assert.deepEqual(readCfg().imageWorkflow, WF_B, '磁盘已落盘');

  const plain = saveComfyConfig({ width: 640 });
  assert.deepEqual(plain.imageWorkflow, WF_B, '不带 activeId 的保存不碰镜像');
  assert.equal(plain.width, 640);

  const cleared = saveComfyConfig({ imageActiveId: 'ghost' });
  assert.equal(cleared.imageWorkflow, null, 'id 不在库中 → 视为清空');
  assert.equal(cleared.imageWorkflowName, '');
  assert.equal(readCfg().imageWorkflow, null);
});

test('删除语义：只改库（不带 activeId）不动镜像；库清空 + activeId null → 镜像清空', () => {
  reset();
  writeCfg({
    imageWorkflowLib: [
      { id: 'a', name: 'A', workflow: WF_A, createdAt: 1, lastTest: null },
      { id: 'b', name: 'B', workflow: WF_B, createdAt: 1, lastTest: null },
    ],
    imageActiveId: 'a', imageWorkflow: WF_A, imageWorkflowName: 'A',
    videoWorkflowLib: [{ id: 'v', name: 'V', workflow: WF_B, createdAt: 1, lastTest: null }],
    videoActiveId: 'v', videoWorkflow: WF_B, videoWorkflowName: 'V',
  });
  // DELETE 非选中项：只替换库
  const keep = saveComfyConfig({ imageWorkflowLib: [{ id: 'a', name: 'A', workflow: WF_A, createdAt: 1, lastTest: null }] });
  assert.deepEqual(keep.imageWorkflow, WF_A, '非选中项删除不碰镜像');
  assert.equal(keep.imageActiveId, 'a');
  // DELETE 选中项：库清空 + activeId 置 null
  const gone = saveComfyConfig({ imageWorkflowLib: [], imageActiveId: null });
  assert.equal(gone.imageWorkflow, null);
  assert.equal(gone.imageWorkflowName, '');
  assert.deepEqual(gone.videoWorkflow, WF_B, '另一类不受影响');
  assert.equal(gone.videoActiveId, 'v');
});

test('comfySummary：两库概览含 lastTest，不回传 workflow 本体，原概览字段保留', () => {
  reset();
  writeCfg({
    imageWorkflowLib: [{ id: 'a', name: 'A', workflow: WF_A, createdAt: 5, lastTest: { ok: true, durationMs: 1234, at: 9, error: null } }],
    imageActiveId: 'a', imageWorkflow: WF_A, imageWorkflowName: 'A',
  });
  const s = comfySummary(loadComfyConfig());
  assert.equal(s.imageWorkflowLib.length, 1);
  const ov = s.imageWorkflowLib[0];
  assert.deepEqual(Object.keys(ov).sort(), ['createdAt', 'id', 'lastTest', 'name', 'nodes']);
  assert.equal(ov.nodes, 1);
  assert.equal(ov.workflow, undefined, '概览绝不回传本体');
  assert.equal(ov.lastTest.ok, true);
  assert.equal(s.videoWorkflowLib.length, 0);
  assert.deepEqual(s.imageWorkflow, { name: 'A', nodes: 1 }, '原单槽位概览保留');
});

test('addLibraryItems：合法入库、非法进 failed 不阻断（纯计算不落盘）', () => {
  reset();
  const cfg = loadComfyConfig();
  const r = addLibraryItems(cfg, 'image', [
    { name: '好工作流', workflow: WF_A },
    { name: '坏JSON', workflow: '{oops' },
    { name: '界面格式', workflow: { nodes: [], links: [] } },
    { name: '空对象', workflow: {} },
  ]);
  assert.equal(r.added.length, 1, '合法项正常入库');
  assert.equal(r.failed.length, 3, '非法项各自计失败，不阻断');
  assert.equal(r.added[0].name, '好工作流');
  assert.equal(r.added[0].nodes, 1);
  assert.ok(r.added[0].id);
  assert.match(r.failed[0].error, /不是合法 JSON/);
  assert.match(r.failed[1].error, /导出\(API\)/, '界面格式给出导出(API)提示');
  assert.match(r.failed[2].error, /没有任何节点/);
  assert.equal(r.lib.length, 1);
  assert.equal(r.lib[0].lastTest, null);
  assert.ok(r.lib[0].createdAt);
  assert.equal(fs.existsSync(FILE), false, '纯计算不写盘');
});

test('addLibraryItems：同名同内容跳过报「已存在」、同名不同内容自动 (2) 后缀', () => {
  reset();
  writeCfg({ imageWorkflowLib: [{ id: 'a', name: '海报', workflow: WF_A, createdAt: 1, lastTest: null }] });
  const cfg = loadComfyConfig();

  const dup = addLibraryItems(cfg, 'image', [{ name: '海报', workflow: WF_A }]);
  assert.equal(dup.added.length, 0);
  assert.match(dup.failed[0].error, /已存在/);
  assert.equal(dup.lib.length, 1);

  const second = addLibraryItems(cfg, 'image', [{ name: '海报', workflow: WF_B }]);
  assert.equal(second.added.length, 1);
  assert.equal(second.added[0].name, '海报 (2)');
  assert.equal(second.lib.length, 2);

  // 带后缀的名字再导入同内容 → 同样按「已存在」跳过
  const dup2 = addLibraryItems({ ...cfg, imageWorkflowLib: second.lib }, 'image', [{ name: '海报 (2)', workflow: WF_B }]);
  assert.equal(dup2.added.length, 0);
  assert.match(dup2.failed[0].error, /已存在/);

  // 再来一个同名「海报」但内容不同 → 自动顺延到 (3)
  const third = addLibraryItems({ ...cfg, imageWorkflowLib: second.lib }, 'image', [{ name: '海报', workflow: { '9': { class_type: 'PreviewImage', inputs: {} } } }]);
  assert.equal(third.added[0].name, '海报 (3)');
});
