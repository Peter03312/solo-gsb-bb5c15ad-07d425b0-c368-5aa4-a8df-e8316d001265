'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { openDb } = require('./db');
const srt = require('./srt');
const { MAX_UPLOAD_BYTES, MAX_TEXT_BYTES } = require('./config');

function createApp() {
  const app = express();
  const db = openDb();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // ---------- 序列化 ----------

  function cueRow(row) {
    return {
      id: row.id,
      idx: row.idx,
      startMs: row.start_ms,
      endMs: row.end_ms,
      start: srt.formatTimestamp(row.start_ms),
      end: srt.formatTimestamp(row.end_ms),
      text: row.text,
    };
  }

  function getWorkOrNull(id) {
    return db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  }

  function getCues(workId) {
    return db
      .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx ASC')
      .all(workId)
      .map(cueRow);
  }

  // ---------- 路由 ----------

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // 作品列表
  app.get('/api/works', (req, res) => {
    const rows = db
      .prepare(
        `SELECT w.id, w.title, w.revision, w.created_at, w.updated_at,
                COUNT(c.id) AS cue_count
           FROM works w
           LEFT JOIN cues c ON c.work_id = w.id
          GROUP BY w.id
          ORDER BY w.id DESC`
      )
      .all();
    res.json({ works: rows });
  });

  // 作品详情（含全部字幕段）
  app.get('/api/works/:id(\\d+)', (req, res) => {
    const work = getWorkOrNull(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });
    res.json({
      work: {
        id: work.id,
        title: work.title,
        revision: work.revision,
        createdAt: work.created_at,
        updatedAt: work.updated_at,
      },
      cues: getCues(work.id),
    });
  });

  // 上传 SRT 新建作品；任何格式/时间错误整份文件不入库
  app.post(
    '/api/works',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            error: `文件上传失败：${err.message}（大小上限 ${
              MAX_UPLOAD_BYTES / 1024 / 1024
            }MB）`,
          });
        }
        next();
      });
    },
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: '缺少上传文件（字段名 file，.srt）' });
      }
      if (!/\.srt$/i.test(req.file.originalname)) {
        return res.status(400).json({ error: '仅支持 .srt 文件' });
      }

      const content = req.file.buffer.toString('utf8');

      let cues;
      try {
        cues = srt.parseSrt(content);
      } catch (e) {
        if (e instanceof srt.SrtError) {
          return res.status(400).json({ error: e.message, line: e.line });
        }
        return res.status(500).json({ error: '解析失败' });
      }

      const rawTitle = (
        req.body.title ||
        req.file.originalname.replace(/\.srt$/i, '')
      ).trim();
      const title = rawTitle.slice(0, 200) || '未命名作品';

      try {
        const result = db.transaction(() => {
          const info = db
            .prepare('INSERT INTO works (title, revision) VALUES (?, 1)')
            .run(title);
          const workId = info.lastInsertRowid;
          const insert = db.prepare(
            'INSERT INTO cues (work_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
          );
          cues
            .slice()
            .sort((a, b) => a.startMs - b.startMs)
            .forEach((c, n) => insert.run(workId, n + 1, c.startMs, c.endMs, c.text));
          return workId;
        })();
        res.status(201).json({ id: result, revision: 1, cueCount: cues.length });
      } catch (e) {
        res.status(500).json({ error: '写入数据库失败' });
      }
    }
  );

  // 删除作品
  app.delete('/api/works/:id(\\d+)', (req, res) => {
    const work = getWorkOrNull(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });
    db.prepare('DELETE FROM works WHERE id = ?').run(work.id);
    res.json({ ok: true });
  });

  // 校订单条字幕：起止时间 / 多行文字。必须携带作品当前修订号。
  app.patch('/api/works/:id(\\d+)/cues/:cueId(\\d+)', (req, res) => {
    const work = getWorkOrNull(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const body = req.body || {};

    // 修订号校验先行：过期则拒绝覆盖，回传最新修订号与目标字幕段供人工重试。
    const baseRevision = Number(body.baseRevision);
    if (!Number.isInteger(baseRevision) || baseRevision < 1) {
      return res
        .status(400)
        .json({ error: 'baseRevision 必须为正整数（作品当前修订号）' });
    }
    if (baseRevision !== work.revision) {
      const latestCue = db
        .prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?')
        .get(req.params.cueId, work.id);
      return res.status(409).json({
        error: `修订号已过期：您基于 ${baseRevision}，当前为 ${work.revision}，请比对后重试`,
        latestRevision: work.revision,
        cue: latestCue ? cueRow(latestCue) : null,
      });
    }

    const cue = db
      .prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?')
      .get(req.params.cueId, work.id);
    if (!cue) return res.status(404).json({ error: '字幕段不存在' });

    let startMs = cue.start_ms;
    let endMs = cue.end_ms;
    let text = cue.text;

    if (body.start !== undefined) {
      try {
        startMs = srt.parseTimestamp(body.start, null);
      } catch (e) {
        return res
          .status(400)
          .json({ error: e.message.replace(/^第 \d+ 行：/u, '') });
      }
    }
    if (body.end !== undefined) {
      try {
        endMs = srt.parseTimestamp(body.end, null);
      } catch (e) {
        return res
          .status(400)
          .json({ error: e.message.replace(/^第 \d+ 行：/u, '') });
      }
    }
    if (body.text !== undefined) {
      if (typeof body.text !== 'string') {
        return res.status(400).json({ error: 'text 必须为字符串' });
      }
      const normalized = body.text
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+$/gm, '');
      if (!normalized || normalized.split('\n').every((l) => l.trim() === '')) {
        return res.status(400).json({ error: '字幕文字不能为空' });
      }
      if (Buffer.byteLength(normalized, 'utf8') > MAX_TEXT_BYTES) {
        return res
          .status(400)
          .json({ error: `字幕文字过长（上限 ${MAX_TEXT_BYTES} 字节）` });
      }
      text = normalized;
    }

    if (endMs <= startMs) {
      return res.status(400).json({ error: '结束时间必须晚于开始时间' });
    }

    try {
      const result = db.transaction(() => {
        // 写事务内复查修订号与交叠：better-sqlite3 事务在单连接上串行执行，
        // 可拦住两个请求同时通过上面预检的竞态。
        const current = db
          .prepare('SELECT revision FROM works WHERE id = ?')
          .get(work.id);
        if (!current || current.revision !== baseRevision) {
          return { kind: 'conflict', latestRevision: current ? current.revision : null };
        }

        // 同作品内不得与其它字幕段交叠（首尾相接允许）。
        const overlap = db
          .prepare(
            `SELECT id FROM cues
              WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
              LIMIT 1`
          )
          .get(work.id, cue.id, endMs, startMs);
        if (overlap) {
          return { kind: 'overlap' };
        }

        db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
        ).run(startMs, endMs, text, cue.id);
        // 时间可能改变先后顺序：按时间重新编号，保证列表与导出序号一致。
        const ordered = db
          .prepare(
            'SELECT id FROM cues WHERE work_id = ? ORDER BY start_ms ASC, id ASC'
          )
          .all(work.id);
        const renumber = db.prepare('UPDATE cues SET idx = ? WHERE id = ?');
        ordered.forEach((r, n) => renumber.run(-(n + 1), r.id)); // 两趟赋值避免 UNIQUE 瞬时冲突
        ordered.forEach((r, n) => renumber.run(n + 1, r.id));
        db.prepare(
          "UPDATE works SET revision = revision + 1, updated_at = datetime('now') WHERE id = ?"
        ).run(work.id);
        return { kind: 'ok' };
      })();

      if (result.kind === 'conflict') {
        const latestCue = db
          .prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?')
          .get(cue.id, work.id);
        return res.status(409).json({
          error: `修订号已过期：您基于 ${baseRevision}，当前为 ${result.latestRevision}，请比对后重试`,
          latestRevision: result.latestRevision,
          cue: latestCue ? cueRow(latestCue) : null,
        });
      }
      if (result.kind === 'overlap') {
        return res.status(409).json({ error: '时间范围与同作品的其它字幕段交叠' });
      }
    } catch (e) {
      return res.status(500).json({ error: '写入数据库失败' });
    }

    const updatedWork = getWorkOrNull(work.id);
    const updatedCue = cueRow(
      db.prepare('SELECT * FROM cues WHERE id = ?').get(cue.id)
    );
    res.json({ revision: updatedWork.revision, cue: updatedCue });
  });

  // 导出标准 SRT：按时间重新编号、保留换行
  app.get('/api/works/:id(\\d+)/export', (req, res) => {
    const work = getWorkOrNull(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });
    const rows = db
      .prepare('SELECT start_ms, end_ms, text FROM cues WHERE work_id = ?')
      .all(work.id);
    const srtText = srt.buildSrt(
      rows.map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, text: r.text }))
    );
    const filename = encodeURIComponent(
      `${work.title.replace(/[\\/:*?"<>|]/g, '_')}.srt`
    );
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send('\uFEFF' + srtText); // \uFEFF prefix for desktop player compatibility
  });

  // JSON 错误兜底
  app.use('/api', (err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}

module.exports = { createApp };
