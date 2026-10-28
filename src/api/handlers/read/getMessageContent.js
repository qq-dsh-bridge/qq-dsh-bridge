// 取一条消息的**内容** —— 图 / 语音 / 视频 / 文件 / 合并转发，一个入口。
//
// ════════════════════════════════════════════════════════════════════════════
// 为什么合并（原 getMessageImages / getVoice / getForwardMessages）
// ════════════════════════════════════════════════════════════════════════════
//
// 三个 op 干的是同一件事：**把上下文里看不见的东西变成能用的东西**。
// 分开的代价不是三份代码，而是三套参数语义：
//   · 图和语音的 `index` = 这条消息里第几个同类段
//   · 转发的 `index`     = 第几个**节点**（里面还有一个 `imgIndex`）
// 同一个词两种含义，模型只能靠 description 猜。合并后**正交拆成两个字段**：
//   `pick` = 该层级里第几个同类媒体段；`node` = 转发里的第几个节点。
//
// ════════════════════════════════════════════════════════════════════════════
// 返回形状（三个消费者，一种形状）
// ════════════════════════════════════════════════════════════════════════════
//
//   `text`     叙述：seq / 发送人 / 正文 / 第几项 / 地址 —— 人和模型都能读
//   `items`    机器可读清单：每项对应 text 里的一段（含失败项与原因）
//   `images`   **只有真像素**进这里，插件据此出 image 块
//   `nodes`    `kind=forward` 时的节点清单
//   `problems` 定位不到 / 越界 / 超限 —— 不属于任何 item
//
// ⚠️ **不要改回 `{ content: [...] }`。** 那是 MCP 时代的形状：现在的渲染链
//    （`plugins/qq-dsh/src/tools/shell.js` 的 `stripBinary` + `projectContent`）
//    **只认 `images` 键**，`content` 里的 `data` 会被原样 JSON.stringify 进上下文 ——
//    一张 720px 图约 6.3k 字符，而且**不会产生 image 块**。原来
//    `getForwardMessages` 的取图路径就是这么坏的（模型收到一大串 base64 却看不见图）。
//
// ⚠️ 语音 / 视频 / 文件**永远不进 `images`** —— 插件会把它们当图片渲染。
//
// ════════════════════════════════════════════════════════════════════════════
// 错误分三类，别混
// ════════════════════════════════════════════════════════════════════════════
//
//   · 参数写错（缺 seq / kind 不认识 / kind=forward 却给 pick）→ BridgeApiError(400)
//     （裸 Error 会被 server.js 一律映射成 500，模型分不清"我写错了"和"服务挂了"）
//   · 定位不到 / 没这类内容 / 越界 / 超限 → **200 + problems**，text 里说清为什么
//   · 下载或转码失败 → 该项 `error`，其它项照常（一项失败不该毁掉整次调用）
//
// ════════════════════════════════════════════════════════════════════════════
// v1 的刻意限制
// ════════════════════════════════════════════════════════════════════════════
//
//   · 视频只给文件地址，**不抽帧**（要看画面让模型自己 ffmpeg —— agentPath 就是给它用的）
//   · `json` 卡片（分享卡片）暂不支持取内容
//
// ════════════════════════════════════════════════════════════════════════════
// 嵌套转发（`node` 是**路径**，不是单个数字）
// ════════════════════════════════════════════════════════════════════════════
//
// 转发里可以再套转发。`node` 因此是一个索引路径：
//
//     {"seq": "1234", "kind": "forward"}              顶层：列这条消息里的转发节点
//     {"seq": "1234", "node": [1]}                    进第 1 个节点
//     {"seq": "1234", "node": [1, 0]}                 再进它里面那个转发的第 0 个节点
//
// 为什么不是"自动递归"：每深一层都是一次 `get_forward_msg`（服务端一次拉一整张卡片），
// 隐式递归会在模型只想看一层时把整棵树拉下来。深挖由调用方决定，一次一层。
// 上限 3 层，与 `send` 侧的 `FORWARD_MAX_DEPTH` 对齐。
//
// `node` **只有数组一种写法**（整数单值不再接受）—— 理由见下面 `parseNodePath` 的注释。
//
// @param args.seq   消息定位符；1..3 条（数组也行）
// @param args.kind  `all`（默认）/ `image` / `voice` / `video` / `file` / `forward`
// @param args.node  转发节点的索引**路径**：整数数组（`[1]` / `[1, 0]`）。最多 3 层
// @param args.pick  该位置里第几个**同类**媒体段（0 起）。不给 = 全部
// @param args.view  强制取像素（多张时）。只对 image 有效
// @param args.limit 列转发节点时最多几个（默认 30，上限 100）
export const op = 'getMessageContent';
export const logsAsSend = true;

