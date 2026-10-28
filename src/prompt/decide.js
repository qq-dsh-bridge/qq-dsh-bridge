// 决策层：判"这一轮她要不要开口"
//
// 两个决策点**共用一份输入快照**（`inputs`）与**同一份日志写法**（`note`）：
//   · 唤醒点 `wake`       —— 被 @ 叫醒时，要不要真的投递
//   · 等待返回点 `waitReturn` —— 这批消息值不值得打断 `qq_wait`
//
// 两处口径必须一致：同一个群、同一批消息，在"叫醒"和"结算"两步判出不同结果，
// 表现出来就是"明明 @ 了却没回"或者"回来了却没内容"。
//
// 模式（`judge.modeFor(convKey)` —— `decide.mode` 可以按会话覆盖）：
//   off      → 直接放行（`enabledFor(conv)` 为假，两个入口都不判）
//   shadow   → **不等它**：投递/返回照旧，判完只记日志
//   enforce  → **等它**：`wake` 判 `ignore` 就不投递；`waitReturn` 判 `keep` 就继续挂着
//
// 判不出来（超时 / 出错 / 没 key）一律**放行** —— 宁可多回一句，不可漏一条消息。

import { dateOf, seqOf } from '../chatlog/store.js';
import { mentionsId, segmentsToText } from '../chatlog/segments.js';

