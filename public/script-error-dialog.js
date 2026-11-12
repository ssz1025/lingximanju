/* ============================================================================
 * 剧本生成失败弹窗：工作台（④ 剧本创作）与剧集详情页共用。
 *
 * 只在生成请求真的报错（HTTP 4xx/5xx）时弹出；批量「部分成功」仍走原来的 toast 汇总。
 * 复用全局 #modal-root + .modal-backdrop/.modal，按钮一律 data-se 而非 data-act：
 * 工作台的 63 个功能入口基线由测试锁定，弹窗不能新增或改动入口集合。
 *
 * 弹窗内直接给「改用模型」下拉：报错时提示用户换模型，却让他关掉弹窗去找选择条，
 * 等于没有切换入口。选中后点「用此模型重试」即写入与剧本台选择条共用的记忆并重试。
 * ==========================================================================*/
import { esc } from './utils.js';
import { pickedModelId, setPickedModelId } from './model-picker.js';

const MODEL_ENTRY = 'episode';

const HINTS = [
  '在上方「改用模型」里换一个档案后点「用此模型重试」，或留空跟随默认模型',
  '到 设置 → 模型与运行 → 全局模型库 检查 API Key、Base URL 与模型名，可用「▶」真实测一次',
  '真实模型调用失败不会用内置模板顶替：失败集原有剧本保持不变，修好配置后重试即可',
];

/**
 * @param {Object} opts
 *   message   后端返回的错误文案（含模型名与原因）
 *   results   批量全失败时的 [{no, error}] 明细
 *   models    当前模型库档案（由调用方强制刷新后传入），用于弹窗内直接切换
 *   onRetry   可选「用此模型重试」回调
 *   onSettings 可选「模型设置」回调
 */
export function showScriptError({ message = '', results = [], models = null, onRetry, onSettings } = {}) {
  const root = document.getElementById('modal-root');
  if (!root) return null;
  const rows = (Array.isArray(results) ? results : []).slice(0, 6)
    .map((r) => `<li><b>第 ${esc(String(r?.no ?? '?'))} 集</b> ${esc(String(r?.error || ''))}</li>`).join('');
  const extra = (Array.isArray(results) ? results.length : 0) > 6
    ? `<p class="script-error-more">还有 ${results.length - 6} 集未列出</p>` : '';

  const modelList = Array.isArray(models) ? models : [];
  const chosen = pickedModelId(MODEL_ENTRY);
  const options = modelList.map((m) => `<option value="${esc(m.id)}"${String(m.id) === String(chosen) ? ' selected' : ''}>${esc(m.name || m.model)}</option>`).join('');
  const modelBox = `<div class="script-error-model">
      <label for="script-error-model">改用模型</label>
      <select id="script-error-model" data-se="model">
        <option value="">跟随默认模型 / 内置模板</option>${options}
      </select>
      <span class="script-error-model-tip">${modelList.length
        ? '选中后点「用此模型重试」；凭证有问题可点「模型设置」修改'
        : '模型库为空或暂未读到：可点「模型设置」新增档案，或留空用内置模板重试'}</span>
    </div>`;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal script-error-modal" role="dialog" aria-modal="true" aria-label="剧本生成失败">
    <div class="wz-head">
      <div><h2>✕ 剧本生成失败</h2><div class="sub">这次请求没有成功，剧本未写入；原来的剧本（如果有）保持不变。</div></div>
      <button class="icon-btn" data-se="close" title="关闭">✕</button>
    </div>
    <div class="script-error-body">
      <p class="script-error-msg">${esc(String(message || '剧本生成请求失败，请稍后重试'))}</p>
      ${rows ? `<div class="script-error-rows"><h4>失败明细</h4><ul>${rows}</ul>${extra}</div>` : ''}
      ${modelBox}
      <div class="script-error-hints"><h4>可以检查</h4><ul>${HINTS.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>
    </div>
    <div class="modal-actions">
      ${onSettings ? '<button class="btn sm" data-se="settings">模型设置</button>' : ''}
      ${onRetry ? '<button class="btn sm" data-se="retry">用此模型重试</button>' : ''}
      <button class="btn primary sm" data-se="close">知道了</button>
    </div>
  </div>`;

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-se="close"]').forEach((b) => b.addEventListener('click', close));
  const settingsBtn = backdrop.querySelector('[data-se="settings"]');
  if (settingsBtn) settingsBtn.addEventListener('click', () => { close(); onSettings?.(); });
  const retryBtn = backdrop.querySelector('[data-se="retry"]');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    const sel = backdrop.querySelector('[data-se="model"]');
    if (sel) setPickedModelId(MODEL_ENTRY, sel.value);
    close();
    onRetry?.();
  });
  backdrop.querySelector('.modal-actions .btn.primary')?.focus();
  root.appendChild(backdrop);
  return { root: backdrop, close };
}