import path from 'node:path';

import { segmentsOf, textOf, segmentsToText } from '../../../chatlog/segments.js';
import { normalizeSegments } from '../../../onebot/parse.js';
import { clockOf, humanSize } from '../../../util/format.js';
import { fetchImageBuffer } from '../../../util/image-fetch.js';
import { fetchBinary } from '../../../util/media-fetch.js';
import { KINDS } from '../../../media/kinds.js';
import { mediaStore, mediaBaseUrl, mediaAgentRoot, originOfMedia } from '../../media.js';
import { BridgeApiError } from '../../errors.js';

// 一条消息里最多看几条（沿用老规矩）。
const MAX_REFS = 3;

// 单次**取到**的媒体数，跨类型**合计**。
//
// ⚠️ 老实现是 image 4 + voice 4 各自独立。合并后必须共用一份预算 ——
//    否则一次调用能取 8 个文件，而"4"这个数是按 token 与等待时间定的。
const MAX_MEDIA = 4;

const DEFAULT_MAX_NODES = 30;
const HARD_MAX_NODES = 100;

// 消息里的媒体存一小时（是缓存，不是资产）。
const TTL_MS = 60 * 60 * 1000;

const KIND_ARGS = Object.freeze(['all', 'image', 'voice', 'video', 'file', 'forward']);

// 转发最多往里走几层。与 `onebot/normalize.js` 的 `FORWARD_MAX_DEPTH` 对齐 ——
// 发送侧能造多深的套娃，读取侧就得能走多深，否则"发得出去、读不回来"。
const MAX_NODE_DEPTH = 3;

// 对外的 kind → 段类型（语音在段里叫 `record`）。
const SEG_TYPE = Object.freeze({ image: 'image', voice: 'record', video: 'video', file: 'file', forward: 'forward' });

// 对外的 kind → 媒体仓库的 kind（`media/kinds.js` 的键：audio 不是 voice）。
const STORE_KIND = Object.freeze({ image: 'image', voice: 'audio', video: 'video', file: 'file' });

// 种类的中文名（problems 里说"没有图"用）。
const KIND_CN = Object.freeze({ image: '图', voice: '语音', video: '视频', file: '文件', forward: '转发' });

// 量词（叙述里说"第 1/2 张图"用）。中文换量词比换名词自然。
const KIND_UNIT = Object.freeze({ image: '张图', voice: '段语音', video: '个视频', file: '个文件', forward: '个转发' });

const AUDIO_MIME = Object.freeze({
  mp3: 'audio/mpeg', amr: 'audio/amr', wav: 'audio/wav', ogg: 'audio/ogg', silk: 'audio/silk',
});

const badArgs = (message, code = 'bad-args', hint = '') => new BridgeApiError(
  hint ? `${message}\n${hint}` : message,
  { status: 400, code },
);

// ────────────────────────────────────────────────────────────── 参数

function intOrNull(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw badArgs(`${name} 必须是整数（0 起），实际是 ${JSON.stringify(value)}`);
  }
  if (value < 0) throw badArgs(`${name} 不能是负数（0 起），实际是 ${value}`);
  return value;
}

// `node` 是**索引路径**，只有一种写法：整数数组（`[1]`、`[1, 0]`）。
//
    // ⚠️ **不要**再放宽成"整数也行"。只有一种形态，才不会因为"插件与桥接
    //    哪一半先重启"而互相锁死 —— 两边各认一种就是工具直接不可用。
//
// 返回 `null`（不给）或非空数组。空数组按"不给"处理（顶层），
// 因为可选参数被模型写成 `[]` 是常事，为它报错没有收益。
function parseNodePath(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw badArgs(
      `node 要写成数组（路径），例如 [1] 或 [1, 0]；现在是 ${JSON.stringify(raw)}`,
      'bad-node',
      '`node` 表示"转发里的第几层第几个"，所以它是一条路径，不是单个数字。',
    );
  }
  if (!raw.length) return null;
  if (raw.length > MAX_NODE_DEPTH) {
    throw badArgs(
      `node 最多 ${MAX_NODE_DEPTH} 层（现在 ${raw.length} 层）`,
      'node-too-deep',
      '转发最多套 3 层 —— 更深的实现里也不会有。',
    );
  }
  return raw.map((value, i) => {
    if (!Number.isInteger(value) || value < 0) {
      throw badArgs(`node[${i}] 必须是整数（0 起），实际是 ${JSON.stringify(value)}`);
    }
    return value;
  });
}

