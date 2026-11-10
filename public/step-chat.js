/* ============================================================================
 * 工作台「分步对话」前端：每一步都能打开一个对话，用一句话改这一步的事
 *
 * 与 cover / ai-chat 的关系：复用 ai-chat.js 的气泡与输入组件（零依赖、零重复实现），
 * 这里只负责
 *  ① 把服务端已存的历史消息回填（用户要求「所有对话记录保留」）
 *  ② 在对话顶部挂一条 token 账目（执行 / 对话 / 合计 + 运行次数），随时可展开明细
 *  ③ 发送后把 Agent 回复、建议 chips、产物链接渲染出来，并在改动后通知外层刷新步骤面板
 * ==========================================================================*/
import { openAIChat } from './ai-chat.js';
import { esc } from './utils.js';

/** 各步输入框的占位示例：让用户一眼知道「这一步能说什么」 */
const PLACEHOLDERS = {
  upload: '把片名改成《雨夜便利店》，类型悬疑，画风用冷调水墨',
  episodes: '按 1200 字一集，最多 4 集，重新拆',
  script: '重新生成第 2 集剧本，基调更冷峻',
  context: '把林晚改成：月白长裙、清冷眉眼',
  storyboard: '做成 45 秒短剧，每个片段 3 秒',
  deliver: '只要导演包，不要成片视频',
  project: '现在做到哪一步了？',
};

const fmtTok = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/** token 账目条：执行与对话分开显示，合计才是该步总账 */
function barHTML(tok) {
  const exec = tok?.exec || {};
  const chat = tok?.chat || {};
  const sum = tok?.sum || {};
  const none = !(sum.total || sum.calls);
  return `<div class="scbar">
    <span class="scbar-t">Token</span>
    <span class="scbar-i" title="执行本步（含对话触发的重跑）累计消耗">执行 <b>${fmtTok(exec.total)}</b><small>${exec.calls || 0} 次</small></span>
    <span class="scbar-i" title="在本步对话里产生的 LLM 消耗">对话 <b>${fmtTok(chat.total)}</b><small>${chat.calls || 0} 次</small></span>
    <span class="scbar-i total" title="执行 + 对话">合计 <b>${fmtTok(sum.total)}</b><small>入 ${fmtTok(sum.prompt)} / 出 ${fmtTok(sum.completion)}</small></span>
    <span class="scbar-grow"></span>
    <button class="scbar-btn" data-scbar="detail" ${none ? 'disabled' : ''}>运行明细</button>
    <button class="scbar-btn" data-scbar="export">导出记录</button>
  </div>`;
}

/** 运行明细：每次运行的时间 / 触发方式 / 结果 / token / 耗时 */
function detailText(step) {
  if (!step) return '本步还没有 token 记录：先执行一次，或让 Agent 重跑一次。';
  const lines = [
    `第 ${step.no} 步「${step.title}」`,
    `执行 ${fmtTok(step.exec.total)} tok（输入 ${fmtTok(step.exec.prompt)} / 输出 ${fmtTok(step.exec.completion)}）· ${step.exec.calls} 次调用`,
    `对话 ${fmtTok(step.chat.total)} tok · ${step.chat.calls} 次调用`,
    `合计 ${fmtTok(step.sum.total)} tok · 共运行 ${step.runs} 次`,
  ];
  if (step.runLog?.length) {
    lines.push('', '运行明细（最近在前）：');
    for (const it of step.runLog.slice(0, 10)) {
      const at = new Date(it.at).toLocaleString('zh-CN', { hour12: false });
      const how = it.action === 'chat' ? '对话触发' : it.action === 'auto' ? '自动' : '手动';
      lines.push(`· ${at} · ${how} · ${it.ok ? '成功' : '失败'} · ${fmtTok(it.tokens?.total || 0)} tok · ${((it.durationMs || 0) / 1000).toFixed(1)}s`);
    }
  }
  return lines.join('\n');
}

/**
 * 打开某一步的对话页。
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} o.projectName
 * @param {string} o.stepId   upload|episodes|script|context|storyboard|deliver|project
 * @param {string} o.label    标题（如「第 3 步 · 剧本生成与格式统一」）
 * @param {Function} [o.onChanged] 改动后回调（外层据此刷新步骤面板 / 画布）
 */
