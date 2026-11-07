import test from 'node:test';
import assert from 'node:assert/strict';
import {
  str, esc, escapeHTML, cut, num, fmtNum, fmt, clamp, uid, escapeRegExp, $,
} from '../public/utils.js';

test('str / esc：统一转义 & < > " \' 且 null 与 undefined 归空串', () => {
  assert.equal(str(null), '');
  assert.equal(str(undefined), '');
  assert.equal(str(0), '0');
  assert.equal(esc(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(escapeHTML, esc, 'escapeHTML 是同一份实现的别名');
});

test('cut：输出长度不超过 n（省略号计入 n），短串原样返回', () => {
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('abcdef', 4).length, 4);
  assert.equal(cut('abc', 4), 'abc');
  assert.equal(cut('', 4), '');
  assert.equal(cut(null, 4), '');
  assert.equal(cut('abcdef', 1), '…');
  assert.equal(cut('abcdef'), 'abcdef', '默认上限 120');
  assert.equal(cut('abcdef', 0), '…', '非法上限钳到 1');
  assert.equal(cut('abcdef', NaN), 'abcdef', 'NaN 上限回退到 120');
});

test('num / fmtNum：数值兜底与千分位，绝不把 NaN 带进视图', () => {
  assert.equal(num('42'), 42);
  assert.equal(num(undefined), 0);
  assert.equal(num(NaN, 7), 7);
  assert.equal(num(Infinity, 7), 7);
  assert.equal(num('', 3), 0, '空串按 Number 语义为 0，不触发兜底');
  assert.equal(fmtNum(1234567), '1,234,567');
  assert.equal(fmtNum(undefined), '0');
});

test('fmt：空值显示破折号，其余转字符串', () => {
  assert.equal(fmt(undefined), '—');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(''), '—');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(false), 'false');
});

test('clamp：闭区间钳制，含负值与越界', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(0.25, 0.1, 1.4), 0.25);
});

test('uid：带前缀且高频生成不重复', () => {
  const ids = new Set(Array.from({ length: 500 }, () => uid('n')));
  assert.equal(ids.size, 500);
  assert.ok([...ids].every((id) => id.startsWith('n_')));
  assert.match(uid('ep'), /^ep_/);
});

test('escapeRegExp：元字符全部转义，字符串可直接用于 new RegExp', () => {
  assert.equal(escapeRegExp('a.b*c?'), 'a\\.b\\*c\\?');
  assert.equal(escapeRegExp('[a-z](x){1,2}'), '\\[a-z\\]\\(x\\)\\{1,2\\}');
  assert.ok(new RegExp(escapeRegExp('a+b')).test('a+b'));
  assert.equal(escapeRegExp(null), '');
});

test('$：Node 无 DOM 环境返回 null 而不抛错', () => {
  assert.equal(typeof document, 'undefined');
  assert.doesNotThrow(() => $('anything'));
  assert.equal($('anything'), null);
});
