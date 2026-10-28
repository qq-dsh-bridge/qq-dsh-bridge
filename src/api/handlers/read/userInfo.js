// 某个 QQ 的资料 —— 不限于本群成员。
//
// 与旧 `memberInfo` 的差别：那个只会答"这个群里的人"，一问到群外人
// （"你认识 12345 吗"）就只能报错。现在一次查清三件事：
//
//   inGroup   这个号在不在当前群（私聊会话里没有这个概念，字段不返回）
//   member    在群里的那份资料（名片/角色/头衔/等级/入群时间/最后发言/禁言）
//   basic     账号本身的资料（昵称/性别/年龄/QQ 等级/号龄/签名/连续登录）
//   avatar    头像地址（小图 100、大图 640）
//
// ══ 只给"有信息量"的字段
//
// SnowLuma 的 `get_group_member_info` 返回 20+ 字段，其中 `area` / `unfriendly` /
// `title_expire_time` / `qidian_*` 恒空或恒默认（它自己的 schema 注明 QQ NT 不提供）。
// 给出来就是假数据 —— 模型会以为"查到了什么"。所以这里**判空即省略**。
//
// ══ 刻意**不给** `is_robot`
//
// OneBot 那个字段标的是"QQ 官方登记的机器人账号"，而现实里很多人拿自己的号跑 bot
// —— 那些账号是 false。字段名叫 isRobot 会让人读成"它是不是机器人"，证不了还误导。
//
// ══ include：只要一部分
//
// `include: ['basic']` 只回基础资料，`['member','avatar']` 只要群内身份和头像。
// 不传 = 三组全要。组内字段仍然判空，不会为了凑数返回空串。
export const op = 'userInfo';
export const logsAsSend = true;

import { dateTimeOf, normalizeGroupRole } from '../../../chatlog/store.js';

const GROUPS = ['basic', 'member', 'avatar'];

/** 选中的字段组；非法值忽略，全非法或没传 = 全要。 */
function wanted(args) {
  const raw = Array.isArray(args?.include) ? args.include : [];
  const picked = raw.map((s) => String(s).toLowerCase().trim()).filter((s) => GROUPS.includes(s));
  return new Set(picked.length > 0 ? picked : GROUPS);
}

/**
 * 这个返回是不是"真成员"。
 *
 * ══ 协议端行为（SnowLuma 1.14.22 实测）
 *
 * 对**不在群里**的号，`get_group_member_info` 不报错，而是回一个空壳：
 *
 *   { group_id, user_id, nickname: "", card: "", sex: "unknown", age: 0,
 *     join_time: 0, last_sent_time: 0, shut_up_timestamp: 0, level: "0",
 *     role: "member", title: "" }
 *
 * 也就是说 `role: "member"` 和 `level: "0"` 在"真成员"和"根本没这个人"两种情况下
 * 长得一样 —— 只看对象存在就会把群外人判成群成员（就是这么误报的）。
 *
 * 真正的证据是这几项里任意一个非零/非空：
 *   入群时间、最后发言、群等级、名片、头衔、昵称、owner/admin 角色
 *
 * `role: "member"` 单独**不能**当证据。
 */
function isRealMember(info) {
  if (!info || typeof info !== 'object') return false;
  const role = String(info.role ?? '').trim().toLowerCase();
  if (role === 'owner' || role === 'admin') return true;
  const positive = (v) => Number(v) > 0;
  return positive(info.join_time)
    || positive(info.last_sent_time)
    || positive(info.level)
    || Boolean(String(info.card ?? '').trim())
    || Boolean(String(info.title ?? '').trim())
    || Boolean(String(info.nickname ?? '').trim());
}

/** 头像地址：qlogo 直链，两个尺寸都常用（群里贴图 vs 判断"换了头像没"）。 */
function avatarOf(qq) {
  return {
    small: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`,
    large: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`,
  };
}

