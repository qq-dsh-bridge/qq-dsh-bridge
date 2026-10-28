// 读取与标记 —— 三种触发共用同一套规则。
//
// ── 核心规则：从最新往上取，遇已读即停
//
//   从最新一条开始往上遍历：
//     未读（readCount == 0） → 收进结果
//     已读（readCount > 0）  → **停止**
//     收满 limit             → 停止，**剩下的保持未读**
//
//   三个阶段只是 limit 不同：
//     冷启动（被 @ 唤醒）      60
//     热启动（回应期闸门放行） 20
//     主动查阅（AI 自己找）    按需
//
//   「遇已读即停」不是 bug，它就是"上次读到哪"的边界。这条规则同时保证：
//     - 只取**新的**（老积压中间隔着已读的，天然碰不到）
//     - 老积压**不被抽干**（超出的部分保持未读，等 AI 主动来查）
//
// ── 关于「积压」的一个刻意选择
//
//   若未读积压 500 条（机器人离线一天），冷启动只取**最新** 60 条，
//   更早的 440 条**完全不动**（仍是 readCount == 0）。
//
//   不标记、不丢弃、不投递。它们就静静躺着，直到 AI 觉得上下文不够、
//   主动按时间或按未读来查。这与"标记为已读但没投递"相比更诚实：
//   不会让 AI 以为自己看过那 440 条。
//
// ── 主动查阅默认**不**改 readCount
//
//   检索归检索。如果查一次历史就把未读清空了，"我还欠什么没读"这个判断
//   就废了。需要标记时显式传 markRead: true。

import { textOf, deriveMsgType } from './segments.js';
import { seqOf } from './store.js';

// 一轮读取的 phase 取值。
//
// ── 为什么只有「强制投递」一种
//
// 早期设计分了 `cold`（冷启动）/ `hot`（热启动）。但两者本质相同：
// *都是桥接强制把消息喂进上下文**，都会自动标记已读。区分它们没有行为差异，
// 只多一个会写错的枚举值。现在统一成 `push`。
//
// `manual` 保留：那是 AI **主动查阅**（检索），语义确实不同 ——
// 检索默认不改已读状态（见 query 的 markRead 参数）。
export const PHASES = Object.freeze({
  // 桥接强制投递（唤醒时 / 回应期窗口）。自动标为已读。
  PUSH: 'push',
  // AI 主动查阅且显式要求标记。
  MANUAL: 'manual',
});

// 取最新的未读消息。
//
// ── 为什么不跳过"自己发的"
//
// **不要**按 `role === 'self'` 跳过：本机可能有两个 bot **共用同一个 QQ 号**
// （DSH agent 与 Yunzai）。OneBot 事件里它们看起来完全一样 —— 都是 self_id
// 发的，所以本号说的话也要算"欠读"。
//
// 于是跳过 self 会导致：
//   1. Yunzai 抢答的内容被当成"我自己说的"而丢弃
//   2. 上下文 20/60 条被自己的发言截断（取不满）
//   3. 更糟：AI 不知道 Yunzai 已经回过，可能与它抢话/重复
//
// 结论：**一律算未读**。"这句是本号发的"只是一条**标注**，
// 由提示词层显示（见 deliver.js），不参与读取规则。
//
// 代价是自己刚说的话会被再读一遍 —— 无害，反而提醒了它说过什么。
//
// @param doc      一天的文档
// @param options.limit      最多取几条
// @param options.stopAtRead 遇到已读是否停止（默认 true，这是核心规则）
// @returns 结果数组，**按 no 升序**（给人读的顺序）
export function takeLatestUnread(doc, { limit = 60, stopAtRead = true } = {}) {
  const out = [];
  const msgs = doc.messages ?? [];

  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    const isRead = (m.readCount ?? 0) > 0;

    if (isRead) {
      // 核心规则：遇到已读就停 —— 那是"上次读到哪"的边界。
      if (stopAtRead) break;
      continue; // stopAtRead=false：跳过已读继续往上收
    }

    out.push(m);
    if (out.length >= limit) break; // 收满就停，剩下的保持未读
  }

  return out.reverse();
}

