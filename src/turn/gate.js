// 触发判定与闸门 

import { mentionsId } from '../chatlog/segments.js';

// 触发原因。
export const REASONS = Object.freeze({
  PRIVATE: 'private',       // 私聊（视为直接找它）
  AT: 'atMention',          // 被 @
});

// 是不是在叫它。**只认 @**（私聊除外）。
//
// ── 引用为什么不算了
//
// 曾经有 `REASONS.QUOTE`（引用了它也算叫它），现已**整条删掉**。
// 理由不是"引用不重要"，是它**太吵**：
//   · 群里互相引用是常态（拿别人的话出来说事）；
//   · 一旦算触发，它就对满群引用的消息都有反应 —— 等于没有闸门。
// @ 才是明确的"我在跟你说话"。
//
// ⚠️ 这条只管**投递 / 叫醒**。`qq_wait` 判"等的人到了没"走 `mentionsSelf`，
//    那是**另一个判断**，目前仍认引用 —— 要改那边得单独改，别以为这里能带上。
//
// @param kind    'group' | 'private'
// @param quote   `{ atSelf, selfQq }`
//                  · `atSelf` —— 这条有没有 @ 它（由 segments 判定，见 segments.js）
//                  · `selfQq` —— 本号（引用判定删掉后已不参与，保留只为调用点形状稳定）
// @returns reason 或 null
export function detectTrigger(event, kind, quote) {
  // 私聊 = 直接找它，无需 @。
  if (kind === 'private') return REASONS.PRIVATE;

  if (quote?.atSelf) return REASONS.AT;

  return null;
}

// 闸门：这条消息的发送者，是否被 `who` 允许。
//
// @param who     'owner' | 'everyone'
// @param senderQq 发送者 QQ
// @param ownerQq  主人的 QQ
export function gateAllows(who, senderQq, ownerQq) {
  if (who === 'everyone') return true;
  const qq = String(senderQq ?? '');
  return qq !== '' && qq === String(ownerQq ?? '');
}

// 规范化闸门取值（只认 owner / everyone，其余一律退回 owner —— fail-closed）。
//
// 为什么不退回 everyone：配置写错时"谁都能叫醒它"是更危险的失败方向。
export function normalizeWho(value) {
  return value === 'everyone' ? 'everyone' : 'owner';
}

// 人类可读的触发文案（用于提示词的【触发】小节）。
export function triggerLabel(reason, isOwner) {
  switch (reason) {
    case REASONS.PRIVATE:
      return isOwner ? '主人私聊你' : '有人私聊你';
    case REASONS.AT:
      return isOwner ? '主人 @ 了你' : '有人 @ 了你';
    default:
      return '未知触发';
  }
}

