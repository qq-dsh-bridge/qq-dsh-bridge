
export const op = 'send';
export const needsAllow = true;
export const logsAsSend = true;

import fs from 'node:fs';
import path from 'node:path';

import { normalizeOutgoingBubble } from '../../../onebot/normalize.js';
import { toAgentPath, agentize } from '../../../util/path-map.js';
import { segmentsToText, textOf, escapeName, mediaOf } from '../../../chatlog/segments.js';
import { seqOf } from '../../../chatlog/store.js';
import { loadStickers, findSticker, loadStickerBytes, bumpUse } from '../../../chatlog/stickers.js';
import { mediaStore, mediaBaseUrl } from '../../media.js';
import { idOfPath, idOfUrl } from '../../../media/url.js';
import { KINDS } from '../../../media/kinds.js';
import { sniffMime } from '../../../media/sniff.js';
import { fetchSafe } from '../../../util/safe-fetch.js';
import { BridgeApiError } from '../../errors.js';

// 入参错误统一 400：模型能改，别让它显示成 500/internal。
const badArgs = (message, code = 'bad-args') => new BridgeApiError(message, { status: 400, code });

// OneBot 的报错里有 UID/UIN 这类内部词，换成人话再给模型；
// 原始报文留在日志里（调用处 logger.warn 记的是原 error）。
function humanizeOneBotError(error) {
  return String(error?.message ?? error)
    .replace(/failed to resolve UID for UIN (\d+)/gi, '这个号不在本群（或不是好友），@ 不到 $1')
    .replace(/HTTP download failed:\s*(\d{3})/gi, '媒体下载失败（HTTP $1），地址可能已过期');
}

