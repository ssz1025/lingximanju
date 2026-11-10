/* 画布组合纯函数单测：单集种子画布 / 全项目组合总览 / 范围标签与下拉选项
 * 覆盖：合法 type、id 稳定唯一、历史数据兜底、不泄漏原文全文、组合图无悬空边、
 *      统计计数、>600 节点裁剪、label/options 分组与空项目兜底、纯函数不可变。
 * 运行：node --test tests/canvas-compose.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedEpisodeCanvas,
  composeOverallCanvas,
  canvasScopeLabel,
  canvasScopeOptions,
  syncEpisodeCanvasResources,
  syncMainCanvasCharacterAssets,
} from '../public/canvas-compose.js';
import { scopeKeyOf, parseScopeKey } from '../public/project-model.js';

const LEGAL_TYPES = new Set([
  'idea', 'script', 'rag', 'plan', 'episode', 'event', 'scene', 'shot',
  'character', 'camera', 'keyframe', 'review', 'video', 'transition', 'final', 'note',
]);

// 原文全文标记：任何节点 data 都不应出现它（只允许标题 / ≤120 字摘要）
const MARKER = 'NEVER_LEAK_ORIGINAL_PARAGRAPH_';
const LONG_TEXT = MARKER.repeat(400) + '雨夜原文长段落'.repeat(900);

function handCanvas() {
  const node = (id, type, title, x, status = 'idle') => ({
    id, type, agent: null, title, x, y: 60, w: 268, status, progress: 0, error: '', data: {}, meta: {},
  });
  return {
    nodes: [
      node('hw_root', 'episode', '手写根节点', 60, 'done'),
      node('hw_note', 'note', '手写便签', 380),
      node('hw_final', 'final', '手写结尾', 720),
    ],
    edges: [
      { id: 'hw_e1', from: 'hw_root', to: 'hw_note', kind: 'flow' },
      { id: 'hw_e2', from: 'hw_note', to: 'hw_final', kind: 'flow' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** 两季 3 集：ep1 带手写 canvas、ep2 无 canvas、ep3 为全空老数据 */
function makeProject() {
  return {
    id: 'prj_canvas', name: '雨夜侦探', mode: 'novel',
    nodes: [], edges: [],
    viewport: { x: 80, y: 60, zoom: 0.8 },
    management: {
      kind: 'novel',
      source: { text: LONG_TEXT },
      seasons: [{ no: 1, title: '第一季 · 迷雾' }, { no: 2, title: '第二季 · 真相' }],
      episodes: [
        {
          no: 1, title: '雨夜来信', season: 1, chars: 3200,
          summary: '侦探收到一封神秘来信', hook: '来老地方',
          sourceTitles: ['第一章 雨夜来信', '第二章 旧案卷宗'],
          text: LONG_TEXT,
          chapters: [
            { no: 1, title: '第一章 雨夜来信', text: LONG_TEXT },
            { no: 2, title: '第二章 旧案卷宗', text: LONG_TEXT },
          ],
          segments: [
            { no: 1, title: '开场 · 雨夜', text: LONG_TEXT, chars: 400, cells: 6, gridUrl: '/assets/grid_1.png' },
            { no: 2, title: '侦探登场', text: LONG_TEXT, chars: 380, cells: 4 },
          ],
          script: { scenes: [{}] }, characterIds: ['c1', 'c2'],
          pack: { url: '/assets/pack.zip' }, video: { url: '/assets/v.mp4' },
          canvas: handCanvas(),
        },
        {
          no: 2, title: '咖啡馆密谈', season: 1, chars: 2800,
          summary: '两人在咖啡馆交换线索', hook: '窗外有人',
          sourceTitles: ['第三章 咖啡馆'], text: LONG_TEXT,
          chapters: [{ no: 1, title: '第三章 咖啡馆', text: LONG_TEXT }],
          segments: [
            { no: 1, title: '密谈', text: LONG_TEXT, chars: 300, cells: 5, gridUrl: '/assets/grid_2.png' },
          ],
          script: null, characterIds: [], pack: null, video: null,
        },
        {
          // 老数据：text / chapters / segments 全空，无 canvas
          no: 3, title: '真相浮现', season: 2, chars: 0,
          summary: '', hook: '', sourceTitles: [], text: '',
          chapters: [], segments: [],
          script: null, characterIds: [], pack: null, video: null,
        },
      ],
      chapters: [], characters: [],
    },
  };
}

