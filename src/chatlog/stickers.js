// 表情库。
//
// ── 数据从哪来
//
// 每个 QQ 号一份索引：`state/stickers/<uin>/index.json`（图片同目录
// `<md5>.<ext>`）。收藏表情是**账号级**的，不能混在一个文件里。
// 条目里的 `emoji_id` 是 QQ 收藏表情的身份，`url` 指向
// `p.qpic.cn/qq_expression/<uin>/...`。
//
// ── 怎么发出去
//
// 有 `emoji_id` 的走 SnowLuma `send_custom_face`（保留收藏表情样式）；
// 只有本地字节的旧条目才退回 `image` + base64。
//
// ── 一条消息只能是一张表情
//
// 这是 QQ 的常识：表情和文字**不能**挤在同一个气泡里。
// 想说话就另外发一条文本。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// mimeType → 扩展名。
//
// ⚠️ **借媒体层的那张表，不在这里重写一遍。**
//    "能 publish 的类型"与"能收藏进库的类型"必须是**同一个集合** ——
//    写两遍就一定会漂移（这个项目里最贵的一类故障，见 api/handlers/index.js
//    头部的 switch 事故）。这里只需要 mime→ext 这一件事。
//
// ⚠️ 取的是 `media/kinds.js` 的 `KINDS.image.mimes`，**不是** `api/media.js`
//    里那个 `ALLOWED` 别名 —— 后者只是对同一张表的 re-export，从 `chatlog/`
//    去 import `api/` 会让领域层反向依赖接口层（全仓唯一一处反向边）。
import { KINDS } from '../media/kinds.js';

const IMAGE_EXT_BY_MIME = KINDS.image.mimes;

// 单张表情大小上限（字节）。表情包不该有几 MB。
export const MAX_STICKER_BYTES = 5 * 1024 * 1024;

// 本地文件扩展名 → mimeType。
//
// 读本地收藏文件时**没有 content-type 可依**（HTTP 头早没了），
// 只能从扩展名反推；推不出来就按 png 交给 OneBot（它自己会认字节）。
const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

// 只允许这些主机的图片 —— 表情库来自 QQ，别的一律不发。
const ALLOWED_HOSTS = new Set([
  'p.qpic.cn',
  'gchat.qpic.cn',
  'multimedia.nt.qq.com.cn',
]);

export class StickerError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'StickerError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

// 读表情库。
//
// 损坏的 JSON **抛错而不是回退成空**：静默回退会让人以为"表情被删光了"，
// 而实际是文件坏了 —— 这两件事该被区分开。
export function loadStickers({ file } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  // 空文件 = 没有索引（删文件/占位失败都会留下 0 字节），直接当空库。
  // 非空但坏掉的 JSON 仍然抛错 —— 那可能是写到一半，不能静默丢掉。
  if (raw.trim() === '') return [];
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new StickerError(`表情库 JSON 解析失败：${error.message}`, {
      hint: `文件：${file}。修好它，或删掉让它重新生成。`,
    });
  }
  if (!Array.isArray(doc)) {
    throw new StickerError('表情库顶层必须是数组', { hint: `文件：${file}` });
  }
  return doc.filter((x) => x && typeof x === 'object' && x.id);
}