function normalizeKind(raw) {
  const raw2 = String(raw ?? 'all').trim().toLowerCase();
  // `record` 是段类型名，允许手滑写成它。
  const kind = raw2 === 'record' ? 'voice' : raw2;
  if (!KIND_ARGS.includes(kind)) {
    throw badArgs(`kind 不认识："${raw}"`, 'bad-kind', `只能是 ${KIND_ARGS.join(' / ')}。`);
  }
  return kind;
}

function toRefs(raw) {
  const all = (Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (!all.length) {
    throw badArgs('缺少 seq（消息定位符）', 'missing-seq',
      '例如 {"seq": "1234"}。定位符就是消息行首那个序号，也可以是 1001#7 这种。');
  }
  return { refs: all.slice(0, MAX_REFS), dropped: Math.max(0, all.length - MAX_REFS) };
}

// ────────────────────────────────────────────────────────────── 小工具

// agent 看到的路径（配了 media.agentRoot 才有）。给 bash / ffmpeg 用。
function agentPathOf(meta, store) {
  const root = mediaAgentRoot();
  if (!root) return '';
  const rel = path.relative(store.root, path.join(store.base, meta.rel)).split(path.sep).join('/');
  return `${root}/${rel}`;
}

function sourceOf(data) {
  return String(data?.url || data?.file || '').trim();
}

function mimeOfAudio(hint) {
  const raw = String(hint ?? '').split(';')[0].trim().toLowerCase();
  if (raw.startsWith('audio/')) return raw;
  return AUDIO_MIME[raw] ?? 'audio/mpeg';
}

// 这条消息（或这个转发节点）里属于 `kind` 的段，**保持原有顺序**。
//
// 转发段**不在**这里出现：它走另一条流程（列节点），不是"取字节"。
//
// @returns `[{ kind, data, pick, total }]`，`pick` 是同类型内部序号（0 起）
function candidatesOf(segs, kind) {
  const wanted = kind === 'all'
    ? new Set(['image', 'record', 'video', 'file'])
    : new Set([SEG_TYPE[kind]]);

  const picked = [];
  for (const seg of segs) {
    const type = seg?.type;
    if (!type || !wanted.has(type)) continue;
    const own = kind === 'all'
      ? Object.keys(SEG_TYPE).find((k) => SEG_TYPE[k] === type)
      : kind;
    if (!own) continue;
    picked.push({ kind: own, data: seg.data ?? {} });
  }

  // 回填 pick / total（只在同类型内编号）。
  const seen = {};
  const totals = {};
  for (const item of picked) totals[item.kind] = (totals[item.kind] ?? 0) + 1;
  for (const item of picked) {
    item.pick = seen[item.kind] ?? 0;
    seen[item.kind] = item.pick + 1;
    item.total = totals[item.kind];
  }
  return picked;
}

function labelOf(kind, pick, total) {
  // 永远带位置：单张也写「第 1/1 张图」。省两个字符换来的歧义不值得 ——
  // 模型看到「第 2/3 张图」才知道还有几张没看。
  return `第 ${pick + 1}/${total} ${KIND_UNIT[kind] ?? KIND_CN[kind] ?? kind}`;
}

// ────────────────────────────────────────────────────────────── 取字节

// 图片：先用存下来的地址，失败再用 `file` 重签。
//
// ⚠️ `usedUrl` 必须声明在 `try` **之外** —— 写成块内的 `let`，`catch` 里看不到它，
    // 报的是 `usedUrl is not defined`，把"为什么下载失败"整个盖掉。
async function imageBytes(target, { http, fetchImage, logger, ref }) {
  const first = sourceOf(target);
  if (!first) throw new Error('这个图片段没有地址（url / file 都是空）');
  let usedUrl = first;
  try {
    return { ...(await fetchImage(first)), usedUrl };
  } catch (error) {
    if (!target.file) throw Object.assign(error, { usedUrl });
    const fresh = await http.getImageUrl(target.file);
    if (!fresh) throw Object.assign(error, { usedUrl });
    logger?.debug('图片地址过期，已用 file 重签', { seq: ref, file: target.file });
    usedUrl = fresh;
    return { ...(await fetchImage(fresh)), usedUrl };
  }
}

// 语音：先让服务端转 mp3（避开 silk，ffmpeg 能直接用），失败再直连下载。
async function voiceBytes(target, { http, fetchBin, logger, ref }) {
  if (target.file) {
    const rec = await http.getRecord?.(target.file, { outFormat: 'mp3' });
    if (rec?.base64) {
      logger?.debug('语音已由服务端转码', { seq: ref, format: rec.format, duration: rec.duration });
      return { data: Buffer.from(rec.base64, 'base64'), mime: mimeOfAudio(rec.format), duration: rec.duration };
    }
  }
  const url = String(target.url ?? '').trim();
  if (!url) throw new Error('这段语音既没有 file 也没有 url');
  const got = await fetchBin(url, { label: '语音' });
  return { data: got.buffer, mime: mimeOfAudio(got.contentType), duration: 0 };
}

// 把一段媒体落进媒体库，返回 items 里的一项。
//
// 缓存键用 `originOfMedia`（与图片共用一套，靠 kind 后缀区分）——
// 同一份资源只存一次是媒体层的约定，不是这个 handler 的私事。
async function materialize(candidate, ctx, deps) {
  const { store, logger, http, fetchImage, fetchBin, convKey, ref, node } = { ...ctx, ...deps };
  const origin = originOfMedia(candidate.data, {
    convKey, ref, index: candidate.pick, kind: candidate.kind,
  });

  const item = {
    seq: ref,
    node,
    kind: candidate.kind,
    pick: candidate.pick,
    total: candidate.total,
    name: '',
    mimeType: '',
    bytes: 0,
    cached: false,
    viewed: false,
    url: '',
    agentPath: '',
  };

  try {
    let meta = store.findByOrigin(origin);
    if (meta) {
      item.cached = true;
    } else {
      const storeKind = STORE_KIND[candidate.kind];
      const spec = KINDS[storeKind];
      let payload;

      if (candidate.kind === 'image') {
        const got = await imageBytes(candidate.data, { http, fetchImage, logger, ref });
        payload = { data: got.buffer, mime: got.contentType };
        logger?.debug('图片已入库', {
          seq: ref, pick: candidate.pick, bytes: got.buffer.length, from: String(got.usedUrl).slice(0, 60),
        });
      } else if (candidate.kind === 'voice') {
        payload = await voiceBytes(candidate.data, { http, fetchBin, logger, ref });
      } else {
        // video / file：**只下载，不处理**。
        //
        // 视频刻意不抽帧：那要 ffmpeg + 一套失败降级，而模型真要看画面时自己抽一帧
        // 更灵活（`agentPath` 就是给它跑 ffmpeg 用的）。
        const url = sourceOf(candidate.data);
        if (!url) throw new Error(`这段${KIND_CN[candidate.kind]}没有可用地址`);
        const got = await fetchBin(url, {
          maxBytes: spec?.maxBytes ?? 64 * 1024 * 1024,
          label: KIND_CN[candidate.kind],
        });
        payload = { data: got.buffer, mime: got.contentType };
      }

      meta = store.put({
        data: payload.data,
        kind: storeKind,
        mime: payload.mime,
        name: String(candidate.data?.name ?? ''),
        ttlMs: TTL_MS,
        origin,
      });
      logger?.debug('媒体已入库', {
        seq: ref, node, kind: candidate.kind, pick: candidate.pick, bytes: meta.bytes, mime: meta.mime,
      });
    }

    item.name = meta.name || '';
    item.mimeType = meta.mime;
    item.bytes = meta.bytes;
    item.url = `${mediaBaseUrl()}/m/${meta.id}`;
    item.agentPath = agentPathOf(meta, store);
    return item;
  } catch (error) {
    const message = String(error?.message ?? error);
    // 老语音的典型失败：直链 rkey 过期、服务端缓存也没了 —— 这句话能省一次排查。
    const hint = candidate.kind === 'voice' && /HTTP (400|403|404)/.test(message)
      ? '（这条语音太老了：直链签名已过期，服务端缓存里也没有了 —— 只有刚发的能取）'
      : '';
    logger?.warn('取媒体失败', {
      conv: convKey, seq: ref, node, kind: candidate.kind, pick: candidate.pick, error: message,
    });
    item.error = `${message}${hint}`;
    item.triedUrl = error?.usedUrl || sourceOf(candidate.data) || '';
    return item;
  }
}

// ────────────────────────────────────────────────────────────── 转发

// OneBot 的转发返回**形状不统一**：数组 / {messages} / {message} 三种都见过。
function normalizeNodes(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.message)) return data.message;
  return [];
}