/** 每集一个 350 节点的手写大画布，用于触发 >600 节点裁剪 */
function bigCanvas(tag) {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 350; i += 1) {
    nodes.push({
      id: `${tag}_n_${i}`, type: 'note', agent: null, title: `节点 ${i}`,
      x: (i % 5) * 300, y: Math.floor(i / 5) * 140, w: 268,
      status: 'idle', progress: 0, error: '', data: {}, meta: {},
    });
    if (i > 0) {
      edges.push({ id: `${tag}_e_${i}`, from: `${tag}_n_${i - 1}`, to: `${tag}_n_${i}`, kind: 'flow' });
    }
  }
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function bigProject() {
  return {
    id: 'prj_big', name: '超大项目',
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    management: {
      kind: 'novel',
      seasons: [{ no: 1, title: '第一季' }, { no: 2, title: '第二季' }],
      episodes: [
        { no: 1, title: '甲', season: 1, canvas: bigCanvas('a') },
        { no: 2, title: '乙', season: 1, canvas: bigCanvas('b') },
        { no: 3, title: '丙', season: 2, canvas: bigCanvas('c') },
      ],
    },
  };
}

const ids = (list) => list.map((x) => x.id);
const noDangling = (canvas) => {
  const set = new Set(ids(canvas.nodes));
  return canvas.edges.every((e) => set.has(e.from) && set.has(e.to));
};

/* ------------------------------------------------------------------------ */
test('1. seedEpisodeCanvas：节点/边 > 0、id 稳定唯一、合法 type、不泄漏原文、不改入参', () => {
  const project = makeProject();
  const before = JSON.stringify(project);
  const seed = seedEpisodeCanvas(project, 2);
  const again = seedEpisodeCanvas(project, 2);

  assert.ok(seed.nodes.length > 0, '节点数 > 0');
  assert.ok(seed.edges.length > 0, '边数 > 0');
  assert.deepEqual(seed, again, '连续两次调用结果 deepEqual（id 稳定可重复）');

  const nodeIds = ids(seed.nodes);
  const edgeIds = ids(seed.edges);
  assert.equal(new Set(nodeIds).size, nodeIds.length, '节点 id 唯一');
  assert.equal(new Set(edgeIds).size, edgeIds.length, '边 id 唯一');

  for (const n of seed.nodes) {
    assert.ok(LEGAL_TYPES.has(n.type), `type 合法：${n.type}`);
    assert.equal(n.w, 268);
    assert.ok(['idle', 'done'].includes(n.status));
    assert.equal(n.meta.scope, 'episode');
    assert.equal(n.meta.episodeNo, 2);
    assert.deepEqual(n.data.scopeRef, { kind: 'episode', no: 2 });
    if (typeof n.data.text === 'string') {
      assert.ok(n.data.text.length <= 120, 'note 的 data.text ≤120 字');
    }
  }
  assert.ok(noDangling(seed), 'seed 内部边无悬空端点');

  const root = seed.nodes.find((n) => n.id === 'ep_2_root');
  const finalNode = seed.nodes.find((n) => n.id === 'ep_2_final');
  assert.ok(root && root.type === 'episode', 'root 节点存在');
  assert.equal(root.data.episodeNo, 2);
  assert.equal(root.data.episode.no, 2);
  assert.ok(Array.isArray(root.data.episode.sourceTitles));
  assert.ok(finalNode && finalNode.type === 'final', 'final 节点存在');

  // ep2 的 script/pack/video 为空 -> idle；ep1 有产物 -> done
  assert.equal(seed.nodes.find((n) => n.type === 'script').status, 'idle');
  const seed1 = seedEpisodeCanvas(project, 1);
  assert.equal(seed1.nodes.find((n) => n.type === 'script').status, 'done');
  assert.equal(seed1.nodes.find((n) => n.id === 'ep_1_pack').status, 'done');
  assert.equal(seed1.nodes.find((n) => n.id === 'ep_1_video').status, 'done');

  const json = JSON.stringify(seed);
  assert.ok(json.length < 20000, '序列化长度 < 20000');
  assert.ok(!json.includes(MARKER), '不得出现原文长段落标记');
  assert.equal(JSON.stringify(project), before, '不得修改入参 project / ep');
});

