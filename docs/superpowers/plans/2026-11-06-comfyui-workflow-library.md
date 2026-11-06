# ComfyUI 工作流库 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页支持出图/视频各导入多个 ComfyUI「导出(API)」工作流形成库，选中即生效，支持多选批量导入、真实串行试跑、重命名与删除。

**Architecture:** 库存在 `data/comfyui.json` 单文件（`imageWorkflowLib` / `videoWorkflowLib` 数组 + `imageActiveId` / `videoActiveId`），选中项回填到原有 `imageWorkflow` / `videoWorkflow` **镜像字段**，因此 providers / director-pack / run-test 等全部消费端零改动。服务端在 `routes.mjs` 新增 4 个 REST 端点；试跑进度复用既有 SSE 通道（`log` 事件 + `source:'wf-test'` 过滤）。前端设置弹窗的单槽位 textarea 改为库列表。

**Tech Stack:** 零依赖原生 Node.js（ESM、`node --test`、原生 fetch + AbortController、SSE）；浏览器端 `input.multiple` + `EventSource`。

**Spec:** `docs/superpowers/specs/2026-11-06-comfyui-workflow-library-design.md`
**测试说明:** 规格验证清单写「无测试框架」不准确——项目实际有 `node --test`。配置层与 API 层用 TDD 单元/集成测试覆盖；依赖浏览器与真实 ComfyUI 的部分留到 Task 8 手工清单。

**仓库注意事项：**

- 工作区有**未提交**的 `README.md`、`docs/AGENTS.md` 改动，与本计划无关。每次提交**只 `git add` 本任务列出的文件**，禁止 `git add -A`。
- 数据目录：`LINGXIMANJU_DATA_DIR` 可覆盖（默认 `data/`）。测试必须把它指到临时目录再动态导入被测模块（ESM import 提升，不能用静态 import）。
- 服务默认端口 `45367`（`./start.sh`，实际端口见 `data/.port`）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/comfy-config.mjs` | 修改 | 库字段默认值、防御清洗、旧配置迁移、选中→镜像回填、概览输出、`addLibraryItems` 纯导入逻辑 |
| `src/api/routes.mjs` | 修改 | 4 个端点：`POST/PUT /api/comfyui/library`、`DELETE /api/comfyui/library/:kind/:id`、`POST /api/comfyui/test-batch` |
| `tests/comfy-lib.test.mjs` | 新建 | 配置层 TDD（数据模型/迁移/回填/导入去重） |
| `tests/comfy-lib-api.test.mjs` | 新建 | API 层 TDD（假 req/res 驱动 handleApi + 假 ComfyUI HTTP 服务） |
| `public/panels.js` | 修改 | 库列表 UI：渲染/切换/展开/重命名/删除/多选导入/批量试跑 |
| `public/styles.css` | 修改 | `.wf-*` 库列表样式 |

---

### Task 1: 配置数据模型——库字段 + 防御清洗 + 旧配置迁移

**Files:**
- Modify: `src/core/comfy-config.mjs`
- Create: `tests/comfy-lib.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/comfy-lib.test.mjs`：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 3 个测试全部 FAIL（`imageWorkflowLib` 等字段尚不存在，断言 `Expected values to be strictly deep-equal` / `undefined`），末尾 `# fail 3`。

- [ ] **Step 3: 实现数据模型**

修改 `src/core/comfy-config.mjs`。

3a. `DEFAULT_COMFY` 中 `videoWorkflowName: '',` 之后插入库字段：

```js
  imageWorkflowName: '',
  videoWorkflowName: '',
  // 工作流库：多导入 + 选中生效。选中项会镜像回填到上面的 imageWorkflow/videoWorkflow，
  // 因此 providers / director-pack / run-test / comfySummary 等消费端零改动。
  imageWorkflowLib: [],   // [{id, name, workflow, createdAt, lastTest:{ok,durationMs,at,error}|null}]
  videoWorkflowLib: [],
  imageActiveId: null,
  videoActiveId: null,
```

3b. 在 `function normalize(raw) {` **之前**加入稳定 id 生成器：

```js
/** 由内容推导稳定 id：迁移在每次 load 时重放，确定性 id 保证 GET → PUT 切换选中不丢匹配 */
function contentId(seed, obj) {
  const s = JSON.stringify(obj);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${seed}_${(h >>> 0).toString(36)}`;
}
```

3c. 在 `normalize` 的 `return cfg;` **之前**插入清洗 + 迁移：

```js
  // ---- 工作流库：防御性清洗 + 旧配置迁移 ----
  for (const kind of ['image', 'video']) {
    const libKey = `${kind}WorkflowLib`;
    const activeKey = `${kind}ActiveId`;
    const raw = Array.isArray(cfg[libKey]) ? cfg[libKey] : [];
    const cleaned = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || !item.id) continue;
      if (!item.workflow || typeof item.workflow !== 'object' || Array.isArray(item.workflow)) continue;
      cleaned.push({
        id: item.id,
        name: String(item.name || '').trim() || '未命名工作流',
        workflow: item.workflow,
        createdAt: Number(item.createdAt) || 0,
        lastTest: item.lastTest && typeof item.lastTest === 'object' ? {
          ok: Boolean(item.lastTest.ok),
          durationMs: Number(item.lastTest.durationMs) || 0,
          at: Number(item.lastTest.at) || 0,
          error: item.lastTest.error ? String(item.lastTest.error) : null,
        } : null,
      });
    }
    cfg[libKey] = cleaned;
    // 选中 id 必须是字符串且存在于库中，否则视为未选中（镜像字段原样保留，绝不丢工作流）
    cfg[activeKey] = typeof cfg[activeKey] === 'string' && cleaned.some((e) => e.id === cfg[activeKey])
      ? cfg[activeKey] : null;
    // 迁移：旧配置单槽位镜像非空而对应处理见下——幂等；异常时保留镜像，下次 load 重试
    try {
      const mirror = cfg[`${kind}Workflow`];
      if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
        const dup = cleaned.find((e) => JSON.stringify(e.workflow) === JSON.stringify(mirror));
        if (dup) {
          if (!cfg[activeKey]) cfg[activeKey] = dup.id;      // 内容已在库中 → 只补选中，不重复加
        } else if (!cleaned.length) {
          const id = contentId(`wf${kind}`, mirror);
          cleaned.push({
            id,
            name: String(cfg[`${kind}WorkflowName`] || '').trim() || '未命名工作流',
            workflow: mirror,
            createdAt: Date.now(),
            lastTest: null,
          });
          cfg[activeKey] = id;
        }
      }
    } catch { /* 迁移失败保留镜像，下次 load 重试，保证不丢工作流 */ }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 末尾 `# pass 3`、`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/core/comfy-config.mjs tests/comfy-lib.test.mjs
git commit -m "feat(comfy): 工作流库数据模型——库字段、防御清洗与旧配置迁移"
```