function nodeRow(path, n, segs, pool) {
  const media = { image: 0, voice: 0, video: 0, file: 0, forward: 0 };
  for (const seg of segs) {
    if (seg?.type === 'image') media.image += 1;
    else if (seg?.type === 'record') media.voice += 1;
    else if (seg?.type === 'video') media.video += 1;
    else if (seg?.type === 'file') media.file += 1;
    else if (seg?.type === 'forward') media.forward += 1;
  }
  return {
    // 路径（不是单个数字）：套娃时是 `[1, 0]`，模型原样拿回去当 `node` 用。
    node: path,
    time: n?.time ? clockOf(n.time) : '',
    sender: {
      qq: String(n?.sender?.user_id ?? n?.user_id ?? ''),
      name: String(n?.sender?.card || n?.sender?.nickname || n?.nickname || ''),
    },
    text: segmentsToText({ segments: segs }, { selfQq: pool.selfQq, newline: ' ' }),
    media,
  };
}

function mediaSummary(media) {
  const parts = Object.entries(media)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${KIND_CN[kind]} ${count}`);
  return parts.length ? `媒体：${parts.join('、')}` : '';
}

// ────────────────────────────────────────────────────────────── 叙述

// 一项的叙述块。版式沿用老 `getMessageImages` / `getVoice`（模型已经看惯了）。
function describeItem(item, label) {
  const lines = [label];
  const shape = [
    humanSize(item.bytes),
    item.mimeType,
    item.mimeType === 'image/gif' ? '（动图）' : '',
    item.cached ? '来自媒体库' : '已存入媒体库',
  ].filter(Boolean).join('，');
  lines.push(`  ${shape}`);
  if (item.name) lines.push(`  文件名：${item.name}`);
  lines.push(`  ${item.url}`);
  if (item.agentPath) lines.push(`  ${item.agentPath}`);

  // 每类一句"接下来能干什么" —— 模型最容易卡在这里。
  if (item.kind === 'voice') {
    lines.push('  ⚠️ 你**听不到**音频内容（这里只是把文件存进了媒体库）。要发出去用 {"voice": "<上面那个地址>"}');
  } else if (item.kind === 'video') {
    lines.push('  ⚠️ 你**看不到**画面。要看画面就在上面那个地址上自己抽帧（ffmpeg）；要发出去用 {"video": "<地址>"}');
  } else if (item.kind === 'file') {
    lines.push('  要发出去用 {"file": "<上面那个地址>"}');
  }
  return lines.join('\n');
}

// 消息头的叙述（一条消息一次）。节点里的内容用它自己的头。
function headOf({ ref, sender, body, inNode }) {
  if (inNode) {
    return `seq=${ref} 节点 [${inNode.path.join(', ')}]`
      + `（${inNode.sender}${inNode.time ? `，${inNode.time}` : ''}）`;
  }
  return `seq=${ref}（${sender} 发的${body ? `，文字：「${body}」` : ''}）`;
}

// ────────────────────────────────────────────────────────────── 主流程

// `fetchImage` / `fetchBinary` 写在签名里（而不是从 `deps` 里临时取）——
// `buildHandlers` 的启动期自检读的就是这段解构：漏传依赖会在启动时抛，
// 而不是等第一次取图时被 async 回调吞成一行日志。
export async function run({ poolFor, http, logger, fetchImage = fetchImageBuffer, fetchBinary: fetchBin = fetchBinary }, convKey, args = {}) {
  const store = mediaStore();
  if (!store) throw new Error('媒体仓库没初始化（桥接启动时 configureMediaStore 失败）');

  const kind = normalizeKind(args.kind);
  const { refs, dropped } = toRefs(args.seq);
  const pick = intOrNull(args.pick, 'pick');
  const nodePath = parseNodePath(args.node);
  const view = args.view === true;
  const limit = Math.min(
    Math.max(1, intOrNull(args.limit, 'limit') ?? DEFAULT_MAX_NODES),
    HARD_MAX_NODES,
  );

  // `pick` 与 `node` 是两个**正交**维度。`kind=forward` 与 `node` 可以同时用
  // （"进这一层，把这里的转发列出来"），但 `pick` 是对媒体说的，跟节点清单没关系。
  if (kind === 'forward' && pick !== null) {
    throw badArgs('kind=forward 时要用 node（节点路径），不是 pick', 'bad-pick',
      'pick 是"这个位置第几个同类媒体段"，对节点清单没有意义。');
  }

  const pool = poolFor(convKey);
  const runtime = { store, http, logger, convKey, fetchImage, fetchBin };

  const acc = {
    items: [],
    images: [],   // 只有"真取到像素"的图
    nodes: [],    // 转发节点清单
    blocks: [],   // 叙述
    problems: [],
    truncated: false,
  };
  let budget = MAX_MEDIA;

  // 超过 3 条不是错，但**必须说出来** —— 静默丢掉第 4 条会让模型以为都看了。
  if (dropped) {
    acc.problems.push(`一次最多看 ${MAX_REFS} 条消息，后面 ${dropped} 条没处理 —— 分两次调。`);
  }

  for (const ref of refs) {
    const found = pool.find(ref);
    if (!found) {
      acc.problems.push(`seq=${ref}：找不到这条消息`);
      continue;
    }
    const message = found.message;
    const sender = String(message.sender?.name ?? '') || '未知';
    const body = textOf(message);
    const ownSegs = segmentsOf(message);

    // ── (A) 走一段 `node` 路径：逐层拉转发，最后停在那层节点上
    let segs = ownSegs;
    let inNode = null;
    if (nodePath !== null) {
      const resolved = await resolvePath({ ref, ownSegs, path: nodePath, http });
      if (resolved.error) {
        acc.problems.push(resolved.error);
        continue;
      }
      segs = resolved.segs;
      inNode = resolved.inNode;
      acc.problems.push(...resolved.notes);
    }

    const head = headOf({ ref, sender, body, inNode });
    // 当前位置在树上的路径：顶层是 `[]`，节点里是 `[1]` / `[1, 0]`。
    const basePath = inNode?.path ?? [];

    // ── (B) 转发清单（kind=forward，或 all 里遇到转发段）
    //
    // 展开的是**当前位置**里的转发：顶层消息本身，或 `node` 指定的那层节点。
    // 每深一层都要再调一次 —— 一次 `get_forward_msg` 拉的是整张卡片，隐式递归会很贵。
    if (kind === 'forward' || kind === 'all') {
      for (const forwardSeg of segs.filter((s) => s?.type === 'forward')) {
        const forwardId = String(forwardSeg.data?.id ?? '').trim();
        if (!forwardId) {
          acc.problems.push(`${head}：有一个转发段没有 id（可能已过期）`);
          continue;
        }
        let raw;
        try {
          raw = normalizeNodes(await http.getForwardMessages(forwardId));
        } catch (error) {
          acc.problems.push(`${head}：拉转发内容失败 —— ${String(error?.message ?? error)}`);
          continue;
        }
        if (!raw.length) {
          acc.problems.push(`${head}：这条合并转发取不到内容（可能已过期，或实现不支持 get_forward_msg）`);
          continue;
        }

        const shown = raw.slice(0, limit);
        if (raw.length > shown.length) acc.truncated = true;
        const rows = shown.map((n, i) => {
          const nodeSegs = normalizeSegments(n?.message ?? n?.content ?? []);
          return { ...nodeRow([...basePath, i], n, nodeSegs, pool), seq: ref };
        });
        acc.nodes.push(...rows);

        const lines = [
          `${head}里有 1 个合并转发，共 ${raw.length} 个节点`
          + `${raw.length > shown.length ? `，这里列前 ${shown.length} 个` : ''}：`,
        ];
        for (const row of rows) {
          const who = row.sender.name || row.sender.qq || '未知';
          lines.push(`  [${row.node.join(', ')}] ${row.time ? `${row.time} ` : ''}${who}${row.text ? `：${row.text}` : ''}`);
          const media = mediaSummary(row.media);
          if (media) lines.push(`        ${media}`);
        }
        // 示例直接用**真实存在**的那一行的路径 —— 别让模型自己拼。
        const example = rows.find((r) => Object.values(r.media).some((n) => n > 0)) ?? rows[0];
        lines.push(
          `（按时间从旧到新。要看某个节点里的东西：带上 node 再调一次，`
          + `例如 {"seq": "${ref}", "node": ${JSON.stringify(example.node)}, "kind": "image"}。）`,
        );
        acc.blocks.push(lines.join('\n'));
      }
    }

    // ── (C) 媒体（图 / 语音 / 视频 / 文件）
    if (kind !== 'forward') {
      const all = candidatesOf(segs, kind);
      const picked = pick === null ? all : all.filter((c) => c.pick === pick);

      if (!picked.length) {
        if (pick !== null) {
          const totals = all.reduce((sum, c) => ({ ...sum, [c.kind]: c.total }), {});
          acc.problems.push(
            `${head}：没有第 ${pick} 个（从 0 起）`
            + (all.length
              ? `：这条里只有 ${Object.entries(totals).map(([k, n]) => `${KIND_CN[k]} ${n}`).join('、')}`
              : ''),
          );
        } else if (kind !== 'all') {
          // "这里没有图" 是事实，但如果这里其实有**转发**，必须提一句 ——
    // 否则模型会以为这层是空的（那层其实还是套娃，只回"没有可取内容"）。
          const hasForward = segs.some((s) => s?.type === 'forward');
          acc.problems.push(
            `${head}：没有${KIND_CN[kind]}`
            + (hasForward ? '（但这里有一个合并转发 —— 用 `kind: "forward"` 看它）' : ''),
          );
        }
        // kind=all 且确实什么都没有：不报 problem，最后统一说一句（见 buildText）
        continue;
      }

      // 多张图时默认只给摘要（省 token）；单张或显式 view 才取像素。
      //
      // 语音/视频/文件**没有"看"这回事** —— 它们只有"存下来给地址"。
      const imageCount = picked.filter((c) => c.kind === 'image').length;
      const wantPixels = view || imageCount === 1;

      // 同一条消息里连续多项时，只有**第一项**重复消息头。
      // 否则四张图会把同一句「seq=… 李四 发的，文字：「…」」刷四遍，
      // 真正变化的部分（第几张、多大）反而被淹没。
      let headUsed = false;

      for (const candidate of picked) {
        const pos = labelOf(candidate.kind, candidate.pick, candidate.total);
        // 第一项带消息头，后续项只留位置（**不加缩进** —— 下面那几行已经是缩进的，
        // 同层级再加两个空格会让"这是新的一项"和"这是上一项的描述"看起来一样）。
        const label = headUsed ? pos : `${head} ${pos}`;
        headUsed = true;

        // 图：不取像素时只报"缓存过没有 + 尺寸/类型"，让模型自己挑。
        if (candidate.kind === 'image' && !wantPixels) {
          const cached = store.findByOrigin(originOfMedia(candidate.data, {
            convKey, ref, index: candidate.pick, kind: 'image',
          }));
          const summaryHint = String(candidate.data?.summary ?? '').trim();
          const shape = cached
            ? `${humanSize(cached.bytes)}，${cached.mime}${cached.mime === 'image/gif' ? '（动图）' : ''}，已在库里`
            : `未下载${summaryHint && summaryHint !== '[图片]' ? `（${summaryHint}）` : ''}`;
          acc.items.push({
            seq: ref,
            node: inNode?.path ?? null,
            kind: 'image',
            pick: candidate.pick,
            total: candidate.total,
            name: '',
            mimeType: cached?.mime ?? '',
            bytes: cached?.bytes ?? 0,
            cached: Boolean(cached),
            viewed: false,
            url: '',
            agentPath: '',
          });
          acc.blocks.push(`${label}\n  ${shape}`);
          continue;
        }

        if (budget <= 0) {
          acc.problems.push(`${label}：超过单次上限（${MAX_MEDIA} 个媒体），没取`);
          continue;
        }
        budget -= 1;

        const item = await materialize(candidate, {
          convKey, ref, node: inNode?.path ?? null,
        }, runtime);
        acc.items.push(item);

        if (item.error) {
          acc.blocks.push(`${label}\n  取不到 —— ${item.error}`);
          continue;
        }
        if (item.kind === 'image') {
          item.viewed = true;
          acc.images.push({ url: item.url, mimeType: item.mimeType });
        }
        acc.blocks.push(describeItem(item, label));
      }
    }
  }

  return finish(acc, { kind });
}

// 沿 `node` 路径逐层往里走，返回**最终那个位置**的段数组。
// 失败时返回 `{ error }`（进 problems，不抛 —— "这里没有转发"是世界状态，不是调用错误）。
async function resolvePath({ ref, ownSegs, path, http }) {
  let segs = ownSegs;
  const trail = [];      // 走过的索引：`[1]` → `[1, 0]`
  const notes = [];      // 不影响结果、但该说的话（比如一层里有多个转发段）
  let last = null;       // 最后一层节点的身份，用于叙述

  for (const index of path) {
    const at = `seq=${ref}` + (trail.length ? ` 节点 [${trail.join(', ')}]` : '');

    const forwardSegs = segs.filter((s) => s?.type === 'forward');
    if (!forwardSegs.length) return { error: `${at}：这里没有合并转发，node 用不上` };
    // 一层里有多个转发段时只走第一个，但**说出来** ——
    // 静默取第一个会让"我想看的是另一个"变成永远看不到。
    if (forwardSegs.length > 1) {
      notes.push(`${at}：这里有 ${forwardSegs.length} 个转发段，只展开了第一个`);
    }

    const forwardId = String(forwardSegs[0].data?.id ?? '').trim();
    if (!forwardId) return { error: `${at}：这个转发段没有 id（可能已过期）` };

    let raw;
    try {
      raw = normalizeNodes(await http.getForwardMessages(forwardId));
    } catch (error) {
      return { error: `${at}：拉转发内容失败 —— ${String(error?.message ?? error)}` };
    }

    const target = raw[index];
    if (!target) {
      return { error: `${at}：这个转发只有 ${raw.length} 个节点（从 0 起），没有第 ${index} 个` };
    }

    segs = normalizeSegments(target?.message ?? target?.content ?? []);
    trail.push(index);
    last = {
      sender: String(target?.sender?.card || target?.sender?.nickname || target?.nickname || '') || '未知',
      time: target?.time ? clockOf(target.time) : '',
    };
  }

  return {
    segs,
    notes,
    inNode: { path: [...trail], sender: last?.sender ?? '', time: last?.time ?? '' },
  };
}

// 统一出口：`problems` / `truncated` 按需出现，`note` 恒定。
function finish(acc, { kind }) {
  const lines = [];
  if (acc.blocks.length) lines.push(...acc.blocks);
  else if (!acc.problems.length) {
    lines.push(kind === 'all'
      ? '这条消息里没有可取的内容（只有文字 —— 而文字已经在上下文里了）。'
      : `没有取到${KIND_CN[kind] ?? kind}。`);
  }

  if (acc.problems.length) {
    if (lines.length) lines.push('');
    lines.push(...acc.problems);
  }

  // 摘要只说**真做到**的事。"处理了 N 个媒体"会把"只列了清单、没下载"也说成处理过。
  const got = acc.items.filter((i) => i.url).length;
  const listed = acc.items.filter((i) => !i.url).length;
  const summary = [];
  if (got) summary.push(`取了 ${got} 个媒体`);
  if (listed) summary.push(`另有 ${listed} 个只列了清单、没下载`);
  if (acc.images.length) summary.push(`给了 ${acc.images.length} 张图的像素`);
  if (summary.length) {
    lines.push('');
    lines.push(`（${summary.join('；')}）`);
  }

  // 只提示"还差一步就能看到"的那些 —— 已经看过的不再啰嗦。
  const pending = acc.items.filter((i) => i.kind === 'image' && !i.viewed && !i.error);
  if (pending.length) {
    lines.push(
      `要真看哪张图：再调一次并带上 "view": true`
      + `${pending.length > 1 ? '（也可以再用 pick 只挑一张）' : ''}。`,
    );
  }

  return {
    text: lines.join('\n').trim(),
    items: acc.items,
    ...(acc.images.length ? { images: acc.images } : {}),
    ...(acc.nodes.length ? { nodes: acc.nodes } : {}),
    ...(acc.problems.length ? { problems: acc.problems } : {}),
    ...(acc.truncated ? { truncated: true } : {}),
    note: '语音与视频你听不到/看不到画面，只能拿到文件地址（agentPath 可以喂给 ffmpeg）。',
  };
}
