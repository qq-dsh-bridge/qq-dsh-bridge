// 通用二进制下载（语音 / 视频 / 文件）—— 与 fetchImageBuffer 同一套安全边界。
//
// 为什么单独一个文件而不是复用 `image-fetch.js`：那边的域名白名单、错误文案、
// 上限都是按"图片"写的；语音要走同一条白名单但不同的大小上限与文案。
// 两套逻辑混在一起，改一处就会误伤另一处。

// QQ 的媒体 CDN。语音（amr/silk）、视频、图片都从这几个域名发。
export const MEDIA_HOSTS = new Set([
  'multimedia.nt.qq.com.cn',
  'gchat.qpic.cn',
  'p.qpic.cn',
  'c2cpicdw.qpic.cn',
  'c3cpicdw.qpic.cn',
]);

// @returns `{ buffer, contentType }`
export async function fetchBinary(url, { maxBytes = 16 * 1024 * 1024, label = '媒体' } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`${label}地址不是合法 URL：${String(url).slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label}地址协议不支持：${u.protocol}`);
  }
  // 白名单是 SSRF 的唯一防线：模型不能借这个工具去抓内网/任意地址。
  if (!MEDIA_HOSTS.has(u.hostname)) {
    throw new Error(`${label}域名不在白名单内：${u.hostname}（允许：${[...MEDIA_HOSTS].join(', ')}）`);
  }

  const res = await fetch(u.href, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载${label}失败：HTTP ${res.status}`);

  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`${label}太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`${label}是空的`);
  if (buf.length > maxBytes) throw new Error(`${label}太大（${buf.length} 字节）`);

  return { buffer: buf, contentType: res.headers?.get?.('content-type') ?? 'application/octet-stream' };
}
