'use strict';

/**
 * 初始化存储：创建数据目录与 SQLite 表结构。幂等。
 * Docker 构建阶段运行 npm run init-db；容器启动时 openDb() 也会再次确保表存在。
 */
const { openDb, closeDb } = require('../src/db');

const db = openDb();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('works','cues')")
  .all();
closeDb();

console.log('数据库初始化完成，已就绪的表：', tables.map((t) => t.name).join(', '));
