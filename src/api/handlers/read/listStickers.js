// 列出可用表情 —— **以 QQ 收藏表情为准**，并顺手重建本地索引。
//
// 收藏的真相在 QQ 那边（`fetch_custom_face_detail`），本地索引只是缓存。所以：
// · 先拉 QQ 收藏（emoji_id / md5 / url / desc）；
// · 用本地条目补描述/标签/useCount（同一个 md5 或 emoji_id）；
// · 合并结果写回 `state/stickers/<uin>/index.json` —— 这就是“重新索引”。
//
// 本地独有的旧条目（`collected_*`，还没进 QQ 收藏的）仍然列在后面，
// 它们只能按图片发；QQ 收藏条目按 `send_custom_face` 发。
export const op = 'listStickers';
export const logsAsSend = true;

import fs from 'node:fs';
import { loadStickers, saveStickers, describeStickers } from '../../../chatlog/stickers.js';

export async function run({ stickerPath, http, logger }, convKey, args) {
  const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 50;

  let local = [];
  let corruptBackup = '';
  try {
    local = loadStickers({ file: stickerPath });
  } catch (error) {
    // 本地索引坏了：QQ 才是真相。把坏文件挪走，按空索引重建。
    const backup = `${stickerPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stickerPath, backup);
      corruptBackup = backup;
    } catch {
      corruptBackup = '';
    }
    logger?.warn?.('本地表情索引损坏，按 QQ 收藏重建', {
      error: String(error), backup: corruptBackup,
    });
  }

  const warnings = [];
  if (corruptBackup) warnings.push(`本地索引损坏，已备份到 ${corruptBackup}`);

  let faces = [];
  let qqError = '';
  // 多取一些：删条目要用“完整列表”判断，不能因为 limit 小就误删。
  const fetchCount = Math.max(limit, 500);
  try {
    const data = await http.call('fetch_custom_face_detail', { count: fetchCount });
    faces = Array.isArray(data) ? data : [];
  } catch (error) {
    qqError = String(error?.message ?? error);
    warnings.push(`读取 QQ 收藏表情失败：${qqError}`);
    logger?.warn?.('读取 QQ 收藏表情失败，改用本地索引', { error: qqError });
  }

  // 只有拿到“没被 count 截断”的列表时，才敢按它删本地条目。
  const complete = qqError === '' && faces.length < fetchCount;

  if (!faces.length) {
    if (!local.length) {
      return {
        stickers: [],
        total: 0,
        ...(warnings.length ? { warning: warnings.join('；') } : {}),
        note: 'QQ 收藏是空的，本地也没有索引。先用 qq_sticker_collect 收一张。',
      };
    }
    return {
      stickers: describeStickers(local, { limit }),
      total: local.length,
      ...(warnings.length ? { warning: warnings.join('；') } : {}),
      note: '用 ref（或 shortId、描述）放进 qq_send 的 sticker 段。sticker 要单独一条。',
    };
  }

  const byId = new Map();
  const byMd5 = new Map();
  for (const entry of local) {
    if (entry?.id) byId.set(String(entry.id), entry);
    const md5 = String(entry?.md5 ?? '').toUpperCase();
    if (md5) byMd5.set(md5, entry);
  }

  const now = new Date().toISOString();
  const merged = [];
  const seen = new Set();

  for (const face of faces) {
    const emojiId = String(face?.emoji_id ?? '').trim();
    if (!emojiId) continue;

    const md5 = String(face?.md5 ?? '').toUpperCase();
    const old = byId.get(emojiId) ?? (md5 ? byMd5.get(md5) : null) ?? null;

    merged.push({
      id: emojiId,
      resId: String(face?.resId ?? emojiId),
      emoji_id: emojiId,
      url: String(face?.url ?? old?.url ?? ''),
      md5,
      // QQ 那边的非空 desc **优先**：在手机/客户端改过名字要能同步进来。
      // QQ 为空时才保留本地标注（很多条 QQ 侧本来就没有备注）。
      desc: String(face?.desc || old?.desc || ''),
      file: old?.file ?? '',
      tags: Array.isArray(old?.tags) ? old.tags : [],
      localNote: old?.localNote ?? '',
      usage: old?.usage ?? '',
      source: 'qq-favorite',
      useCount: old?.useCount ?? 0,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    });
    seen.add(emojiId);
    if (md5) seen.add(md5);
  }

  // 本地独有的旧条目（没有 emoji_id / 不在 QQ 收藏里）也列出来，排后面。
  // 但 QQ 里**已经删掉**的收藏不能继续留着 —— 否则删了还在列表里，
  // 发送时又会撞 "not in the saved sticker list"。
  const qqIds = new Set(merged.map((e) => String(e.emoji_id ?? '')));
  const isQqFaceId = (s) => /^\d+_0_0_0_[0-9A-F]{32}_0_0$/i.test(String(s ?? ''));

  for (const entry of local) {
    const id = String(entry?.id ?? '');
    const emojiId = String(entry?.emoji_id ?? '');
    const md5 = String(entry?.md5 ?? '').toUpperCase();
    if ((id && seen.has(id)) || (emojiId && seen.has(emojiId)) || (md5 && seen.has(md5))) continue;

    const qqLike = emojiId || id;
    if (complete && isQqFaceId(qqLike) && !qqIds.has(qqLike)) continue;   // 云端已删
    merged.push({ ...entry, source: entry.source || 'local' });
  }

  saveStickers(stickerPath, merged);
  logger?.info?.('表情索引已按 QQ 收藏重建', {
    conv: convKey, qq: faces.length, localOnly: merged.length - faces.length,
  });

  return {
    stickers: describeStickers(merged, { limit }),
    total: merged.length,
    note: '用 ref（或 shortId、描述）放进 qq_send 的 sticker 段：'
      + '`{ "messages": [{ "sticker": "猫娘抱鱼" }] }`。'
      + '有 emoji_id 的按 QQ 收藏表情发，旧的本地条目按图片发。'
      + 'QQ 端的改名、新增、删除会在这次重建时同步进来。sticker 要单独一条。',
  };
}
