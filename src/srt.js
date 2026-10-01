'use strict';

/**
 * SRT 解析与生成。
 *
 * 标准 SRT 段落格式：
 *   序号
 *   00:00:01,000 --> 00:00:03,500
 *   第一行文字
 *   第二行文字
 *   （空行结束）
 *
 * 解析失败时抛出 SrtError，其中 line 为 1 起始的行号，便于在界面上指出。
 */

class SrtError extends Error {
  constructor(message, line) {
    super(line ? `第 ${line} 行：${message}` : message);
    this.name = 'SrtError';
    this.line = line || null;
  }
}

/**
 * 解析时间戳为毫秒。接受标准逗号毫秒，也宽容点号。
 * 形如 HH:MM:SS,mmm；小时允许超过 2 位（非负整数）。
 * 可指定出错时报告的行号。
 */
function parseTimestamp(text, line) {
  const s = String(text).trim();
  const m = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(s);
  if (!m) {
    throw new SrtError(
      `时间戳格式非法：“${text}”，应为 HH:MM:SS,mmm（毫秒 3 位数字）`,
      line
    );
  }
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4]);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

/** 毫秒 -> 标准 SRT 时间戳（逗号分隔、毫秒 3 位）。 */
function formatTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new SrtError(`无法格式化时间戳：${ms}`);
  }
  const total = Math.round(ms);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

/**
 * 解析整份 SRT 文本。
 * 返回 [{ index, startMs, endMs, text }]，已按开始时间排序。
 *
 * 校验：序号、时间轴行、非负、结束晚于开始、文字非空、同一文件内段落不交叠。
 */
function parseSrt(input) {
  if (input == null) {
    throw new SrtError('文件内容为空');
  }
  let raw = String(input);
  // 去掉 UTF-8 BOM（UTF-8 BOM 不视为错误）。
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  // 统一 CRLF / CR 为 LF；去掉行尾空白但保留行首空白（文字本身可能以空格开头）。
  const lines = raw.split(/\r\n?|\n/).map((l) => l.replace(/[ \t]+$/u, ''));

  const blocks = [];
  let i = 0;

  // 跳过文件开头的空行（宽容）。
  while (i < lines.length && lines[i] === '') i++;

  while (i < lines.length) {
    const blockStart = i;
    const indexLine = lines[i];
    const indexLineNo = i + 1;

    if (!/^\d+$/u.test(indexLine.trim())) {
      throw new SrtError(`应为字幕序号（非负整数），实际为“${indexLine}”`, indexLineNo);
    }
    const index = Number(indexLine.trim());
    if (index < 1) {
      throw new SrtError('字幕序号必须从 1 开始的正整数', indexLineNo);
    }
    i++;

    if (i >= lines.length) {
      throw new SrtError('序号后缺少时间轴行', i + 1);
    }
    const timingLine = lines[i];
    const timingLineNo = i + 1;
    const timingParts = timingLine.trim().split(/\s+/u);
    if (timingParts.length < 3 || timingParts[1] !== '-->') {
      throw new SrtError(
        `时间轴行格式非法：“${timingLine}”，应为 “开始 --> 结束”`,
        timingLineNo
      );
    }
    // 标准允许时间轴后追加坐标信息（如 X1:.. X2:.. Y1:.. Y2:..），校验其形如 key:value。
    for (let k = 3; k < timingParts.length; k++) {
      if (!/^[A-Za-z]\d*:[^\s]+$/u.test(timingParts[k])) {
        throw new SrtError(
          `时间轴行含有无法识别的内容：“${timingParts[k]}”`,
          timingLineNo
        );
      }
    }
    const startMs = parseTimestamp(timingParts[0], timingLineNo);
    const endMs = parseTimestamp(timingParts[2], timingLineNo);
    if (endMs <= startMs) {
      throw new SrtError('结束时间必须晚于开始时间', timingLineNo);
    }
    i++;

    const textLines = [];
    while (i < lines.length && lines[i] !== '') {
      if (lines[i].trim() === '') {
        // 只含空白字符的行：SRT 中视为段落分隔空行，拒绝以避免歧义。
        throw new SrtError('字幕文字段中出现了空白行（应为非空文字或空行结束段落）', i + 1);
      }
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length === 0) {
      throw new SrtError('该字幕段缺少文字内容', timingLineNo);
    }
    if (textLines.some((t) => t.includes('-->'))) {
      // 文字行中出现时间轴标记通常说明缺空行/结构错乱。
      throw new SrtError('字幕文字中出现了时间轴标记 “-->”，段落结构可能错乱', i);
    }

    blocks.push({
      index,
      startMs,
      endMs,
      text: textLines.join('\n'),
      blockStartLine: blockStart + 1,
    });

    // 跳过段落之间的空行（允许多个）。
    while (i < lines.length && lines[i] === '') i++;
  }

  if (blocks.length === 0) {
    throw new SrtError('文件中没有任何字幕段');
  }

  // 交叠检查按开始时间排序后进行（首尾相接 end == next.start 允许）。
  const sorted = [...blocks].sort((a, b) => a.startMs - b.startMs);
  for (let n = 1; n < sorted.length; n++) {
    const prev = sorted[n - 1];
    const cur = sorted[n];
    if (cur.startMs < prev.endMs) {
      throw new SrtError(
        `字幕段交叠：序号 ${prev.index} 与序号 ${cur.index} 的时间范围重叠`,
        cur.blockStartLine
      );
    }
  }

  return blocks.map(({ index, startMs, endMs, text }) => ({
    index,
    startMs,
    endMs,
    text,
  }));
}

/**
 * 由字幕段数组生成标准 SRT 文本：按开始时间排序、重新编号、保留文字内换行。
 * cues: [{ startMs, endMs, text }]
 */
function buildSrt(cues) {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const out = [];
  sorted.forEach((cue, n) => {
    out.push(String(n + 1));
    out.push(`${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`);
    out.push(String(cue.text).replace(/\r\n?/g, '\n'));
    out.push('');
  });
  return out.join('\n');
}

module.exports = { SrtError, parseTimestamp, formatTimestamp, parseSrt, buildSrt };
