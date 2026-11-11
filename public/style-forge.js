/* ============================================================================
 * AI 导演风格设计师（全局对话框）
 *
 * 何时用：导演风格是**全局**资源（data/director-styles.json），不绑定某个项目。
 * 在项目工作台里点「✦ AI 新增导演风格」时，统一对话面板的风格档位接管
 * （草稿随会话留存，见 chat-panel.js / chat-hub.js）；
 * 只有在没有项目上下文的全局风格管理页里，才用这里的独立对话框。
 *
 * 协议：无状态草稿回传——每轮把「上一轮草稿 + 用户本轮发言」交给 LLM，
 * 返回合并后的完整草稿；ready 后一键保存。
 * ==========================================================================*/
import { openAIChat } from './ai-chat.js';

/** 节奏文案（与后端 style-forge-chat 的 draft 结构同口径） */
function paceText(pace = {}) {
  const mode = pace.mode || '';
  if (mode === 'fast') return '快切';
  if (mode === 'slow') return '长镜';
  if (mode === 'medium') return '中速';
  return '';
}

export function openForgeChat({ onSaved } = {}) {
  let draft = null;
  const chat = openAIChat({
    title: '✦ AI 导演风格设计师',
    subtitle: '对话式生成新导演风格：说说题材、基调、颜色、光线、运镜与节奏，我来补全成完整档案',
    placeholder: '描述你想要的导演风格（如「赛博朋克霓虹都市，冷蓝与洋红，手持快节奏」）…',
    welcome: {
      role: 'assistant',
      text: '我是导演风格设计师。告诉我你想要的画面长什么样——题材与故事气质、情绪基调、主色调（1~4 组颜色）、光线与构图偏好、运镜与节奏——信息越全，档案越准；缺的部分我会逐轮追问。完成后一键保存，新风格会直接出现在项目技能里。',
      suggestions: ['赛博朋克霓虹都市，冷蓝与洋红，手持快节奏', '唐代宫廷仕女画风，暖金与胭脂红，仪式感长镜', '黑白默片质感，高对比硬光，固定机位'],
    },
    onSend: async ({ history, ui }) => {
      try {
        const d = await request('/api/director-styles/chat', { messages: history, draft });
        draft = d.draft || draft;
        const done = !!d.ready;
        const lines = [`**风格草稿${done ? '已齐' : '进行中'}**`];
        const pal = (draft.palettes || []).map((p) => p.name).filter(Boolean);
        const got = [
          draft.label && `名称「${draft.label}」`,
          draft.director && `参考 ${draft.director}`,
          pal.length && `主色 ${pal.join(' / ')}`,
          draft.tone && `基调 ${draft.tone}`,
          draft.pace?.mode && `节奏 ${paceText(draft.pace)}`,
        ].filter(Boolean);
        if (got.length) lines.push(got.join(' · '));
        if (!done && d.missing?.length) lines.push(`还缺：${d.missing.join('、')}`);
        ui.addMessage({
          role: 'assistant',
          text: `${d.reply || ''}\n\n${lines.join('\n')}`,
          suggestions: d.suggestions,
          actions: done ? [
            { label: '💾 保存为导演风格', act: 'save', primary: true },
            { label: '↺ 再改一轮', act: 'keep' },
          ] : [{ label: '↺ 继续补充', act: 'keep' }],
        });
        if (d.fellBack) chat.addMessage({ role: 'assistant', text: '⚠ 模型调用失败，本轮由内置模板补齐（配置 LLM 档案后效果更好）。' });
      } catch (err) {
        ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` });
      }
    },
    actions: {
      save: async (ui) => {
        if (!draft) return ui.addMessage({ role: 'assistant', text: '✗ 还没有可保存的草稿，先聊出一份完整的风格。' });
        try {
          const d = await request('/api/director-styles', { style: draft });
          ui.addMessage({ role: 'assistant', text: `✓ ${d.message}。新风格已进入项目技能清单，工作台刷新后可见。`, suggestions: ['再做一个新风格', '关闭'] });
          draft = null;
          await onSaved?.(d.style);
        } catch (err) { ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
      },
      keep: async () => { /* 仅占位：让「继续补充」可点击且不报错 */ },
      close: async (ui) => { ui.close(); },
    },
  });
  return chat;
}

/** 极简 JSON 请求（风格接口不需要通用 api 包装） */
async function request(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