test('2. 老数据兜底：chapters/segments/text 全空不抛异常，仍生成 root 与 final', () => {
  const project = makeProject();
  let seed;
  assert.doesNotThrow(() => { seed = seedEpisodeCanvas(project, 3); });
  assert.ok(seed.nodes.some((n) => n.id === 'ep_3_root'), 'root 存在');
  assert.ok(seed.nodes.some((n) => n.id === 'ep_3_final'), 'final 存在');
  // 章节回退到 1 条「本集原文」，分段回退到 1 个「待分镜」
  assert.equal(seed.nodes.filter((n) => n.type === 'note').length, 1);
  assert.equal(seed.nodes.filter((n) => n.type === 'scene').length, 1);
  assert.ok(noDangling(seed));
  assert.ok(!JSON.stringify(seed).includes(MARKER));
});

test('3. composeOverallCanvas：id 全局唯一、无悬空边、每个节点有 scopeRef、跨集 ref、stats 正确、不改入参', () => {
  const project = makeProject();
  const before = JSON.stringify(project);
  const out = composeOverallCanvas(project);

  const nodeIds = ids(out.nodes);
  assert.equal(new Set(nodeIds).size, nodeIds.length, '组合图节点 id 全局唯一');
  assert.ok(noDangling(out), '所有边 from/to 都能在 nodes 里找到');

  for (const n of out.nodes) {
    assert.ok(n.data.scopeRef, '每个节点都有 data.scopeRef');
    assert.ok(['season', 'episode'].includes(n.data.scopeRef.kind));
    if (n.data.scopeRef.kind === 'episode') {
      assert.equal(typeof n.data.sourceNodeId, 'string', '单集节点带 sourceNodeId');
    }
  }

  const crossLinks = out.edges.filter((e) => e.kind === 'ref' && e.id.startsWith('cp_link_'));
  assert.ok(crossLinks.length > 0, '存在跨集 ref 衔接边');
  assert.ok(crossLinks.every((e) => new Set(nodeIds).has(e.from) && new Set(nodeIds).has(e.to)));

  assert.ok(out.nodes.some((n) => n.id === 'cp_season_1' && n.data.scopeRef.kind === 'season'));
  assert.ok(out.nodes.some((n) => n.id === 'cp_season_2' && n.data.scopeRef.kind === 'season'));
  assert.deepEqual(out.viewport, { x: 40, y: 40, zoom: 0.45 });

  assert.equal(out.stats.seasonCount, 2);
  assert.equal(out.stats.episodeCount, 3);
  assert.equal(out.stats.seededCount, 2, 'ep2 / ep3 无 canvas，临时 seed 且不写回');
  assert.equal(out.stats.nodeCount, out.nodes.length);
  assert.equal(out.stats.edgeCount, out.edges.length);
  assert.equal(JSON.stringify(project), before, '不得修改入参 project（尤其不写回 ep.canvas）');
  assert.equal(project.management.episodes[1].canvas, undefined, 'ep2 的 canvas 字段仍不存在');
});

