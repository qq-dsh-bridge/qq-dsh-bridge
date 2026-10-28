// 安全下载：给"模型给的 URL"用（qq_send 的 image / voice 入缓存）。
//
// 与 `image-fetch.js` / `media-fetch.js` 的区别：
//   · 那两个只允许 **QQ 图床白名单**，给"看群里的图/语音"用；
//   · 这个允许任意公网 http(s)，但**拒绝回环 / 私网 / 链路本地**，给
//     "把模型给的地址抓回来存进媒体库"用。
//
// ⚠️ 这是 SSRF 的边界：桥接跑在回环上，后面就是 dsh 的 3082 / 3110。
//    模型能塞任意 URL 进来，所以必须在这里挡内网，而不是相信 SnowLuma。
//    已知残余风险：DNS rebinding（校验时解析一次、fetch 时再解析一次）。
//    本机部署下这个风险很低；真要彻底解决得给 undici 换 connector，先不做。

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 私网 / 保留地址。返回 true = 不能访问。
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 192 && b === 0) return true;                // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                            // multicast + reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;        // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true;        // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // 解析不出 IP —— 按不安全处理。
  return true;
}

// 校验一个 URL 是否可以访问（协议 + 主机）。
async function assertPublicHost(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只允许 http(s) 地址（收到 ${u.protocol}）`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('地址缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`拒绝访问本机地址：${host}`);
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`拒绝访问内网地址：${host}`);
    return;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`域名解析失败：${host}`);
  }
  if (!addrs.length) throw new Error(`域名没有解析结果：${host}`);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`拒绝访问内网地址：${host} → ${bad.address}`);
}

async function readBody(res, { maxBytes, controller }) {
  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`内容太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }

  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`内容太大（${buf.length} 字节）`);
    return buf;
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`内容太大（超过 ${maxBytes} 字节）`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// 下载一个公网地址。
//
// @returns `{ buffer, contentType, finalUrl }`
export async function fetchSafe(rawUrl, { maxBytes = 8 * 1024 * 1024, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let current;
  try {
    current = new URL(String(rawUrl));
  } catch {
    throw new Error(`地址不是合法 URL：${String(rawUrl).slice(0, 120)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(current);

      const res = await fetch(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': UA, accept: '*/*' },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers?.get?.('location');
        if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
        current = new URL(loc, current);
        continue;
      }
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

      const buffer = await readBody(res, { maxBytes, controller });
      if (buffer.length === 0) throw new Error('下载到的是空内容');

      return {
        buffer,
        contentType: String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase(),
        finalUrl: current.href,
      };
    }
    throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`下载超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
