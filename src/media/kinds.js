// 媒体类型表：目录名、允许的 mime、默认 TTL、单文件上限
//
// ⚠️ `ttlMs: 0` = **不按时间清**，只受配额（media.totalMb）约束。
// 统一按配额淘汰（攒到上限再按最旧删），见 store.js 的 sweep()。别改成按时间清：
// 那会让一张图在 10~20 分钟后就被删，比 QQ 自己的图片缓存还短。
// `permanent: true`（表情）不进配额淘汰：那是手攒的资产，不是缓存。

export const KINDS = Object.freeze({
  image: {
    dir: 'image',
    byMonth: true,
    ttlMs: 0,
    maxBytes: 8 * 1024 * 1024,
    mimes: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' },
  },
  audio: {
    dir: 'ptt',
    byMonth: true,
    ttlMs: 0,
    maxBytes: 16 * 1024 * 1024,
    mimes: {
      'audio/amr': 'amr',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/silk': 'silk',
    },
  },
  video: {
    dir: 'video',
    byMonth: true,
    ttlMs: 0,
    maxBytes: 64 * 1024 * 1024,
    mimes: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
  },
  file: {
    dir: 'file',
    byMonth: true,
    ttlMs: 0,
    maxBytes: 64 * 1024 * 1024,
    mimes: null,   // 任意，扩展名从文件名推
  },
  emoji: {
    dir: 'emoji',
    byMonth: false,
    ttlMs: 0,      // 永久：表情是手攒的资产，不是缓存
    permanent: true,
    maxBytes: 4 * 1024 * 1024,
    mimes: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' },
  },
});

// 这里曾导出 `KIND_NAMES = Object.keys(KINDS)` —— **已删**：没有任何消费方，
// 而 `Object.keys(KINDS)` 本身就够用；多一个"名字列表"只会让人以为它是白名单。

// 扩展名 → mime（`file` 类别只有这一条反查路径，也用于路由的 Content-Type）。
const EXT_MIME = new Map();
for (const spec of Object.values(KINDS)) {
  for (const [mime, ext] of Object.entries(spec.mimes ?? {})) EXT_MIME.set(ext, mime);
}
EXT_MIME.set('pdf', 'application/pdf');
EXT_MIME.set('zip', 'application/zip');
EXT_MIME.set('txt', 'text/plain; charset=utf-8');
EXT_MIME.set('json', 'application/json');

// 能直接发给浏览器的类型（其余一律 octet-stream + attachment）。
export const SERVABLE = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/amr', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/silk',
  'video/mp4', 'video/webm',
  'application/pdf', 'application/zip', 'text/plain; charset=utf-8', 'application/json',
]);

export function extOfMime(mime) {
  return EXT_MIME.get(String(mime ?? '').split(';')[0].trim().toLowerCase()) ?? '';
}
