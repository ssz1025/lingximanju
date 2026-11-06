// 流水线模板：生成的不是硬编码流程，而是一张用户可任意改写的初始画布图
import { makeNode, makeEdge } from '../core/agent.mjs';
import { uid } from '../core/store.mjs';

export const TEMPLATE_META = [
  { id: 'idea2video', name: '一句话 → 成片', icon: '✦', description: '从创意出发，自动编剧、分层规划、出图、出片', badge: '推荐' },
  { id: 'script2video', name: '剧本 → 成片', icon: '▤', description: '已有剧本，跳过编剧直接做分镜与视觉一致性', badge: '' },
  { id: 'novel2video', name: '小说 → 分集', icon: '▥', description: '长文本先压缩为事件图谱，再用 RAG 保持角色与设定', badge: '进阶' },
];

const DEMO_IDEA = '雨夜，一位侦探收到一封没有署名的信，信里只有一张旧码头的照片。';

const DEMO_SCRIPT = {
  title: '雨夜来信', genre: '悬疑 / 黑色电影',
  logline: '一封没有署名的信，把侦探引向旧码头的陈年旧案。',
  characters: [
    { name: '沈砚', role: '私家侦探', appearance: '深色风衣、略显疲惫的眼神、左手旧怀表' },
    { name: '林夏', role: '调查记者', appearance: '短发、米色风衣、随身相机' },
  ],
  scenes: [
    { id: 'sc_1', location: '雨夜旧城区 · 巷口', time: '深夜', summary: '一封没有署名的信把侦探引到案发地', script: ['【深夜 · 巷口】', '雨水顺着霓虹灯牌滴落，沈砚展开信纸。', '沈砚：「这张照片，是十年前拍的。」'] },
    { id: 'sc_2', location: '警局审讯室', time: '凌晨', summary: '证词里出现无法解释的时间差', script: ['【凌晨 · 审讯室】', '林夏把照片推到灯下。', '林夏：「他说那天根本没下过雨。」'] },
  ],
};

export function buildTemplate(id = 'idea2video', opts = {}) {
  const tpl = TEMPLATE_META.find((t) => t.id === id) || TEMPLATE_META[0];
  const style = opts.style || (id === 'novel2video' ? 'watercolor' : 'noir');
  const sceneLimit = id === 'novel2video' ? 3 : 2;
  const shotsPerScene = id === 'script2video' ? 4 : 3;
  const ideaText = opts.idea || (id === 'novel2video'
    ? `${DEMO_IDEA} 此后十年，城中陆续出现同样的信封。沈砚与林夏沿着旧码头的线索，一步步翻出被掩埋的真相。`
    : DEMO_IDEA);

  const idea = makeNode({
    type: 'idea', agent: null, status: 'done', title: '创意输入', x: 60, y: 220,
    data: { text: ideaText, summary: '双击节点可修改创意，然后从此处重跑', kind: '输入' },
  });
  const script = makeNode({
    type: 'script', agent: id === 'script2video' ? null : 'screenwriter',
    status: id === 'script2video' ? 'done' : 'idle',
    title: id === 'script2video' ? '既有剧本' : '剧本生成',
    x: 380, y: 220,
    data: id === 'script2video'
      ? { text: ideaText, script: DEMO_SCRIPT, summary: `${DEMO_SCRIPT.scenes.length} 场 · ${DEMO_SCRIPT.characters.length} 位角色（可编辑）` }
      : { text: ideaText, summary: '等待编剧智能体…' },
  });
  const rag = makeNode({
    type: 'rag', agent: 'rag', title: id === 'novel2video' ? '原著索引 / RAG' : '全局上下文 / RAG',
    x: 700, y: 60, data: { summary: '索引原文，为分解后的节点补全上下文' },
  });
  const characters = makeNode({
    type: 'character', agent: 'character', title: '角色资产库', x: 700, y: 400,
    data: { summary: '三视图定妆，供所有镜头以 ref 边复用' },
  });
  const plan = makeNode({
    type: 'plan', agent: 'decomposer', title: '层次化叙事分解', x: 1020, y: 60,
    data: { sceneLimit, shotsPerScene, summary: `事件 → 场景 → 镜头 · 预计 ${sceneLimit} 场景 × ${shotsPerScene} 镜头` },
  });
  const camera = makeNode({
    type: 'camera', agent: 'camera-graph', title: '机位依赖图', x: 1340, y: 400,
    data: { join: { type: 'video', min: 1 }, summary: '汇总视觉锚点、并行层与一致性报告' },
  });
  const final = makeNode({
    type: 'final', agent: 'composer', title: '成片时间线', x: 1660, y: 220,
    data: { join: { type: 'video', min: 1 }, summary: '所有镜头片段就绪后自动组装' },
  });
  const note = makeNode({
    type: 'note', agent: null, status: 'done', title: '使用说明', x: 60, y: 470,
    data: {
      text: '① 点顶栏「运行完整流水线」看画布自动生长\n② 拖动节点 / 滚轮缩放 / 空白拖拽框选\n③ 右键任一节点可单独重跑\n④ 右侧切换「节点属性 / Agent 对话」\n⑤ 在设置里填 API Key 可切到真实模型',
      summary: '无限画布 · 智能体制片',
    },
  });

  const nodes = [idea, script, rag, characters, plan, camera, final, note];
  const edge = (a, b, kind = 'flow') => makeEdge(a.id, b.id, kind);
  const edges = [
    edge(idea, script), edge(script, rag), edge(script, characters),
    edge(rag, plan), edge(plan, camera), edge(camera, final),
  ];

  return {
    id: uid('prj'),
    name: opts.name || (id === 'script2video' ? '雨夜来信 · 剧本改编' : id === 'novel2video' ? '雨夜来信 · 小说分集' : '雨夜侦探'),
    mode: tpl.id,
    createdAt: Date.now(), updatedAt: Date.now(),
    viewport: { x: 80, y: 60, zoom: 0.72 },
    settings: {
      provider: 'mock', baseUrl: '', apiKey: '', model: '', imageEndpoint: '', videoEndpoint: '',
      k: 2, concurrency: 3, style, aspect: '16:9',
      ...(opts.settings || {}),
    },
    nodes, edges, runs: [],
  };
}