// 原子写回表情库 —— **临时文件 + rename**，唯一允许改盘上这个文件的方式。
//
// ⚠️ 为什么不能直接 `writeFileSync(file, …)`：
//    写到一半进程被杀 / 断电，盘上就是**半个 JSON** —— 而 `loadStickers`
//    遇到坏 JSON 是**抛错**（刻意不回退成空），于是整个表情功能全废，
//    还得人工去修。同目录的 rename 是原子的：要么旧内容、要么新内容。
//
// 写法与 `api/media.js` / 原来的 `bumpUse` 一致（那两处各写过一遍 tmp+rename，
// 现在收敛到这一个函数 —— 收藏 / 改名 / 记使用量都走它）。
export function saveStickers(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// `file` / `url` → 扩展名？取不到扩展名返回 null。
//
// 支持列表来自 `api/media.js` 的白名单（png / jpeg / webp / gif）。
// `content-type` 可能带参数（`image/jpeg; charset=binary`），先剥掉。
export function extForMime(mimeType) {
  const key = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXT_BY_MIME[key] ?? null;
}

// 收藏进来的表情图片目录：与 `index.json` **同一目录**。
//
// 传 `stickerFile(root, uin)` 的返回值。按号分库后，图片自然也跟着账号走。
export function stickerDir(file) {
  return path.dirname(file);
}

// 图片字节 → md5（**大写十六进制**）。
//
// 大小写必须固定：库里 QQ 同步来的条目是**大写**，如果收藏时写小写，
// 同一个 md5 会被当成两条（去重靠字符串比较）。去重口径也在这里，
// 不让每个调用方各自大写一遍。
export function md5Of(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').toUpperCase();
}

// 按 md5 找库里那条 —— **同一个 md5 就是同一张图**（收藏去重的判据）。
//
// 第二道网：`md5` 字段丢了的老条目，用落盘文件名再比一次
// （`<md5>.<ext>`，见 `qq_sticker_collect` 的命名）。只比第一道也行，
    // 但字段确实可能丢（同步/迁移），宁可多比一次。
export function findByMd5(entries, md5) {
  const want = String(md5 ?? '').toLowerCase();
  if (want === '') return null;
  return entries.find((e) => {
    if (String(e.md5 ?? '').toLowerCase() === want) return true;
    const f = String(e.file ?? '');
    return f !== '' && path.basename(f).toLowerCase().startsWith(want);
  }) ?? null;
}

// 按 id / md5 / 描述找一条表情。
//
// 支持模糊匹配描述：模型经常只记得"那个猫娘抱鱼的"，
// 让它必须背住一长串 id 是不现实的。
export function findSticker(entries, ref) {
  const want = String(ref ?? '').trim();
  if (!want) return null;

  const lower = want.toLowerCase();

  // ① 精确 id / resId
  for (const e of entries) {
    if (String(e.id) === want) return e;
    if (e.resId && String(e.resId) === want) return e;
  }

  // ② 短 id（md5 前 8 位，大小写不敏感）
  if (/^[0-9a-f]{8}$/i.test(want)) {
    const hits = entries.filter((e) => shortIdOf(e).toLowerCase() === lower);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new StickerError(`短 id "${want}" 匹配到多条表情，请用完整 ref`, {
        hint: `候选：${hits.map((e) => e.id).join('、')}`,
      });
    }
  }

  // ③ 完整 md5
  for (const e of entries) {
    if (e.md5 && String(e.md5).toLowerCase() === lower) return e;
  }

  // ④ 描述精确匹配
  for (const e of entries) {
    if (e.desc && String(e.desc) === want) return e;
  }

  // ⑤ 描述包含（模糊）—— 唯一命中才算，多个命中宁可报错让人选
  const hits = entries.filter((e) => e.desc && String(e.desc).toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new StickerError(`"${want}" 匹配到多个表情，请用更精确的 shortId`, {
      hint: `候选：${hits.map((e) => `${e.desc}(${shortIdOf(e)})`).join('、')}`,
    });
  }

  return null;
}