export async function run({ http }, convKey, args) {
  const qq = String(args?.qq ?? '').trim();
  if (!/^\d{5,12}$/.test(qq)) throw new Error(`qq 参数应是 5-12 位数字，收到 "${qq}"`);
  const groupId = convKey.startsWith('group:') ? convKey.slice(6) : '';
  const want = wanted(args);

  // 群成员资料：不在群里时协议端一般直接报错，那正是 inGroup=false 的信号。
  let member = null;
  if (groupId) {
    try {
      const info = await http.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(qq),
      });
      if (isRealMember(info)) member = info;
    } catch {
      member = null;
    }
  }

  // 账号资料：协议端不一定实现 get_stranger_info，失败就只回群内那部分。
  let stranger = null;
  let strangerFailed = false;
  try {
    stranger = await http.call('get_stranger_info', { user_id: Number(qq) });
  } catch {
    strangerFailed = true;
  }

  const at = (sec) => (Number(sec) > 0 ? dateTimeOf(Number(sec) * 1000) : '');
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const text = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
    return '';
  };

  const out = { qq };
  // 私聊里没有"在不在群"这个概念，字段直接不给，而不是给个 false。
  if (groupId) out.inGroup = Boolean(member);

  if (want.has('basic')) {
    const nickname = text(member?.nickname, stranger?.nickname);
    if (nickname) out.nickname = nickname;

    // unknown 不是信息，是"没填"——所以取值时就要跳过它，
    // 不能让成员资料里的 unknown 挡住账号资料里的 female。
    const sex = [member?.sex, stranger?.sex]
      .map((v) => String(v ?? '').trim().toLowerCase())
      .find((v) => v && v !== 'unknown');
    if (sex) out.sex = sex;

    const age = num(stranger?.age, member?.age);
    if (age) out.age = age;

    const qqLevel = num(stranger?.qq_level, member?.qq_level);
    if (qqLevel) out.qqLevel = qqLevel;

    // 号龄（年）—— 和 QQ 等级一起看才知道"是老号还是新号"。
    const qage = num(stranger?.qage, member?.qage);
    if (qage) out.qage = qage;

    const signature = text(stranger?.sign, stranger?.long_nick, stranger?.longNick);
    if (signature) out.signature = signature;

    const loginDays = num(stranger?.login_days, stranger?.loginDays);
    if (loginDays) out.loginDays = loginDays;
  }

  if (want.has('member') && groupId) {
    out.groupId = groupId;
    if (member) {
      const shutUntil = Number(member.shut_up_timestamp ?? 0);
      const m = {
        // owner=群主 → 归一成与消息记录同口径的 groupRole。
        groupRole: normalizeGroupRole(member.role),
      };
      // 群名片（群里显示的名字）。为空时 nickname 才是实际显示名。
      const card = String(member.card ?? '').trim();
      if (card) m.card = card;
      const title = String(member.title ?? '').trim();
      if (title) m.title = title;
      const level = String(member.level ?? '').trim();
      if (level && level !== '0') m.level = level;
      const joinTime = at(member.join_time);
      if (joinTime) m.joinTime = joinTime;
      // 最后发言时间 —— 判断"这人还活跃吗"。
      const lastSentTime = at(member.last_sent_time);
      if (lastSentTime) m.lastSentTime = lastSentTime;
      // 被禁言到什么时候；没禁言时这个字段不出现（不是 1970）。
      if (shutUntil > Date.now() / 1000) m.mutedUntil = dateTimeOf(shutUntil * 1000);
      out.member = m;
    }
  }

  if (want.has('avatar')) out.avatar = avatarOf(qq);

  // note 只解释"为什么缺"，不重复字段里已有的信息。
  const notes = [];
  if (groupId && !member) notes.push('这个号不在当前群（只有账号资料）');
  if (strangerFailed) notes.push('没取到账号资料（协议端可能不支持 get_stranger_info）');
  if (notes.length > 0) out.note = notes.join('；');

  return out;
}
