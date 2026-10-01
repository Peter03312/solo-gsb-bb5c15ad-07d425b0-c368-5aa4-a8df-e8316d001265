'use strict';

// ---------- 工具 ----------

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- 页面：作品列表 / 上传 ----------

async function renderHome() {
  let works = [];
  let loadErr = '';
  try {
    const data = await api('GET', '/api/works');
    works = data.works;
  } catch (e) {
    loadErr = e.message;
  }

  view.innerHTML = `
    <div class="card">
      <h2>上传 UTF-8 SRT 字幕</h2>
      <div id="upload-error"></div>
      <form id="upload-form" class="upload-row">
        <input type="text" id="title" name="title" placeholder="作品名称（可选，默认用文件名）"
               style="flex:1; min-width:220px;" maxlength="200" />
        <input type="file" id="file" name="file" accept=".srt,text/plain" required />
        <button type="submit">上传并校订</button>
      </form>
      <p class="muted">整份文件通过格式与时间校验后才会入库；任一错误会指出所在行号。</p>
    </div>

    <div class="card">
      <h2>作品列表</h2>
      ${loadErr ? `<div class="error-box">${esc(loadErr)}</div>` : ''}
      ${
        works.length === 0 && !loadErr
          ? '<p class="muted">还没有作品，请先上传 SRT 文件。</p>'
          : `<ul class="work-list">
              ${works
                .map(
                  (w) => `
                <li>
                  <div>
                    <a class="work-title" href="#/work/${w.id}">${esc(w.title)}</a>
                    <span class="rev-badge">修订号 ${w.revision}</span>
                    <div class="work-meta">字幕段 ${w.cue_count} 条 · 更新于 ${esc(
                    w.updated_at
                  )}</div>
                  </div>
                  <div>
                    <a class="btn secondary" href="/api/works/${w.id}/export">导出 SRT</a>
                    <button class="danger" data-del="${w.id}" data-name="${esc(w.title)}">删除</button>
                  </div>
                </li>`
                )
                .join('')}
            </ul>`
      }
    </div>
  `;

  document.getElementById('upload-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errBox = document.getElementById('upload-error');
    errBox.innerHTML = '';
    const fd = new FormData();
    const file = document.getElementById('file').files[0];
    const title = document.getElementById('title').value;
    if (!file) {
      errBox.innerHTML = '<div class="error-box">请选择 .srt 文件</div>';
      return;
    }
    fd.append('file', file);
    fd.append('title', title);
    try {
      const data = await api('POST', '/api/works', fd);
      toast(`已导入 ${data.cueCount} 条字幕`);
      location.hash = `#/work/${data.id}`;
    } catch (e) {
      const lineInfo = e.data && e.data.line ? `（第 ${e.data.line} 行）` : '';
      errBox.innerHTML = `<div class="error-box">${esc(e.message)}${esc(lineInfo)}</div>`;
    }
  });

  view.querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`确定删除作品「${btn.dataset.name}」？此操作不可恢复。`)) return;
      try {
        await api('DELETE', `/api/works/${btn.dataset.del}`);
        renderHome();
      } catch (e) {
        toast(e.message);
      }
    });
  });
}

// ---------- 页面：作品校订 ----------

