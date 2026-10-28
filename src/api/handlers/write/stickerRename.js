// 改一条已收藏表情的**描述 / 标签 / 备注**。
//
// ── 为什么需要它
//
// 表情库里的 `desc` 是模型挑表情的**唯一**依据，而它是在收藏那一刻随手写的：
// 当时觉得"猫娘抱鱼"够用，过后发现库里已经有三条都叫这个（实测库里的
// 痛点就是**描述重复/为空**，见 `chatlog/stickers.js` 头部）。没有改名，
// 库里只会越攒越乱，最后模型挑不准、人也不想维护。
//
// ── 改元数据，并写回 QQ
//
// 字节在 `state/stickers/<uin>/<md5>.<ext>` 里，`desc` 只是索引。
// 有 `emoji_id` 的条目改 desc 时会同步调 SnowLuma `modify_custom_face` ——
// 否则下次 `qq_list_stickers` 从 QQ 重建索引时，描述会被 QQ 的空值盖掉。
// 旧的 `collected_*` 没有 QQ id，只能改本地。
//
// @param args.ref       定位（ref / shortId / 现有描述 —— 都走 findSticker）
// @param args.desc      新描述
// @param args.tags      新标签数组
// @param args.localNote 新备注
export const op = 'stickerRename';

// ⚠️ `needsAllow` / `logsAsSend` —— 与 `stickerCollect` 同一条口径：
//    改的是**按号分库**的 `state/stickers/<uin>/index.json`，
//    属于对全局持久状态的写操作，先过白名单、并且必须留痕。
export const needsAllow = true;
export const logsAsSend = true;

import {
  loadStickers, saveStickers, findSticker, shortIdOf, similarStickers,
} from '../../../chatlog/stickers.js';