// 这条是不是"本号"发的。
//
// ⚠️ **只用于标注，绝不用于过滤**（见 takeLatestUnread 的说明）。
// 本号 = DSH agent 自己 **或** Yunzai（同一个 QQ 号）。
export function isSelfMessage(m, selfQq = '') {
  const want = String(selfQq ?? '');
  if (want !== '') return String(m?.sender?.qq ?? '') === want;
  return false;
}

// 跨天取未读。
//
// 为什么必须跨天：23:58 积压的消息，00:01 被唤醒时若只看今天的文件就漏了。
//
// ── "遇已读即停" 在跨天时的精确语义
//
// 单日内的规则是"从最新往上，遇已读即停"。跨天时有一个关键区别：
//
//   当天**全部已读** ⇒ 说明当天没有未读边界，**必须继续往前一天找**。
//   当天**取到一些后遇已读** ⇒ 边界就在这里，停止。
//
// 换句话说：只有"已经取到东西"之后遇到的已读才是真边界。
// 否则会出现这个 bug（实测踩过）：今天全读过了 → 立刻判停 →
// 昨天明明有未读却返回空。
//
// @param store
// @param options.limit    最多取几条
// @param options.maxDays  最多回溯几天（防止全库扫描）
// @param options.stopAtRead  是否遇已读即停（默认 true）
// @returns 按时间**升序**的消息数组，每条带 `date`
export function takeLatestUnreadAcrossDays(store, { limit = 60, maxDays = 7, stopAtRead = true } = {}) {
  const dates = store.dates().slice(-maxDays).reverse(); // 最新在前
  const collected = [];

  for (const date of dates) {
    if (collected.length >= limit) break;

    const doc = store.load(date);
    const msgs = doc.messages ?? [];
    const beforeThisDay = collected.length;

    // 从当天最新往回找
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      const isRead = (m.readCount ?? 0) > 0;

      if (isRead) {
        if (!stopAtRead) continue;
        // 已读边界。但**只有当本天已经取到东西时**它才是真边界（见上）。
        if (collected.length > beforeThisDay) {
          collected.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
          return collected;
        }
        // 本天一条未读都没取到 ⇒ 当天全部已读，继续往前一天。
        break;
      }

      collected.push({ ...m, date });
      if (collected.length >= limit) break;
    }
  }

  // 统一按时间升序（跨天后 no 不单调，必须用时间排）
  collected.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  return collected;
}

// 标记一批消息为"读过一轮"。
//
// @param store
// @param items   带 `date` 的消息数组（身份用 `seqOf` 现算 —— 群聊是 msgSeq、
//                私聊是 `MMDD#no`；所以 items 不需要自己带编号）
// @param phase   PHASES.COLD / HOT / MANUAL
// @returns 实际标记的条数
export function markRead(store, items, phase, opts = {}) {
  const refs = [];
  for (const it of items) {
    if (!it?.date) continue;
    const seq = seqOf(it, it.date);
    if (seq === undefined) continue;
    refs.push({ date: it.date, seq });
  }
  return markReadByRefs(store, refs, phase, opts);
}

// 按**定位符**标已读 —— `[{ date, seq }]`。
//
// ⚠️ 这是**池 → 存储**的回写入口（`pool.markRead()` 里调），别处不要再直调：
//    标记的唯一作者是池，存储里的 `readCount` 只是投影。
//    直调会让"池标了、库没标"或反过来，变成两条账 —— 本项目反复撞过的 bug 形态。
//
// @returns 实际标了几条（找不到的静默跳过：消息可能已被上限/清理挤掉）
export function markReadByRefs(store, refs, phase, { atMs = Date.now() } = {}) {
  let n = 0;
  const byDate = new Map();
  for (const r of refs) {
    if (!r?.date || r.seq === undefined || r.seq === null) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(String(r.seq));
  }

  for (const [date, seqs] of byDate) {
    const doc = store.load(date);
    const wanted = new Set(seqs);
    let touched = false;
    for (const m of doc.messages) {
      if (!wanted.has(seqOf(m, date))) continue;
      m.readCount = (m.readCount ?? 0) + 1;
      n += 1;
      touched = true;
    }
    if (!touched) continue;

    // ⚠️ **必须同时做两件事**：标脏 + 安排落盘。少任何一件都会静默丢状态。
    //
    // 而只调 scheduleFlush 不标脏同样不行：`flush()` 第一行就是
    // `if (!entry.dirty) return false`，直接返回，什么都不写。
    // 两件事必须一起做。
    store.cache.get(date).dirty = true;
    store.scheduleFlush(date);
  }
  return n;
}