// 和 `want` **像**的几条 —— 只用于报错信息。
//
// ⚠️ 存在的唯一理由：只说"找不到"是没用的。
//    实测模型拿到 `找不到表情 "猫娘"` 之后只能瞎试（换写法重试四五次），
//    因为**它不知道库里到底有什么**。所以找不到时要把库里的候选摆出来。
//
// ── 打分刻意简单（不引模糊匹配库，本项目零依赖）
//
//   · 描述互相包含（`猫娘抱鱼` vs `猫`）→ 高分
//   · id / md5 / shortId 前缀命中 → 高分（模型可能只记得前几位）
//   · 2-gram 重合度：中文按**两个字一组**比，比按单字比更接近"看起来像"
//     （`青发花饰猫娘` 与 `猫娘抱鱼` 靠 `猫娘` 这一组就能对上）
export function similarStickers(entries, want, { limit = 5 } = {}) {
  const q = String(want ?? '').trim().toLowerCase();
  if (q === '') return [];

  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const gq = grams(q);

  return entries
    .map((e) => {
      const desc = String(e.desc ?? '').toLowerCase();
      const id = String(e.id ?? '').toLowerCase();
      const md5 = String(e.md5 ?? '').toLowerCase();
      let score = 0;
      if (desc && (desc.includes(q) || q.includes(desc))) score += 3;
      if (id.startsWith(q) || md5.startsWith(q) || shortIdOf(e).toLowerCase().startsWith(q)) score += 3;
      const g = grams(desc);
      let hit = 0;
      for (const x of gq) if (g.has(x)) hit += 1;
      if (gq.size) score += (hit / gq.size) * 2;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

// 给模型看的清单 —— 只给必要字段，URL 太长不列。
export function describeStickers(entries, { limit = 50 } = {}) {
  return entries.slice(0, limit).map((e, i) => ({
    ref: e.id,
    desc: e.desc || '(无描述)',
    // ⚠️ 短 id 取 **md5 的前 8 位**，不能取整个 id 的尾 8 位 ——
        //    id 结构是 `<uin>_0_0_0_<md5>_0_0`，尾 8 位永远是 `_0_0`，
        //    大多数条目会撞成同一个值。
    shortId: shortIdOf(e),
    useCount: e.useCount ?? 0,
    index: i,
  }));
}

// 短 id：md5 的前 8 位（大写十六进制）。
//
// 为什么是 md5 而不是整个 id 的尾部：见 describeStickers 的说明。
// 8 位十六进制 = 40 亿种，9 条表情里不可能撞。
export function shortIdOf(entry) {
  const md5 = String(entry?.md5 ?? '').toUpperCase();
  if (md5.length >= 8) return md5.slice(0, 8);
  // 没有 md5 就从 id 里挖出那段十六进制
  const m = /([0-9A-F]{8,})/i.exec(String(entry?.id ?? ''));
  return m ? m[1].toUpperCase().slice(0, 8) : String(entry?.id ?? '').slice(0, 8);
}

// 校验图片地址：只允许表情库那几个域名，且必须是 https。
export function assertAllowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new StickerError(`表情地址不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'https:') {
    throw new StickerError(`表情地址必须是 https（实际 ${u.protocol}）`);
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new StickerError(`表情地址域名不在白名单内：${u.hostname}`, {
      hint: `允许：${[...ALLOWED_HOSTS].join('、')}`,
    });
  }
  return u;
}

// 下载表情图片。
//
// @returns `{ buffer, contentType }`
export async function fetchStickerImage(url, { fetchImpl = globalThis.fetch, maxBytes = MAX_STICKER_BYTES } = {}) {
  assertAllowedUrl(url);

  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new StickerError(`下载表情失败：HTTP ${res.status}`);
  }

  // 先看声明的大小，避免下完才发现太大
  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new StickerError(`表情太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new StickerError(`表情太大（${buf.length} 字节 > 上限 ${maxBytes}）`);
  }
  if (buf.length === 0) {
    throw new StickerError('表情图片是空的');
  }

  return { buffer: buf, contentType: res.headers?.get?.('content-type') ?? '' };
}

// 取一条表情的**图片字节** —— 发送路径唯一该用的入口。
//
// ══ 顺序：**有 `file` 就读本地，没有才去下载 `url`**
//
//   · 收藏进来的表情（`qq_sticker_collect`）落的是**字节**（`state/stickers/<md5>.<ext>`），
//     `url` 是空的 —— 不去下载。
//   · QQ 自带收藏的 `url` 指向 `p.qpic.cn/qq_expression/...`，**没有 rkey、长期可用**，
//     但仍然可能被 QQ 换掉/清掉；所以只要条目有 `file` 就优先本地。
//
// ⚠️ 为什么原来只有"下载 url"这一条路：那时库里只有 QQ 同步来的条目，
//    每条都有 url。收藏功能一加，`file` 就成了**唯一不会过期**的来源 ——
//    不改这里的话，收藏的表情**发不出去**（url 为空 → 直接报错）。
//
// @returns `{ buffer, contentType, source: 'file' | 'url' }`
export async function loadStickerBytes(entry, { fetchImpl = globalThis.fetch, maxBytes = MAX_STICKER_BYTES } = {}) {
  const local = String(entry?.file ?? '').trim();

  if (local !== '') {
    // ⚠️ 读之前先看存在性 —— `readFileSync` 的 ENOENT 报文里只有路径的**一部分**
    //    与一句 `no such file or directory`，模型看不出"是文件没了"还是"路径写错了"。
    //
    // ⚠️ **该说的必须写在 `message` 里，不能只写进 `hint`。**
    //    实测：`hint` 会被两处丢掉 —— `api/server.js` 回给 MCP 的是
    //    `error.message`（hint 根本不参与），`onebot/normalize.js` 拼
    //    sticker 段错误时也是 `error?.message`。所以 hint 只进日志/toString，
    //    **模型看不到**。要它看见就得写进 message。
    if (!fs.existsSync(local)) {
      throw new StickerError(
        `表情的图片文件不在了：${local}\n`
        + '（收藏时落盘的那个文件被删掉/挪走了 —— 重新用 qq_sticker_collect 收一次，'
        + '或把条目里的 file 改成真实路径。）',
        { hint: 'state/stickers/ 下的文件不该手工挪动。' },
      );
    }
    const buffer = fs.readFileSync(local);
    if (buffer.length === 0) {
      throw new StickerError(`表情文件是空的：${local}（多半是写坏了 —— 重新收藏一次）`);
    }
    // 同一把尺子：下载路径的上限是多少，本地读就是多少（否则"收得进、发不出"）。
    if (buffer.length > maxBytes) {
      throw new StickerError(
        `表情文件太大（${buffer.length} 字节 > 上限 ${maxBytes}）：${local}`
        + '（发送路径也会拒它 —— 换一张小图重新收藏。）',
      );
    }
    const ext = path.extname(local).slice(1).toLowerCase();
    return { buffer, contentType: MIME_BY_EXT[ext] ?? 'image/png', source: 'file' };
  }

  const url = String(entry?.url ?? '').trim();
  if (url === '') {
    // 库里确实有这种条目：只有 id 和 desc，没有任何图（早先同步留下的半条数据）。
    throw new StickerError(
      `表情 ${entry?.id ?? '(无 id)'} 没有图：file 和 url 都是空的`
      + '（这条只剩描述，发不出去 —— 用 qq_sticker_collect 重新收一张，或把它从库里删掉。）',
    );
  }

  const got = await fetchStickerImage(url, { fetchImpl, maxBytes });
  return { ...got, source: 'url' };
}

//
//     segs.push({ type: 'reply', … });
//     segs.push({ type: 'at',    … });
//     segs.push({ type: 'image', data: { file: `base64://${…}` } });
//     return segs;                    // ← 加不进 text
//
// 而它的文档注释里写着：
//
//     ⚠️ 不能在同一气泡里带文字 —— **那是 QQ 的规矩，不是我们的选择**。
//
// *那句话是错的。** 实测主人自己就发过「表情包 + 文字」同一条，
// 落库形状是：
//
//     segments: [ { type:'image', sub_type:1, summary:'[动画表情]' },
//                 { type:'text',  text:'111' } ]
//
// 表情包在 OneBot 层面就是一个普通 `image` 段（靠 `sub_type: 1` 标
// "动画表情"），**和 text 同条完全合法**。
//
// ── 这条"把实现限制写成协议事实"的注释代价是什么
//
// 工具描述里也抄了这句话。于是 AI **从不尝试**发"文字+表情" ——
// 它以为做不到。而它本可以做到。
//
// ── 现在怎么做
//
// 表情包统一走 `qq_send` 的 `sticker` 段：
//
//     { "segments": [{ "text": "这个好笑" }, { "sticker": "猫娘抱鱼" }] }
//
// 下载与 base64 编码仍在本模块（`fetchStickerImage`），
// 但**拼段**由 `onebot/normalize.js` 统一处理 —— 只有一条路径，
// 不会再分叉出"这个工具能带文字、那个不能"的问题。

// 记一次使用（给排序用）。写失败不影响发送。
export function bumpUse({ file, id, context = '', now = Date.now } = {}) {
  try {
    const entries = loadStickers({ file });
    const e = entries.find((x) => String(x.id) === String(id));
    if (!e) return;
    e.useCount = (e.useCount ?? 0) + 1;
    e.lastUsedAt = now();
    e.lastContext = String(context).slice(0, 200);
    // 落盘走统一的原子写 —— 早先这里有第二份 `writeFileSync + renameSync`（同一套路写两遍）。
    saveStickers(file, entries);
  } catch {
    // 统计失败无所谓 —— 绝不能因为它发不出表情
  }
}

// 表情库文件路径：**按 QQ 号分库**（收藏表情是账号级的）。
//
// 布局：`state/stickers/<uin>/index.json`，图片同目录 `<md5>.<ext>`。
export function stickerFile(root, uin) {
  const id = String(uin ?? '').trim() || 'unknown';
  return path.join(root, 'state', 'stickers', id, 'index.json');
}
