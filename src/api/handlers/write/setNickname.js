// 改**本号账号昵称**（OneBot `set_qq_profile` 的 `nickname`）。
//
// ══ 这是**全局改名**，不是"群里显示的名字"
//
// 改完之后**所有群、所有好友**看到的都是新名字 —— 它改的是账号资料，
// 不是某个群的群名片（群名片走 `setGroupCard`）。所以：
//
//   · 只在**管理者明确要求**时做（`plugins/qq-dsh-tools` 的工具描述与
//     `prompts/4-qq-tools.md` 里写的是同一条）；
//   · 群友随口一句"你改个名"**不算要求** —— 那不是管理者的意思。
//
// ══ 为什么与 recall.js 同口径（needsAllow + logsAsSend）
//
//   · `needsAllow` —— 它写的是**账号**，影响面比发一条消息大得多。
//     白名单外的会话连话都发不出去，就更不该能改名字（fail-closed）。
//   · `logsAsSend` —— 这个动作**没有可核对的返回值**（见下：不回读），
//     所以日志是事后**唯一**的凭据："谁、什么时候、把名字从什么改成了什么"。
//
// ══ 为什么不回读一次确认（别把"请求发出去了"说成"已确认生效"）
//
// `get_login_info` 报的是 SnowLuma 手上那份账号资料。改完**立刻**再读，
// 很可能还是旧值（客户端/服务端刷新有延迟）。拿它当"已生效"的证据就是
// 编造；拿它当"没生效"又会诱发模型反复重试。所以这里只回读**改前**一次，
// 如实报"要求改成什么 + 原本读到的是什么"。
//
// @param args.nickname 新昵称（必填，非空字符串）
export const op = 'setNickname';
export const needsAllow = true;
export const logsAsSend = true;

import { charCount } from '../../../util/format.js';

// 昵称长度上限（**字符数**，按码点算）。
//
// ⚠️ **这不是 QQ 的规则**，40 也不是从哪儿查到的数 —— QQ 那边另有限制，
//    且随客户端/版本变；超了由 QQ 拒，`call` 会把 retcode 抛出来。
//    这道闸门只干一件事：挡住"把一整段话当昵称传进来"的调用。
//    所以它**故意取得比任何真实昵称都长得多** —— 宁可让 QQ 去拒，
//    也不要我们自己把一条合法改名挡掉（那才是假故障）。
const MAX_NICKNAME_CHARS = 40;

// 按**码点**数长度 —— emoji 是代理对，`'😀'.length` 是 2，但那是**一个**字符。
// 实现见 `util/format.js`（setGroupCard 用的是同一个）。

export async function run({ http, logger }, convKey, args) {
  const nickname = args?.nickname;

  // ⚠️ 这里判的是**类型**，不是假值 —— 昵称只有字符串一种合法形状，
  //    `0` / `false` / `null` 传进来要和"没传"报同一个错，
  //    不能各自溜进别的分支。
  if (typeof nickname !== 'string') {
    throw new Error('要给新昵称：传 `nickname`（字符串）。');
  }
  if (nickname.trim() === '') {
    throw new Error('`nickname` 不能是空的 —— 昵称没有"取消"这种操作，要换就直接给新名字。');
  }
  if (charCount(nickname) > MAX_NICKNAME_CHARS) {
    throw new Error(
      `\`nickname\` 太长了（${charCount(nickname)} 个字符 > 上限 ${MAX_NICKNAME_CHARS}）——`
      + '这不像一个昵称，像一整段话。',
    );
  }

  // 改前读到什么就报什么。
  //
  // ⚠️ 读不到（SnowLuma 抽风/超时）**不能让改名失败** —— 改名本身还有救，
  //    但必须如实说"没读到"，别编一个旧名字出来。取不到记为 `null`，
  //    与"读到了，是空字符串"区分开。
  let before = null;
  try {
    const info = await http.getLoginInfo();
    before = typeof info?.nickname === 'string' ? info.nickname : '';
  } catch (error) {
    logger.warn('改名前读账号资料失败（照常改名，只是报不出改前值）', {
      conv: convKey,
      error: String(error),
    });
  }

  // 字段名以 SnowLuma 的动作为准：`set_qq_profile` 收 `{ nickname, … }`。
  await http.setNickname(nickname);

  // ⚠️ 日志写"已要求改"，不写"已生效" —— 我们只确认动作被 SnowLuma 收下了。
  logger.info('已要求改本号账号昵称（全局改名）', {
    conv: convKey,
    before: before === null ? '(未取到)' : before,
    after: nickname,
  });

  const same = before !== null && before === nickname;
  const beforeText = before === null
    ? '改前的昵称没读到'
    : `改前是${before === '' ? '（空）' : `「${before}」`}`;

  return {
    // 改前的昵称。
    // ⚠️ 取不到时是 `null`，**不是**空字符串 —— 空串是一个事实（"本来就没昵称"），
    //    null 是"不知道"。两者混在一个值里，调用方就没法区分。
    before,
    // 要求改成的新昵称 —— 这是我们**发出去的**，不是回读确认过的。
    after: nickname,
    // 名字本来就是这个：这次等于没改，直说，免得模型以为"改了但看不出来"。
    ...(same ? { unchanged: true } : {}),
    note: [
      `已要求把**账号昵称**改成「${nickname}」（${beforeText}）。`,
      '这是**全局**改名 —— 所有群、所有好友看到的名字都会变。',
      'QQ 那边生效可能有一点延迟；**别为了确认反复重试**，重试不会让它更快。',
      ...(same ? ['注意：这个名字本来就是这个 —— 这次等于没改。'] : []),
    ].join(''),
  };
}