// 等待判定：回应期里，`qq_wait` 该不该立刻返回。
//
// ── 为什么要求 @（这是实测定的）
//
// `qq_wait` 是它**主动**说"我在等人叫我" —— 意图比普通收消息强得多。
// 所以判据也更严：**必须 @ 它**（或引用它）。
//
// 早先只看"谁说的话"（不要求 @），结果是主人随口一句就被当成"等到了"，
// 它就从等待里被拽出来 —— 而那句可能根本不是在对它说。
//
// 注意这和"投递"是**两个独立判断**：
//   投递    这条消息要不要给它看（睡眠要 @，醒着也要 @）
//   qq_wait 算不算"等到人了"（一律要 @）
//
// @param options.who        window.who
// @param options.ownerQq
// @param options.messages   等待期间到达的消息（按时间升序）
// @param options.sinceTs    从什么时候开始等（毫秒）；只看这之后到达的
// @param options.qq        **免 @ 名单**（QQ 数组 / Set）；名单里的人说话就算，不用 @
// @returns `{ arrived, from, messages, fresh, skipped*, timeout }`
//   - `arrived`  有人满足了本次规则 → 立刻返回
//   - `messages` 判定为"等到"的那几条（内部用）
//   - `fresh`    **等待期间全部消息**（不受 `qq` 影响）
//   - `skippedNoMention`  三条判据一条都不满足（不在免 @ 名单 / `windowWho`
//                        不放行 / 没 @ 它）
//   - `timeout`  到点仍没人（**不是错误**，可以收尾）
export function evaluateWait({
  who,
  ownerQq,
  messages = [],
  sinceTs = 0,
  timeoutMs = 0,
  // *免 @ 名单**（QQ 号数组 / Set）。
  //
  // 名单里的人说话就算等到 —— **不用 @，也不受 `who`（`windowWho`）约束**。
  // 空 = 不限人（那就只有"过 `who` 且 @ 了它"才算）。
  qq = [],
  selfQq = '',
  now = Date.now(),
}) {
  // ⚠️ 用 **`>=`**，不是 `>` —— 这是"等不到刚叫它的那句话"的另一半修复。
  //
  // `sinceTs` 和 `m.tsMs` 虽然都是毫秒，但**精度不同**：
  //   · `m.tsMs` 来自 QQ 事件的 `time`（**整秒**，被截断）
  //
  // 于是"等待开始后同一秒内到达的那条"会出现 `m.tsMs === sinceTs`。
  // 用 `>` 会把它当成"开始之前的"丢掉 —— 实测 `diff=0` 时
  // `arrived` 恒为 false，而 `diff=1000` 时为 true。
  //
  // ⚠️ 放宽到 `>=` 的代价：可能把"开始那一秒里更早的一条"也算进来。
  //    但那还要再过 `windowWho` 闸门 + @/引用判定（见下），
  //    不会被当成"等到了" —— 而**漏掉真正叫它的那句**才是更糟的错。
  const fresh = messages.filter((m) => (m.tsMs ?? 0) >= sinceTs);

  const allowed = [];
  let skippedNoMention = 0;

  // *免 @ 名单**（来自工具参数 `qq`）。
  //
  // ⚠️ 归一化必须在这里做，不能靠调用方：工具参数可能是数字 QQ、字符串 QQ、
  //    甚至 `["10001"]` 与 `[10001]` 混着来。统一 `String()` 后再比。
  const wanted = new Set(
    (Array.isArray(qq) ? qq : [qq]).map((v) => String(v ?? '').trim()).filter(Boolean),
  );

  // ⚠️ **这些参数只管"什么时候返回"，不管"给它看什么"。**
  //
  // `qq` 是**触发器**：决定"什么算等到"。
  // 它**不筛 `fresh`**、也不影响 `newMessages` —— 那批消息照旧全部交给它，
  // 否则它一开口就不知道群里刚在聊什么（那正是原设计要避免的）。
  //
  // 判据本身**只有一份**，在 `waitHit` 里（里面含 `windowWho`）——
  // 这个函数不要再写一遍，两套判据一漂就是"池里明明有、却要等满超时"。

  for (const m of fresh) {
    // ⚠️ 只读 `sender.qq` —— 早先这里写了 `m.sender?.qq ?? m.userQq` 兜底，
    //    而**落库的记录里从来没有 `userQq`**（字段是
    //    `no / messageId / tsMs / sender / segments / readCount`）。
    //
    //    那个兜底是死的，而且**有害**：万一哪天真的读到了空串，
    //    它会静默 fallback 而不是暴露"字段读错了" —— 本项目最高频的
    //    bug 形态就是"两边字段名不一致"，兜底会把那种错盖住。
    //
    // ── 判定**只走 `waitHit`**（唯一实现）
    //
    // 早先这里是 `gateAllows(...) || waitHit(...)` 的并联，两边各判一半 ——
    // 那种写法下 `windowWho` 实际上只管了"不 @ 的人"，而"@ 永远算"，
    // 于是"**谁能 @ 进 wait**"这件事根本没有配置项在管。
    // 现在 `waitHit` 内含 `windowWho`（只在"要 @"那条上用），
    // *这里不要再并联 `gateAllows`** —— 否则第 ① 条的免 @ 名单就没意义了。
    if (!waitHit(m, { selfQq, who, ownerQq, qq: wanted })) {
      skippedNoMention += 1;
      continue;
    }
    allowed.push(m);
  }

  // 闸门里最先说话的那条 —— 提示词要告诉它"谁先开的口"。
  const from = allowed.length ? allowed[0] : null;

  return {
    arrived: allowed.length > 0,
    from,
    // 该等的人说的全部内容（判定用，可能多条）
    messages: allowed,
    // 等待期间**全部**新消息（含被闸门挡掉的别人）。
    //
    // 为什么要单独给这份：闸门决定"谁能让它被叫醒"，**不该决定
    // "它能看到什么"**。实测踩过：主人等它 20 秒，期间群里聊了 6 句
    // （华为、苹果、红包…），它却只看到主人那一句 ——
    // 因为它开口时完全不知道群里刚在聊什么。
    //
    // 给别人也看，它才知道"要不要接这个话茬"。
    fresh,
    skippedNoMention,
    timeout: allowed.length === 0 && timeoutMs > 0 && (now - sinceTs) >= timeoutMs,
  };
}

// 这条消息有没有 @ 它或引用它。
//
// 两种都算"在叫它" —— 引用在语义上就是"我在回应你那句"。
//
// ⚠️ 新结构下判据全部来自 **segments + selfQq**，不再依赖任何
//    入库时算好的标记（`atSelf` / `quote.self` 都已被删 ——
//    前者实测落盘 0 条，后者靠的 `isSelf` 也落盘 0 条）。
export function mentionsSelf(m, selfQq) {
  const want = String(selfQq ?? m?.selfQq ?? '');
  if (want === '') return false;

  if (mentionsId(m, want)) return true;

  // 引用**本号发的**消息也算"在叫它"。
  //
  // ⚠️ 早先写成"quote 带 id 就算" —— 那是错的，跟 `detectTrigger`
  // 当初犯的是同一个错：群友引用群友也会被当成"在叫你"。
  // 判据必须是被引用那条的**发送者**是本号。
  if (String(m?.quote?.data?.sender?.qq ?? '') === want) return true;
  return false;
}

// 触发
export function waitHit(m, {
  selfQq = '',
  who = 'everyone',
  ownerQq = '',
  qq = [],
} = {}) {
  const sender = String(m?.sender?.qq ?? '');

  if (sender !== '') {
    if (qq && typeof qq.has === 'function') {
      if (qq.has(sender)) return true;
    } else if (Array.isArray(qq) && qq.includes(sender)) {
      return true;
    }
  }

  return gateAllows(who, sender, ownerQq) && mentionsSelf(m, selfQq);
}
