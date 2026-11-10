/* 前端试听模块 voice-preview.js 的播放态回归
 * 覆盖：playId 随状态回调带回、单例播放器互斥、stopSpeak 清空 playId、
 *      真实音频样本优先于浏览器合成、空输入不谎报播放、无语音环境安全降级。
 * 运行：node --test tests/voice-preview.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- 浏览器全局桩 ----------------
 * voice-preview.js 顶层刻意不触碰 window（只在函数体内判空），所以导入后补桩即可驱动它，
 * 不必上 jsdom。单例播放器由模块内部持有，这里只做旁路观察。 */
const played = [];   // 每次 play() 的 src
const spoken = [];   // 每次 speechSynthesis.speak() 的 utterance
let lastAudio = null;

class FakeAudio {
  constructor() {
    this.src = ''; this.currentTime = 0; this.paused = true; this.ended = false; this.preload = '';
    lastAudio = this;
  }
  play() { this.paused = false; played.push(this.src); this.onplay?.(); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
}

const speech = {
  speaking: false,
  getVoices() { return [{ name: 'Ting-Ting', lang: 'zh-CN' }]; },
  speak(u) {
    spoken.push(u);
    this.speaking = true;
    u.onstart?.();
    // 真浏览器里 utterance 读完会把 speechSynthesis.speaking 置回 false，桩里补上这一拍
    const origEnd = u.onend;
    u.onend = (...a) => { speech.speaking = false; origEnd?.(...a); };
  },
  cancel() { this.speaking = false; },
  addEventListener() {},
};

global.window = { Audio: FakeAudio, speechSynthesis: speech };
global.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

const {
  isSpeechSupported, onSpeakState, isSpeaking, currentPlayId, isPlaying,
  stopSpeak, playAudio, speakText,
} = await import('../public/voice-preview.js');

beforeEach(() => {
  stopSpeak();
  played.length = 0; spoken.length = 0;
});

/* ---------------------------------------------------------------- 播放态与 playId */
test('onSpeakState：状态回调带 playId，停止后清空', () => {
  const seen = [];
  const off = onSpeakState((s) => seen.push({ ...s }));

  assert.equal(currentPlayId(), '', '初始没有在播');
  assert.equal(isPlaying('voice:vox_1'), false);

  assert.equal(playAudio('/assets/a.wav', 'voice:vox_1'), true);
  assert.deepEqual(seen.at(-1), { speaking: true, playId: 'voice:vox_1' });
  assert.equal(currentPlayId(), 'voice:vox_1');
  assert.equal(isPlaying('voice:vox_1'), true);
  assert.equal(isPlaying('voice:vox_2'), false, '别的条目不能一起高亮');
  assert.equal(isPlaying(''), false, '空 playId 永远不算「正在播这一条」');

  stopSpeak();
  assert.deepEqual(seen.at(-1), { speaking: false, playId: '' }, '停止要带空 playId，UI 才知道该还原哪个按钮');
  assert.equal(currentPlayId(), '');
  assert.equal(isPlaying('voice:vox_1'), false);

  off();
  const before = seen.length;
  playAudio('/assets/a.wav', 'voice:vox_1');
  stopSpeak();
  assert.equal(seen.length, before, 'off() 之后不该再进回调');
});

test('单例互斥：换一条播放会先停上一条，playId 覆盖成新的', () => {
  playAudio('/assets/a.wav', 'draft:vdr_1');
  assert.equal(currentPlayId(), 'draft:vdr_1');
  assert.equal(lastAudio.src, '/assets/a.wav');

  playAudio('/assets/b.wav', 'draft:vdr_2');
  assert.equal(currentPlayId(), 'draft:vdr_2', 'playId 必须是新那条，否则两处按钮会一起卡在「停止」');
  assert.equal(isPlaying('draft:vdr_1'), false);
  assert.equal(lastAudio.src, '/assets/b.wav', '单例播放器换源而不是再造一个，避免叠音');
  assert.equal(lastAudio.paused, false);
});

test('playAudio：空地址不发起播放，也不把状态谎报成「在播」', () => {
  assert.equal(playAudio(''), false);
  assert.equal(playAudio('   '), false);
  assert.equal(playAudio(null, 'voice:vox_1'), false);
  assert.equal(currentPlayId(), '');
  assert.equal(isSpeaking(), false);
  assert.equal(played.length, 0, '压根不该走到 play()');
});

/* ------------------------------------------------- 真实音频 vs 浏览器合成 */
test('speakText：带 audioUrl 一律播真实样本，不进浏览器合成', () => {
  assert.equal(speakText({ audioUrl: '/assets/x.wav', text: '欢迎来到灵犀漫剧', playId: 'voice:vox_9' }), true);
  assert.equal(spoken.length, 0, '用户要听的是抽卡出来的真实音色，不能拿合成音冒充');
  assert.equal(played.length, 1);
  assert.equal(currentPlayId(), 'voice:vox_9');
});

test('speakText：无 audioUrl 才走浏览器合成，playId 同样带回', () => {
  // 先造一次真实音频播放再停下：_audio 单例就此存在且处于 paused。
  // 回归点：此时走浏览器合成，isSpeaking() 不能只看 _audio，否则会误报「没在播」，
  // 播放态按钮（⏸ 停止）就永远出不来。
  playAudio('/assets/warmup.wav', 'voice:warm');
  stopSpeak();

  assert.equal(speakText({ text: '欢迎来到灵犀漫剧', playId: 'voice:vox_3', gender: '女' }), true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, '欢迎来到灵犀漫剧');
  assert.equal(isSpeaking(), true, '浏览器合成在播时必须报「在播」，哪怕 _audio 单例是 paused');
  assert.equal(currentPlayId(), 'voice:vox_3');

  spoken[0].onend();
  assert.equal(currentPlayId(), '', '播完要把 playId 清掉，按钮才能还原成「试听」');
  assert.equal(isSpeaking(), false);
});

test('speakText：空文本不发起朗读', () => {
  assert.equal(speakText({}), false);
  assert.equal(speakText({ text: '   ' }), false);
  assert.equal(spoken.length, 0);
  assert.equal(currentPlayId(), '');
});

/* ---------------------------------------------------------------- 环境降级 */
test('无浏览器语音环境：isSpeechSupported 为 false，试听安全降级', () => {
  const savedWin = global.window;
  const savedUtter = global.SpeechSynthesisUtterance;
  global.window = { Audio: FakeAudio };   // 没有 speechSynthesis
  try {
    assert.equal(isSpeechSupported(), false);
    assert.equal(speakText({ text: '你好', playId: 'voice:v' }), false, '不能朗读就如实返回 false，UI 据此置灰');
    assert.equal(currentPlayId(), '');
    assert.equal(isPlaying('voice:v'), false);
  } finally {
    global.window = savedWin;
    global.SpeechSynthesisUtterance = savedUtter;
    stopSpeak();
  }
  assert.equal(isSpeechSupported(), true);
});

test('完全无 window（纯 Node 静态导入）：所有入口都不抛异常', () => {
  const savedWin = global.window;
  const savedUtter = global.SpeechSynthesisUtterance;
  delete global.window; delete global.SpeechSynthesisUtterance;
  try {
    assert.equal(isSpeechSupported(), false);
    assert.equal(playAudio('/assets/a.wav', 'voice:1'), false);
    assert.equal(speakText({ text: '你好' }), false);
    assert.equal(currentPlayId(), '');
    assert.doesNotThrow(() => stopSpeak());
  } finally {
    global.window = savedWin;
    global.SpeechSynthesisUtterance = savedUtter;
    stopSpeak();
  }
});
