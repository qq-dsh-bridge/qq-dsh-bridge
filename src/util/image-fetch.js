// 图片下载 + 压到 base64 安全线以下
// base64 长度上限 —— **这不是我们的限制，是 DSH 的 bug**。
//
// `dsh-mcp-client/lib/index.js` 校验图片时用的是正则：
//
//     CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
//
// V8 用递归处理 `(?:…{4})*` 这种量词组，**base64 超过约 4.48 MB 字符就爆栈**：
//
//     [image unavailable: image/png; Maximum call stack size exceeded; …]
//
// 实测（逐个尺寸试出来）：
//     3,000,000 字符 → ✅ 20ms
//     4,472,656 字符 → ✅
//     4,483,984 字符 → ❌ 爆栈
//
// 它自己配的 `maxImageBytes: 20MB` 根本没机会生效 —— 正则先炸了。
// 而我们绕不过它（那是 DSH 的代码），只能**在桥接侧压到安全线以下**。
//
// 取 3 MB 留 33% 余量（不同图片的 base64 模式可能影响阈值）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BASE64_CHARS = 3 * 1024 * 1024;

// 允许下载图片的域名 —— QQ 的图床。
const IMAGE_HOSTS = new Set([
  'multimedia.nt.qq.com.cn',
  'gchat.qpic.cn',
  'p.qpic.cn',
  'c2cpicdw.qpic.cn',
  'c3cpicdw.qpic.cn',
  // 商城表情（mface）的预览地址；收藏表情时要从这里取 GIF。
  'gxh.vip.qq.com',
]);

// DSH 自带的 sharp（不新增依赖，借用它的）。
//
// 这个桥接本来就与 DSH 桌面端同机部署，所以**借同机那份**是刻意的；
// 但路径不写死：按"当前进程可执行文件所在目录 + 几个常见安装位置"推算，
// 换机器、换用户名都不用改代码。都推算不出来时也只是"退回原图"，不会崩。
//
// 想显式指定就用 `QQ_SHARP_URL`（file:// URL），它的优先级最高。
const SHARP_REL = path.join('resources', 'app', 'node_modules', 'sharp', 'dist', 'index.mjs');

// 本仓库自己装了 sharp 的话也能用（`npm i sharp`），此时不必依赖 DSH。
const LOCAL_SHARP_REL = path.join('node_modules', 'sharp', 'dist', 'index.mjs');
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sharpCandidates() {
  const list = [];
  if (process.env.QQ_SHARP_URL) list.push(process.env.QQ_SHARP_URL);

  // 已解包的 DSH 安装根目录（`resources/app/...` 那种布局）—— 有两种可能的落点。
  const appRoots = [
    path.dirname(process.execPath),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH NEXT') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'DSH Desktop') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'DSH Desktop') : '',
  ];
  const relatives = [
    SHARP_REL,
    path.join('node_modules', 'sharp', 'dist', 'index.mjs'),
  ];

  for (const root of [PROJECT_ROOT, ...appRoots]) {
    if (!root) continue;
    for (const rel of relatives) {
      const file = path.join(root, rel);
      if (fs.existsSync(file)) {
        const url = pathToFileURL(file).href;
        if (!list.includes(url)) list.push(url);
      }
    }
  }
  return list;
}

const SHARP_URLS = sharpCandidates();

