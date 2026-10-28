// 群信息。
//
// ⚠️ **字段名全部用 OneBot 原始语义**（`group_name` → `name`、
//    `member_count` → `count`…），但**时间戳转成可读**（见 `dateOf`）。
//    给 unix 秒模型还得自己算，而它在别处看到的都是可读时间。
export const op = 'groupInfo';
export const logsAsSend = true;

import { dateOf } from '../../../chatlog/store.js';

export async function run({ http }, convKey, args) {
  if (!convKey.startsWith('group:')) throw new Error('私聊会话没有群信息');
  const info = await http.call('get_group_info', { group_id: Number(convKey.slice(6)) });
  return {
    groupId: convKey.slice(6),
    name: info?.group_name ?? '',
    // 群备注 —— **只有本号能看到**的名字（自己给它起的）。
    // 和 `name` 可能不同；AI 说话时用哪个会影响观感。
    remark: info?.group_remark ?? '',
    count: Number(info?.member_count ?? 0),
    // 人数上限 —— 能算出还能进多少人（群里偶尔会聊到）。
    maxCount: Number(info?.max_member_count ?? 0),
    level: Number(info?.group_level ?? 0),
    createdAt: info?.group_create_time ? dateOf(info.group_create_time * 1000) : '',
    memo: info?.group_memo ?? '',
    description: info?.group_description ?? '',
    // 群头像：p.qlogo.cn 的 gh 路径，gid 出现两次（第二个是尺寸目录的父级）。
    avatar: {
      small: `https://p.qlogo.cn/gh/${convKey.slice(6)}/${convKey.slice(6)}/100`,
      large: `https://p.qlogo.cn/gh/${convKey.slice(6)}/${convKey.slice(6)}/640`,
    },
    // 全员禁言中（0 = 没禁）。
    // ⚠️ 禁言时它**发得出去但没人能回**，值得知道。
    allMuted: Number(info?.group_all_shut ?? 0) !== 0,
  };
}