---

### Task 2: 选中→镜像回填 + comfySummary 两库概览

**Files:**
- Modify: `src/core/comfy-config.mjs`
- Test: `tests/comfy-lib.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/comfy-lib.test.mjs` 末尾（`after(...)` 之后）追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 前 3 个 PASS，新 3 个 FAIL（回填/概览尚未实现），末尾 `# pass 3`、`# fail 3`。

- [ ] **Step 3: 实现回填与概览**

3a. 重写 `saveComfyConfig`（`src/core/comfy-config.mjs`）：

```js
export function saveComfyConfig(patch = {}) {
  const merged = { ...loadComfyConfig(), ...patch };
  // 切换选中：从库回填「当前生效」镜像；id 不在库中 → 清空（回退 Mock）
  for (const kind of ['image', 'video']) {
    const activeKey = `${kind}ActiveId`;
    if (!(activeKey in patch)) continue;   // 普通保存不碰镜像
    const entry = (merged[`${kind}WorkflowLib`] || []).find((e) => e.id === patch[activeKey]);
    merged[`${kind}Workflow`] = entry ? entry.workflow : null;
    merged[`${kind}WorkflowName`] = entry ? entry.name : '';
  }
  const next = normalize(merged);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}
```

3b. `comfySummary` 中 `videoWorkflow: ...` 行之后追加概览数组，并在函数**外**加辅助函数：

```js
/** 给前端的库概览：只回 id/名称/节点数/测试结果，不重复塞 workflow 本体 */
function libOverview(lib) {
  return Array.isArray(lib) ? lib.map((e) => ({
    id: e.id, name: e.name, nodes: Object.keys(e.workflow || {}).length,
    createdAt: e.createdAt, lastTest: e.lastTest,
  })) : [];
}
```

`comfySummary` 返回对象内（`videoWorkflow: ...` 之后）加两行：

```js
    imageWorkflowLib: libOverview(cfg.imageWorkflowLib),
    videoWorkflowLib: libOverview(cfg.videoWorkflowLib),
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 末尾 `# pass 6`、`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/core/comfy-config.mjs tests/comfy-lib.test.mjs
git commit -m "feat(comfy): 选中切换回填镜像字段，概览输出两库列表"
```

---

### Task 3: addLibraryItems 批量导入（校验 + 同名去重 + (2) 后缀）

**Files:**
- Modify: `src/core/comfy-config.mjs`
- Test: `tests/comfy-lib.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/comfy-lib.test.mjs` 末尾追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 前 6 个 PASS，新 2 个 FAIL（`addLibraryItems is not a function` 或未导出），末尾 `# pass 6`、`# fail 2`。

- [ ] **Step 3: 实现 addLibraryItems**

3a. `src/core/comfy-config.mjs` 顶部改 import（引入 `uid` 与 `parseWorkflow`）：

```js
import { DATA_DIR, uid } from './store.mjs';
import { parseWorkflow } from './comfyui.mjs';
```

（原有 `import fs from 'node:fs'; import path from 'node:path';` 保持不变。`comfyui.mjs` 不反向依赖本模块，无循环。）

3b. 文件末尾（`comfySummary` 之后）追加：

```js
/**
 * 批量导入工作流到库（纯计算，不落盘）。
 * 逐项 parseWorkflow 校验：非法项进 failed 不阻断合法项；
 * 同名同内容 → 跳过报「已存在」；同名不同内容 → 名称自动加 (2) 后缀。
 * @returns {{added: Array<{id,name,nodes}>, failed: Array<{name,error}>, lib: Array}}
 */
export function addLibraryItems(cfg, kind, items) {
  const libKey = (kind === 'video' ? 'video' : 'image') + 'WorkflowLib';
  const lib = (Array.isArray(cfg[libKey]) ? cfg[libKey] : []).slice();
  const added = [];
  const failed = [];
  for (const item of items || []) {
    const name = String(item?.name || '').trim() || '未命名工作流';
    let wf;
    try {
      wf = parseWorkflow(item?.workflow, name);
    } catch (err) {
      failed.push({ name, error: err.message });
      continue;
    }
    const content = JSON.stringify(wf);
    if (lib.some((e) => e.name === name && JSON.stringify(e.workflow) === content)) {
      failed.push({ name, error: '已存在（同名同内容），已跳过' });
      continue;
    }
    let finalName = name;
    if (lib.some((e) => e.name === name)) {
      let n = 2;
      while (lib.some((e) => e.name === `${name} (${n})`)) n += 1;
      finalName = `${name} (${n})`;
    }
    const entry = { id: uid('wf'), name: finalName, workflow: wf, createdAt: Date.now(), lastTest: null };
    lib.push(entry);
    added.push({ id: entry.id, name: finalName, nodes: Object.keys(wf).length });
  }
  return { added, failed, lib };
}
```

- [ ] **Step 4: 运行确认通过 + 无循环依赖**

Run: `node --test tests/comfy-lib.test.mjs`
Expected: 末尾 `# pass 8`、`# fail 0`。

Run: `node -e "import('./src/core/comfy-config.mjs').then(() => console.log('import ok'))"`
Expected: 输出 `import ok`（若报 `Cannot access before initialization` 类错误说明出现循环依赖，需回头检查 import）。

- [ ] **Step 5: 提交**

```bash
git add src/core/comfy-config.mjs tests/comfy-lib.test.mjs
git commit -m "feat(comfy): 批量导入工作流——API 格式校验、同名去重与 (2) 后缀"
```

---

### Task 4: 路由层——导入 / 切换 / 重命名 / 删除（含 API 集成测试骨架）

**Files:**
- Modify: `src/api/routes.mjs`
- Create: `tests/comfy-lib-api.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/comfy-lib-api.test.mjs`：