export async function run({ stickerPath, http, logger }, convKey, args) {
  const ref = String(args?.ref ?? '').trim();
  if (ref === '') {
    throw new Error(
      '要改哪条表情？传 `ref` —— qq_list_stickers 给的 ref / shortId，或它现有的描述。',
    );
  }

  const changing = ['desc', 'tags', 'localNote'].filter((k) => args?.[k] !== undefined);
  if (!changing.length) {
    throw new Error(
      '没有要改的字段 —— 至少给 `desc` / `tags` / `localNote` 之一。'
      + '（只调着玩不改东西会被拒，免得你以为改成功了。）',
    );
  }

  const entries = loadStickers({ file: stickerPath });
  if (!entries.length) {
    throw new Error('表情库是空的，没有可改的条目。先用 qq_sticker_collect 收一张。');
  }

  // ⚠️ **描述重名的拦截（这里刻意比 `findSticker` 严）。**
  //
  // `findSticker` 的"描述精确匹配"是**取第一条**（见 stickers.js 第 ④ 步）——
  // 对发送来说无所谓（发哪个都是那张图的笑点），但改名是**破坏性**的：
  // 库里两条都叫"猫娘抱鱼"时，猜错就改掉了另一条，而返回的 desc 还显示
  // "改成功了"。实测这种重名在库里并不罕见（描述是当年随手写的）。
  //
  // 所以：精确命中多条 → **拒绝并要求用 shortId 指明**，把候选摆出来。
  const sameDesc = entries.filter((e) => e.desc && String(e.desc) === ref);
  if (sameDesc.length > 1) {
    throw new Error(
      `"${ref}" 在库里对应 ${sameDesc.length} 条（描述重复），改名会改错条目 —— 请用 shortId 指明是哪一条。\n`
      + `候选：${sameDesc.map((e) => `${shortIdOf(e)}`).join('、')}\n`
      + `（先 qq_list_stickers 看一眼各自的 ref 也行。）`,
    );
  }

  // 走 `findSticker`（支持的写法与发送时**完全一致**：ref / shortId / md5 / 描述）。
  // 它自己会在"描述模糊命中多条"时抛错并列出候选。
  //
  // ⚠️ 那些候选原本放在 `error.hint` 里 —— 而 **hint 到不了模型**
  //    （`api/server.js` 只回 `error.message`）。描述重复时"命中多条"
  //    恰恰是最常见的情况，此时不给候选等于让模型瞎试，所以这里把它拼进 message。
  let entry;
  try {
    entry = findSticker(entries, ref);
  } catch (error) {
    if (error?.hint) throw new Error(`${error.message}\n${error.hint}`);
    throw error;
  }

  if (!entry) {
    // ⚠️ **找不到时不能只说"找不到"。**
    //
    // 实测模型的心理是"换个写法再试" —— 它会连着试四五种（加引号、
    // 换大小写、只写两个字），因为它**不知道库里到底有什么**。
    // 所以这里把最接近的几条摆出来，它一眼就能挑对。
    //
    // 相似度全为 0 时退回**前几条**：库总共几十条，随便给几条
    // 也比一句"找不到"有用。
    const near = similarStickers(entries, ref, { limit: 5 });
    const list = near.length ? near : entries.slice(0, 5);
    throw new Error(
      `表情库里没有 "${ref}"。\n`
      + `库里共 ${entries.length} 条，最接近的：${list.map((e) => `${e.desc || '(无描述)'}(${shortIdOf(e)})`).join('、')}\n`
      + '传 ref / shortId（**md5 前 8 位**）或完整描述都认；'
      + '不确定确切写法就先调 qq_list_stickers。',
    );
  }

  // QQ 收藏表情的身份：新条目有 emoji_id，老的 QQ 条目把 id 直接当 emoji_id。
  const rawId = String(entry.emoji_id ?? entry.id ?? '').trim();
  const emojiId = /^\d+_0_0_0_[0-9A-F]{32}_0_0$/i.test(rawId) ? rawId : '';
  let qqSynced = false;

  const before = {
    desc: String(entry.desc ?? ''),
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    localNote: String(entry.localNote ?? ''),
  };

  let nextDesc = null;
  if (args.desc !== undefined) {
    nextDesc = String(args.desc).trim();
    // ⚠️ **不允许改成空描述**。
    //
    // 空 desc 正是库里现存的老毛病（那些条目模型完全用不上）。
    // 改名是"让描述更有用"的动作，允许它把描述清空等于用这个工具
    // 制造出更多废条目 —— 直接拒绝，并说明理由。
    if (nextDesc === '') {
      throw new Error(
        'desc 不能改成空字符串 —— 没有描述的表情，模型只能靠背 id 来找，等于把它废掉'
        + '（库里已经有一批 desc 为空的条目了）。要弃用它请直接删掉那一条。',
      );
    }

    // 新描述不能和别的条目撞 —— 两条都叫"猫娘抱鱼"时发送会随机命中，
    // 改名正是修这个的动作，不能反过来制造。
    if (nextDesc !== before.desc) {
      const dupes = entries.filter(
        (e) => e !== entry && String(e.desc ?? '').trim() === nextDesc,
      );
      if (dupes.length) {
        throw new Error(
          `「${nextDesc}」已经被 ${dupes.map((e) => shortIdOf(e)).join('、')} 用了 —— `
          + '描述必须唯一，否则挑表情会挑错。换一个描述，或先改掉重名的那条。',
        );
      }
    }
  }

  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    throw new Error('`tags` 要是字符串数组，例如 ["猫", "搞笑"]。');
  }

  const nextTags = args.tags !== undefined ? args.tags.map(String) : entry.tags;
  const nextNote = args.localNote !== undefined ? String(args.localNote) : entry.localNote;

  // 实际变了什么（而不是"请求改了什么"）—— 回执不能把没变的 desc 说成变了。
  const actual = [];
  if (nextDesc !== null && nextDesc !== before.desc) actual.push('desc');
  if (args.tags !== undefined && JSON.stringify(nextTags) !== JSON.stringify(before.tags)) actual.push('tags');
  if (args.localNote !== undefined && nextNote !== before.localNote) actual.push('localNote');

  if (actual.length === 0) {
    return {
      id: entry.id,
      shortId: shortIdOf(entry),
      before: before.desc,
      after: entry.desc,
      tags: entry.tags,
      localNote: entry.localNote,
      changed: [],
      note: `没有变化：描述还是「${entry.desc || '(无描述)'}」，tags/localNote 也没动。`,
    };
  }

  // 只有描述真的变了才写 QQ（没变就没必要多一次远端调用）。
  if (actual.includes('desc') && emojiId !== '') {
    if (!http) throw new Error('改 QQ 收藏表情需要 OneBot 连接（内部 http 未注入）');
    try {
      await http.call('modify_custom_face', { emoji_id: emojiId, desc: nextDesc });
      qqSynced = true;
    } catch (error) {
      throw new Error(`改 QQ 收藏表情的备注失败：${error?.message ?? error}`);
    }
    entry.emoji_id = emojiId;
    entry.id = emojiId;
    entry.resId = emojiId;
  }

  if (nextDesc !== null) entry.desc = nextDesc;
  if (args.tags !== undefined) entry.tags = nextTags;
  if (args.localNote !== undefined) entry.localNote = nextNote;

  entry.updatedAt = new Date().toISOString();

  // 原子写（临时文件 + rename）—— 见 chatlog/stickers.js 的 saveStickers。
  saveStickers(stickerPath, entries);

  logger.info('表情已改名', {
    conv: convKey, id: entry.id, shortId: shortIdOf(entry),
    before: before.desc, after: entry.desc, changed: actual,
  });

  return {
    id: entry.id,
    shortId: shortIdOf(entry),
    // 改前/改后都给 —— 模型要能一眼确认"确实改成了我要的"，而不是自己复述一遍。
    before: before.desc,
    after: entry.desc,
    tags: entry.tags,
    localNote: entry.localNote,
    changed: actual,
    note: [
      actual.includes('desc')
        ? `改好了：「${before.desc || '(无描述)'}」→「${entry.desc}」。`
        : `改好了：${actual.join('、')} 变了。`,
      actual.includes('desc')
        ? (qqSynced
          ? '描述已写回 QQ 收藏表情。'
          : '这条没有 QQ 收藏 id，描述只改了本地索引。')
        : '',
      `发它还是 \`{ "sticker": "${shortIdOf(entry)}" }\`。`,
    ].filter(Boolean).join(''),
  };
}
