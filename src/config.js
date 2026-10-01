'use strict';

const path = require('path');

// 所有可配置项集中在此，均可通过环境变量覆盖（见 README）。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB, 10) * 1024 * 1024 ||
  10 * 1024 * 1024; // 默认 10MB
const MAX_TEXT_BYTES = 10 * 1024; // 单条字幕文字上限

module.exports = { DATA_DIR, PORT, HOST, MAX_UPLOAD_BYTES, MAX_TEXT_BYTES };
