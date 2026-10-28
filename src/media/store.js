// 媒体仓库：内容寻址 + 落盘 + 一份索引
//
// 布局（`<root>/<uin>/`，对齐 QQ / SnowLuma 的按号分层）：
//   image/2026-10/<id>.<ext>
//   ptt/2026-10/<id>.<ext>
//   video/2026-10/<id>.<ext>
//   file/2026-10/<id>_<原文件名>
//   emoji/<id>.<ext>              ← 不分日期、永不自动清理
//   tmp/<uuid>.part               ← 边写边落，写完 rename 进正式目录
//   index.jsonl                   ← 一行一条元数据（追加写，sweep 时整体重写）
//
// `id = sha256(data).slice(0, 32)`：同内容只存一份，重复发布拿到同一个 URL。
// 为什么落盘：视频/语音动辄几 MB，而且 QQ 拉图有延迟、进程重启后链接不该立刻失效。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, extOfMime } from './kinds.js';

export class MediaError extends Error {
  constructor(message, { status = 400, code = 'bad-media' } = {}) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.code = code;
  }
}

const MB = 1024 * 1024;
const MAX_NAME = 80;

// 原文件名里的路径分隔符与控制字符一律抹掉；保留中文与空格。
// `..` 也压成 `_`：虽然分隔符已经没了、跳不出去，但名字里留着 `..` 只会让人误会。
function safeName(raw, ext) {
  const base = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .trim()
    .slice(0, MAX_NAME);
  if (!base) return '';
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base;
}