```js
/* 工作流库 REST API 集成测试（导入 / 切换 / 重命名 / 删除）
 * 运行：node --test tests/comfy-lib-api.test.mjs
 * 用假 req/res 直接驱动 handleApi，不占端口、不依赖真实服务
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-comfy-api-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleApi } = await import('../src/api/routes.mjs');

const FILE = path.join(TMP, 'comfyui.json');
const WF_A = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'a' } } };
const WF_B = { '2': { class_type: 'KSampler', inputs: { seed: 7, steps: 20 } } };
const reset = () => fs.rmSync(FILE, { force: true });
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 直接驱动 handleApi：可读流当请求体，普通对象捕获响应 */
async function api(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  const out = { status: 200, data: null };
  const res = {
    setHeader() {},
    writeHead(status) { out.status = status; },
    end(chunk) { if (chunk) out.data = JSON.parse(String(chunk)); },
    on() {},   // test-batch 会挂 res.on('close')，假对象给个空实现
  };
  const handled = await handleApi(req, res, new URL(pathname, 'http://localhost'));
  assert.equal(handled, true, `${method} ${pathname} 应被 handleApi 处理`);
  return out;
}

test('POST /api/comfyui/library 批量导入：合法入库、非法进 failed、去重后缀、即刻落盘', async () => {
  reset();
  const r = await api('POST', '/api/comfyui/library', {
    kind: 'image',
    items: [
      { name: '出图A', workflow: WF_A },
      { name: '界面格式', workflow: { nodes: [], links: [] } },
      { name: '出图B', workflow: WF_B },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.added.length, 2, '合法项入库');
  assert.equal(r.data.failed.length, 1, '非法项不阻断');
  assert.match(r.data.failed[0].error, /导出\(API\)/);
  assert.equal(r.data.summary.imageWorkflowLib.length, 2);
  assert.equal(r.data.summary.imageWorkflowLib[0].workflow, undefined, '概览不回传本体');
  assert.equal(r.data.config.imageWorkflowLib.length, 2);
  assert.equal(readCfg().imageWorkflowLib.length, 2, '导入即落盘');
  assert.equal(readCfg().imageWorkflow, null, '导入不自动选中');

  const dup = await api('POST', '/api/comfyui/library', { kind: 'image', items: [{ name: '出图A', workflow: WF_A }] });
  assert.equal(dup.data.added.length, 0);
  assert.match(dup.data.failed[0].error, /已存在/, '同名同内容跳过');

  const suffix = await api('POST', '/api/comfyui/library', { kind: 'image', items: [{ name: '出图A', workflow: WF_B }] });
  assert.equal(suffix.data.added[0].name, '出图A (2)', '同名不同内容加后缀');

  const empty = await api('POST', '/api/comfyui/library', { kind: 'image', items: [] });
  assert.equal(empty.status, 400, '空导入 400');
});

test('PUT /api/comfyui/library：切换选中回填镜像；带 name 重命名且不改变选中', async () => {
  reset();
  const post = await api('POST', '/api/comfyui/library', {
    kind: 'video', items: [{ name: 'V1', workflow: WF_A }, { name: 'V2', workflow: WF_B }],
  });
  const [one, two] = post.data.added;

  // 切换选中
  const pick = await api('PUT', '/api/comfyui/library', { kind: 'video', id: two.id });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.ok, true);
  assert.deepEqual(pick.data.config.videoWorkflow, WF_B, '镜像回填');
  assert.equal(pick.data.config.videoWorkflowName, 'V2');
  assert.deepEqual(readCfg().videoWorkflow, WF_B, '镜像落盘');
  assert.equal(readCfg().videoActiveId, two.id);

  // 重命名非选中项：名字变、选中与镜像都不变
  const rn = await api('PUT', '/api/comfyui/library', { kind: 'video', id: one.id, name: 'V1 改名' });
  const rnEntry = rn.data.config.videoWorkflowLib.find((e) => e.id === one.id);
  assert.equal(rnEntry.name, 'V1 改名');
  assert.equal(rn.data.config.videoActiveId, two.id, '重命名不改变选中');
  assert.equal(rn.data.config.videoWorkflowName, 'V2', '镜像名不受影响');

  // 重命名选中项：镜像名同步
  const rnActive = await api('PUT', '/api/comfyui/library', { kind: 'video', id: two.id, name: 'V2 改' });
  assert.equal(rnActive.data.config.videoWorkflowName, 'V2 改');
  assert.deepEqual(rnActive.data.config.videoWorkflow, WF_B, '选中与镜像内容不变');
  assert.equal(rnActive.data.config.videoActiveId, two.id);

  // 重命名不存在的项 → 404
  const ghost = await api('PUT', '/api/comfyui/library', { kind: 'video', id: 'ghost', name: 'x' });
  assert.equal(ghost.status, 404);

  // 切回第一个
  const back = await api('PUT', '/api/comfyui/library', { kind: 'video', id: one.id });
  assert.deepEqual(back.data.config.videoWorkflow, WF_A);
  assert.equal(back.data.config.videoWorkflowName, 'V1 改名');
});

test('DELETE /api/comfyui/library/:kind/:id：删选中项清镜像、删非选中项保留、不存在 404', async () => {
  reset();
  const post = await api('POST', '/api/comfyui/library', {
    kind: 'image', items: [{ name: 'A', workflow: WF_A }, { name: 'B', workflow: WF_B }],
  });
  const [a, b] = post.data.added;
  await api('PUT', '/api/comfyui/library', { kind: 'image', id: a.id });

  const delOther = await api('DELETE', `/api/comfyui/library/image/${b.id}`);
  assert.equal(delOther.status, 200);
  assert.deepEqual(delOther.data.config.imageWorkflow, WF_A, '非选中项删除镜像不动');
  assert.equal(delOther.data.config.imageWorkflowLib.length, 1);

  const missing = await api('DELETE', '/api/comfyui/library/image/ghost');
  assert.equal(missing.status, 404);

  const delActive = await api('DELETE', `/api/comfyui/library/image/${a.id}`);
  assert.equal(delActive.status, 200);
  assert.equal(delActive.data.config.imageWorkflow, null, '删选中项 → 镜像清空回退 Mock');
  assert.equal(delActive.data.config.imageActiveId, null);
  const disk = readCfg();
  assert.equal(disk.imageWorkflow, null);
  assert.equal(disk.imageWorkflowLib.length, 0, '已落盘');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/comfy-lib-api.test.mjs`
Expected: 3 个测试 FAIL（`未知接口 POST /api/comfyui/library` → 断言 `应被 handleApi 处理` 失败），末尾 `# fail 3`。