async function renderWork(id) {
  let data;
  try {
    data = await api('GET', `/api/works/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="error-box">${esc(
      e.message
    )}</div><a class="btn secondary" href="#/">返回列表</a></div>`;
    return;
  }

  document.getElementById('global-hint').textContent =
    '多人同时校订：保存时携带当前修订号，过期会被拒绝并显示服务器上的最新版本';

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <h1 style="margin:0;">${esc(data.work.title)}</h1>
        <span class="rev-badge" id="rev-badge">修订号 ${data.work.revision}</span>
        <span style="flex:1"></span>
        <a class="btn secondary" href="/api/works/${data.work.id}/export">导出标准 SRT</a>
        <a class="btn secondary" href="#/">返回列表</a>
      </div>
      <p class="muted">按时间顺序展示。可修改起止时间（HH:MM:SS,mmm）与多行文字（回车换行）；
        时间须非负、结束晚于开始，且不得与同作品其它字幕段交叠。</p>
      <div id="work-error"></div>
    </div>
    <div id="cue-list">
      ${data.cues.map((c) => cueCard(c, data.work.revision)).join('')}
    </div>
  `;

  view.querySelectorAll('[data-save]').forEach((btn) =>
    btn.addEventListener('click', () => saveCue(data.work.id, btn.dataset.save))
  );
}

function cueCard(c, revision) {
  return `
  <div class="cue" id="cue-${c.id}">
    <div class="cue-head">
      <span class="cue-idx">#${c.idx}</span>
      <div class="time-fields">
        <input class="time" data-field="start" value="${esc(c.start)}" size="13"
               aria-label="开始时间" placeholder="00:00:00,000" />
        <span class="muted">→</span>
        <input class="time" data-field="end" value="${esc(c.end)}" size="13"
               aria-label="结束时间" placeholder="00:00:00,000" />
      </div>
      <div class="cue-actions">
        <button data-save="${c.id}">保存（修订号 ${revision}）</button>
      </div>
    </div>
    <div class="cue-body">
      <textarea data-field="text" rows="${Math.max(2, c.text.split('\n').length)}">${esc(
    c.text
  )}</textarea>
      <div class="conflict hidden" data-role="conflict"></div>
    </div>
  </div>`;
}

async function saveCue(workId, cueId) {
  const card = document.getElementById(`cue-${cueId}`);
  const conflictEl = card.querySelector('[data-role="conflict"]');
  conflictEl.classList.add('hidden');
  conflictEl.textContent = '';

  const badge = document.getElementById('rev-badge');
  const baseRevision = parseInt((badge.textContent.match(/\d+/) || ['1'])[0], 10);

  const payload = {
    baseRevision,
    start: card.querySelector('[data-field="start"]').value.trim(),
    end: card.querySelector('[data-field="end"]').value.trim(),
    text: card.querySelector('[data-field="text"]').value,
  };

  try {
    const data = await api('PATCH', `/api/works/${workId}/cues/${cueId}`, payload);
    badge.textContent = `修订号 ${data.revision}`;
    toast(`已保存，修订号更新为 ${data.revision}`);
    // 用服务端返回的规范值（时间格式/排序后的序号可能变化）刷新该卡片
    refreshCueCard(card, data.cue, data.revision);
  } catch (e) {
    if (e.status === 409 && e.data && e.data.latestRevision) {
      // 修订号过期：展示最新修订号与服务器上的目标字幕段，供人工比对重试。
      badge.textContent = `修订号 ${e.data.latestRevision}`;
      card.querySelector('[data-save]').textContent =
        `保存（修订号 ${e.data.latestRevision}）`;
      if (e.data.cue) {
        conflictEl.textContent =
          `⚠ ${e.message}\n\n服务器最新版本（修订号 ${e.data.latestRevision}）：\n` +
          `${e.data.cue.start} --> ${e.data.cue.end}\n${e.data.cue.text}\n\n` +
          `请将您的修改与最新内容人工合并后，再次点击保存。`;
        conflictEl.classList.remove('hidden');
      } else {
        conflictEl.textContent = `⚠ ${e.message}（该字幕段可能已被删除）`;
        conflictEl.classList.remove('hidden');
      }
    } else {
      toast(e.message);
    }
  }
}

function refreshCueCard(card, cue, revision) {
  card.querySelector('.cue-idx').textContent = `#${cue.idx}`;
  card.querySelector('[data-field="start"]').value = cue.start;
  card.querySelector('[data-field="end"]').value = cue.end;
  card.querySelector('[data-field="text"]').value = cue.text;
  card.querySelector('[data-save]').textContent = `保存（修订号 ${revision}）`;
}

// ---------- 简易哈希路由 ----------

function route() {
  document.getElementById('global-hint').textContent = '';
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/work\/(\d+)$/);
  if (m) {
    renderWork(m[1]);
  } else {
    location.hash = '#/';
    renderHome();
  }
}

window.addEventListener('hashchange', route);
route();