function monthOf(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function createMediaStore({ root, uin = 'unknown', logger = null, totalMb = 500 } = {}) {
  if (!root) throw new MediaError('createMediaStore 需要 root', { code: 'no-root' });

  const base = path.join(root, String(uin || 'unknown'));
  const tmpDir = path.join(base, 'tmp');
  const indexPath = path.join(base, 'index.jsonl');

  /** @type {Map<string, any>} id → meta */
  const index = new Map();
  // origin → id。用于"这条消息的这张图是不是已经存过了"，避免每次调用都重新下载。
  const origins = new Map();
  let totalBytes = 0;
  // 上次读索引时磁盘文件的 mtime —— 外部脚本（迁移/收藏）写进来后靠它触发回读。
  let loadedAt = 0;

  fs.mkdirSync(tmpDir, { recursive: true });

  // ── 索引 ────────────────────────────────────────────────────────────────

  function load() {
    let raw = '';
    try {
      raw = fs.readFileSync(indexPath, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let meta;
      try {
        meta = JSON.parse(line);
      } catch {
        continue;   // 半截行（进程被杀）直接跳过
      }
      if (!meta?.id) continue;
      if (meta.deleted) {
        index.delete(meta.id);
        continue;
      }
      // 别名行：`{ id, origin }`（同一个 id 被第二个 origin 认领 —— 同图不同消息）。
      if (!meta.rel) {
        if (meta.origin) origins.set(meta.origin, meta.id);
        continue;
      }
      // 文件被手动删了就当作没这条
      if (!fs.existsSync(path.join(base, meta.rel))) continue;
      index.set(meta.id, meta);
      if (meta.origin) origins.set(meta.origin, meta.id);
    }
    totalBytes = [...index.values()].reduce((n, m) => n + (m.bytes || 0), 0);
    try {
      loadedAt = fs.statSync(indexPath).mtimeMs;
    } catch {
      loadedAt = 0;
    }
    logger?.debug('媒体索引已加载', { uin, entries: index.size, totalBytes });
  }

  function rewriteIndex() {
    const lines = [...index.values()].map((m) => JSON.stringify(m));
    // 别名也得落盘：同一个 id 被多个 origin 认领时，只有一条能写在 meta 里。
    for (const [origin, id] of origins) {
      const meta = index.get(id);
      if (!meta || meta.origin === origin) continue;
      lines.push(JSON.stringify({ id, origin }));
    }
    const body = lines.join('\n');
    const tmp = `${indexPath}.${process.pid}.tmp`;
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
    fs.renameSync(tmp, indexPath);
    try {
      loadedAt = fs.statSync(indexPath).mtimeMs;
    } catch {
      loadedAt = 0;
    }
  }

  // ── 写 ──────────────────────────────────────────────────────────────────

  // 存一份媒体。
  // @returns `{ id, rel, mime, bytes, createdAt, expiresAt, reused }`
  function put({ data, kind = 'image', mime, name = '', ttlMs, origin = '', permanent = false } = {}) {
    const spec = KINDS[kind];
    if (!spec) throw new MediaError(`未知的媒体类别 "${kind}"`, { code: 'bad-kind' });
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new MediaError('媒体数据是空的', { code: 'empty' });
    }
    if (data.length > spec.maxBytes) {
      throw new MediaError(
        `${kind} 超过单文件上限（${(spec.maxBytes / MB).toFixed(0)} MB，收到 ${(data.length / MB).toFixed(1)} MB）`,
        { code: 'too-large', status: 413 },
      );
    }

    const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
    const allowed = spec.mimes;
    if (allowed && !allowed[type]) {
      throw new MediaError(
        `${kind} 不支持 "${type}"。允许：${Object.keys(allowed).join(' / ')}`,
        { code: 'bad-mime' },
      );
    }

    const ext = allowed ? allowed[type] : extOfMime(type);
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);

    const hit = index.get(id);
    if (hit && fs.existsSync(path.join(base, hit.rel))) {
      // 同一份内容再发一次：只续期，不重复写盘。
      if (!permanent && hit.expiresAt) {
        hit.expiresAt = Date.now() + (ttlMs ?? spec.ttlMs);
        rewriteIndex();
      }
      // 同内容、不同来源（同一张图出现在两条消息里）：把新 origin 也认领到这个 id。
      remember(origin, id);
      return { ...hit, reused: true };
    }

    const dir = spec.byMonth ? path.join(spec.dir, monthOf()) : spec.dir;
    const fileName = kind === 'file'
      ? `${id}_${safeName(name, ext) || `file.${ext || 'bin'}`}`
      : `${id}.${ext || 'bin'}`;
    const rel = path.join(dir, fileName).split(path.sep).join('/');

    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const part = path.join(tmpDir, `${crypto.randomUUID()}.part`);
    fs.writeFileSync(part, data);
    fs.renameSync(part, abs);

    const ttl = permanent || spec.ttlMs === 0 ? 0 : (ttlMs ?? spec.ttlMs);
    const meta = {
      id,
      kind,
      mime: allowed ? type : type || 'application/octet-stream',
      bytes: data.length,
      rel,
      name: kind === 'file' ? (safeName(name, ext) || fileName) : '',
      origin,
      createdAt: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
      // 永久项不进配额淘汰（表情；或调用方显式 permanent）。
      ...(permanent || spec.permanent ? { permanent: 1 } : {}),
    };
    index.set(id, meta);
    totalBytes += meta.bytes;
    fs.appendFileSync(indexPath, `${JSON.stringify(meta)}\n`, 'utf8');
    remember(origin, id);
    return meta;
  }

  // 记住"这个来源对应哪个 id"。
  //
  // 为什么单独存一层：`getMessageContent` 要按「会话+seq+第几张」判断"存过没有"。
  // 只用内容 hash 判不出来（那得先把图下载下来算 hash —— 正是要避免的事）。
  // 别名行只写 `{ id, origin }`，体积可以忽略。
  function remember(origin, id) {
    const key = String(origin ?? '');
    if (!key || origins.get(key) === id) return;
    origins.set(key, id);
    try {
      fs.appendFileSync(indexPath, `${JSON.stringify({ id, origin: key })}\n`, 'utf8');
    } catch { /* 索引写不进去不影响本次返回 */ }
  }

  // 按来源查（返回 meta 或 null）。
  function findByOrigin(origin) {
    const key = String(origin ?? '');
    if (!key) return null;
    let id = origins.get(key);
    if (!id && indexMtimeAhead()) {
      load();
      id = origins.get(key);
    }
    return id ? get(id)?.meta ?? null : null;
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  function get(id) {
    const key = String(id ?? '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(key)) return null;

    let meta = index.get(key);

    // 索引里有**别的进程**写进来的条目时（手工脚本、或者同时跑的第二份实例），
    // 内存里还是旧的 —— 查不到就回读一次索引文件。
    if (!meta && indexMtimeAhead()) {
      load();
      meta = index.get(key);
    }

    if (!meta) return null;
    if (meta.expiresAt && Date.now() > meta.expiresAt) return null;
    const abs = path.join(base, meta.rel);
    if (!fs.existsSync(abs)) {
      index.delete(key);
      return null;
    }
    return { meta, file: abs };
  }

  // 磁盘上的索引比内存新？（外部写入）
  function indexMtimeAhead() {
    try {
      return fs.statSync(indexPath).mtimeMs > loadedAt;
    } catch {
      return false;
    }
  }

  function read(id) {
    const hit = get(id);
    return hit ? fs.readFileSync(hit.file) : null;
  }

  // ── 清理 ────────────────────────────────────────────────────────────────

  function sweep(now = Date.now()) {
    let changed = false;

    for (const [id, meta] of index) {
      if (meta.expiresAt && now > meta.expiresAt) {
        try { fs.unlinkSync(path.join(base, meta.rel)); } catch { /* 已经没了 */ }
        index.delete(id);
        totalBytes -= meta.bytes || 0;
        changed = true;
      }
    }

    // 配额：超了按创建时间删，**只删到刚好不超**（不预清 10%）。
    //
    // 按"删一条、再看一眼"删，停在上限内。别一次删到 `cap * 0.9` ——
    // 那等于每次触顶白扔 10% 的缓存，500 MB 就是 50 MB。
    //
    // 表情（KINDS[kind].permanent）不参与：那是手攒的资产，不随缓存淘汰。
    const cap = totalMb * MB;
    if (totalBytes > cap) {
      const victims = [...index.values()]
        .filter((m) => !m.permanent && !KINDS[m.kind]?.permanent)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const meta of victims) {
        if (totalBytes <= cap) break;
        try { fs.unlinkSync(path.join(base, meta.rel)); } catch { /* ignore */ }
        index.delete(meta.id);
        totalBytes -= meta.bytes || 0;
        changed = true;
      }
    }

    // tmp 里超过 1 小时的半截文件
    try {
      for (const name of fs.readdirSync(tmpDir)) {
        const p = path.join(tmpDir, name);
        try {
          if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(p);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    if (changed) rewriteIndex();
    return { entries: index.size, bytes: totalBytes };
  }

  function stats() {
    const byKind = {};
    for (const m of index.values()) {
      byKind[m.kind] = byKind[m.kind] ?? { count: 0, bytes: 0 };
      byKind[m.kind].count += 1;
      byKind[m.kind].bytes += m.bytes || 0;
    }
    return { root: base, entries: index.size, bytes: totalBytes, totalMb, byKind };
  }

  load();

  return { put, get, read, findByOrigin, sweep, stats, base, root, indexPath };
}