// 按候选顺序加载 sharp，第一个能 import 的就是它。
//
// 全都失败时抛出**最后一个**错误 —— 调用方据此把"压不了"写进 note，
// 而不是让整个取图操作失败。
async function loadSharp() {
  if (SHARP_URLS.length === 0) {
    throw new Error('找不到 DSH 桌面端的 sharp（可用 QQ_SHARP_URL 显式指定）');
  }
  let lastError;
  for (const url of SHARP_URLS) {
    try {
      const mod = await import(url);
      return mod.default ?? mod;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// 图片下载 + 压缩（给"让模型看图"用）。
//
// 域名白名单与 stickers.js 分开：表情库固定来自 QQ 表情 CDN，
// 群聊图片可能来自 `multimedia.nt.qq.com.cn`、`gchat.qpic.cn` 等。
//
// @returns `{ buffer, contentType }`
export async function fetchImageBuffer(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`图片地址不是合法 URL：${String(url).slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`图片地址协议不支持：${u.protocol}`);
  }
  if (!IMAGE_HOSTS.has(u.hostname)) {
    throw new Error(`图片域名不在白名单内：${u.hostname}（允许：${[...IMAGE_HOSTS].join(', ')}）`);
  }

  const res = await fetch(u.href, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`图片太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('图片是空的');
  if (buf.length > maxBytes) throw new Error(`图片太大（${buf.length} 字节）`);

  return { buffer: buf, contentType: res.headers?.get?.('content-type') ?? 'image/png' };
}

// 用 sharp 把图片压到 base64 安全线以下。
//
// ── 为什么要压（见 MAX_BASE64_CHARS 的说明）
//
// DSH 校验 base64 的正则在 >4.48 MB 字符时爆栈，而它自己配的
// 20MB 上限根本没机会生效。那张 2560×1440 PNG 压出来 5.91 MB，
// 于是模型收到的是 `[image unavailable: … Maximum call stack size exceeded]`。
//
// ── 为什么可以借用 DSH 的 sharp
//
// 本项目坚持零运行时依赖，但 sharp 是 **DSH 自带的**（桌面端 node_modules），
// 同机同版本、路径稳定。用绝对 file:// URL 动态 import 即可 ——
// 不装新依赖，也不改 package.json。
//
// 借不到时**不报错**，退回原图 —— 那样至多大图看不了，不会让整个工具失败。
//
// @returns `{ buffer, contentType, shrunk, note }`
export async function shrinkToSafeBase64({ buffer, contentType }, { maxChars = MAX_BASE64_CHARS } = {}) {
  // 字节数 → base64 字符数（向上取整到 4 的倍数）。
  //
  // ⚠️ **参数是「字节数」，不是 Buffer。**
  //
  // 第一版写成 `(b) => Math.ceil(b.length / 3) * 4` 然后调 `b64Len(buffer.length)`
  // —— 传进去的是数字，数字没有 `.length`，于是算出 **`NaN`**。
  // 而 `NaN <= 任何数` **永远是 false**，于是"已在安全线内就直接返回"
  // 这条早退**永远不生效**：**每一张图都被压缩**，连 0.28MB 的小图
  // 也被一路压到 285px / q40，糊到认不出屏幕上写的型号。
  //
  // 这种 bug 特别隐蔽：不报错、不抛异常，只是**判断恒为假**。
  // 所以这里把参数名写成 `bytes` 并做了防御 —— 传错类型直接炸，
  // 别再让它安静地算出一个 NaN。
  const b64Len = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`b64Len 需要字节数，收到 ${bytes}（类型 ${typeof bytes}）`);
    }
    return Math.ceil(bytes / 3) * 4;
  };

  // 已经在安全线内 —— 不动它，避免无谓的重编码损失画质。
  if (b64Len(buffer.length) <= maxChars) {
    return { buffer, contentType, shrunk: false };
  }

  let sharp;
  try {
    sharp = await loadSharp();
  } catch (error) {
    return {
      buffer,
      contentType,
      shrunk: false,
      note: `图片过大（base64 约 ${(b64Len(buffer.length) / 1024 / 1024).toFixed(1)}MB，`
        + `超过 DSH 能接受的 ${(maxChars / 1024 / 1024).toFixed(0)}MB）且无法加载压缩库`
        + `（${error.message.slice(0, 80)}），原样返回 —— 这次很可能看不到。`,
    };
  }

  // 逐步降质降尺寸，直到进安全线。
  //
  // ── 策略为什么这样定（实测调整过一轮）
  //
  // 第一版从 1600px/q80 起步、每轮缩 0.75 倍降到 q40、最多 6 轮 ——
  // 结果实测出现 `285px / q40` 的**糊到认不出字**的输出，
  // agent 只能回"这图糊了，型号基本看不清喵"。
  //
  // 问题不在"要不要压"，而在**起步太低、降得太狠**：
  //   · 截图里要认的是**小字**（型号、内存容量），分辨率比压缩率重要得多
  //   · JPEG 对文字本来就吃亏，q40 基本等于毁掉文字
  //   · 而安全线是 3MB base64（≈2.2MB 图），**正常截图根本用不到那么小**
  //
  // 所以改成：**先只降质量，尽量不降分辨率**；只有质量降到 60 还不够，
  // 才开始缩尺寸。这样文字清晰度优先保住。
  const steps = [
    // 先只动质量，保住分辨率（文字最吃这个）
    { w: 2200, q: 88 },
    { w: 2200, q: 78 },
    { w: 2200, q: 68 },
    // 还不够才缩尺寸 —— 每次只缩到 0.85，别一步砍掉一半
    { w: 1870, q: 68 },
    { w: 1600, q: 68 },
    { w: 1360, q: 70 },
    { w: 1100, q: 72 },
  ];

  for (const step of steps) {
    let out;
    try {
      out = await sharp(buffer)
        .resize({ width: step.w, height: step.w, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: step.q, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      return {
        buffer, contentType, shrunk: false,
        note: `压缩失败（${error.message.slice(0, 80)}），原样返回。`,
      };
    }
    if (b64Len(out.length) <= maxChars) {
      return {
        buffer: out,
        contentType: 'image/jpeg',
        shrunk: true,
        note: `原图过大，已压成 ${step.w}px / q${step.q}（`
          + `${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(out.length / 1024).toFixed(0)}KB）。`,
      };
    }
  }

  // 连最狠的一档都不够 —— 说明是**超长截图**那类极端图（几千像素高）。
  // 这时候按高度再砍一刀，并**明说可能看不清**，让 agent 有机会请对方补文字。
  const last = steps[steps.length - 1];
  const out = await sharp(buffer)
    .resize({ width: 1100, height: 4000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();
  return {
    buffer: out,
    contentType: 'image/jpeg',
    shrunk: true,
    note: `图片极大（可能是超长截图），已压到 1100px / q70，**细节可能看不清**；`
      + '如果关键信息认不出来，直接问对方要文字。',
  };
}
