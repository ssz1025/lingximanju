/* ============================================================================
 * 角色音色试听：浏览器原生 SpeechSynthesis（Web Speech API）+ 真实音频样本。
 *
 * 为什么不只用浏览器 TTS：
 *   - 预设 / 手填音色只有文字描述，靠 sampleText + rate/pitch 在客户端制造差异，
 *     零依赖、零配置、可离线，与项目「无需 API Key 即可完整跑通」的哲学一致；
 *   - 但 ComfyUI 抽卡出来的音色本身就是一段真实音频，再拿浏览器合成去「模拟」它
 *     等于把用户听到的东西换掉了 —— 所以带 audio 的音色一律直接播放该文件。
 *
 * 两种播放方式共用同一套状态订阅（speaking: boolean），UI 按钮只需关心「在响 / 没响」。
 * 仅在浏览器环境使用；顶层不触碰 window，可被静态分析安全导入。
 * ==========================================================================*/

/** 浏览器是否支持语音合成 */
export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

const _listeners = new Set();
/** 订阅试听状态变化（speaking: boolean） */
export function onSpeakState(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
function emitState(speaking) {
  _listeners.forEach((cb) => { try { cb(speaking); } catch { /* 忽略单个监听异常 */ } });
}

/** 当前是否正在朗读 / 播放音频 */
export function isSpeaking() {
  if (_audio) return !_audio.paused && !_audio.ended;
  return isSpeechSupported() && window.speechSynthesis.speaking;
}

// 单例播放器：试听是「独占」的，同时只允许一个音色在响，避免叠音听不清
let _audio = null;

function audioEl() {
  if (typeof window === 'undefined') return null;
  if (!_audio) {
    _audio = new window.Audio();
    _audio.preload = 'auto';
    _audio.onended = () => emitState(false);
    _audio.onpause = () => emitState(false);
    _audio.onerror = () => emitState(false);
    _audio.onplay = () => emitState(true);
  }
  return _audio;
}

/** 立即停止所有朗读 / 播放 */
export function stopSpeak() {
  if (_audio) {
    try { _audio.pause(); _audio.currentTime = 0; } catch { /* 忽略 */ }
  }
  if (isSpeechSupported()) {
    try { window.speechSynthesis.cancel(); } catch { /* 忽略 */ }
  }
  emitState(false);
}

/**
 * 播放一段真实音频样本（抽卡音色 / 服务器 TTS 产物）。
 * @param {string} url  /assets/ 下的音频地址
 * @returns {boolean} 是否成功发起播放
 */
export function playAudio(url) {
  const src = String(url || '').trim();
  if (!src) return false;
  const a = audioEl();
  if (!a) return false;
  stopSpeak();
  try {
    a.src = src;
    a.currentTime = 0;
    const p = a.play();
    // 自动播放被浏览器拦截时 play() 返回 rejected Promise：不抛出，交给 UI 判断
    if (p && typeof p.catch === 'function') p.catch(() => emitState(false));
    emitState(true);
    return true;
  } catch {
    emitState(false);
    return false;
  }
}

/**
 * 在浏览器可用语音里挑一个最合适的：先按语言前缀（如 zh）筛选，
 * 再按性别关键词（男/女/Male/Female 等）粗匹配；都拿不到就退回默认。
 * @returns {SpeechSynthesisVoice|null}
 */
export function pickBrowserVoice(lang = 'zh-CN', gender = '') {
  if (!isSpeechSupported()) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  const prefix = String(lang || 'zh-CN').split('-')[0].toLowerCase();
  const byLang = voices.filter((v) => String(v.lang || '').toLowerCase().startsWith(prefix));
  const pool = byLang.length ? byLang : voices;
  if (gender === '女') {
    const f = pool.find((v) => /female|女|woman|ting|mei|ya|venus/i.test(v.name) || /[Ff]emale/.test(v.name));
    if (f) return f;
  } else if (gender === '男') {
    const m = pool.find((v) => /male|男|man|david|li|yu|mars/i.test(v.name) || /[Mm]ale/.test(v.name));
    if (m) return m;
  }
  // 中文优先：名字里常见中文 TTS 音色
  const zh = pool.find((v) => /[一-龥]/.test(v.name));
  return zh || pool[0];
}

/**
 * 试听一段文本。
 * @param {object} opts { text, lang?, rate?, pitch?, gender?, voiceName?, audioUrl? }
 * @returns {boolean} 是否成功发起朗读（不支持时返回 false）
 */
export function speakText(opts = {}) {
  // 有真实音频样本就优先播它：用户听到的必须是他将要绑定的那条音色
  if (opts.audioUrl) return playAudio(opts.audioUrl);
  if (!isSpeechSupported()) return false;
  const text = String(opts.text || '').trim();
  if (!text) return false;
  stopSpeak();
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = String(opts.lang || 'zh-CN');
  u.rate = Number.isFinite(Number(opts.rate)) ? Math.max(0.5, Math.min(2, Number(opts.rate))) : 1;
  u.pitch = Number.isFinite(Number(opts.pitch)) ? Math.max(0, Math.min(2, Number(opts.pitch))) : 1;
  const v = pickBrowserVoice(u.lang, opts.gender);
  if (v) u.voice = v;
  u.onstart = () => emitState(true);
  u.onend = () => emitState(false);
  u.onerror = () => emitState(false);
  // 部分浏览器首次 getVoices 为空（异步加载）：等 voiceschanged 后再试一次
  const voices = synth.getVoices();
  if (!voices.length) {
    const tryOnce = () => { try { synth.speak(u); emitState(true); } catch { /* 忽略 */ } };
    if (typeof synth.onvoiceschanged === 'undefined') {
      window.speechSynthesis.addEventListener('voiceschanged', tryOnce, { once: true });
    } else {
      synth.onvoiceschanged = tryOnce;
    }
    // 兜底：立刻也试一次，避免事件不触发时完全没声音
    setTimeout(tryOnce, 120);
  } else {
    synth.speak(u);
    emitState(true);
  }
  return true;
}
