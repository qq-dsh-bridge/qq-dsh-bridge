// 媒体路由：`GET|HEAD /m/<id>`（所有 kind 共用）
//
// · **不鉴权** —— 拉图的是 SnowLuma，它没有桥接的令牌。安全性靠不可枚举的
//   随机 id + 只监听回环（见 server.js）。
// · 支持 `Range`（视频拖动、语音流式）与大文件流式读，不整块进内存。
// · 非白名单 mime 一律 `application/octet-stream` + attachment —— 一个
//   `text/html` 上传在浏览器里打开就是 XSS 载体。
// · id 是内容哈希 ⇒ 同一个 id 的内容永不变化，可以长缓存。

import fs from 'node:fs';
import { SERVABLE } from '../media/kinds.js';
import { idOfPath } from '../media/url.js';

function notFound(res, message) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

// 解析 `Range: bytes=a-b`（只支持单段；多段回 200 整份，足够用）。
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);

  if (start === null && end === null) return null;
  if (start === null) {
    // `bytes=-500`：最后 500 字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

// 下载名：优先 meta.name，其次落盘文件名；去掉引号与路径分隔符。
function fileNameOf(meta) {
  const raw = String(meta?.name || meta?.rel?.split('/').pop() || 'file');
  return raw.replace(/["\\/\r\n]/g, '_').slice(0, 120);
}

// RFC 5987 的 `filename*=UTF-8''…`：encodeURIComponent 不转 `'()*`，要补。
function encodeName(s) {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function serveMedia(req, res, { store, urlPath }) {
  const id = idOfPath(urlPath);
  if (!id) {
    notFound(res, 'not found');
    return;
  }

  const hit = store.get(id);
  if (!hit) {
    notFound(res, '这份媒体已经被配额清掉，或不存在。');
    return;
  }

  const { meta, file } = hit;
  const size = meta.bytes;
  const servable = SERVABLE.has(meta.mime);
  const name = fileNameOf(meta);
  const headers = {
    'content-type': servable ? meta.mime : 'application/octet-stream',
    'accept-ranges': 'bytes',
    // 内容寻址：id 由 sha256 决定，内容永不改变。
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${servable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeName(name)}`,
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': size });
    res.end();
    return;
  }

  const range = parseRange(req.headers?.range, size);
  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': size });
  fs.createReadStream(file).pipe(res);
}
