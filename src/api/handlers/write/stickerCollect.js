// 收藏图片 / 动图进 **QQ 收藏表情**（custom face）。
//
// 收藏走 SnowLuma 的 `add_custom_face` —— 它返回的 `emoji_id` 才是 QQ 那边真正的身份。
// 本地条目只做索引 + 备注缓存（发送时用 `send_custom_face`）。
//
// 来源（每条二选一）：
//   · `seq`（+ `index`）：消息里的第几张图（0 起）
//   · `path`：本地文件；配了 agentRoot 时只认 agent 路径，本机路径拒绝
//
// 一次可以给多条 `items`；单条失败不影响其它条。
// 合并转发里的图暂不支持（要走 `qq_get_content` 的 node + pick 两步，这里没做）。
//
// @param args.items  `[{ seq?, index?, path?, desc, tags?, localNote? }]`
export const op = 'stickerCollect';

// 写的是**共享**表情库 + QQ 账号的收藏，先过白名单（fail-closed）。
export const needsAllow = true;
// 改了持久状态，要能查"谁在什么时候塞了什么"。
export const logsAsSend = true;

import fs from 'node:fs';
import path from 'node:path';

import { mediaOf } from '../../../chatlog/segments.js';
import {
  loadStickers, saveStickers, findByMd5, md5Of, shortIdOf, stickerDir, extForMime,
  MAX_STICKER_BYTES,
} from '../../../chatlog/stickers.js';
import { fetchImageBuffer } from '../../../util/image-fetch.js';
import { toHostPathStrict } from '../../../util/path-map.js';
import { sniffMime } from '../../../media/sniff.js';
import { BridgeApiError } from '../../errors.js';

const badArgs = (message, code = 'bad-args') => new BridgeApiError(message, { status: 400, code });

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export async function run({ poolFor, http, logger, stickerPath }, convKey, args) {
  const pool = poolFor(convKey);
  const items = Array.isArray(args?.items) ? args.items : null;

  if (!items || items.length === 0) {
    throw badArgs(
      '要收藏的东西放在 `items` 数组里，例如：\n'
      + '  · 消息里的图：`{ "items": [{ "seq": 1234, "index": 0, "desc": "猫娘抱鱼" }] }`\n'
      + '  · 本地文件：`{ "items": [{ "path": "/ws/pic.gif", "desc": "狗头疑惑" }] }`',
    );
  }

  // QQ 已有的收藏按 md5 建索引：同内容不再重复 add，只更新备注。
  // 拉取失败不阻断 —— 退化成"本地 md5 去重"，最坏是多一条重复收藏。
  const existingByMd5 = new Map();
  try {
    const data = await http.call('fetch_custom_face_detail', { count: 200 });
    for (const face of Array.isArray(data) ? data : []) {
      if (face?.md5) existingByMd5.set(String(face.md5).toUpperCase(), face);
    }
  } catch (error) {
    logger.warn('读取 QQ 收藏表情失败，本次按本地 md5 去重', { error: String(error) });
  }

  const entries = loadStickers({ file: stickerPath });
  const dir = stickerDir(stickerPath);

  const collected = [];
  const failed = [];

  for (const [index, item] of items.entries()) {
    try {
      const one = await collectOne({
        item, pool, http, logger, convKey, entries, existingByMd5, dir,
      });
      collected.push(one);
    } catch (error) {
      failed.push({ index, error: String(error?.message ?? error) });
      logger.warn('收藏表情失败', { conv: convKey, index, error: String(error) });
    }
  }

  if (collected.length) saveStickers(stickerPath, entries);

  logger.info('表情收藏完成', {
    conv: convKey, total: items.length, ok: collected.length, failed: failed.length,
  });

  return {
    total: items.length,
    collected,
    failed,
    note: collected.length
      ? '已写进 QQ 收藏表情；`emoji_id` 是它的身份，本地 stickers.json 只做索引/备注。'
      : '一条都没收进去，看 failed。',
  };
}

