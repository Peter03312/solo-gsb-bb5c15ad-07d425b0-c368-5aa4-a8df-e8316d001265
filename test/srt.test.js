'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSrt,
  buildSrt,
  parseTimestamp,
  formatTimestamp,
  SrtError,
} = require('../src/srt');

const VALID = `1
00:00:01,000 --> 00:00:03,500
你好，世界
第二行

2
00:00:03,500 --> 00:00:06,000
下一段（首尾相接）
`;

test('解析合法 SRT（多行文字、首尾相接）', () => {
  const cues = parseSrt(VALID);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[0].text, '你好，世界\n第二行');
});

test('容忍 CRLF、开头 BOM 和多余空行', () => {
  const raw = '﻿\r\n\r\n1\r\n00:00:00,000 --> 00:00:01,000\r\nHi\r\n';
  const cues = parseSrt(raw);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hi');
});

test('时间戳转换：非负 00:00:00,000 合法', () => {
  assert.equal(parseTimestamp('00:00:00,000'), 0);
  assert.equal(parseTimestamp('01:02:03,004'), 3723004);
  assert.equal(formatTimestamp(3723004), '01:02:03,004');
});

test('非法时间戳带行号', () => {
  const bad = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '文字',
    '',
    '2',
    '00:00:5,000 --> 00:00:07,000',
    '秒数不足两位',
    '',
  ].join('\n');
  try {
    parseSrt(bad);
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e instanceof SrtError);
    assert.equal(e.line, 6);
  }
});

test('结束不晚于开始：报错并指出时间轴行', () => {
  const bad = `1
00:00:05,000 --> 00:00:05,000
等长

2
00:00:06,000 --> 00:00:02,000
倒序
`;
  assert.throws(
    () => parseSrt(bad),
    (e) => e instanceof SrtError && e.line === 2
  );
});

test('段落交叠：报错并指出后一段行号', () => {
  const bad = `1
00:00:01,000 --> 00:00:04,000
A

2
00:00:03,000 --> 00:00:05,000
B 与 A 交叠
`;
  assert.throws(
    () => parseSrt(bad),
    (e) => e instanceof SrtError && /交叠/.test(e.message) && e.line === 5
  );
});

test('序号缺失/非数字：指出行号', () => {
  const bad = `1
00:00:01,000 --> 00:00:03,000
A

（这里应有序号）
00:00:05,000 --> 00:00:07,000
B
`;
  assert.throws(
    () => parseSrt(bad),
    (e) => e instanceof SrtError && e.line === 5
  );
});

test('缺少文字内容报错', () => {
  const bad = '1\n00:00:01,000 --> 00:00:03,000\n\n';
  assert.throws(() => parseSrt(bad), SrtError);
});

test('空文件报错', () => {
  assert.throws(() => parseSrt(''), SrtError);
  assert.throws(() => parseSrt('\n\n  \n'), SrtError);
});

test('生成 SRT：按时间重新编号并保留换行', () => {
  const out = buildSrt([
    { startMs: 6000, endMs: 7000, text: '晚出现' },
    { startMs: 0, endMs: 1000, text: '第一行\n第二行' },
  ]);
  const expected =
    '1\n' +
    '00:00:00,000 --> 00:00:01,000\n' +
    '第一行\n第二行\n' +
    '\n' +
    '2\n' +
    '00:00:06,000 --> 00:00:07,000\n' +
    '晚出现\n';
  assert.equal(out, expected);
});

test('round-trip：生成后再解析保持一致', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, text: 'a\nb' },
    { startMs: 2000, endMs: 3000, text: 'c' },
  ];
  const reparsed = parseSrt(buildSrt(cues));
  assert.deepEqual(
    reparsed.map((c) => [c.startMs, c.endMs, c.text]),
    [
      [1000, 2000, 'a\nb'],
      [2000, 3000, 'c'],
    ]
  );
});
