// 取消息：**池优先，库兜底**
//
// 两条路径（`takeMessages` 池、`scanStore` 库）用的是**同一套规则**：
//   ① 从**最新**往回；② **跳过本号发的**（且不标记）；③ 遇到**已读**即边界，停；
//   ④ 超过上限的只计数（`omitted`）。
//
// 这套规则是"它还没见过什么"的**唯一判据** —— 投递与 `qq_wait` 都走这里，
// 所以两边不可能给出不同的答案。
//
// ⚠️ 这里只**挑**，不标记。标记由调用方在"确实要交给模型"之后统一打
//    （`state.js` 的 `#deliver` / `#settleWait`）—— 提前标 = 中途死掉的那批永久丢失。

import { MARKS, isMarked } from './pool.js';
import { dateOf, seqOf } from '../chatlog/store.js';

// 池里的"已读"：库里 `readCount` 是真相，池里的 `MARKS.READ` 是它的镜像。
// 两个都要看 —— 哪边先落后半格都不该让它重复吐出已经给过的消息。
export function isReadEntry(it) {
  return (it.msg?.readCount ?? 0) > 0 || isMarked(it, MARKS.READ);
}

// 取 `newMessages`：**先从池里扫未读的 `limit` 条；不够再去存储补**。
//
// 池里凑不满 `limit` ⇒ 去库里取**比池里最旧那条更早**的补齐（已经在池里取过的那些
// 按身份挡掉，不重复）。这样进程刚起来、池还没攒到东西时也不会返回空。
export function takeMessages({ store, pool, limit }) {
  const self = String(store?.selfQq ?? '');
  const fromPool = [];   // 最新 → 更早
  const takenIds = new Set();   // 已从池里取过的身份 —— 库扫要挡掉它们（避免重复）
  let omitted = 0;

  for (const it of pool.pick((e) => e.kind === 'message').reverse()) {
    const m = it.msg;
    if (!m) continue;
    // 本号发的：跳过，**不当边界也不标记**（它永远不进上下文）。
    if (self !== '' && String(m.sender?.qq ?? '') === self) continue;
    // 已读 = 边界，停（更早的都处理过了）。
    if (isReadEntry(it)) break;
    if (fromPool.length < limit) {
      fromPool.push({ ...m, date: dateOf(m.tsMs) });
      if (it.id) takenIds.add(it.id);
    } else omitted += 1;
  }

  if (fromPool.length >= limit) return { messages: fromPool.reverse(), omitted };

  const older = scanStore({ store, limit: limit - fromPool.length, skipIds: takenIds });
  return {
    messages: [...older.messages, ...fromPool.reverse()],
    omitted: omitted + older.omitted,
  };
}

// 库扫（慢路径）：从最新往回跨天扫，跳过本号发的，到第一条已读为止，
// 至多 `limit` 条，超出只计数。`skipIds` 里的（已经从池里取过的）直接跳过。
//
// · 用"已读边界"而不是"时间起点"：时间起点会覆盖上一轮投递那批 ⇒ 它重复看到处理过的消息。
// · 必须显式跳过自己发的：自己发的也是已读，上一条回复会立刻成为边界 ⇒ 真正的未读一条取不到。
// · 区间里群友的未读闲聊也要（不止 @ 它的那条）：要开口就得知道群里刚在聊什么。
//
// ⚠️ 不能用 `tsMs >= 池里最旧那条` 来挡：QQ 事件的时间是**整秒**，多条消息经常
//    共享同一个 `tsMs`，那样会把库里同秒的另一条误判成"取过了"而**静默丢一条**。
export function scanStore({ store, limit, skipIds = new Set() }) {
  const self = String(store?.selfQq ?? '');
  const taken = [];
  let omitted = 0;
  let stopped = false;
  for (const date of store.dates().slice().reverse()) {
    if (stopped) break;
    const doc = store.load(date);
    for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
      const m = doc.messages[i];
      // ① 自己发的：跳过，**不当边界**（否则会卡住后面的未读）
      if (self !== '' && String(m.sender?.qq ?? '') === self) continue;
      // ② 已经从池里取过的：跳过，不当边界（不重复给同一条）
      const seq = seqOf(m, date);
      if (seq !== undefined && skipIds.has(`${date}#${seq}`)) continue;
      // ③ 第一条已读 = 边界，停。
      if ((m.readCount ?? 0) > 0) { stopped = true; break; }
      // ④ 未读：收，超上限的只计数
      if (taken.length < limit) taken.push({ ...m, date });
      else omitted += 1;
    }
  }
  taken.reverse();
  return { messages: taken, omitted };
}