// 收一条。
async function collectOne({ item, pool, http, logger, convKey, entries, existingByMd5, dir }) {
  const desc = String(item?.desc ?? '').trim();
  if (desc === '') {
    throw new Error('每条都要有 `desc`（描述）—— 它是以后挑表情的唯一依据，例如 "猫娘抱鱼"');
  }

  const bytes = await readBytes({ item, pool, http, convKey, logger });

  if (bytes.buffer.length > MAX_STICKER_BYTES) {
    throw new Error(
      `图太大（${Math.round(bytes.buffer.length / 1024)}KB > 上限 `
      + `${Math.round(MAX_STICKER_BYTES / 1024)}KB），换一张小点的`,
    );
  }

  const ext = extForMime(bytes.mimeType);
  if (!ext) {
    throw new Error(
      `只收 png / jpeg / webp / gif（图片或动图），这个是 "${bytes.mimeType || '未知'}"`,
    );
  }

  const md5 = md5Of(bytes.buffer);
  const local = findByMd5(entries, md5);

  // 描述是挑表情的唯一依据，不能两条都叫"猫娘抱鱼"。
  const dup = entries.find((e) => e !== local && String(e.desc ?? '').trim() === desc);
  if (dup) {
    throw new Error(`「${desc}」已经被 ${shortIdOf(dup)} 用了 —— 描述必须唯一，换一个`);
  }

  let emojiId = String(existingByMd5.get(md5)?.emoji_id ?? '').trim();

  if (!emojiId) {
    const data = await http.call('add_custom_face', {
      file: `base64://${bytes.buffer.toString('base64')}`,
    });
    emojiId = String(data?.emoji_id ?? '').trim();
    if (!emojiId) throw new Error('add_custom_face 没有返回 emoji_id');
  }

  // add_custom_face 不带备注；备注要单独写回 QQ。
  let note = '';
  try {
    await http.call('modify_custom_face', { emoji_id: emojiId, desc });
  } catch (error) {
    note = `已收藏，但备注没写进 QQ：${error?.message ?? error}`;
    logger.warn('收藏表情备注写入失败', { emoji_id: emojiId, error: String(error) });
  }

  // 本地留一份字节：预览/旧发送路径还能用；权威身份仍是 emoji_id。
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${md5}.${ext}`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes.buffer);
    fs.renameSync(tmp, file);
  }

  const uin = String(pool?.selfQq ?? '');
  const url = uin ? `https://p.qpic.cn/qq_expression/${uin}/${emojiId}/0` : '';
  const ts = new Date().toISOString();

  if (local) {
    Object.assign(local, {
      id: emojiId,
      resId: emojiId,
      emoji_id: emojiId,
      url,
      md5,
      desc,
      file,
      source: 'qq-favorite',
      ...(Array.isArray(item?.tags) ? { tags: item.tags.map(String) } : {}),
      ...(item?.localNote !== undefined ? { localNote: String(item.localNote) } : {}),
      updatedAt: ts,
    });
    if (!local.createdAt) local.createdAt = ts;
  } else {
    entries.push({
      id: emojiId,
      resId: emojiId,
      emoji_id: emojiId,
      url,
      md5,
      desc,
      file,
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
      localNote: item?.localNote !== undefined ? String(item.localNote) : '',
      usage: '',
      source: 'qq-favorite',
      useCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  // 同一批里再来一张一样的，直接命中。
  existingByMd5.set(md5, { emoji_id: emojiId, md5, desc });

  return {
    emoji_id: emojiId,
    shortId: shortIdOf({ id: emojiId, md5 }),
    md5,
    desc,
    from: bytes.from,
    ...(note ? { note } : {}),
  };
}

// 取字节：本地路径 / 消息里的图。
async function readBytes({ item, pool, http, convKey, logger }) {
  const rawPath = String(item?.path ?? '').trim();

  if (rawPath !== '') {
    if (item?.seq !== undefined && item?.seq !== null && item?.seq !== '') {
      throw new Error('`path` 和 `seq` 只能给一个');
    }

    // `path` 只收本地文件；其它形状在 stat 之前就说清楚，别落到
    // “本地文件不存在：/m/xxx” 这种误导性的报错。
    if (/^\/m\//i.test(rawPath)) {
      throw new Error('`path` 只收本地文件；`/m/<id>` 是媒体库地址，收藏消息里的图请用 `seq`');
    }
    if (/^https?:\/\//i.test(rawPath)) {
      throw new Error('`path` 只收本地文件；不支持直接抓外网 URL');
    }
    if (/^(base64:|data:)/i.test(rawPath)) {
      throw new Error('`path` 只收本地文件；不收 base64');
    }

    const checked = toHostPathStrict(rawPath);
    if (!checked.ok) {
      throw new Error('`path` 只接受工作区路径（例如 /ws/pic.gif）；本机路径不允许');
    }

    const file = checked.value;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`本地文件不存在：${rawPath}`);
    }
    if (!stat.isFile()) throw new Error(`不是文件：${rawPath}`);
    if (stat.size > MAX_STICKER_BYTES) {
      throw new Error(`文件太大（${Math.round(stat.size / 1024)}KB）`);
    }

    const buffer = fs.readFileSync(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mimeType = sniffMime(buffer) || EXT_MIME[ext] || '';
    return { buffer, mimeType, from: 'local' };
  }

  const ref = item?.seq;
  if (ref === undefined || ref === null || ref === '') {
    throw new Error('每条要给 `seq`（消息定位符）或 `path`（本地工作区路径）之一');
  }

  const found = pool.find(ref);
  if (!found) throw new Error(`按 seq=${ref} 找不到这条消息`);

  const media = mediaOf(found.message).filter((x) => x.kind === 'image');
  if (!media.length) throw new Error(`seq=${ref} 这条消息里没有图片`);

  const want = Number.isInteger(item?.index) ? item.index : 0;
  const target = media[want];
  if (!target) {
    throw new Error(`seq=${ref} 只有 ${media.length} 张图（index 从 0 起），没有第 ${want} 张`);
  }

  const url = target.url || target.file || '';
  if (!url) throw new Error(`seq=${ref} 第 ${want + 1} 张图没有可用的地址`);

  try {
    const raw = await fetchImageBuffer(url);
    return { buffer: raw.buffer, mimeType: raw.contentType, from: 'message' };
  } catch (firstError) {
    if (!target.file) throw firstError;
    const fresh = await http.getImageUrl(target.file);
    if (!fresh) throw firstError;
    logger.debug('收藏时图片地址过期，已用 file 重签', {
      conv: convKey, file: target.file, freshUrl: String(fresh).slice(0, 60),
    });
    const raw = await fetchImageBuffer(fresh);
    return { buffer: raw.buffer, mimeType: raw.contentType, from: 'message-refreshed' };
  }
}
