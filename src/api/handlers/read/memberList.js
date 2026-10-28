// 群成员列表 —— **筛选型**，不是"全列出来"。
//
// ══ 为什么必须筛（这是设计前提，不是可选优化）
//
// 那个群 **上千人**。OneBot 的 `get_group_member_list` **不支持任何筛选**
// （参数只有 `group_id` / `no_cache`），**一次性把全部成员给出来**。
//
// 上千条 × 每条约 200 字节 ≈ **334 KB** —— 远超任何合理的工具返回。
// 所以筛选只能在**我们这边**做，参数也只能是"筛什么"。
//
// ══ 返回里必须带 `total`
//
// 不给的话模型**看不见被筛掉的那些人**，会以为"群里只有 30 个人"。
// 这类"把局部当全部"的误判比返回空数组更难发现。
//
// ══ 取不到时必须报错，不能返回空
//
// SnowLuma 那条路径在缓存为空时会**抛错**。而"返回空数组"会让模型
// 以为"群里没人" —— 那是**假事实**，比一句"拿不到"糟得多。
//
// @param args.role     只看这个群内身份：groupOwner / admin / member
// @param args.name     名字包含该子串（**名片与昵称都搜**，大小写不敏感）
// @param args.hasTitle 只要头衔非空的
// @param args.sort     'active'（默认，最近发言）/ 'joinTime' / 'level'
// @param args.limit    最多几条（默认 30，上限 100）
export const op = 'memberList';
export const logsAsSend = true;

import { dateOf, dateTimeOf, normalizeGroupRole } from '../../../chatlog/store.js';

export async function run({ http }, convKey, args) {
  if (!convKey.startsWith('group:')) throw new Error('私聊会话没有成员列表');
  const groupId = Number(convKey.slice(6));

  let all;
  try {
    all = await http.call('get_group_member_list', { group_id: groupId });
  } catch (error) {
    throw new Error(
      `拿不到群成员列表（${error?.message ?? error}）。`
      + '这通常是腾讯那边还没缓存好 —— 过一会儿再试，或先用 qq_user_info 查具体某个人。',
    );
  }
  if (!Array.isArray(all)) throw new Error('群成员列表返回了非数组，无法处理。');

  const wantRole = String(args?.role ?? '').trim();
  const wantName = String(args?.name ?? '').trim().toLowerCase();
  const wantTitle = args?.hasTitle === true;

  const norm = (m) => ({
    qq: String(m?.user_id ?? ''),
    card: m?.card ?? '',
    nickname: m?.nickname ?? '',
    groupRole: normalizeGroupRole(m?.role),
    title: m?.title ?? '',
    level: String(m?.level ?? ''),
    joinTime: Number(m?.join_time) > 0 ? dateOf(Number(m.join_time) * 1000) : '',
    lastSentTime: Number(m?.last_sent_time) > 0 ? dateTimeOf(Number(m.last_sent_time) * 1000) : '',
    // 排序用的原始值，返回前会剥掉。
    _joinRaw: Number(m?.join_time ?? 0),
    _sentRaw: Number(m?.last_sent_time ?? 0),
    _levelRaw: Number(m?.level ?? 0) || 0,
  });

  let rows = all.map(norm);

  if (wantRole) rows = rows.filter((r) => r.groupRole === wantRole);
  if (wantTitle) rows = rows.filter((r) => r.title !== '');
  if (wantName) {
    // 名片和昵称**都搜** —— 群里显示的是名片，但很多人名片是空的。
    rows = rows.filter((r) => r.card.toLowerCase().includes(wantName)
      || r.nickname.toLowerCase().includes(wantName));
  }

  // 排序在**我们这边**做 —— 接口不排。
  //
  // 上千条的排序开销可忽略，而"排在前面的就是模型能看到的全部"
  // （limit 会截断），所以这一步**直接决定它看到谁**。
  const sort = String(args?.sort ?? 'active');
  if (sort === 'joinTime') rows.sort((a, b) => b._joinRaw - a._joinRaw);
  else if (sort === 'level') rows.sort((a, b) => b._levelRaw - a._levelRaw);
  // active（默认）：最近发言在前。从没发过言的（0）自然落到最后。
  else rows.sort((a, b) => b._sentRaw - a._sentRaw);

  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 30));
  const shown = rows.slice(0, limit);

  return {
    // 群里**总共**多少人 —— 不给的话模型会把"筛出来的"当成全部。
    total: all.length,
    // 筛选后命中几条。
    matched: rows.length,
    // 实际给了几条（limit 截断后）。
    shown: shown.length,
    note: rows.length > shown.length
      ? `还有 ${rows.length - shown.length} 条没列出（limit=${limit}）—— 用 name/role 缩窄条件，或加大 limit（上限 100）。`
      : undefined,
    members: shown.map(({ _joinRaw, _sentRaw, _levelRaw, ...keep }) => keep),
  };
}