test('4. 节点超过 600 触发裁剪，且裁剪后仍无悬空边', () => {
  const project = bigProject();
  const before = JSON.stringify(project);
  const out = composeOverallCanvas(project);

  // 3 集 × 40 + 2 个季标题 = 122
  assert.equal(out.nodes.length, 122, '每集仅保留前 40 个节点');
  assert.equal(out.stats.nodeCount, 122);
  assert.ok(out.nodes.length < 350 * 3 + 2, '确实发生了裁剪');
  assert.ok(noDangling(out), '裁剪后无悬空边（引用被丢弃节点的边已过滤）');
  assert.ok(out.nodes.every((n) => n.data.scopeRef));
  assert.ok(out.edges.some((e) => e.id.startsWith('cp_link_')), '裁剪后跨集衔接仍存在');
  assert.equal(JSON.stringify(project), before, '不得修改入参');
});

test('5. canvasScopeLabel / canvasScopeOptions：三种 key、分组顺序、空项目兜底', () => {
  const project = makeProject();

  assert.equal(canvasScopeLabel(project, scopeKeyOf('overall')), '全部 · 组合画布');
  assert.equal(canvasScopeLabel(project, scopeKeyOf('main')), '项目主画布');
  const ep1 = canvasScopeLabel(project, scopeKeyOf('episode', 1));
  assert.ok(ep1.includes('第 1 集'));
  assert.ok(ep1.startsWith('第一季 · 迷雾 · '), '多季项目加季标题前缀');
  assert.equal(canvasScopeLabel(project, scopeKeyOf('episode', 99)), '第 99 集', '找不到集回退');

  // parseScopeKey 与 scopeKeyOf 互逆
  assert.deepEqual(parseScopeKey(scopeKeyOf('episode', 2)), { kind: 'episode', no: 2 });
  assert.deepEqual(parseScopeKey(scopeKeyOf('overall')), { kind: 'overall', no: 0 });
  assert.deepEqual(parseScopeKey(scopeKeyOf('main')), { kind: 'main', no: 0 });

  const options = canvasScopeOptions(project);
  assert.deepEqual(options.map((o) => o.key), ['overall', 'main', '', 'ep:1', 'ep:2', '', 'ep:3']);
  assert.equal(options[0].group, '总览');
  assert.equal(options[1].group, '总览');
  for (const o of options.filter((x) => x.divider)) {
    assert.equal(o.key, '');
    assert.equal(o.group, '分季');
    assert.equal(o.divider, true);
  }
  for (const o of options.filter((x) => x.key.startsWith('ep:'))) {
    assert.equal(o.group, '分集');
    assert.ok(o.label.includes(`第 ${parseScopeKey(o.key).no} 集`));
  }
  assert.deepEqual(options.filter((x) => x.divider).map((x) => x.label), ['第一季 · 迷雾', '第二季 · 真相']);

  // 空项目：options 仍有 overall/main，label 与 compose 安全兜底
  const empty = { management: { kind: 'novel', episodes: [] } };
  const emptyOptions = canvasScopeOptions(empty);
  assert.deepEqual(emptyOptions.map((o) => o.key), ['overall', 'main']);
  assert.equal(canvasScopeLabel(empty, scopeKeyOf('episode', 5)), '第 5 集');
  const emptyOut = composeOverallCanvas(empty);
  assert.deepEqual(emptyOut.nodes, []);
  assert.deepEqual(emptyOut.edges, []);
  assert.deepEqual(emptyOut.stats, { seasonCount: 0, episodeCount: 0, nodeCount: 0, edgeCount: 0, seededCount: 0 });
  assert.deepEqual(emptyOut.viewport, { x: 40, y: 40, zoom: 0.45 });
});