- [ ] **Step 3: 实现三个端点**

3a. `src/api/routes.mjs` 修改 import 行（加 `addLibraryItems`）：

```js
import { loadComfyConfig, saveComfyConfig, comfySummary, addLibraryItems } from '../core/comfy-config.mjs';
```

3b. `MATCH` 对象（`deliverable` 行之后）加一条：

```js
  libItem: /^\/api\/comfyui\/library\/(image|video)\/([^/]+)$/,
```

3c. 在 `POST /api/comfyui/run-test` 块结束（`return json(res, {...}), true;` 与右花括号）之后、`if (pathname === '/api/bootstrap' ...)` 之前，插入：

```js
  // ---------- 工作流库：批量导入 / 切换选中 / 重命名 / 删除 ----------
  if (pathname === '/api/comfyui/library' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json(res, { error: '没有可导入的工作流' }, 400), true;
    const { added, failed, lib } = addLibraryItems(loadComfyConfig(), kind, items);
    if (added.length) saveComfyConfig({ [`${kind}WorkflowLib`]: lib });
    const config = loadComfyConfig();
    return json(res, { added, failed, config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/library' && method === 'PUT') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const cfg0 = loadComfyConfig();
    if (name) {
      // 重命名：只改名称不改选中；改的是选中项时把 activeId 放进补丁触发镜像名同步
      const libKey = `${kind}WorkflowLib`;
      const lib = cfg0[libKey] || [];
      const target = lib.find((e) => e.id === body.id);
      if (!target) return json(res, { error: '库项不存在' }, 404), true;
      const patch = { [libKey]: lib.map((e) => (e.id === target.id ? { ...e, name } : e)) };
      if (cfg0[`${kind}ActiveId`] === target.id) patch[`${kind}ActiveId`] = target.id;
      const config = saveComfyConfig(patch);
      return json(res, { ok: true, config, summary: comfySummary(config) }), true;
    }
    // 切换选中（id 不在库中由 saveComfyConfig 视为清空）
    const config = saveComfyConfig({ [`${kind}ActiveId`]: typeof body.id === 'string' ? body.id : null });
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }
  const libHit = pathname.match(MATCH.libItem);
  if (libHit && method === 'DELETE') {
    const kind = libHit[1];
    const id = decodeURIComponent(libHit[2]);
    const cfg = loadComfyConfig();
    const libKey = `${kind}WorkflowLib`;
    const before = Array.isArray(cfg[libKey]) ? cfg[libKey] : [];
    const lib = before.filter((e) => e.id !== id);
    if (lib.length === before.length) return json(res, { error: '库项不存在' }, 404), true;
    const patch = { [libKey]: lib };
    if (cfg[`${kind}ActiveId`] === id) patch[`${kind}ActiveId`] = null;   // 删选中项 → activeId/镜像一起清空
    const config = saveComfyConfig(patch);
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/comfy-lib-api.test.mjs`
Expected: 末尾 `# pass 3`、`# fail 0`。

Run: `npm test`
Expected: 全部文件通过（novel / novel-project / project-steps / comfy-lib / comfy-lib-api），`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/api/routes.mjs tests/comfy-lib-api.test.mjs
git commit -m "feat(api): 工作流库 REST——批量导入、切换选中、重命名与删除"
```

---

### Task 5: POST /api/comfyui/test-batch——连接探测 + 串行真实试跑 + lastTest 落盘

**Files:**
- Modify: `src/api/routes.mjs`
- Test: `tests/comfy-lib-api.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试（含假 ComfyUI 服务）**

在 `tests/comfy-lib-api.test.mjs` 末尾追加：

```js
/** 假 ComfyUI：/system_stats、/prompt（工作流含 MockFail 节点即 400）、/history、/view */
function startMockComfy() {
  const state = { prompts: 0, inFlight: 0, violations: 0, order: [] };
  const server = http.createServer((req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system_stats') {
      return send({ system: { comfyui_version: 'mock' }, devices: [{ name: 'mock-gpu', vram_total: 1 }] });
    }
    if (url.pathname === '/prompt') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const types = Object.values(body.prompt || {}).map((n) => n.class_type);
        state.order.push(types.join(','));
        if (state.inFlight > 0) state.violations += 1;   // 上一条没完成又提交 → 违反串行
        state.inFlight += 1;
        state.prompts += 1;
        if (types.includes('MockFail')) { state.inFlight -= 1; return send({ error: '模拟失败' }, 400); }
        send({ prompt_id: `p${state.prompts}` });
      });
      return;
    }
    const m = url.pathname.match(/^\/history\/(\w+)$/);
    if (m) {
      state.inFlight -= 1;
      return send({
        [m[1]]: {
          outputs: { out: { images: [{ filename: 't.png', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success' },
        },
      });
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]));
    }
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('POST /api/comfyui/test-batch：先探测连接、串行试跑、逐项 lastTest 落盘', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfgSafe({
      baseUrl,
      imageWorkflowLib: [
        { id: 'ok1', name: '成功流', workflow: WF_A, createdAt: 1, lastTest: null },
        { id: 'bad1', name: '失败流', workflow: { '9': { class_type: 'MockFail', inputs: {} } }, createdAt: 1, lastTest: null },
      ],
    });
    const r = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['ok1', 'bad1'] });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.results.length, 2);
    assert.equal(r.data.results[0].ok, true);
    assert.equal(r.data.results[0].error, null);
    assert.ok(r.data.results[0].durationMs >= 0);
    assert.equal(r.data.results[1].ok, false);
    assert.match(r.data.results[1].error, /模拟失败/);
    assert.equal(state.violations, 0, '必须串行，不并发抢 ComfyUI 队列');
    assert.match(state.order[0], /SaveImage/, '按 ids 顺序先跑第一项');
    assert.match(state.order[1], /MockFail/);
    const saved = readCfg();
    assert.equal(saved.imageWorkflowLib[0].lastTest.ok, true, '成功项徽标落盘');
    assert.ok(saved.imageWorkflowLib[0].lastTest.durationMs >= 0);
    assert.equal(saved.imageWorkflowLib[1].lastTest.ok, false);
    assert.match(saved.imageWorkflowLib[1].lastTest.error, /模拟失败/);
    assert.equal(r.data.summary.imageWorkflowLib[0].lastTest.ok, true, '响应概览同步');
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('POST /api/comfyui/test-batch：无匹配 id → 400；ComfyUI 连不上 → 整批 connectionError', async () => {
  reset();
  const none = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['ghost'] });
  assert.equal(none.status, 400);

  // 先占一个端口再关掉，得到一个必然拒绝连接的地址
  const closed = http.createServer();
  await new Promise((res) => closed.listen(0, '127.0.0.1', res));
  const deadPort = closed.address().port;
  await new Promise((res) => closed.close(res));
  writeCfgSafe({
    baseUrl: `http://127.0.0.1:${deadPort}`,
    imageWorkflowLib: [{ id: 'x', name: 'X', workflow: WF_A, createdAt: 1, lastTest: null }],
  });
  const r = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['x'] });
  assert.equal(r.data.ok, false);
  assert.match(r.data.connectionError, /无法连接/, '连不上整批返回，不逐项空等超时');
  assert.deepEqual(r.data.results, []);
  assert.equal(readCfg().imageWorkflowLib[0].lastTest, null, '没试跑不写 lastTest');
});
```

同时在该文件顶部（`const readCfg = ...` 之后）补两个测试辅助（`http` 导入与 `writeCfgSafe`）：

```js
const writeCfgSafe = (obj) => fs.writeFileSync(FILE, JSON.stringify(obj), 'utf8');
```

并把顶部 import 改为：

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/comfy-lib-api.test.mjs`
Expected: 前 3 个 PASS，新 2 个 FAIL（`未知接口 POST /api/comfyui/test-batch`），末尾 `# pass 3`、`# fail 2`。

