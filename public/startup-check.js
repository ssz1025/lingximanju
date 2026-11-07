/* ============================================================================
 * 启动检查：打开应用时判断模型是否配置完整。
 *
 * 未配置 → 弹引导框，两个出口：
 *   「去配置模型」→ 打开设置弹窗（模型 / 本地 ComfyUI）
 *   「先跳过」    → 记住选择（本地 + 服务端），顶栏保留「⚠ 模型未配置」入口随时可补配
 * 内置 Mock 模板可零配置跑通全流程，因此「跳过」是完全可用的路径，不是半成品。
 * ==========================================================================*/
const SKIP_KEY = 'lx.skipConfigCheck';
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 是否需要提示：文本模型未配置 或 本地 ComfyUI 工作流未导入 */
export function configNeedsAttention(settings, comfy) {
  const llm = settings?.llm || {};
  const llmOk = Boolean(llm.configured);
  const comfyOk = Boolean(comfy?.imageWorkflow || comfy?.videoWorkflow);
  return !llmOk || !comfyOk;
}

export function configDetail(settings, comfy) {
  const llm = settings?.llm || {};
  return {
    llmOk: Boolean(llm.configured),
    llmText: llm.configured ? `${esc(llm.provider)} · ${esc(llm.model || '默认模型')} · ${esc(llm.maskedKey || '')}` : '未配置 · 当前使用内置 Mock 模板',
    comfyImageOk: Boolean(comfy?.imageWorkflow),
    comfyVideoOk: Boolean(comfy?.videoWorkflow),
    comfyText: comfy?.baseUrl ? `本地服务 ${esc(comfy.baseUrl)}` : '默认 http://127.0.0.1:8188',
    comfyReady: Boolean(comfy?.imageWorkflow && comfy?.videoWorkflow),
  };
}

export function skipWasChosen(settings) {
  return Boolean(settings?.skipConfigCheck) || localStorage.getItem(SKIP_KEY) === '1';
}

/** @returns {boolean} 是否弹出了引导框 */
export function checkModelConfig({ settings, comfy, onConfigure, onSkip } = {}) {
  if (!configNeedsAttention(settings, comfy)) return false;
  if (skipWasChosen(settings)) return false;

  const d = configDetail(settings, comfy);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop startup-backdrop';
  backdrop.innerHTML = `<div class="modal startup-modal" role="dialog" aria-label="模型配置引导">
    <div class="startup-illustration" aria-hidden="true">
      <svg viewBox="0 0 320 92" width="100%" height="92">
        <defs><linearGradient id="stg" x1="0" x2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset="1" stop-color="#8b9bff"/></linearGradient></defs>
        <path d="M18 66 H302" stroke="var(--border)" stroke-width="2"/>
        ${[42, 110, 178, 246].map((x, i) => `
          <circle cx="${x}" cy="66" r="14" fill="var(--panel-2)" stroke="url(#stg)" stroke-width="2"/>
          <text x="${x}" y="71" text-anchor="middle" font-size="13" fill="var(--text)">${['文', '图', '影', '包'][i]}</text>`).join('')}
        <path d="M56 66 H96 M124 66 H164 M192 66 H232" stroke="url(#stg)" stroke-width="2" stroke-dasharray="4 4"/>
      </svg>
    </div>
    <h2>首次使用 · 配置创作模型</h2>
    <div class="sub">配置后，剧本、角色提取会调用你的大模型，画面与视频由本地 ComfyUI 生成。不配置也能用内置模板完整体验所有流程。</div>
    <div class="startup-status">
      <div class="startup-row ${d.llmOk ? 'ok' : 'warn'}">
        <span class="startup-ico">${d.llmOk ? '✓' : '!'}</span>
        <div><strong>文本大模型（剧本 / 角色 / 小说）</strong><small>${d.llmText}</small></div>
      </div>
      <div class="startup-row ${d.comfyReady ? 'ok' : 'warn'}">
        <span class="startup-ico">${d.comfyReady ? '✓' : '!'}</span>
        <div><strong>本地 ComfyUI（宫格图 / 视频）</strong>
          <small>${d.comfyText} · 出图工作流${d.comfyImageOk ? '已导入' : '未导入'} · 视频工作流${d.comfyVideoOk ? '已导入' : '未导入'}</small></div>
      </div>
    </div>
    <div class="startup-note">所有配置只保存在本机 <code>data/</code> 目录。之后随时可从顶栏 ⚙ 或「⚠ 模型未配置」重新进入设置。</div>
    <div class="modal-actions">
      <button class="btn" data-act="skip">先跳过</button>
      <button class="btn primary" data-act="config">去配置模型</button>
    </div>
  </div>`;

  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="config"]').addEventListener('click', () => {
    close();
    onConfigure?.();
  });
  backdrop.querySelector('[data-act="skip"]').addEventListener('click', async () => {
    close();
    try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* 隐私模式下忽略 */ }
    try {
      await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipConfigCheck: true }),
      });
    } catch { /* 后端暂不可达也不影响本次跳过 */ }
    onSkip?.();
  });
  $('modal-root').appendChild(backdrop);
  return true;
}