test('6. 纯函数不可变：调用全部函数前后 JSON.stringify(project) 完全一致', () => {
  const project = makeProject();
  const before = JSON.stringify(project);
  seedEpisodeCanvas(project, 1);
  seedEpisodeCanvas(project, 2);
  composeOverallCanvas(project);
  composeOverallCanvas(project);
  canvasScopeLabel(project, scopeKeyOf('episode', 3));
  canvasScopeOptions(project);
  assert.equal(JSON.stringify(project), before);

  const big = bigProject();
  const bigBefore = JSON.stringify(big);
  composeOverallCanvas(big);
  assert.equal(JSON.stringify(big), bigBefore);
});

/* ------------------------------------------------------------------------
 * 7-9. syncEpisodeCanvasResources：新分镜板 / 角色定妆图同步进画布
 * ----------------------------------------------------------------------*/

function portraitProject() {
  const project = makeProject();
  const m = project.management;
  m.characters = [
    { id: 'c1', name: '林澈', role: '主角', aliases: ['阿澈'], views: { front: { url: '/assets/char_c1_front.png' } } },
    { id: 'c2', name: '苏眉', role: '配角', aliases: [], views: { side: { url: '/assets/char_c2_side.png' } } },
    { id: 'c9', name: '路人甲', role: '龙套', aliases: [], views: {} },
  ];
  return project;
}

test('7. syncEpisodeCanvasResources：播种画布自动补齐分镜板节点与连线，幂等且不写入 ep.canvas', () => {
  const project = portraitProject();
  const before = JSON.stringify(project);
  const first = syncEpisodeCanvasResources(project, 2);
  assert.equal(first.changed, true, '首次播种 / 同步 changed=true');

  const { canvas } = first;
  // ep2 的第 1 段有 gridUrl → 自动补 keyframe 节点 + 段→分镜板 flow 边
  const grid = canvas.nodes.find((n) => n.id === 'ep_2_grid_1');
  assert.ok(grid, '分镜板节点已补进画布');
  assert.equal(grid.type, 'keyframe');
  assert.equal(grid.data.url, '/assets/grid_2.png');
  assert.equal(grid.status, 'done');
  const gridEdge = canvas.edges.find((e) => e.id === 'ep_2_e_seggrid_1');
  assert.ok(gridEdge && gridEdge.from === 'ep_2_seg_1' && gridEdge.to === 'ep_2_grid_1', '段 → 分镜板自动连线');
  assert.ok(noDangling(canvas), '同步后无悬空边');
  for (const n of canvas.nodes) {
    assert.equal(n.meta.scope, 'episode');
    assert.deepEqual(n.data.scopeRef, { kind: 'episode', no: 2 });
  }

  // 幂等：app.js 会把 synced.canvas 写回 ep.canvas 并落盘，之后再同步应无变化
  assert.equal(JSON.stringify(project), before, '纯函数：首次同步不写回 project / ep.canvas');
  project.management.episodes[1].canvas = first.canvas;   // 模拟调用方写回
  const second = syncEpisodeCanvasResources(project, 2);
  assert.equal(second.changed, false, '与已持久化画布一致时 changed=false');
  assert.deepEqual(second.canvas, first.canvas, '两次结果 deepEqual');
});