- [ ] **Step 3: 实现 test-batch 端点**

`src/api/routes.mjs`：在 Task 4 插入的工作流库端点块**之后**（同样位于 `/api/bootstrap` 之前）再插入：

```js
  if (pathname === '/api/comfyui/test-batch' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'video' ? 'video' : 'image';
    const config = loadComfyConfig();
    const libKey = `${kind}WorkflowLib`;
    const lib = config[libKey] || [];
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => lib.some((e) => e.id === id));
    if (!ids.length) return json(res, { error: '没有匹配的库项' }, 400), true;
    try {
      await testConnection(config.baseUrl);
    } catch (err) {
      // 连不上整批返回，不让每一项空等到 15 分钟超时
      return json(res, { ok: false, connectionError: err.message, results: [] }), true;
    }
    const log = (level, message) => emit('log', { source: 'wf-test', level, message });
    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });

    // 每项完成即写回 lastTest：重新读盘再改，避免覆盖试跑期间用户的其它修改
    const writeLastTest = (id, lastTest) => {
      try {
        const fresh = loadComfyConfig();
        const cur = fresh[libKey] || [];
        const target = cur.find((e) => e.id === id);
        if (!target) return;
        target.lastTest = lastTest;
        saveComfyConfig({ [libKey]: cur });
      } catch (err) { console.warn('[comfy] lastTest 写回失败：', err.message); }
    };

    const results = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (clientGone) break;   // 客户端断开 → 当前项被 signal 取消后停止后续项
      const entry = lib.find((e) => e.id === ids[i]);
      if (!entry) continue;
      log('info', `▶ 试跑 ${i + 1}/${ids.length} ·「${entry.name}」`);
      const t0 = Date.now();
      let lastTest;
      try {
        const r = await runWorkflow(config, entry.workflow, {
          prompt: 'cinematic test shot, consistent character, soft light',
          filenamePrefix: 'lingximanju_test', cfg: config,
        }, {
          bindings: config.bindings?.[kind] || [],
          signal: ac.signal,
          log: (lv, msg) => log(lv, `「${entry.name}」${msg}`),
        });
        lastTest = { ok: true, durationMs: r.durationMs, at: Date.now(), error: null };
        results.push({ id: entry.id, ok: true, durationMs: r.durationMs, error: null });
        log('info', `✓「${entry.name}」 ${(r.durationMs / 1000).toFixed(1)}s`);
      } catch (err) {
        const error = clientGone ? '已取消' : (/执行超时/.test(err.message) ? '超时' : err.message);
        lastTest = { ok: false, durationMs: Date.now() - t0, at: Date.now(), error };
        results.push({ id: entry.id, ok: false, durationMs: lastTest.durationMs, error });
        log('error', `✕「${entry.name}」 ${error}`);
      }
      writeLastTest(entry.id, lastTest);
    }
    if (clientGone) return true;   // 对端已断开，无需再写响应
    const final = loadComfyConfig();
    return json(res, { ok: true, results, config: final, summary: comfySummary(final) }), true;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/comfy-lib-api.test.mjs`
Expected: 末尾 `# pass 5`、`# fail 0`（假 ComfyUI 服务全程 <2s）。

Run: `npm test && npm run check`
Expected: 全部测试 `# fail 0`；`npm run check` 无输出、退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/api/routes.mjs tests/comfy-lib-api.test.mjs
git commit -m "feat(api): 批量真实试跑——连接探测、串行执行、SSE 进度与 lastTest 逐项落盘"
```

---

### Task 6: 设置页库列表——渲染 / 选中切换 / 展开 JSON / 重命名 / 删除确认 + 样式

**Files:**
- Modify: `public/panels.js`
- Modify: `public/styles.css`

> ⚠️ 本任务的 4 处 `panels.js` 编辑（HTML 区块、保存逻辑、旧 bindFile/analyze 移除、新列表逻辑）**必须在同一次提交完成**：旧按钮/textarea 被移除后若残留绑定，打开设置弹窗会直接报 `Cannot read properties of null`。

- [ ] **Step 1: 替换工作流区 HTML**

`public/panels.js` 中把整段 `<div class="cf-section">`（含 `<h4>API 格式工作流</h4>`、两个单槽位 field、两个 textarea，约 L95-110）替换为：

```html
      <div class="cf-section">
        <h4>出图工作流库（关键帧 / 角色 / 转场 / 海报）</h4>
        <div class="cf-note">${esc(WF_HELP).replace(/\n/g, '<br>')}</div>
        <div class="wf-lib" id="cf-lib-image"></div>
      </div>

      <div class="cf-section">
        <h4>视频工作流库（图生视频 / 首尾帧 / 导演台）</h4>
        <div class="cf-note">选中项即当前生效的工作流，切换即时生效；无选中时该环节使用 Mock 自绘。测试 = 提交本地 ComfyUI 真实串行试跑一次。</div>
        <div class="wf-lib" id="cf-lib-video"></div>
      </div>
