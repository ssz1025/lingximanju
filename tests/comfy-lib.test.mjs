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
  DEFAULT_COMFY, loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems,
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
