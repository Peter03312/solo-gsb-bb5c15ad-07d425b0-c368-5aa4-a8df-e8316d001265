'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

let dbInstance = null;

/**
 * 打开（必要时创建）SQLite 数据库并建表。幂等，可重复调用。
 */
function openDb(dataDir = DATA_DIR) {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'subtitles.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cues (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      idx     INTEGER NOT NULL,          -- 作品内序号（按时间）
      start_ms INTEGER NOT NULL,
      end_ms   INTEGER NOT NULL,
      text    TEXT NOT NULL,
      UNIQUE (work_id, idx)
    );

    CREATE INDEX IF NOT EXISTS idx_cues_work ON cues (work_id, start_ms);
  `);

  dbInstance = db;
  return db;
}

function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = { openDb, closeDb };