export function openStepChat(o = {}) {
  const { projectId, projectName = '', stepId, label = '分步对话', onChanged = null } = o;
  const base = `/api/projects/${projectId}/steps/${stepId}/chat`;
  let lastTokens = null;

  const chat = openAIChat({
    title: `💬 ${label}`,
    subtitle: `${projectName} · 在这里直接改这一步`,
    placeholder: `说一句要改什么，例如「${PLACEHOLDERS[stepId] || PLACEHOLDERS.project}」…`,
    onSend: async ({ text, ui }) => {
      ui.setBusy(true, 'Agent 正在处理这一步…（重跑步骤可能要几十秒）');
      try {
        const d = await api(base, { message: text });
        ui.addMessage({
          role: 'assistant',
          text: d.reply,
          suggestions: d.suggestions || [],
          links: (d.artifacts || []).map((a) => ({ label: a.label, url: a.url })),
        });
        if (d.context?.tokens) { lastTokens = d.context.tokens; paintBar(); }
        if (d.changed) onChanged?.(d);
      } catch (err) {
        ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` });
      } finally {
        ui.setBusy(false);
      }
    },
  });

  /* ---------- 顶层 token 账目条：插在消息列表上方 ---------- */
  const bars = document.querySelectorAll('.page-content.chat .aichat-list');
  const list = bars[bars.length - 1];
  let barEl = null;
  function paintBar() {
    if (!barEl || !lastTokens) return;
    barEl.innerHTML = barHTML({
      exec: lastTokens.exec || {}, chat: lastTokens.chat || {}, sum: lastTokens.sum || {},
    });
    bindBar();
  }
  function bindBar() {
    barEl?.querySelectorAll('[data-scbar]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.scbar;
      if (act === 'detail') {
        chat.addMessage({ role: 'assistant', text: detailText(lastTokens?.step || null) });
      } else if (act === 'export') {
        window.open(`${base}/export?format=md`, '_blank');
      }
    }));
  }
  if (list?.parentElement) {
    barEl = document.createElement('div');
    barEl.className = 'scbar-host';
    barEl.innerHTML = barHTML({ exec: {}, chat: {}, sum: {} });
    list.parentElement.insertBefore(barEl, list);
    bindBar();
  }

  /* ---------- 回填历史 + 首次开场白 ---------- */
  (async () => {
    let d = null;
    try { d = await api(base); } catch (err) {
      chat.addMessage({ role: 'assistant', text: `✗ 读取本步对话失败：${err.message}` });
      return;
    }
    const stepTok = (d.tokens?.steps || []).find((s) => s.id === stepId) || null;
    lastTokens = {
      exec: stepTok?.exec, chat: stepTok?.chat, sum: stepTok?.sum, step: stepTok,
    };
    paintBar();

    for (const msg of d.messages || []) {
      chat.addMessage({
        role: msg.role,
        text: msg.text,
        suggestions: msg.role === 'assistant' ? (msg.suggestions || []) : [],
      });
    }
    // 开场白：现状摘要 + 本步可用快捷指令（新会话时才铺满，老会话只补一句现状）
    const lines = (d.context?.lines || []).join('\n');
    chat.addMessage({
      role: 'assistant',
      text: (d.messages?.length ? '（以上是这一步之前的对话，已全部保留）\n\n' : '')
        + `我是「${label}」的协作助手，这一步现在的情况：\n${lines}\n\n`
        + '直接说要改什么就行，改完会写进项目并记在这里。',
      suggestions: (d.actions || []).slice(0, 4).map((a) => a.say),
    });
  })();

  return chat;
}

/** 外层拿到 token 汇总时用的轻量渲染（步骤面板的 token 卡片） */
export function tokenChipHTML(tok) {
  const sum = tok?.sum || {};
  if (!(sum.total || sum.calls)) return '';
  return `<span class="sp-tok-chip" title="执行 ${fmtTok(tok.exec?.total)} tok · 对话 ${fmtTok(tok.chat?.total)} tok">Σ ${fmtTok(sum.total)} tok</span>`;
}
