// 画布侧 Agent：能读画布、能解释依赖、能整理布局、能真正长出分镜节点
import { autoLayout } from '../core/graph.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';
import { buildContext, getAgent } from '../core/agent.mjs';
import { emit } from '../core/events.mjs';

const byStatus = (nodes, s) => nodes.filter((n) => n.status === s).length;

function explain(project, target) {
  if (!target) return '请在指令里用 @节点ID 指定要解释的节点（点击节点后检查器里可复制 ID）。';
  const incoming = project.edges.filter((e) => e.to === target.id);
  const outgoing = project.edges.filter((e) => e.from === target.id);
  const desc = (list, dir) => list.map((e) => {
    const other = project.nodes.find((n) => n.id === (dir === 'in' ? e.from : e.to));
    const kindName = { flow: '数据流', anchor: '视觉锚点', ref: '资产引用' }[e.kind] || e.kind;
    return `· ${dir === 'in' ? '来自' : '流向'}「${other?.title || e.from}」（${kindName}）`;
  }).join('\n');
  return `「${target.title}」是 ${target.type} 节点，绑定智能体 ${target.agent || '无'}，当前状态 ${target.status}。\n上游依赖 ${incoming.length} 条：\n${desc(incoming, 'in') || '· 无（根节点）'}\n下游 ${outgoing.length} 条：\n${desc(outgoing, 'out') || '· 无'}\n\n视觉锚点（anchor）表示前驱镜头的关键帧会作为参考图传入后继镜头，这是保持角色与空间一致的关键；资产引用（ref）表示镜头复用了角色资产库里的定妆图。`;
}

function consistency(project) {
  const chars = project.nodes.filter((n) => n.type === 'character');
  const keys = project.nodes.filter((n) => n.type === 'keyframe');
  const anchors = project.edges.filter((e) => e.kind === 'anchor').length;
  const refs = project.edges.filter((e) => e.kind === 'ref').length;
  const orphan = keys.filter((k) => !project.edges.some((e) => e.to === k.id && (e.kind === 'ref' || e.kind === 'anchor')));
  const lines = [
    `角色资产节点：${chars.length} 个`,
    `关键帧节点：${keys.length} 个，其中 ${keys.length - orphan.length} 个继承了角色资产或视觉锚点`,
    `视觉锚点边：${anchors} 条；资产引用边：${refs} 条`,
  ];
  if (!keys.length) lines.push('当前还没有镜头链，建议先运行完整流水线，再来做一致性检查。');
  else if (orphan.length) lines.push(`⚠ ${orphan.length} 个关键帧没有任何参考锚点，跨镜头身份漂移风险较高：${orphan.slice(0, 3).map((n) => n.title).join('、')}`);
  else lines.push('✓ 所有关键帧都有参考锚点，身份与空间状态可沿依赖链传播。');
  return lines.join('\n');
}

export async function chatWithCanvas(project, message = '', modelId = '', onUsage = null) {
  const text = String(message).trim();
  const segments = [];
  let changed = false;
  let action = 'reply';
  const refs = [...text.matchAll(/@([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const target = refs.map((id) => project.nodes.find((n) => n.id === id)).find(Boolean);

  if (/整理|布局|排列|对齐|自动排|arrange/i.test(text)) {
    const pos = autoLayout(project.nodes, project.edges);
    let moved = 0;
    for (const n of project.nodes) {
      if (pos[n.id] && (Math.abs(n.x - pos[n.id].x) > 1 || Math.abs(n.y - pos[n.id].y) > 1)) {
        n.x = pos[n.id].x; n.y = pos[n.id].y; moved += 1;
      }
    }
    changed = true; action = 'arrange';
    segments.push(`已按拓扑分层重新排列 ${moved} 个节点：同一列的节点互不依赖、可并发生成，箭头方向就是数据 / 视觉锚点的传播方向。`);
  } else if (/一致|检查|漂移|审查|风险|consistency/i.test(text)) {
    segments.push(consistency(project));
  } else if (/解释|依赖|为什么|关系|上游|下游/i.test(text)) {
    segments.push(explain(project, target));
  } else if (/分镜|镜头|补.*镜|生成.*镜/i.test(text)) {
    const scene = (target?.type === 'scene' && target) || project.nodes.find((n) => n.type === 'scene');
    if (!scene) {
      segments.push('当前画布还没有场景节点。请先运行完整流水线，让「层次化叙事分解」长出事件与场景，再让我补镜头。');
    } else {
      const providers = createProviders(resolveModelSettings(project, modelId), () => {}, onUsage);
      const runState = { runId: 'chat', pending: new Set(), dirty: false };
      const ctx = buildContext({
        project, node: scene, inputs: [], upstream: [], providers,
        signal: new AbortController().signal, runState,
      });
      const agent = getAgent('storyboard');
      await agent.run(ctx);
      emit('node:status', { projectId: project.id, runId: 'chat', nodeId: scene.id, status: 'done', progress: 1 });
      changed = true; action = 'storyboard';
      segments.push(`已为「${scene.title}」补出 ${scene.data?.shots?.length || 0} 个镜头，并在画布上生成「镜头规格 → 关键帧 → VLM 择优 → 视频片段」的完整链路，跨机位处还插入了转场空间锚点。点击顶栏「运行完整流水线」即可逐节点生成内容。`);
    }
  } else if (/状态|进度|概览|到哪|多少|总结|summary/i.test(text)) {
    const n = project.nodes.length;
    segments.push(`项目「${project.name}」共 ${n} 个节点、${project.edges.length} 条连线。\n完成 ${byStatus(project.nodes, 'done')} · 待运行 ${byStatus(project.nodes, 'idle')} · 失败 ${byStatus(project.nodes, 'error')} · 跳过 ${byStatus(project.nodes, 'skipped')}。\n已生成 ${project.nodes.filter((x) => x.type === 'video' && x.data?.clip).length} 个镜头片段，视觉锚点 ${project.edges.filter((e) => e.kind === 'anchor').length} 条。\n${byStatus(project.nodes, 'error') ? '有失败节点，建议右键「从此处重跑」。' : byStatus(project.nodes, 'idle') ? '还有未完成节点，点顶栏「运行完整流水线」继续。' : '全部节点已完成。'}`);
  } else if (/下一步|接下来|建议|该做什么|next/i.test(text)) {
    const next = project.nodes.find((x) => x.status === 'idle' && x.agent);
    segments.push(next
      ? `建议下一步运行「${next.title}」（${next.agent}）。它是当前拓扑里最靠前的待执行节点；如果想只重做某一段，右键该节点选「从此处重跑」。`
      : '没有待执行节点了。可以修改创意后重跑，或让我「整理画布」「检查一致性」。');
  } else {
    segments.push(`我是画布协作者，能读到这张图的 ${project.nodes.length} 个节点与 ${project.edges.length} 条连线。可以试试：\n· 「整理画布」— 按依赖拓扑自动布局\n· 「检查一致性」— 找出没有视觉锚点的镜头\n· 「@${project.nodes[0]?.id || '节点ID'} 解释依赖」— 讲清某节点的上游下游\n· 「给场景补 4 个镜头」— 真正长出镜头链\n· 「项目进度」「下一步做什么」`);
  }
  return { segments, changed, action };
}
