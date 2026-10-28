// 改**本号在当前群的群名片**（OneBot `set_group_card`）。
//
// ══ 只能改自己的（与 recall.js 的"只撤自己的"是同一条边界）
//
// `set_group_card` 收 `{ group_id, user_id, card }` —— `user_id` 想填谁就填谁，
// 而**改别人的名片是群管理行为**，本桥接刻意不提供（见 api/server.js 头部：
// 工具面只暴露聊天所需的安全子集）。所以这里：
//
//   · `user_id` **一律强制成本号**，不接受任何指定；
//   · 本号拿不到（`store.selfQq` 为空）→ **拒绝**（fail-closed）。
//     宁可不做，也不能做错人 —— 与 recall.js 同一个理由；
//   · `args` 里被塞了 `user_id` / `qq` 之类想指定别人的字段 → **忽略，
//     但记一条 warn**。静默忽略是最坏的一种：调用方会以为"按我说的改了"。
//
// ══ 空字符串是**合法值**（这个坑必须写清）
//
// `card: ''` = **清空名片**，QQ/SnowLuma 都支持（SnowLuma 的动作摘要就写着
// "空字符串清除"，schema 是 `card: f.string().default('')`）。所以：
//
//   · 这里判的是 `typeof args.card !== 'string'` —— **绝不能写 `!args.card`**，
//     那会把"清空"当成"没传"，变成一个"想清空却改不了"的假故障；
//   · `onebot/http.js` 的包装同理，只把 `undefined` / `null` 当缺失。
//
// ══ 私聊里没有名片
//
// 私聊会话调它 → 直接报错说清为什么，而不是拿着 `group_id = NaN` 去发一个
// 必然失败的动作（那样模型只会看到 OneBot 的 retcode，猜不出原因）。
//
// ══ 不回读改前/改后
//
// 想报"改前是什么"就得再调一次 `get_group_member_info`：
//   · 多一次动作就多一个失败点 —— 查询失败时我们会报"改名片失败"，而实际改成功了；
//   · 回读到的名片同样可能还是旧值（刷新有延迟），拿它当"已生效"就是编造；
//   · 名片改成什么，调用方本来就知道（就是它自己传的 `card`）。
//
// @param args.card 新名片（必填；**空字符串表示清空**）
export const op = 'setGroupCard';
export const needsAllow = true;
export const logsAsSend = true;

import { charCount } from '../../../util/format.js';

// 名片长度上限（字符数，按码点）。
//
// ⚠️ 同 setNickname.js：**不是** QQ 的规则（QQ 那边另有限制，超了由它拒、
//    retcode 会被抛出来）。40 取得比任何真实名片都长得多，只为挡住
//    "整段话当名片"的调用 —— 不替 QQ 做校验收。
const MAX_CARD_CHARS = 40;

// 这些字段**一个都不看**，只看它们**在不在**，用来记 warn。
//
// 名字故意列全一点：调用方（模型）可能按别的实现猜字段名 —— 猜了就该被
// 明确告知"这个字段没用"，而不是默默忽略。
const TARGET_FIELD_ALIASES = ['user_id', 'userId', 'qq', 'uin', 'target', 'targetQq', 'target_qq'];

// 按**码点**数长度（emoji 是代理对，`'😀'.length` 是 2 而不是 1）——
// 实现见 `util/format.js` 的 `charCount`（setNickname 用的是同一个）。

export async function run({ poolFor, http, logger }, convKey, args) {
  if (!convKey.startsWith('group:')) {
    throw new Error(
      '群名片只在**群**里存在 —— 当前是私聊会话，改不了名片。'
      + '（私聊里能改的是账号昵称，那是 `qq_set_nickname`；同样只在管理者明确要求时做。）',
    );
  }
  const groupId = convKey.slice(6);

  // ⚠️ 判**类型**，不判假值 —— `''` 是合法的"清空"，见文件头的说明。
  if (typeof args?.card !== 'string') {
    throw new Error("要改成什么？传 `card`（字符串）。**清空名片就传空字符串 `''`** —— 空串不是「没传」。");
  }
  if (charCount(args.card) > MAX_CARD_CHARS) {
    throw new Error(
      `\`card\` 太长了（${charCount(args.card)} 个字符 > 上限 ${MAX_CARD_CHARS}）——`
      + '这不像一个名片，像一整段话。',
    );
  }

  // ⚠️ 只改自己：本号拿不到就**不做**。
  //
  // 这里**不能**退回"那就用 args 里的 user_id 吧" —— 那正是要挡的那条路。
  // 与 recall.js 的 `selfQq === ''` 分支同一个取舍：宁可拒，不能做错人。
  const selfQq = String(poolFor(convKey).selfQq ?? '');
  if (selfQq === '') {
    throw new Error('不知道本号（selfQq 为空），无法确定该改**谁**的名片 —— 拒绝（不能改别人）。');
  }

  // 想指定别人？忽略，但**说出来** —— 静默忽略会让调用方以为改的是别人。
  const ignored = TARGET_FIELD_ALIASES.filter((k) => args[k] !== undefined && args[k] !== null);
  if (ignored.length) {
    logger.warn('改群名片：args 里带了指定「改谁」的字段，已忽略（只改本号）', {
      conv: convKey,
      fields: ignored.map((k) => `${k}=${String(args[k]).slice(0, 40)}`).join(', '),
      selfQq,
    });
  }

  // 参数名以 SnowLuma 的动作为准：`{ group_id, user_id, card }`（见 onebot/http.js 的包装）。
  await http.setGroupCard(groupId, selfQq, args.card);

  const cleared = args.card === '';
  // 同 setNickname：日志写"已要求改"，不写"已生效" —— 回读到的值不足以证明生效。
  logger.info('已要求改本号群名片', {
    conv: convKey,
    groupId,
    qq: selfQq,
    card: cleared ? '(清空)' : args.card,
    ...(ignored.length ? { ignoredFields: ignored.join(', ') } : {}),
  });

  return {
    groupId,
    // 改的是谁 —— 恒为本号（调用方可以拿它核对）。
    qq: selfQq,
    // 要求改成的名片（`''` = 清空）。
    card: args.card,
    cardCleared: cleared,
    // 被忽略的"指定别人"字段；有值就说明这次调用者想改别人。
    ...(ignored.length ? { ignoredTargetFields: ignored } : {}),
    note: (cleared
      ? '已要求**清空**你在本群的名片 —— 群里接下来显示的会是你的账号昵称。'
      : `已要求把你在本群的名片改成「${args.card}」。`)
      + '名片**群里所有人都看得到**；QQ 那边生效可能有一点延迟，别为确认反复重试。'
      + (ignored.length ? `（args 里的 ${ignored.join('、')} 被忽略了 —— 这个工具只改本号。）` : ''),
  };
}
