// 媒体 URL 的唯一解析 / 拼装处。
//
// 形状：`http://127.0.0.1:3110/m/<32hex>`
//   · 不带扩展名 —— 类型由存储里的 `meta.mime` 决定；扩展名是给人看的，
//     不是给 HTTP 的（Content-Type 才是）。
//   · 不带文件名 —— 下载名从 `meta.name` 走 Content-Disposition。
//
// ⚠️ `idOfUrl` 同时是**取图/收藏的安全边界**：只认回环 + `/m/<32hex>`。
//    放开的话它就变成 SSRF 入口（模型能让桥接去请求任意地址）。

const MEDIA_PATH = /^\/m\/([0-9a-f]{32})(?:\/.*)?$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// 从请求路径取出 id（`/m/<id>`，可带尾随的文件名段）。
export function idOfPath(urlPath) {
  const [p] = String(urlPath ?? '').split('?');
  const m = MEDIA_PATH.exec(p);
  return m ? m[1].toLowerCase() : null;
}

// 从完整 URL 取出 id；非本机回环一律 null。
export function idOfUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (!LOOPBACK.has(u.hostname)) return null;
  return idOfPath(u.pathname);
}

export function mediaPathOf(id) {
  return `/m/${id}`;
}

export function mediaUrlOf(baseUrl, id) {
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}${mediaPathOf(id)}`;
}
