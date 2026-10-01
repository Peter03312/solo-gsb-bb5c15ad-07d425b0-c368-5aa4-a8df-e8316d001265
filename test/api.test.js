'use strict';

// 必须在 require 应用模块之前设置独立数据目录
process.env.DATA_DIR = require('node:fs').mkdtempSync('/tmp/sub-test-');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');

let server;
let base;

function srtFile(name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  return fd;
}

async function getJson(url) {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
}

async function upload(content, name = 'sample.srt') {
  const res = await fetch(base + '/api/works', { method: 'POST', body: srtFile(name, content) });
  return { status: res.status, body: await res.json() };
}

async function patch(workId, cueId, payload) {
  const res = await fetch(`${base}/api/works/${workId}/cues/${cueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const VALID = `1
00:00:01,000 --> 00:00:03,000
第一条
第二行

2
00:00:03,000 --> 00:00:05,000
第二条
`;

before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

test('健康检查', async () => {
  const r = await getJson('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('上传合法文件并读取字幕段', async () => {
  const r = await upload(VALID);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.cueCount, 2);

  const detail = await getJson(`/api/works/${r.body.id}`);
  assert.equal(detail.body.work.revision, 1);
  assert.equal(detail.body.cues.length, 2);
  assert.equal(detail.body.cues[0].text, '第一条\n第二行');
});

test('非法文件（时间倒序）整份不入库并返回行号', async () => {
  const before = (await getJson('/api/works')).body.works.length;
  const bad = `1
00:00:05,000 --> 00:00:01,000
倒序`;
  const r = await upload(bad);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /结束时间/);
  assert.equal(r.body.line, 2);

  const after = (await getJson('/api/works')).body.works.length;
  assert.equal(after, before, '非法文件不应产生任何作品');
});

test('交叠文件不入库并指出行号', async () => {
  const before = (await getJson('/api/works')).body.works.length;
  const bad = `1
00:00:01,000 --> 00:00:04,000
A

2
00:00:03,500 --> 00:00:05,000
B`;
  const r = await upload(bad);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /交叠/);
  assert.equal(r.body.line, 5);
  const after = (await getJson('/api/works')).body.works.length;
  assert.equal(after, before);
});

test('缺少 baseRevision / 非法值 -> 400', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const r = await patch(up.body.id, detail.body.cues[0].id, {
    text: 'x',
  });
  assert.equal(r.status, 400);
});

test('过期修订号 -> 409，返回最新修订号与最新字幕段', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const cueId = detail.body.cues[0].id;

  // 先用修订号 1 成功编辑，产生修订号 2
  const ok = await patch(up.body.id, cueId, { baseRevision: 1, text: '第一次修改' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.revision, 2);

  // 再拿过期的 1 提交
  const stale = await patch(up.body.id, cueId, {
    baseRevision: 1,
    text: '基于旧版本的修改',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.latestRevision, 2);
  assert.equal(stale.body.cue.text, '第一次修改');
  assert.equal(stale.body.cue.id, cueId);
});

test('并发提交同一修订号：恰好一个成功，另一个 409', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const cueId = detail.body.cues[0].id;

  const [r1, r2] = await Promise.all([
    patch(up.body.id, cueId, { baseRevision: 1, text: '并发修改 A' }),
    patch(up.body.id, cueId, { baseRevision: 1, text: '并发修改 B' }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const conflict = r1.status === 409 ? r1.body : r2.body;
  assert.equal(conflict.latestRevision, 2);
  assert.ok(conflict.cue, '409 必须回传最新字幕段');

  const final = await getJson(`/api/works/${up.body.id}`);
  assert.equal(final.body.work.revision, 2);
});

test('交叠编辑被拒且修订号不变', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const first = detail.body.cues[0];

  const r = await patch(up.body.id, first.id, {
    baseRevision: 1,
    start: '00:00:02,000',
    end: '00:00:04,500', // 与第二条 3.000–5.000 交叠
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /交叠/);

  const again = await getJson(`/api/works/${up.body.id}`);
  assert.equal(again.body.work.revision, 1);
  assert.equal(again.body.cues[0].startMs, 1000);
});

test('结束不晚于开始 -> 400', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const r = await patch(up.body.id, detail.body.cues[0].id, {
    baseRevision: 1,
    start: '00:00:05,000',
    end: '00:00:05,000',
  });
  assert.equal(r.status, 400);
});

test('非负边界 00:00:00,000 合法；非法时间格式 -> 400', async () => {
  const up = await upload(VALID);
  const detail = await getJson(`/api/works/${up.body.id}`);
  const cueId = detail.body.cues[0].id;

  const bad = await patch(up.body.id, cueId, {
    baseRevision: 1,
    start: '0:0:0.0',
  });
  assert.equal(bad.status, 400);

  const ok = await patch(up.body.id, cueId, {
    baseRevision: 1,
    start: '00:00:00,000',
    end: '00:00:00,500',
    text: '贴在零点',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('编辑改变时间顺序后重新编号，导出按时间排序并保留换行', async () => {
  const up = await upload(VALID); // cue A 1-3, cue B 3-5
  const detail = await getJson(`/api/works/${up.body.id}`);
  const [a, b] = detail.body.cues;

  // 把 A 移到 B 之后（6-8），编号应自动变为 2
  const moved = await patch(up.body.id, a.id, {
    baseRevision: 1,
    start: '00:00:06,000',
    end: '00:00:08,000',
    text: '第一条\n仍然多行',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.cue.idx, 2);
  assert.equal(moved.body.revision, 2);

  const after = await getJson(`/api/works/${up.body.id}`);
  assert.equal(after.body.cues[0].id, b.id);
  assert.equal(after.body.cues[1].text, '第一条\n仍然多行');

  const res = await fetch(base + `/api/works/${up.body.id}/export`);
  assert.equal(res.status, 200);
  const text = await res.text();
  // 去除 BOM 后断言
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const expected =
    '1\n' +
    '00:00:03,000 --> 00:00:05,000\n' +
    '第二条\n' +
    '\n' +
    '2\n' +
    '00:00:06,000 --> 00:00:08,000\n' +
    '第一条\n仍然多行\n';
  assert.equal(body, expected);
});
