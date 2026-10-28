// 日志。
//
// 三个硬要求（都来自旧实现踩过的坑）：
//
//  1. **编码统一 UTF-8。** 旧方案的 `bridge.log` 是 GBK 写入 / UTF-8 读取，
//     整份日志是 mojibake，人工排查时等于没有日志。这里显式指定 utf8，
//     不做任何平台默认编码推断。
//
//  2. **脱敏在写入前完成，而不是靠调用方自觉。** 旧实现有 ~30 处调用点，
//     其中几条发送路径**故意跳过**了脱敏、改用精确 token 名单兜底——
//     那种分散策略必然会随新增调用点而漏。这里把脱敏做进 logger 本身：
//     任何走到 logger 的字符串都会被过一遍。
//
//  3. **结构化字段与消息分开。** 把耗时/会话/原因做成字段而不是拼进文本，
//     这样"慢在哪"可以直接聚合，不用 grep 正则（旧方案只能 grep）。

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// 脱敏规则。宁可多脱一点，也不要把凭据写进日志。
//
// 覆盖：Cookie（含 dsh-auth-*）、Authorization/Bearer、常见 token 字段名、
// 带 access_token 的 URL 查询串。
const REDACTIONS = [
  // dsh-auth-xxx=... 整段 Cookie
  [/(dsh-auth-[A-Za-z0-9_-]+=)[^\s;,"']+/g, '$1<redacted>'],
  // Cookie: ... / Set-Cookie: ...
  [/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1<redacted>'],
  // Authorization: Bearer xxx
  [/((?:authorization|proxy-authorization)\s*:\s*)[^\r\n]+/gi, '$1<redacted>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/g, '$1 <redacted>'],
  // JSON / 查询串里的敏感键
  [
    /("?(?:access_?token|accessToken|auth_?token|launch_?token|api_?key|apiKey|secret|password|passwordHash|passwordSalt)"?\s*[:=]\s*)("?)([^"',\s}&]+)\2/gi,
    '$1$2<redacted>$2',
  ],
  // URL 查询串里的 token
  [/([?&](?:access_token|token|key)=)[^&\s"']+/gi, '$1<redacted>'],
];

// 电话号码般的 QQ 号：不脱敏（排查必需），但长数字串里的 token 形态要防。
export function redact(text) {
  let out = String(text);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

export class Logger {
  // @param options.level  最低输出级别
  // @param options.file   同时写入的文件；空 = 不写文件
  // @param options.maxBytes 单文件轮转上限
  // @param options.maxFiles 保留文件数
  // @param options.stdout / stderr 可注入，便于测试
  constructor({ level = 'info', file = '', maxBytes = 8 * 1024 * 1024, maxFiles = 5, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.setLevel(level);
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stream = null;
    this.written = 0;
    if (file) this.#openFile();
  }

  setLevel(level) {
    const normalized = String(level).toLowerCase();
    if (!(normalized in LEVELS)) {
      throw new Error(`未知日志级别 "${level}"，可用：${Object.keys(LEVELS).join(' / ')}`);
    }
    this.level = normalized;
    this.threshold = LEVELS[normalized];
  }

  #openFile() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 追加模式 + 显式 utf8：不使用平台默认编码。
      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
      this.stream.on('error', (error) => {
        // 文件日志坏掉不能影响主流程，但必须让人看见（走 stderr，避免递归）。
        this.stderr.write(`[logger] 日志文件写入失败：${error.message}\n`);
        this.stream = null;
      });
      this.written = fs.statSync(this.file).size;
    } catch (error) {
      this.stderr.write(`[logger] 无法打开日志文件 ${this.file}：${error.message}\n`);
      this.stream = null;
    }
  }

  #rotateIfNeeded() {
    if (!this.stream || this.written < this.maxBytes) return;
    try {
      this.stream.end();
      // 简单轮转：.log → .log.1 → .log.2 …
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
      this.written = 0;
    } catch (error) {
      this.stderr.write(`[logger] 日志轮转失败：${error.message}\n`);
    }
  }

  #write(level, message, fields) {
    if (LEVELS[level] < this.threshold) return;

    const at = new Date();
    // 本地时钟 + 显式时区偏移，避免跨时区排查时对不上（旧方案只有本地时间无偏移）。
    const ts = formatTimestamp(at);
    const safeMessage = redact(message);
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${redact(stableFields(fields))}` : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${safeMessage}${suffix}\n`;

    const sink = LEVELS[level] >= LEVELS.warn ? this.stderr : this.stdout;
    sink.write(line);

    if (this.stream) {
      this.stream.write(line);
      this.written += Buffer.byteLength(line, 'utf8');
      this.#rotateIfNeeded();
    }
  }

  debug(message, fields) { this.#write('debug', message, fields); }
  info(message, fields) { this.#write('info', message, fields); }
  warn(message, fields) { this.#write('warn', message, fields); }
  error(message, fields) { this.#write('error', message, fields); }

  // 从配置构造。
  static fromConfig(config, options = {}) {
    return new Logger({
      level: config.log.level,
      file: config.log.file,
      maxBytes: config.log.maxBytes,
      maxFiles: config.log.maxFiles,
      ...options,
    });
  }

  // 应用新配置。热重载时调用。
  //
  // 日志级别的改动必须当场生效——否则"我已经调成 debug 了但没看到日志"
  // 会浪费大量排查时间。文件路径变化则重开流。
  applyConfig(config) {
    this.setLevel(config.log.level);
    if (config.log.file !== this.file) {
      this.stream?.end();
      this.stream = null;
      this.file = config.log.file;
      this.maxBytes = config.log.maxBytes;
      this.maxFiles = config.log.maxFiles;
      if (this.file) this.#openFile();
    } else {
      this.maxBytes = config.log.maxBytes;
      this.maxFiles = config.log.maxFiles;
    }
  }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}

function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// 字段序列化：键排序，保证同一条日志在不同次的输出可比对。
function stableFields(fields) {
  const keys = Object.keys(fields).sort();
  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' ');
}

// 读日志文件的尾部 N 行（给控制台用）。
//
// 只读尾部而不是整个文件：日志会轮转、可能几十 MB，
// 控制台每次刷新都全读一遍是浪费。
//
// 从文件末尾按块往回读，够 N 行就停 —— 避免为了最后 200 行
// 把整个文件载进内存。
export function readLogTail(file, lines = 200) {
  if (!file || !fs.existsSync(file)) return [];

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const CHUNK = 64 * 1024;
    let pos = size;
    let text = '';

    while (pos > 0 && countLines(text) <= lines) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      text = buf.toString('utf8') + text;
    }

    const all = text.split(/\r?\n/);
    // 末尾通常有个空行（每行都以 \n 结尾），去掉它。
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {
      // 已关
    }
    }
  }
}

function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}