test('8. 角色定妆图同步：characterIds 精确关联 → 角色节点 + ref 连线 + 资产节点缩略图；取消关联后清理', () => {
  const project = portraitProject();
  // ep2 用 seed 画布（带资产节点）：给 ep2 精确关联 c1/c2；c1 有正面定妆图，c2 只有侧面，c9 未关联不出现
  project.management.episodes[1].characterIds = ['c1', 'c2'];
  const { canvas } = syncEpisodeCanvasResources(project, 2);

  const chr1 = canvas.nodes.find((n) => n.id === 'ep_2_chr_c1');
  const chr2 = canvas.nodes.find((n) => n.id === 'ep_2_chr_c2');
  assert.ok(chr1 && chr1.type === 'character' && chr1.data.url === '/assets/char_c1_front.png', 'c1 定妆图节点');
  assert.ok(chr2 && chr2.data.url === '/assets/char_c2_side.png', 'c2 无正面图时回退任一视图');
  assert.ok(!canvas.nodes.some((n) => String(n.id).startsWith('ep_2_chr_c9')), '未关联角色不生成节点');

  const edge1 = canvas.edges.find((e) => e.id === 'ep_2_e_charasset_c1');
  assert.ok(edge1 && edge1.kind === 'ref' && edge1.to === 'ep_2_chr_c1', '资产 → 角色 ref 连线');
  assert.ok(noDangling(canvas), '无悬空边');

  const asset = canvas.nodes.find((n) => n.id === 'ep_2_character');
  assert.ok(asset, '角色资产节点存在');
  assert.equal(asset.data.count, 2);
  assert.deepEqual(asset.data.characters.map((c) => c.name), ['林澈', '苏眉']);
  assert.equal(asset.data.characters[0].portraitUrl, '/assets/char_c1_front.png');
  assert.equal(asset.status, 'done', '有定妆图后资产节点点亮');

  // 取消关联后：chr 节点与连线被清理，无悬空边
  project.management.episodes[1].characterIds = ['c2'];
  const after = syncEpisodeCanvasResources(project, 2);
  assert.ok(!after.canvas.nodes.some((n) => n.id === 'ep_2_chr_c1'), '取消关联的角色节点已清理');
  assert.ok(!after.canvas.edges.some((e) => e.id === 'ep_2_e_charasset_c1'), '对应连线已清理');
  assert.ok(noDangling(after.canvas));
});

test('9. 重切分段后清理多余节点；主画布角色资产节点同步缩略图；组合总览实时包含新资源', () => {
  const project = portraitProject();
  // ep1 手搭画布没有分段节点：首次同步补出 2 段 + 第 1 段的分镜板
  const first = syncEpisodeCanvasResources(project, 1).canvas;
  assert.ok(first.nodes.some((n) => n.id === 'ep_1_seg_2'), '同步补齐缺失的分段节点');
  assert.ok(first.nodes.some((n) => n.id === 'ep_1_grid_1'), '同步补齐分镜板节点');
  // 重切成 1 段且撤掉分镜图 → seg_2 / grid_1 应被清理
  project.management.episodes[0].segments = [{ no: 1, title: '重切后唯一段', chars: 300, cells: 5 }];
  const resync = syncEpisodeCanvasResources(project, 1);
  assert.ok(!resync.canvas.nodes.some((n) => ['ep_1_seg_2', 'ep_1_grid_1'].includes(n.id)), '失效自动节点被清理');
  assert.ok(noDangling(resync.canvas));

  // 主画布：character 类型节点同步 data.characters（缩略图由 nodes.js 渲染）
  project.nodes = [{
    id: 'main_char', type: 'character', agent: 'character', title: '角色资产库',
    x: 700, y: 400, w: 268, status: 'idle', progress: 0, error: '', data: {}, meta: {},
  }];
  assert.equal(syncMainCanvasCharacterAssets(project), true, '首次同步有变化');
  const mainChar = project.nodes[0];
  assert.equal(mainChar.data.count, 3);
  assert.equal(mainChar.data.characters.length, 3);
  assert.equal(mainChar.status, 'done');
  assert.equal(syncMainCanvasCharacterAssets(project), false, '重复调用无变化');

  // 组合总览：实时反映最新资源（重切后的 ep1 不再出现旧分镜板，角色定妆图节点在列）
  const overall = composeOverallCanvas(project);
  assert.ok(!overall.nodes.some((n) => n.id === 'cp_1_ep_1_grid_1'), '组合总览不含已失效的分镜板节点');
  assert.ok(overall.nodes.some((n) => n.id === 'cp_1_ep_1_chr_c1'), '组合总览包含角色定妆图节点');
  assert.ok(noDangling(overall));
});