export async function run({ poolFor, http, logger, stickerPath }, convKey, args) {
  const pool = poolFor(convKey);
  const isGroup = convKey.startsWith('group:');

  // dry-run
  const dryRun = args?.dryRun === true;

  // #region 引用 / 表情 解析器

  const resolveReply = async (seq) => {
    try {
      const id = pool.find(seq)?.message?.messageId;
      if (!id) logger.warn('引用失败：按 seq 找不到对应消息', { conv: convKey, seq });
      return id;
    } catch (error) {
      logger.warn('引用失败：查 seq 出错', { conv: convKey, seq, error: String(error) });
      return null;
    }
  };


  const resolveSticker = async (ref) => {
    const entries = loadStickers({ file: stickerPath });
    let entry;
    try {
      entry = findSticker(entries, ref);
    } catch (error) {
      if (error?.hint) throw new Error(`${error.message}\n${error.hint}`);
      throw error;
    }
    if (!entry) return null;

    if (!dryRun) bumpUse({ file: stickerPath, id: entry.id, context: convKey });

    // QQ 收藏表情的身份：新条目有 `emoji_id`，老条目把 id 直接当 emoji_id。
    const id = String(entry.emoji_id ?? entry.id ?? '').trim();
    const emojiId = /^\d+_0_0_0_[0-9A-F]{32}_0_0$/i.test(id) ? id : '';

    // 只有没有 QQ id 的旧条目才需要本地字节（退化成图片）。
    let base64 = '';
    if (emojiId === '') {
      try {
        const { buffer } = await loadStickerBytes(entry);
        base64 = buffer.toString('base64');
      } catch {
        // 既没有 QQ id 又没有本地文件 —— 交给 normalize 报“找不到”。
      }
    }

    return { emojiId, md5: entry.md5, desc: entry.desc || entry.id, base64 };
  };

  let selfNameCache = '';
  const selfName = async () => {
    if (selfNameCache) return selfNameCache;
    try {
      const info = await http.getLoginInfo();
      selfNameCache = String(info?.nickname ?? '').trim();
    } catch {
      // 拿不到昵称就退回 QQ 号；不能因此发不出记录。
    }
    if (!selfNameCache) selfNameCache = String(pool.selfQq ?? '') || '我';
    return selfNameCache;
  };

  // `/m/<id>` 在交给 SnowLuma 前补成绝对地址；外网 URL 先按同一套
  // SSRF 白名单下载进媒体库；本地路径原样交给 SnowLuma。
  const materializeForwardImage = async (raw) => {
    const value = String(raw ?? '');
    const id = value.startsWith('/m/') ? idOfPath(value) : idOfUrl(value);
    if (id) {
      const store = mediaStore();
      if (!store?.get(id)) throw badArgs(`聊天记录里的图片不存在：${value}`, 'media-not-found');
      return `${mediaBaseUrl()}/m/${id}`;
    }
    if (!/^https?:\/\//i.test(value)) return value;

    const store = mediaStore();
    if (!store) throw new Error('媒体库没有初始化，无法缓存聊天记录里的图片');
    const origin = `url:${value}`;
    const hit = store.findByOrigin(origin);
    if (hit) return `${mediaBaseUrl()}/m/${hit.id}`;

    const got = await fetchSafe(value, { maxBytes: KINDS.image.maxBytes });
    let type = got.contentType;
    if (!KINDS.image.mimes[type]) {
      const sniffed = sniffMime(got.buffer);
      if (sniffed) type = sniffed;
    }
    const meta = store.put({ data: got.buffer, kind: 'image', mime: type, origin });
    return `${mediaBaseUrl()}/m/${meta.id}`;
  };

  const buildForwardNodes = async (nodes) => {
    const selfQq = String(pool.selfQq ?? '').trim();
    if (selfQq === '') throw badArgs('本号 QQ 未知，无法生成聊天记录');
    // 昵称同样按名字规则转义：`[` / `]` / `⧵` 不能在卡片里顶穿结构。
    const nickname = escapeName(await selfName(), { max: 0 });
    const out = [];

    for (const node of nodes) {
      if (node.kind === 'seqs') {
        for (const seq of node.seqs) {
          const found = pool.find(seq);
          const id = found?.message?.messageId;
          if (!id) throw badArgs(`聊天记录里的 seq=${seq} 找不到对应消息`);

          // ⚠️ 语音不能这样进合并转发 —— 提前拦住，别让服务端回一句看不懂的话。
          //
          // 实测（图 / 嵌套 / 自编节点都能进，只有语音不行）：
          //   `动作 send_forward_msg 失败：record fast-upload not available (server requires bytes)`
          //
          // 原因是这个节点的形态：我们只把 `message_id` 交给服务端，**原始消息由它自己去取**，
          // 而它取到 record 之后需要"按 URL 快传"——语音没有这条路，只能给字节，
          // 而字节在我们这一侧（按 id 引用的路径上我们根本碰不到它）。
          //
          // 对照：图片有快传通道，所以带图的消息可以照原样引用。
          // 视频暂不拦 —— 服务端只对 record 报了这句，video 有没有快传通道还没验证过。
          const hasRecord = mediaOf(found.message)
            .some((m) => m.kind === 'record');
          if (hasRecord) {
            throw badArgs(
              `聊天记录里的 seq=${seq} 含语音，塞不进合并转发 —— `
              + '服务端按 id 取到语音后需要「按 URL 快传」，而语音没有这个通道（它要原始字节，'
              + '而 id 引用这条路我们拿不到字节）。\n'
              + '两个办法：① 把那条语音用 `qq_send` 单独发一条；'
              + '② 合并转发里只引用不含语音的消息（文字/图片可以）。',
              'forward-record',
            );
          }

          out.push({ type: 'node', data: { message_id: Number(id) } });
        }
        continue;
      }

      if (node.kind === 'self') {
        const content = await Promise.all(node.segments.map(async (seg) => (seg.type === 'image'
          ? { ...seg, data: { ...seg.data, url: await materializeForwardImage(seg.data?.url) } }
          : seg)));
        out.push({
          type: 'node',
          data: { user_id: Number(selfQq), nickname, content },
        });
        continue;
      }

      if (node.kind === 'forward') {
        out.push({
          type: 'node',
          data: {
            user_id: Number(selfQq),
            nickname,
            content: await buildForwardNodes(node.nodes),
          },
        });
      }
    }

    return out;
  };

  // #endregion


  // #region 入参 → 气泡

  let planned;  

  if (Array.isArray(args.messages) && args.messages.length) {
    planned = [];
    for (const [i, bubble] of args.messages.entries()) {
      const r = await normalizeOutgoingBubble(bubble, { resolveReply, resolveSticker });
      if (!r.ok) {
        throw badArgs(`messages 第 ${i + 1} 条有误：${r.errors.join('；')}`);
      }
      planned.push({ segments: r.segments, label: textOf({ segments: r.segments }).slice(0, 60) });
    }
  } else {
    if (typeof args.text === 'string' && args.text.trim() !== '') {
      planned = [{
        segments: [{ type: 'text', data: { text: args.text } }],
        label: args.text.slice(0, 60),
      }];
    } else if (args.text !== undefined || args.segments !== undefined || args.replyTo !== undefined) {
      throw badArgs(
        '请用 `messages` 发送：\n'
        + '  · 一句： `{ "messages": [{ "text": "内容" }] }`\n'
        + '  · 带引用和 @： `{ "messages": [{ "reply": "1234", "at": "123456", "text": " 内容" }] }`\n'
        + '  · 多条： `{ "messages": [{ "text": "一" }, { "text": "二" }] }`',
      );
    }
  }

  if (!planned.length) {
    throw badArgs('没有可发送的内容 —— 请给 `messages: [{ "text": "…" }]`');
  }

  const forwardCards = planned.filter(
    (one) => one.segments.length === 1 && one.segments[0].type === 'forward',
  );
  if (forwardCards.length > 2) {
    throw badArgs(`一次最多 2 条合并聊天记录（现在 ${forwardCards.length} 条）—— 多出来的分两次发`);
  }

  // #region 发送前：把 URL 收进媒体库
  //
  // image / voice 的地址常带 rkey（QQ 图床），发出去之后很快就 404。
  // 统一在发送前抓进媒体库，真正交给 SnowLuma 的永远是 `/m/<id>`。
  //
  // · `/m/<id>`（相对或回环绝对 URL）→ 已在库里，只补成绝对地址；
  // · 其它 http(s) → findByOrigin 命中就复用，否则下载 → 入库；
  // · 本地路径 → 不缓存，原样交给下游；
  // · 下载/校验失败是**硬错误**：这一条不发，避免"发出去了但回头引用是死链"。
  //
  // 预演（dryRun）不入库 —— 看格式不应该产生副作用。
  if (!dryRun) {
    const store = mediaStore();
    if (!store) throw new Error('媒体库没有初始化，无法缓存图片/语音/视频地址');

    const cacheOne = async (kind, raw) => {
      const value = String(raw ?? '').trim();
      if (value === '') return null;

      // 自己发布的地址：已经缓存，补成绝对 URL 即可（SnowLuma 要能直接取）。
      if (value.startsWith('/m/')) {
        const id = idOfPath(value);
        if (!id) throw badArgs(`不是合法的媒体地址：${value}`, 'media-not-found');
        if (!store.get(id)) throw badArgs(`媒体库里没有 ${id}（可能已被配额清掉，重新生成/下载一次）`, 'media-not-found');
        return `${mediaBaseUrl()}/m/${id}`;
      }
      const ownId = idOfUrl(value);
      if (ownId) {
        if (!store.get(ownId)) throw badArgs(`媒体库里没有 ${ownId}（可能已被配额清掉，重新生成/下载一次）`, 'media-not-found');
        return `${mediaBaseUrl()}/m/${ownId}`;
      }

      // 本地路径：文件就在盘上，不占配额。
      if (!/^https?:\/\//i.test(value)) return null;

      const origin = `url:${value}`;
      const hit = store.findByOrigin(origin);
      if (hit) return `${mediaBaseUrl()}/m/${hit.id}`;

      const spec = KINDS[kind];
      const got = await fetchSafe(value, {
        maxBytes: spec.maxBytes,
        ...(kind === 'video' ? { timeoutMs: 60_000 } : {}),
      });

      // CDN 有时回 application/octet-stream；按字节猜一次再入库。
      let type = got.contentType;
      if (spec.mimes && !spec.mimes[type]) {
        const sniffed = sniffMime(got.buffer);
        if (sniffed) type = sniffed;
      }

      const meta = store.put({ data: got.buffer, kind, mime: type, origin });
      logger.debug('媒体已入缓存', {
        kind, bytes: meta.bytes, mime: meta.mime, from: value.slice(0, 80),
      });
      return `${mediaBaseUrl()}/m/${meta.id}`;
    };

    for (const [i, one] of planned.entries()) {
      for (const seg of one.segments) {
        try {
          if (seg.type === 'image' && seg.data?.url) {
            const cached = await cacheOne('image', seg.data.url);
            if (cached) seg.data.url = cached;
          } else if (seg.type === 'record' && seg.data?.file) {
            const cached = await cacheOne('audio', seg.data.file);
            if (cached) seg.data.file = cached;
          } else if (seg.type === 'video' && seg.data?.file) {
            const cached = await cacheOne('video', seg.data.file);
            if (cached) seg.data.file = cached;
          }
        } catch (error) {
          const what = seg.type === 'image' ? '图片' : seg.type === 'video' ? '视频' : '语音';
          const who = one.label ? `（${one.label}）` : '';
          throw badArgs(`第 ${i + 1} 条${who}的${what}无法入缓存：${error?.message ?? error}`, 'media-cache-failed');
        }
      }
    }
  }
  // #endregion

  const missingLocal = [];
  // URL、媒体库地址、base64 都不是本地文件；只看真正的路径。
  const checkLocal = (i, file) => {
    const value = String(file ?? '');
    if (value === '' || /^(https?:|base64:|data:|\/m\/)/i.test(value)) return;
    if (!path.isAbsolute(value) || !fs.existsSync(value)) {
      missingLocal.push(`第 ${i + 1} 条：${toAgentPath(value)}`);
    }
  };
  const checkForwardLocal = (i, nodes) => {
    for (const node of nodes ?? []) {
      if (node.kind === 'self') {
        for (const seg of node.segments ?? []) {
          if (seg.type === 'image') checkLocal(i, seg.data?.url);
        }
      } else if (node.kind === 'forward') {
        checkForwardLocal(i, node.nodes);
      }
    }
  };

  for (const [i, one] of planned.entries()) {
    for (const seg of one.segments) {
      if (seg?.type === 'forward') {
        checkForwardLocal(i, seg.data?.nodes);
        continue;
      }
      // 只有 image / record / video 能带本地文件；其余段没有路径可言。
      if (seg?.type !== 'record' && seg?.type !== 'image' && seg?.type !== 'video') continue;
      checkLocal(i, seg.data?.file ?? seg.data?.url);
    }
  }
  if (missingLocal.length) {
    throw badArgs(
      `本地文件找不到：\n${missingLocal.map((m) => `  · ${m}`).join('\n')}\n`
      + '工作区路径要写成绝对路径（WSL 里是 `/ws/...`）；'
      + '或者直接用 `qq_get_content` 返回的 `/m/<id>` 地址。',
    );
  }

  // 一条气泡 → 文本：预演、真发、返回值**共用同一个渲染器**（所以"看到的"就是"发出的"）。
  const render = (one) => segmentsToText(
    { segments: one.segments },
    { selfQq: pool.selfQq, newline: '\n', trimText: false },
  );
  // #endregion


  // #region 预演

  if (dryRun) {
    return {
      dryRun: true,
      wouldSend: planned.length,
      messages: planned.map((one) => ({ segmentsText: render(one) })),
      note: '以上是**将要发出**的原文（一条都没发）。核对无误后，用同样的参数去掉 `dryRun` 再真发一次。',
    };
  }

  const sent = [];
  for (const [index, one] of planned.entries()) {
    // sticker / forward 都必须独占一条（normalize 已保证），可以各自走专用动作。
    const sticker = one.segments.length === 1 && one.segments[0].type === 'sticker'
      ? one.segments[0].data
      : null;
    const forward = one.segments.length === 1 && one.segments[0].type === 'forward'
      ? one.segments[0].data
      : null;

    let action;
    let params;
    let data;

    try {
      if (forward) {
        action = 'send_forward_msg';
        params = { messages: await buildForwardNodes(forward.nodes) };
      } else if (sticker?.emoji_id) {
        action = 'send_custom_face';
        params = { emoji_id: String(sticker.emoji_id) };
      } else {
        action = isGroup ? 'send_group_msg' : 'send_private_msg';
        params = { message: one.segments, auto_escape: false };
      }

      if (isGroup) params.group_id = Number(convKey.slice(6));
      else params.user_id = Number(convKey.slice(8));

      data = await http.call(action, params);
    } catch (error) {
      logger.warn('发送失败（前面的气泡已发出）', {
        conv: convKey, index: index + 1, total: planned.length, error: String(error),
      });
      sent.push({ segmentsText: render(one), error: agentize(humanizeOneBotError(error)) });
      for (const rest of planned.slice(index + 1)) sent.push({ segmentsText: render(rest), notSent: true });
      break;
    }


    const messageId = String(data?.message_id ?? '');

    sent.push({ messageId, segmentsText: render(one) });
  }

  await fillSeqFromEcho(pool, sent);
  for (const s of sent) { if (!s.seq && s.messageId) s.seq = s.messageId; delete s.messageId; }
  const count = (k) => sent.filter((s) => Boolean(s[k])).length;
  return { sent: count('seq'), failed: count('error'), notSent: count('notSent'), messages: sent };

  // #endregion
}


// #region 群聊 seq：等回推补齐

const ECHO_WAIT_MS = 800;   // 0.8s 上限

async function fillSeqFromEcho(pool, sent, { timeoutMs = ECHO_WAIT_MS } = {}) {
  const pending = sent.filter((s) => !s.seq && s.messageId);
  if (!pending.length) return;

  const take = () => {
    for (const s of pending) {
      if (s.seq) continue;
      const found = pool.findByMessageId(s.messageId);
      if (found) s.seq = seqOf(found.message, found.date);
    }
  };
  const allDone = () => pending.every((s) => s.seq);

  take();
  if (allDone()) return;
  await new Promise((resolve) => {
    let timer;
    let off = () => {};
    const finish = () => { clearTimeout(timer); off(); resolve(); };
    const onAppended = () => { take(); if (allDone()) finish(); };
    off = pool.onAppend(onAppended);
    timer = setTimeout(finish, timeoutMs);
    take();   
    if (allDone()) finish();
  });
}


// #endregion