```

- [ ] **Step 2: 移除已死代码**

2a. 删除 `wfText` 行（约 L58）：

```js
  const wfText = (wf) => (wf ? JSON.stringify(wf, null, 2) : '');
```

2b. 「保存设置」onClick 内，删除 `parseWF` 整个定义，并从 `patch` 对象中删除 4 个 workflow 字段——即把：

```js
        const box = q('cf-result');
        const parseWF = (text, label) => {
          const t = String(text || '').trim();
          if (!t) return null;
          let obj;
          try { obj = JSON.parse(t); } catch { throw new Error(`${label} 不是合法 JSON`); }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${label} 必须是 JSON 对象`);
          if (Array.isArray(obj.nodes) || Array.isArray(obj.links)) throw new Error(`${label} 是界面保存格式，请在 ComfyUI 选择「导出(API)」`);
          return obj;
        };
        try {
          const patch = {
            enabled: q('cf-enabled').checked,
            strict: q('cf-strict').checked,
            baseUrl: q('cf-base').value.trim(),
            imageWorkflow: parseWF(q('cf-wf-image').value, '出图工作流'),
            videoWorkflow: parseWF(q('cf-wf-video').value, '视频工作流'),
            imageWorkflowName: q('cf-img-name').value,
            videoWorkflowName: q('cf-video-name').value,
            width: Number(q('cf-width').value) || 864,
```

改为：

```js
        const box = q('cf-result');
        try {
          const patch = {
            enabled: q('cf-enabled').checked,
            strict: q('cf-strict').checked,
            baseUrl: q('cf-base').value.trim(),
            width: Number(q('cf-width').value) || 864,
```

2c. 删除旧 `bindFile` 定义与两处调用、`analyze` 定义与两处绑定（约 L232-271 整段：`const bindFile = ...` 到 `root.querySelector('#cf-analyze-video').addEventListener(...)`）。该位置由 Step 3 的库逻辑接替。

- [ ] **Step 3: 加入库列表逻辑**

在原 `bindFile`/`analyze` 的位置（tab 切换绑定代码之后、`openSettings` 结束花括号之前）插入：

```js
  /* ---------- 工作流库：选中生效 / 展开 / 重命名 / 删除 ---------- */
  const libKey = (kind) => `${kind}WorkflowLib`;
  const activeKey = (kind) => `${kind}ActiveId`;
  const testing = new Set();   // 正在试跑的库项 id → 行内转圈（Task 7 接线）

  const postJSON = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  const libItemHTML = (kind, e) => {
    const t = e.lastTest;
    const active = e.id === cfg[activeKey(kind)];
    const badge = testing.has(e.id)
      ? `<span class="wf-badge run"><span class="wf-spin"></span>试跑中</span>`
      : !t ? `<span class="wf-badge none" title="尚未真实试跑">未测</span>`
      : t.ok ? `<span class="wf-badge ok" title="上次试跑：${esc(new Date(t.at || Date.now()).toLocaleString())}">✓ ${(Number(t.durationMs) / 1000).toFixed(1)}s</span>`
      : `<span class="wf-badge err" title="${esc(t.error || '失败')}">✕ ${esc(String(t.error || '失败').slice(0, 18))}</span>`;
    return `<div class="wf-item ${active ? 'active' : ''}" data-id="${esc(e.id)}">
      <input type="radio" name="wf-pick-${kind}" ${active ? 'checked' : ''} data-act="pick" title="选中即当前生效">
      <span class="wf-name" data-act="expand" title="点击查看 / 复制 JSON · 双击重命名">${esc(e.name)}</span>
      <span class="wf-nodes">${Object.keys(e.workflow || {}).length} 节点</span>
      ${badge}
      <button class="wf-del" type="button" data-act="del" title="删除">✕</button>
      <textarea class="cf-code wf-json" rows="7" readonly hidden>${esc(JSON.stringify(e.workflow, null, 2))}</textarea>
    </div>`;
  };

  const renderLib = (kind) => {
    const box = root.querySelector(`#cf-lib-${kind}`);
    if (!box) return;
    const lib = cfg[libKey(kind)] || [];
    box.innerHTML = lib.length
      ? lib.map((e) => libItemHTML(kind, e)).join('')
      : `<div class="wf-empty">暂无工作流 · 点「⇧ 导入 JSON」选择本地 ComfyUI「导出(API)」文件（可多选）</div>`;
  };

  const applyConfig = (d) => {
    if (d?.config) { cfg = d.config; renderLib('image'); renderLib('video'); }
  };

  const deleteItem = async (kind, entry, isActive) => {
    try {
      const r = await fetch(`/api/comfyui/library/${kind}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      applyConfig(d);
      toast(isActive ? `已删除「${entry.name}」· 该环节已回退 Mock 自绘` : `已删除「${entry.name}」`, 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
  };

  const requestDelete = (kind, entry) => {
    const isActive = cfg[activeKey(kind)] === entry.id;
    if (!isActive) { deleteItem(kind, entry, false); return; }
    showModal({
      title: '删除正在使用的工作流？',
      sub: `「${esc(entry.name)}」是当前生效的工作流，删除后该环节回退到 Mock 自绘。`,
      actions: [
        { label: '取消' },
        { label: '删除', primary: true, onClick: async () => { await deleteItem(kind, entry, true); } },
      ],
    });
  };

  const pickActive = async (kind, entry) => {
    try {
      const r = await fetch('/api/comfyui/library', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: entry.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      applyConfig(d);
      toast(`生效工作流已切换为「${entry.name}」`, 'ok');
    } catch (e) { toast(`切换失败：${e.message}`, 'err'); }
  };

  const startRename = (kind, item, entry) => {
    const span = item.querySelector('.wf-name');
    if (!span) return;
    const input = document.createElement('input');
    input.className = 'wf-rename';
    input.value = entry.name;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== entry.name) {
        try {
          const r = await fetch('/api/comfyui/library', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, id: entry.id, name: next }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          applyConfig(d);
          toast(`已重命名为「${next}」`, 'ok');
          return;
        } catch (e) {
          toast(`重命名失败：${e.message}`, 'err');
        }
      }
      renderLib(kind);
    };
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') finish(true);
      if (ke.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };

  const setupLib = (kind) => {
    const box = root.querySelector(`#cf-lib-${kind}`);
    if (!box) return;
    box.addEventListener('click', (ev) => {
      const item = ev.target.closest('.wf-item');
      if (!item) return;
      const entry = (cfg[libKey(kind)] || []).find((e) => e.id === item.dataset.id);
      if (!entry) return;
      const act = ev.target.dataset.act;
      if (act === 'expand') {
        const ta = item.querySelector('.wf-json');
        if (ta) ta.hidden = !ta.hidden;
        return;
      }
      if (act === 'del') { requestDelete(kind, entry); return; }
      if (ev.target.matches('input[data-act="pick"]') && cfg[activeKey(kind)] !== entry.id) {
        pickActive(kind, entry);
      }
    });
    box.addEventListener('dblclick', (ev) => {
      const item = ev.target.closest('.wf-item');
      if (!item || !ev.target.classList.contains('wf-name')) return;
      const entry = (cfg[libKey(kind)] || []).find((e) => e.id === item.dataset.id);
      if (entry) startRename(kind, item, entry);
    });
  };

  for (const kind of ['image', 'video']) { setupLib(kind); renderLib(kind); }
```

- [ ] **Step 4: 加样式**

`public/styles.css` 中 `.cf-result .cf-code { max-height: 130px; overflow: auto; }` 之后追加：

```css
/* ---- 工作流库列表 ---- */
.wf-lib { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.wf-empty { font-size: 10.5px; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; padding: 10px 11px; text-align: center; line-height: 1.6; }
.wf-item { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--border-soft); border-radius: 8px; background: var(--panel); flex-wrap: wrap; }
.wf-item.active { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
.wf-item input[type="radio"] { accent-color: var(--accent); cursor: pointer; flex: none; }
.wf-name { flex: 1; min-width: 60px; font-size: 11.5px; color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-nodes { font-size: 10px; color: var(--muted); flex: none; }
.wf-badge { font-size: 10px; padding: 2px 7px; border-radius: 999px; background: var(--panel-3); color: var(--muted); flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-badge.ok { color: var(--green); }
.wf-badge.err { color: var(--red); }
.wf-badge.run { color: var(--accent); display: inline-flex; align-items: center; gap: 5px; }
.wf-del { border: none; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; padding: 2px 5px; border-radius: 5px; flex: none; }
.wf-del:hover { color: var(--red); background: var(--panel-3); }
.wf-json { flex-basis: 100%; margin-top: 7px; }
.wf-rename { flex: 1; min-width: 60px; font-size: 11.5px; padding: 2px 6px; border: 1px solid var(--accent); border-radius: 5px; background: var(--panel); color: var(--text); outline: none; }
.wf-spin { width: 10px; height: 10px; border: 1.5px solid var(--border); border-top-color: var(--accent); border-radius: 50%; display: inline-block; animation: wf-spin .7s linear infinite; }
.wf-run { color: var(--muted); margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
@keyframes wf-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 5: 语法与回归检查**

Run: `node --check public/panels.js`
Expected: 无输出、退出码 0（`package.json` 有 `"type": "module"`，`node --check` 按 ESM 解析）。

Run: `npm test`
Expected: `# fail 0`（服务端测试不受前端改动影响，防回归）。

手工冒烟（可选，若服务已在跑）：

```bash
curl -s -X POST http://127.0.0.1:45367/api/comfyui/library \
  -H 'Content-Type: application/json' \
  -d '{"kind":"image","items":[{"name":"冒烟项","workflow":{"1":{"class_type":"SaveImage","inputs":{}}}}]}' | head -c 300
```
Expected: 返回 JSON 含 `"added"` 且有一项 `name":"冒烟项"`。随后打开设置弹窗应看到该行。

- [ ] **Step 6: 提交**

```bash
git add public/panels.js public/styles.css
git commit -m "feat(ui): 设置页工作流库列表——选中生效、展开 JSON、重命名与删除确认"
```

---

### Task 7: 多选导入 + 自动串行试跑 + 测试全部（SSE 进度）

**Files:**
- Modify: `public/panels.js`

- [ ] **Step 1: 两个库区块加按钮**

`public/panels.js` 中，出图区块把：

```html
        <div class="wf-lib" id="cf-lib-image"></div>
      </div>
```

替换为：

```html
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-image" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-image" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-image"></div>
      </div>
```

视频区块同理，把：

```html
        <div class="wf-lib" id="cf-lib-video"></div>
      </div>
```

替换为：

```html
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-video" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-video" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-video"></div>
      </div>
```

- [ ] **Step 2: 加试跑与导入逻辑并接线按钮**

`public/panels.js` 中把：

```js
  for (const kind of ['image', 'video']) { setupLib(kind); renderLib(kind); }
```

替换为：

```js
  /* ---------- 批量真实试跑（进度经 SSE log 事件回显） ---------- */
  let testES = null;
  const testBatch = async (kind, ids) => {
    if (!ids.length) { toast('库为空，先导入工作流', 'err'); return; }
    ids.forEach((id) => testing.add(id));
    renderLib(kind);
    const box = root.querySelector('#cf-result');
    box.hidden = false;
    box.innerHTML = `<div class="wf-run"><span class="wf-spin"></span> 串行试跑 ${ids.length} 项 · 进度实时回显</div>`;
    testES?.close();
    testES = new EventSource('/api/events');
    testES.onmessage = (ev) => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (e.type !== 'log' || e.source !== 'wf-test') return;
      if (!document.contains(box)) { testES?.close(); testES = null; return; }
      const line = document.createElement('div');
      if (e.level === 'error') line.className = 'err';
      line.textContent = e.message;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    };
    try {
      const d = await postJSON('/api/comfyui/test-batch', { kind, ids });
      if (d.connectionError) throw new Error(d.connectionError);
      applyConfig(d);
      const ok = d.results.filter((x) => x.ok).length;
      const fail = d.results.length - ok;
      box.querySelector('.wf-run')?.remove();
      box.insertAdjacentHTML('afterbegin',
        `<b class="${fail ? 'err' : 'ok'}">${fail ? '试跑完成（存在失败项）' : '✓ 试跑全部成功'}</b> 成功 ${ok} · 失败 ${fail}`);
      box.scrollTop = 0;
      toast(`试跑完成：成功 ${ok} · 失败 ${fail}`, fail ? '' : 'ok');
    } catch (e) {
      const conn = /无法连接/.test(e.message);
      box.querySelector('.wf-run')?.remove();
      box.insertAdjacentHTML('afterbegin',
        `<b class="err">✕ ${conn ? 'ComfyUI 连接失败' : '试跑失败'}</b> ${esc(e.message)}${conn ? ' · 请先启动 ComfyUI（--listen 127.0.0.1 --port 8188）' : ''}`);
      box.scrollTop = 0;
      toast(`试跑失败：${e.message}`, 'err');
    } finally {
      testES?.close(); testES = null;
      ids.forEach((id) => testing.delete(id));
      renderLib(kind);
    }
  };

  /* ---------- 多选导入：入库 → toast 汇总 → 自动逐个串行试跑 ---------- */
  const importLib = (kind) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const box = root.querySelector('#cf-result');
      box.hidden = false;
      const items = [];
      const bad = [];
      for (const f of files) {
        try { items.push({ name: f.name.replace(/\.json$/i, ''), workflow: JSON.parse(await f.text()) }); }
        catch { bad.push(f.name); }
      }
      if (bad.length) toast(`${bad.length} 个文件不是合法 JSON：${bad.join('、')}`, 'err');
      if (!items.length) return;
      box.textContent = `正在导入 ${items.length} 个文件…`;
      try {
        const d = await postJSON('/api/comfyui/library', { kind, items });
        applyConfig(d);
        const summary = `新增 ${d.added.length}${d.failed.length ? ` · 失败 ${d.failed.length}` : ''}`;
        box.innerHTML = d.failed.length
          ? `<b class="ok">✓ ${summary}</b><div class="cf-code" style="margin-top:6px">${d.failed.map((x) => `<div><b class="err">✕ ${esc(x.name)}</b> ${esc(x.error)}</div>`).join('')}</div>`
          : `<b class="ok">✓ ${summary}</b> 已入库，开始自动串行试跑…`;
        toast(summary, d.failed.length ? '' : 'ok');
        if (d.added.length) await testBatch(kind, d.added.map((x) => x.id));
      } catch (e) {
        box.innerHTML = `<b class="err">✕ 导入失败</b> ${esc(e.message)}`;
        toast(`导入失败：${e.message}`, 'err');
      }
    };
    input.click();
  };

  for (const kind of ['image', 'video']) {
    setupLib(kind);
    renderLib(kind);
    root.querySelector(`#cf-import-${kind}`).addEventListener('click', () => importLib(kind));
    root.querySelector(`#cf-testall-${kind}`).addEventListener('click', () =>
      testBatch(kind, (cfg[libKey(kind)] || []).map((e) => e.id)));
  }
```

- [ ] **Step 3: 语法与回归检查**

Run: `node --check public/panels.js && npm test`
Expected: `node --check` 无输出退出 0；测试 `# fail 0`。

- [ ] **Step 4: 提交**

```bash
git add public/panels.js
git commit -m "feat(ui): 多选批量导入 + 导入后自动串行试跑 + 测试全部（SSE 进度回显）"
```

---

### Task 8: 全量回归 + 规格手工验证清单

**Files:**
- 可能修复：以上任意文件（验证发现问题时）

- [ ] **Step 1: 自动化回归**

Run: `npm test && npm run check && node --check public/panels.js`
Expected: 全部 `# fail 0`、退出码 0。共 5 个测试文件（novel、novel-project、project-steps、comfy-lib 8 项、comfy-lib-api 5 项）。

- [ ] **Step 2: 准备测试素材**

```bash
printf '{"nodes":[],"links":[]}' > /tmp/界面格式.json
printf '{"1":{"class_type":"SaveImage","inputs":{"filename_prefix":"t"}}}' > /tmp/出图A.json
printf '{"1":{"class_type":"KSampler","inputs":{"seed":7,"steps":20}}}' > /tmp/出图B.json
```

- [ ] **Step 3: 启动服务并走手工清单**

Run: `./start.sh`（另开终端，地址默认 `http://127.0.0.1:45367`）

- [ ] **Step 4: 逐项验证（对应规格 8 条清单 + 本计划补充项）**

- [ ] 1. 打开设置 → 「本地 ComfyUI / 最终产物」页，两个库区块正常渲染（有项或空态）。
- [ ] 2. 出图库「⇧ 导入 JSON」多选 3 个素材文件 → toast `新增 2 · 失败 1`，`#cf-result` 中失败列表含「请使用导出(API)」类提示；库里出现 2 行「未测」徽标。
- [ ] 3. 导入后自动串行试跑：行内转圈 → 徽标变 `✓ 用时` / `✕ 错误`（tooltip 含错误）。ComfyUI 关闭时 → 显示「ComfyUI 连接失败」，徽标保持「未测」。
- [ ] 4. 点另一项单选 → toast 切换确认 → 检查 `data/comfyui.json` 中镜像 `imageWorkflow` 已变为选中项节点；跑一次出图（或看日志）确认用的是新工作流。
- [ ] 5. 双击名称改名 → Enter → toast；重开弹窗确认持久化；对**选中项**改名后确认 `imageWorkflowName` 同步。
- [ ] 6. 删除选中项 → 确认弹窗 → 确认后镜像清空、toast 提示已回退 Mock；再跑出图确认回退 Mock 自绘。删除非选中项无弹窗直接删。
- [ ] 7. 重启服务 → 库、选中态、lastTest 徽标全部保留。
- [ ] 8. 旧配置迁移：把 `data/comfyui.json` 中 4 个库字段删掉、保留 `imageWorkflow` 非空（或用备份），重启 → 打开设置确认它成为库第一项且已选中；重复重启不产生第二项。
- [ ] 9. 「▶ 测试全部」→ `#cf-result` 中 SSE 进度逐行回显（`▶ 试跑 1/2 ·…`），完成 toast `试跑完成：成功 N · 失败 M`；试跑期间行内显示「试跑中」转圈。
- [ ] 10. 同名不同内容重复导入 → 自动 `(2)` 后缀；同名同内容 → 失败列表报「已存在」。
- [ ] 11. 全程浏览器控制台无报错（特别是打开设置、保存设置两个动作）。

- [ ] **Step 5: 收尾提交（若有修复）**

```bash
# 仅当验证产生了修复改动时执行；按实际改动暂存具体文件
git add <改动的文件>
git commit -m "fix(comfy): 工作流库手工验证问题修复"
```

验证全部通过后，向用户汇报结果并勾掉规格 `2026-11-06-comfyui-workflow-library-design.md` 对应的验证清单。