export function createDecider({ judge = null, decideLog = null, logger = null } = {}) {
  // 输入快照 —— 唤醒点与 wait 返回点共用。
  //
  // @param p.conv 会话键。**必须传**：`decide.*` 与角色卡都可以按会话覆盖
  //               （见 config/sessions.js 的白名单），渲染"她自己说过的话"时
  //               要用**这个会话**那张卡上的人名，不是全局那个。
  function inputs({ pool, selfQq, message, exempt = false, conv = '' }) {
    const list = typeof pool?.messages === 'function' ? pool.messages() : [];
    const self = String(selfQq ?? '');
    const now = Date.now();
    const isSelf = (m) => String(m?.sender?.qq ?? '') === self;
    const selfName = (typeof judge?.roleNameFor === 'function'
      ? judge.roleNameFor(conv)
      : judge?.roleName) || '她';
    const recent = list.slice(-12).map((m) => ({
      who: isSelf(m) ? selfName : String(m?.sender?.name ?? m?.sender?.qq ?? ''),
      text: segmentsToText(m).slice(0, 80),
      secsAgo: Math.max(0, Math.round((now - (Number(m?.tsMs) || now)) / 1000)),
      self: isSelf(m),
    }));
    const lastSelf = [...list].reverse().find(isSelf);
    const today = dateOf(now);
    const todayCount = list.filter((m) => isSelf(m) && dateOf(Number(m?.tsMs) || now) === today).length;
    return {
      now,
      recent,
      state: {
        sinceSelfSec: lastSelf
          ? Math.max(0, Math.round((now - (Number(lastSelf.tsMs) || now)) / 1000))
          : undefined,
        todayCount,
      },
      atMe: Boolean(message?.atSelf) || mentionsId(message, self),
      exempt,
      triggerText: message ? segmentsToText(message).slice(0, 120) : '',
      seq: message ? seqOf(message, message.date) : '',
    };
  }

  // 记一行。shadow 与 enforce 都记，靠 `enforced` 区分。
  function note({ conv, kind, enforce, startedTs, seq, trigger, state, verdict, extra = {} }) {
    decideLog?.write({
      // `ts` 取**判定结束**的时刻 —— 用开始时刻会让日志看起来"没更新"：
      // 一条 3 秒超时的判定，会排到比它晚出发的短判定前面去。
      ts: Date.now(),
      startedTs,
      conv,
      kind,
      mode: typeof judge?.modeFor === 'function' ? judge.modeFor(conv) : judge?.mode,
      enforced: enforce,
      act: verdict?.act,
      reason: verdict?.reason,
      ms: verdict?.ms,
      sysHash: typeof judge?.hashFor === 'function'
        ? judge.hashFor(kind, conv)
        : (kind === 'wait' ? judge?.hashOf?.('wait') : judge?.sysHash),
      seq,
      trigger,
      state,
      ...extra,
      usage: verdict?.usage
        ? {
          hit: verdict.usage.prompt_cache_hit_tokens,
          miss: verdict.usage.prompt_cache_miss_tokens,
          total: verdict.usage.total_tokens,
          credit: verdict.usage.credit,
        }
        : undefined,
      error: verdict?.error,
    });
  }

  const active = (conv) => (typeof judge?.enabledFor === 'function'
    ? judge.enabledFor(conv)
    : (typeof judge?.enabled === 'function' && judge.enabled()));
  const modeOf = (conv) => (typeof judge?.modeFor === 'function' ? judge.modeFor(conv) : judge?.mode);
  const ownerAlwaysOf = (conv) => (typeof judge?.ownerAlwaysFor === 'function'
    ? judge.ownerAlwaysFor(conv)
    : Boolean(judge?.ownerAlways));

  // 唤醒点：返回 `'ignore'` 时调用方**不投递**；`null` = 放行（shadow / 判不出来）。
  async function wake({ conv, pool, selfQq, message, isOwner }) {
    if (!active(conv)) return null;

    const enforce = modeOf(conv) === 'enforce';
    const { now, recent, state, atMe, triggerText, seq } = inputs({
      pool, selfQq, message, conv,
    });
    const record = (verdict) => note({
      conv,
      kind: 'wake',
      enforce,
      startedTs: now,
      seq,
      trigger: { who: String(message.sender?.qq ?? ''), atMe, isOwner, text: triggerText.slice(0, 60) },
      state,
      verdict,
    });

    // 主人在 `enforce` 下默认直放：他是唯一会被派活的人，判错代价最高，
    // 而且省一次 1.6 秒的调用。
    if (enforce && isOwner && ownerAlwaysOf(conv)) {
      const short = { act: 'reply', reason: '主人直放', ms: 0 };
      record(short);
      return short;
    }

    const run = async () => {
      const v = await judge.decide({
        kind: 'wake',
        recent,
        trigger: {
          who: String(message.sender?.name ?? message.sender?.qq ?? ''),
          text: triggerText,
          atMe,
          isOwner,
        },
        state,
        convKey: conv,
      });
      record(v);
      return ['ignore', 'reply'].includes(v.act) ? v : null;
    };

    if (enforce) return run();
    void run().catch((error) => logger?.debug('决策层异常', { conv, error: String(error) }));
    return null;
  }

  // 等待返回点：`keep` = 继续挂着（拒绝返回没有任何代价：游标不动、池里不收走，
  // 这批会在下次真返回时一起进 `newMessages`）。
  //
  // @param w          本次 wait 对象（`qq` / `waitedFromTs` / `deciding` 都在上面）
  // @param isCurrent  `() => boolean`，判断 `w` 是否仍是当前等待（期间可能超时/重开）
  // @param onArrived  `() => void`，真的要返回时调（state 的 `#settleWait('arrived')`）
  function waitReturn({ conv, pool, selfQq, w, message, isCurrent, onArrived }) {
    if (!active(conv)) {
      onArrived();
      return;
    }
    const enforce = modeOf(conv) === 'enforce';
    const { now, recent, state, atMe, triggerText, seq } = inputs({
      pool, selfQq, message, conv,
    });
    const who = String(message?.sender?.name ?? message?.sender?.qq ?? '');
    const record = (verdict) => note({
      conv,
      kind: 'wait',
      enforce,
      startedTs: now,
      seq,
      trigger: { who: String(message?.sender?.qq ?? ''), atMe, text: triggerText.slice(0, 60) },
      state,
      verdict,
      extra: { waitedMs: Math.max(0, Date.now() - (Number(w.waitedFromTs) || Date.now())) },
    });
    const ask = () => judge.decide({
      kind: 'wait', recent, trigger: { who, text: triggerText, atMe }, state, convKey: conv,
    });

    if (!enforce) {
      void ask().then(record).catch((error) => logger?.debug('决策层异常', { conv, error: String(error) }));
      onArrived();
      return;
    }

    // 已经在判 → 这条已经进池，判完那次会把两批一起带上，不重复判。
    if (w.deciding) return;
    w.deciding = true;
    void ask()
      .then((v) => {
        w.deciding = false;
        record(v);
        // 期间可能超时 / 被取消 / 重开了一个 wait —— 那就别动现在这个。
        if (!isCurrent()) return;
        // 判不出来一律返回（宁可多给，不可让它干等）。
        if (v.act !== 'keep') onArrived();
      })
      .catch((error) => {
        w.deciding = false;
        logger?.debug('决策层异常', { conv, error: String(error) });
        if (isCurrent()) onArrived();
      });
  }

  return { inputs, note, wake, waitReturn, active };
}