// 主动查阅 —— 支持多种筛选。
//
// 与 takeLatestUnread 的区别：这是**检索**，按条件找，不受"遇已读即停"限制。
//
// @param options.dates       限定日期（数组）；空 = 全部
// @param options.unreadOnly  只看未读
// @param options.readRounds  按已读轮次筛：`{ min, max, eq }`
// @param options.sender      按发言者 id 筛
// @param options.role        按**群内身份**筛：groupOwner / admin / member
// @param options.since / until  时间范围（unix 秒）
// @param options.contains    正文包含子串（大小写不敏感）
// @param options.includeRecalled  是否包含已撤回（默认**包含**，因为撤回本身是信息）
// @param options.kinds       按 msgType 筛：text / image / face / mixed / record / video / forward / json
// @param options.limit       最多返回
// @param options.order       'desc'（默认，最新在前）| 'asc'
export function query(store, options = {}) {
  const {
    dates,
    unreadOnly = false,
    readRounds,
    sender,
    role,
    since,
    until,
    contains,
    includeRecalled = true,
    excludeRecalled = false,
    kinds,
    limit = 50,
    order = 'desc',
  } = options;

  const targetDates = dates?.length ? dates : store.dates();
  const rows = [];

  for (const date of targetDates) {
    const doc = store.load(date);
    for (const m of doc.messages) {
      const readCount = m.readCount ?? 0;

      if (unreadOnly && readCount !== 0) continue;
      if (readRounds) {
        if (readRounds.eq !== undefined && readCount !== readRounds.eq) continue;
        if (readRounds.min !== undefined && readCount < readRounds.min) continue;
        if (readRounds.max !== undefined && readCount > readRounds.max) continue;
      }
      if (sender && String(m.sender?.qq) !== String(sender)) continue;
      if (role && m.sender?.groupRole !== role) continue;
      // ⚠️ 时间**只有 `tsMs`**（毫秒）—— 旧的 `ts`（秒）已删。
      //    而 AI 传进来的 `since`/`until` 是 **unix 秒**（工具 schema 里
      //    明确写了"不是毫秒"），所以这里 *1000 换算再比。
      if (since !== undefined && m.tsMs < Number(since) * 1000) continue;
      if (until !== undefined && m.tsMs > Number(until) * 1000) continue;
      // `kinds` 按 **msgType** 筛，而 msgType **已不再落盘** ——
      // 所以这里读时派生（segments 是唯一数据源）。
      if (kinds?.length && !kinds.includes(deriveMsgType(m))) continue;

      const recalled = Boolean(m.state?.recalled);
      if (!includeRecalled && recalled) continue;
      if (excludeRecalled && recalled) continue;

      if (contains) {
        // 搜正文用 textOf（只拼 text 段），不搜带标记的 segmentsToText ——
        // 否则搜 "image" 会命中每一条带图的记录。
        const hay = `${textOf(m)} ${m.sender?.name ?? ''}`.toLowerCase();
        if (!hay.includes(String(contains).toLowerCase())) continue;
      }

      rows.push({ ...m, date });
    }
  }

  rows.sort((a, b) => (order === 'asc'
    ? (a.tsMs ?? 0) - (b.tsMs ?? 0)
    : (b.tsMs ?? 0) - (a.tsMs ?? 0)));

  return rows.slice(0, limit);
}

