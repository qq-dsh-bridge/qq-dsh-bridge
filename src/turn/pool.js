// *`[lines:N]` 消息块 / 事件的滑动窗口**（不分回合）。
//
// ── 它解决什么
//
// 群里随时会有新消息**和事件**（撤回、表情回应、戳一戳）。模型跑一轮期间它们**不能直接
// 投递**（同一轮里不能并发起新一轮），也**不能丢**；睡着时到达的同样要留住（醒来就得有上下文）。
// 所以**到就进池**：不分回合、不分是谁发的（本号的也进 —— 那是上下文的一部分）。
//
// 但到达的那一刻**判不了**："该不该算它叫到我"取决于模型给 `qq_wait` 的参数
// （`qq`），而那个参数**还不存在**。
//
// 所以：**到达时不判，只存**；等模型开 wait 时，拿它当时给的规则来这里筛一遍
// （见 `ConversationState#poolWake`）。
//
// ── 为什么消息和事件在**同一个**队列里
//
// 顺序是真相。"他说了 A → 有人回了个表情 → 他撤了 A"与"他撤了 A → 他接着说了 B"
// 不是一回事。拆成两个数组就得在读取时按时间重排，而两边的时钟精度不同
// （QQ 事件的 `time` 都是**整秒**）⇒ 同一秒里的先后会随机。一个队列 + 单调递增的
// `seq`，次序天然确定，也天然知道"这个事件发生在哪些消息之后"。
//
// ── 为什么事件是"追加条目"，而不是"给那条消息打状态标记"
//
// ① 池里的消息对象**就是库里那个对象**（`receive` 把落库后的记录直接塞进来）。
//    给它打 `state.recalled` 等于**改了库里的对象** —— 投递失败、回滚、重投时全串味。
// ② 打标记丢过程："谁撤的、什么时候撤的"没了。而**管理员撤别人的消息**与
//    **作者自己收回**是两件不同的事，前者是个动作，后者是个澄清。
// ③ 戳一戳**根本没有 messageId**（`user_id` 戳 `target_id`），挂不到任何一条消息上。
//    要"读、存、投递统一管理"，它就只能也成为一个条目。
//
// ⚠️ **落盘那一侧反过来**：库里 `state.recalled` 是"消息的当前属性"，原地标记是对的
//    （`store.recall` 追加一行状态增量，消息行永不改）。池是短期上下文、库是长期真相，
//    两边职责不同，别把那套搬过来，也别把这套搬过去。
//
// ── 不清空，改用**标记**（这是本模块最重要的约定）
//
// 早先是"清池"：`#settleWait` 成功后清一次、`#deliver` 成功后清一次。问题是**清空是
// 一个没有记录的破坏性动作** —— 清完就没人知道"这批到底交出去没有、交给谁了"，
// 而且一旦某条路的顺序写错（先清后送），消息就静默消失，日志里一行都没有。
//
// 现在：**永远不清**。每个消费者在自己**成功之后**给条目打一个记号：
//
//     pool.mark(shown, MARKS.DELIVERED)   // 已经渲染进上下文、真的送到模型了
//     pool.markRead(shown)                // 模型已经知道这条了（送达即已读）
//
// 读的时候**按标记取**：`unmarked(MARKS.DELIVERED)` = "还没投递过的"，
// `unmarked(MARKS.READ)` = "它还欠读什么"。**这两句别混用** —— 区别见 `MARKS`。
//
// 为什么这样更对：
//   · 标记**带时间戳**，能回答"这批是几秒前交的、之后有没有又来过人"；
//   · 一个池可以同时服务**多个消费者**（投递 / 落库 / 渲染上下文 / 排障），
//     各看各的标记，互不干扰 —— 清空模型做不到这件事；
//   · 失败路径**什么都不用做**（不打记号就是"没成功"），不必写"回滚"。
//
// ⚠️ 唯一还会丢东西的地方是**上限**（见下），所以下游要在条目还在的时候标记它。
//
// ── 两种消费模型：**逐条标记** vs **水位线**（第二个重要约定）
//
// 并不是所有东西都该用 `marks`。判据只有一句：**这个消费会不会"局部取"？**
//
//     会 → `marks`（逐条）      不会 → `cursors`（整批，只记一个数字）
//
// "局部取"的具体样子（这个项目里每一条都是真的）：
//   · 投递有 `replyLimit`(20) 条数上限、`maxChars` 字符上限 ⇒ 一批只带得走一部分；
//   · 取未读是"从最新往回扫，到第一条已读就停" ⇒ 天然会跳过中间的；
//   · 更远的信息以后还要（谁往回引用一句，那批就得还能取到）。
// 一条消息没被带上，就**必须**仍是"没交付"，下次还能取。**水位线做不到这件事** ——
// 它会直接跨过去，那批永久消失（`probe-pool-unit` 第 16 组就是拿这个当判据演示的）。
//
// 反过来，**事件**（撤回 / 表情 / 戳）适合水位线：
//   · 数量极少（实测 2.5 天 70 个）⇒ 投递时一次全带，不存在"只带一部分"；
//   · 过期之后**永久没用**：`qq_wait` 判"要不要立刻返回"只关心"上次交付之后"的事；
//   · 条目会被上限挤掉，但水位线是个数字，**不会因此失真**。
//
// ⚠️ 边界：一旦给事件也加上限（比如"最多呈现 20 个"），就必须改回 `marks` ——
//    否则水位线会跨过没交出去的那些，它们永久丢失。
// ⚠️ 两者的记账时机**完全一样**：只在成功之后。失败就什么都不做（不打记号 / 水位线不动）。
//
// ── 三条硬口径
//
// 1. **`newMessages` 先取池、答不全再回库** —— 实际分工：
//    `#settleWait` → `#takeMessages` 先问池（快，内存里就有答案）；池里**从最新往回
//    撞不到"已读边界"**（说明答不全：启动初期没攒够、或更早的已被上限挤掉）才回库按
//    老规则扫。两条路径的规则一致：跳过本号发的、撞到已读即停、至多 `replyLimit`(20)。
//    ⚠️ 判据是"**池能不能给出完整答案**"，不是"条数够不够"。
// 2. **有上限，满了丢最旧的。** 群里刷屏时无界增长就是内存泄漏，而且池越大开 wait 时
//    扫得越慢。丢最旧而不是丢最新：刚来的那句比十分钟前的废话重要得多。
//    ⚠️ 池是**滑动窗口**，不是仓库 —— 想长期留的必须落库（见 `store`，池里不记落库状态）。
// 3. **不清空**（见上一节）。要"忘掉"一批，就标记它、然后按标记过滤。
//
// ── 可合并的事件
//
// 同一个动作重复到达时不追加新条目，而是**累加在已有那条上**（`count` / `lastTsMs`）。
// 这不是为了省内存（500 条撑得住），是为了**不刷屏**：
//   · `recall`   —— 同一条消息只留一条（撤回是幂等的，重复通知/本地又撤一次，没有新信息）
//   · `reaction` —— 同一人 + 同一条消息 + 同一个表情，`isAdd` 取**最后一次**
//                  （来回点两下，最终状态才是他要表达的）
//   · `poke`     —— 同一对（戳的人 → 被戳的人）在 `POKE_MERGE_MS` 内合并成一条
//                  （连戳五下不是五件事，是一件"他在戳你"）
//
// ── `pick` / `all` / `messages` 是干什么的
//
// `someMessage` 用于"要不要立刻返回"；`pick` 给 `#takeFromPool` 做**投递取样**
// （按 `MARKS.READ` 找已读边界），`all` / `messages` 给排障与别的消费者看。
//
// ⚠️ 池取样与库扫是**两套判据**，必须共用同一组规则（跳过本号、已读即停），
//    否则会出现"池里明明有、却要等满超时"或"给了已经处理过的消息"。

import { dateOf, seqOf } from '../chatlog/store.js';
import { deriveMsgType, textOf } from '../chatlog/segments.js';

// #region 常量

// 默认上限（条）。
//
// 500 是"一次刷屏 + 期间所有事件"的量级：实测量级参考 —— 2.5 天里 4444 条消息、
// 67 次撤回、1 次表情回应、2 次 `notify`。所以 500 条足够覆盖一轮里的一切，
// 又远小于能把内存或扫描成本搞坏的程度。
//
// ⚠️ 先写死在这里，之后再接到配置文件（`config.poolLimit`）——
//    接的时候只改 `#limitOf`，别把 500 散到调用方去。
export const DEFAULT_LIMIT = 500;

// 连戳合并窗口（毫秒）。同一个人戳同一个人，窗口内只算一件事。
export const POKE_MERGE_MS = 10_000;

// 条目标记名 —— "这件事对它做过了"。
//
// ⚠️ 标记名要表达**已经发生的事实**，不是"要不要处理"：
//    写 `DELIVERED` 而不是 `TODO_DELIVER`。这样失败路径天然正确（没打就是没成功），
//    不必写"取消标记"。
export const MARKS = Object.freeze({
  // *已经投递**：真的渲染进上下文、送到模型了（`#deliver` / `#settleWait` 成功后打）。
  //
  // 这是**交付记账**：回答"这批到底交出去没有、有没有被 `maxChars` / `replyLimit` 截断"。
  // ⚠️ 别拿它当"已读" —— 被截断没进去的那几条，模型根本不知道它们存在。
  DELIVERED: 'delivered',

  // *已读**：模型已经知道这条内容了（等价旧库里 `readCount > 0`）。
  //
  // 与 `DELIVERED` 是**两条账**，故意分开：
  //   · 投递成功 → 两个都打（送到即已读）；
  //   · AI 主动 `qq_read_chat` 把历史标成已读 → **只打 READ**，不打 DELIVERED ——
  //     那些从没进过提示词，打 DELIVERED 会让"交付审计"说谎。
  //
  // 于是：`unmarked(READ)` = "它还欠读什么"；`unmarked(DELIVERED)` = "还没送过什么"。
  //
  // ⚠️ 用 `markRead()` 打，别直接 `mark(…, 'read')` —— 见那个方法上的说明。
  READ: 'read',
});

// *水位线**（游标）名 —— "整批消费到哪儿了"。
//
// 与 `MARKS` 的区别（这是本模块第二个重要约定）：
//
//   · `MARKS`（逐条）—— 每条自己一个记号。用于**会被"局部取"的东西**：投递有
//     `replyLimit`(20) / `maxChars` 截断、扫到已读边界就停、更远的信息以后还要。
//     一条没被带上，就必须仍是"没交付"，下次还能取到。**水位线做不到这件事。**
//   · `CURSORS`（水位线）—— 整个流只记一个数字。前提是**"要么全取、要么不取"**：
//     一旦某天给事件也加上限（比如"最多呈现 20 个"），水位线就会**跨过没交出去的那些**、
//     它们永久丢失 —— 那时必须改回 `MARKS`。
//
// ── 名字的两种格式
//
//   ① **按事件类型**：`<kind>` 或 `<kind>:<用途>`
//      · 第一个冒号前必须是一种事件类型（见 `KINDS`）—— `since()` 靠它决定"查哪种事件的编号"。
//      · 只用 `<kind>`（如 `'recall'`）= 这种事件的默认消费者。
//      · 同一个 `kind` 有**多个消费者**时才加后缀（`'recall:shown'` / `'recall:wake'`）：
//        一个消费者前移自己的线，绝不能把另一个消费者该看到的东西推走。
//      · 编号用 `entry.tid`（**每种事件各一套**，撤回#3 与 表情#12 互不相干）。
//
//   ② **跨类型**：以 `*` 开头（如 `'*wait'`）
//      · `since()` 返回池里**全部**条目（消息 + 所有事件），编号用全池 `entry.seq`。
//      · 给"**消费点**"用 —— 它关心的不是某一种事件，而是"上次之后又来了什么"。
//
// ⚠️ 两套编号都**只增不减、也不复用**：旧条目被上限挤掉后，后来的接着往上编号
//    （不会回到 1）。所以水位线永远能表达"我处理到这里了"，不会因为池变小而错位。
export const CURSORS = Object.freeze({
  // 撤回到哪儿（默认消费者）。
  RECALL: 'recall',
  // 表情回应到哪儿（默认消费者）。
  REACTION: 'reaction',
  // 戳一戳到哪儿（默认消费者）。
  POKE: 'poke',
  // *`qq_wait` 的规则判定**到哪儿了 —— 跨类型，按全池 `seq` 推进。
  //
  // ── 它解决什么
  //
  // 开 `qq_wait` 时要回答一个问题：「**上次判定之后**，池里有没有"算叫到它"的消息？」
  //
  // 没有这条线，答案会永远是"有" —— 已经交付过的老消息一直躺在池里（池不清空），
  // 于是它每次开 wait 都立刻返回：等 0 毫秒 → 回一句 → 再等，一轮空转。
  //
  // ── 和 `MARKS.DELIVERED` 的分工（两个都要，**不是二选一**）
  //
  //   · `MARKS.DELIVERED` —— **逐条**："这条真的渲染进上下文了"。用于交付审计 / 排障，
  //     与截断（`replyLimit` / `maxChars`）严格对齐。
  //   · `CURSORS.WAIT` —— **一个位置**："判定从这儿接着"。用于触发判定。
  //
  // 一个回答"哪几条看过了"，一个回答"从哪儿开始算新的"。混用会出那两种怪事：
  // 用逐条标记当判定 → 被截断的那几条让每次 wait 都命中；用水位线当交付记账 →
  // 被截断、没真给它的那几条被当成"看过了"。
  WAIT: '*wait',
});

// 条目类型。
//
// ⚠️ 用 `message` 之外的字符串当 kind 时，**语义要与 OneBot 事件对得上**，
//    这样接入时映射是直译、不用二次翻译（形状见 SnowLuma `event-converter/to-notice.ts`）：
//
//   recall    ← group_recall / friend_recall
//               actor = operator_id（撤的人；私聊按"被撤那条是谁发的"推）
//               author = user_id（被撤那条的作者）
//               subject.messageId
//   reaction  ← group_msg_emoji_like
//               actor = operator_id（点的人）  emoji = likes[].emoji_id
//               isAdd = sub_type === 'add'     subject.messageId
//   poke      ← notify / poke
//               actor = user_id（戳的人）      target = target_id（被戳的）
//               **没有 subject** —— 它不挂在任何一条消息上
export const KINDS = Object.freeze({
  MESSAGE: 'message',
  RECALL: 'recall',
  REACTION: 'reaction',
  POKE: 'poke',
});

// #endregion


// #region 小工具

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// 时间归一成**毫秒**。
//
// ⚠️ 这里必须真的换算，不能只做类型收敛：QQ 事件的 `time` 是**整秒**，而连戳合并窗口
//    （`POKE_MERGE_MS`）用的是毫秒差 —— 混着用的话"15 秒后"会被算成"15 毫秒内"，
//    窗口形同失效，`count` 会一路涨上去。
//
// 阈值取 `1e12`：2001 年之后的**毫秒**都比它大，**秒**都比它小。
// ⚠️ 传 0 / 负数 / 空 → 用 `fallback`（库里 `atMs ?? Date.now()` 那条老规矩：
//    0 会被当成有效值，落盘变成 1970）。
function toMs(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

// 两个条目是否指向同一条消息。两边都没有 messageId 时**不算同一条**（合并要确定）。
function sameSubject(a, b) {
  const x = a?.subject?.messageId;
  const y = b?.subject?.messageId;
  return Boolean(x) && x === y;
}

// 把"时间"归一成毫秒 —— 接受毫秒、秒、以及 `Date` 能解析的字符串。
// 与 `toMs` 的区别：那个只认数字（QQ 事件的秒/毫秒），这个还要认 `'2026-10-17 20:00'`。
function tsOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (raw !== '' && /^-?\d+$/.test(raw)) return toMs(raw, fallback);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 搜索条件的归一 —— 把各种写法收成一套内部形状，**内存与回源共用**（见 `matchesSearch`）。
//
// 时间有两条写法，都收：
//   · `from` / `to` —— 毫秒，或 `Date` 能解析的字符串；
//   · `since` / `until` —— **unix 秒**（`qq_read_chat` 的历史口径就是这么传的）。
//
// `seq` 决定**取条数的方式**：给了区间就按区间拿（忽略 `limit`）；不给就"从最新往回凑 `limit`"。
function normalizeSearch(filters = {}) {
  const qqIn = filters.qq ?? filters.sender;
  const qqSet = new Set(
    (Array.isArray(qqIn) ? qqIn : (qqIn === undefined || qqIn === null ? [] : [qqIn]))
      .map((v) => str(v))
      .filter(Boolean),
  );

  const fromTs = filters.from !== undefined
    ? tsOf(filters.from, Number.NEGATIVE_INFINITY)
    : (filters.since !== undefined ? Number(filters.since) * 1000 : Number.NEGATIVE_INFINITY);
  const toTs = filters.to !== undefined
    ? tsOf(filters.to, Number.POSITIVE_INFINITY)
    : (filters.until !== undefined ? Number(filters.until) * 1000 : Number.POSITIVE_INFINITY);

  let seqLo = null;
  let seqHi = null;
  if (filters.seq !== undefined && filters.seq !== null) {
    const arr = Array.isArray(filters.seq) ? filters.seq : [filters.seq];
    seqLo = str(arr[0]);
    seqHi = str(arr.length > 1 ? arr[arr.length - 1] : arr[0]);
    if (seqLo === '' || seqHi === '') seqLo = null;
  }
  const bySeq = seqLo !== null;
  // 纯数字才按数值比 —— 私聊的 seq 是 `MMDD#no`，只能按字符串比（字典序跨天仍单调）。
  const numericSeq = bySeq && /^-?\d+$/.test(seqLo) && /^-?\d+$/.test(seqHi);

  return {
    qqSet,
    role: str(filters.role),
    kinds: Array.isArray(filters.kinds) ? filters.kinds.map(str).filter(Boolean) : [],
    unreadOnly: filters.unreadOnly === true,
    readRounds: filters.readRounds && typeof filters.readRounds === 'object' ? filters.readRounds : null,
    includeRecalled: filters.includeRecalled !== false,
    excludeRecalled: filters.excludeRecalled === true,
    dates: Array.isArray(filters.dates) ? filters.dates.map(str).filter(Boolean) : [],
    fromTs,
    toTs,
    needle: str(filters.contains).toLowerCase(),
    seqLo,
    seqHi,
    bySeq,
    numericSeq,
    cap: bySeq ? Number.POSITIVE_INFINITY : Math.max(1, Number(filters.limit) || 50),
    order: filters.order === 'asc' ? 'asc' : 'desc',
  };
}

// 这条消息满不满足筛选 —— **内存与回源共用这一份判断**。
//
// ⚠️ 语义必须与 `read.js` 的 `query()` 对齐（否则"池答"与"回源答"会给出不同结果）：
//   · `contains` 搜的是 `textOf(m)` + 发言人昵称（**不是** `segmentsToText` ——
//     那样搜 "image" 会命中每一条带图的记录）；
//   · `kinds` 按 `deriveMsgType` 现派生（msgType 不落盘）；
//   · `excludeRecalled` / `includeRecalled` 看 `state.recalled`。
function matchesSearch(m, seq, f) {
  if (!m) return false;
  const readCount = m.readCount ?? 0;

  if (f.unreadOnly && readCount !== 0) return false;
  if (f.readRounds) {
    const { eq, min, max } = f.readRounds;
    if (eq !== undefined && readCount !== eq) return false;
    if (min !== undefined && readCount < min) return false;
    if (max !== undefined && readCount > max) return false;
  }
  if (f.qqSet.size && !f.qqSet.has(str(m.sender?.qq))) return false;
  if (f.role && m.sender?.groupRole !== f.role) return false;
  if (f.kinds.length && !f.kinds.includes(deriveMsgType(m))) return false;

  const recalled = Boolean(m.state?.recalled);
  if (f.excludeRecalled && recalled) return false;
  if (!f.includeRecalled && recalled) return false;

  const ts = Number(m.tsMs ?? 0);
  if (ts < f.fromTs || ts > f.toTs) return false;

  if (f.bySeq) {
    const v = String(seq ?? '');
    const hit = f.numericSeq
      ? Number(v) >= Number(f.seqLo) && Number(v) <= Number(f.seqHi)
      : v >= f.seqLo && v <= f.seqHi;
    if (!hit) return false;
  }

  if (f.needle) {
    const hay = `${textOf(m)} ${m.sender?.name ?? ''}`.toLowerCase();
    if (!hay.includes(f.needle)) return false;
  }
  return true;
}

//
// ⚠️ `seq` 自己**可能再带 `#`**（私聊是 `MMDD#no`），所以不能 `split('#')` 取两段 ——
//    日期固定 10 位（`YYYY-MM-DD`），从第 11 位起整段都是 seq。
function splitId(id) {
  const s = typeof id === 'string' ? id : '';
  // 最短合法：`YYYY-MM-DD#1` = 12 字符（seq 可能只有一位，别按"通常长度"卡）。
  if (s.length < 12) return null;
  const date = s.slice(0, 10);
  const seq = s.slice(11);
  return seq === '' ? null : { date, seq };
}

// 这条条目打过某个记号没有。
//
// 抽成导出函数，是因为**读的那一侧**（`#poolWake` 之类）要判它，而又不该自己去摸
// `entry.marks` 的内部形状 —— 哪天改成 Set 或位图，只改这里。
export function isMarked(entry, name) {
  return Boolean(entry?.marks?.[name]);
}

// 解析水位线名，得出它的**范围**。
//
//   `'recall'` / `'recall:shown'` → `{ all: false, kind: 'recall' }`（按类型，比 `tid`）
//   `'*wait'`                     → `{ all: true }`（跨类型，比 `seq`）
//
// ⚠️ 不带冒号时整串就是 kind —— 所以"这种事件的默认消费者"直接写 `KINDS.RECALL` 就够。
// ⚠️ 格式不合法直接**报错**，不要静默返回空：那看起来像"没有新东西"，
//    而实际是名字写错了 —— 这种静默失败最难查（本项目高频 bug 形态）。
function scopeOfCursor(name) {
  const key = String(name ?? '').trim();
  if (key === '') throw new TypeError('TurnPool: 水位线名不能为空');
  if (key.startsWith('*')) {
    // `'*'` 一个字符说明写漏了用途 —— 那种名字会让"消费点"混成一个。
    if (key.length < 2) throw new TypeError(`TurnPool: 水位线名「${name}」只有 * 没有用途`);
    return { all: true };
  }
  const i = key.indexOf(':');
  const kind = i >= 0 ? key.slice(0, i) : key;
  if (kind === '') throw new TypeError(`TurnPool: 水位线名「${name}」里没有事件类型`);
  return { all: false, kind };
}

// #endregion


export class TurnPool {

  // @param options.limit    上限，**可以是函数** —— 传 `() => config.poolLimit` 就能跟着热重载走。
  // @param options.now      取当前时刻（注入是为了测试可控，不要在方法里直接 `Date.now()`）。
  // @param options.identity **消息身份** `(msg) => string`：把"同一条消息"算成一个稳定的键。
  //
  //   ⚠️ 按标记读（`unmarked(MARKS.DELIVERED)`）就必须传它 —— 投递那批是 `store` 里消息的
  //      浅拷贝，对象引用对不上，不传就只能按条目 `seq` 标记。
  //   ⚠️ **别用 `messageId`**：它是 32 位哈希，`store.js` 头注释写明会碰撞（3 万条约 19%）。
  //      用 `seqOf()`（群 = `msgSeq`、私聊 = `MMDD#no`）—— 与"标已读"同一套身份，不另立一套。
  // @param options.onMarkRead **标记回写** `(refs) => void`：`markRead()` 打完池里的标记后，
  //   把 `[{ date, seq }]` 交给它写进存储。
  //
  //   ⚠️ 这是"**池 → 存储**"那条唯一的方向（存储的另一端只有 SnowLuma）。池是标记的
  //      **唯一作者**，存储里的 `readCount` 是它的投影 —— 别在别处再直调 `markRead(store, …)`，
  //      那会立刻出现"池标了库没标"的两条账（本项目反复撞过的 bug 形态）。
  constructor({ limit = DEFAULT_LIMIT, now = Date.now, identity = null, onMarkRead = null, store = null } = {}) {
    this.#limitOf = typeof limit === 'function' ? limit : () => limit;
    this.#now = now;
    this.#identity = typeof identity === 'function' ? identity : null;
    this.#onMarkRead = typeof onMarkRead === 'function' ? onMarkRead : null;
    // *只读的存储句柄**（`{ findByRef, findByMessageId }`）—— 给 `find()` 回源用。
    //
    // ⚠️ 池是"访问存储"的唯一一层：工具只拿池，池需要时才伸手。传 `null`（测试里）
    //    就退化成纯内存查找，找不到返回 `null`。
    this.#store = store && typeof store === 'object' ? store : null;
    this.#items = [];
    this.#seq = 0;
    this.#cursors = new Map();
    this.#typeSeq = new Map();
  }

  #items;
  #limitOf;
  #now;
  #identity;
  #onMarkRead;
  #store;
  #seq;
  // 水位线：name → 已消费到的 `seq`。整批消费用，与逐条 `marks` 是两套。
  #cursors;
  // 每种事件的下一个编号：kind → 已发出的最大 `tid`。**只增不减**（见 `#nextTid`）。
  #typeSeq;

  // 当前上限（跟着配置走，读的时候才算）。
  get limit() {
    return Math.max(1, Number(this.#limitOf()) || DEFAULT_LIMIT);
  }

  get size() {
    return this.#items.length;
  }

  // #region 入池

  // 消息入池。
  //
  // ⚠️ **不拷贝**：存的就是调用方给的那个对象（落库后的记录）。要改它请改库、并保证
  //    在读的时候投影出来 —— 别在这里给它挂字段（见文件头"为什么事件是追加"）。
  addMessage(msg, { tsMs } = {}) {
    return this.#append({
      kind: KINDS.MESSAGE,
      tsMs: toMs(tsMs ?? msg?.tsMs, this.#now()),
      // 身份键 —— 入池时算一次，之后不变（消息内容不会变，只有状态会变）。
      id: this.#idOf(msg),
      msg,
    });
  }

  // 事件入池（撤回 / 表情回应 / 戳一戳）。
  //
  // 形状统一成中性名（`actor` / `target` / `emoji` / `isAdd`），OneBot 原名字段由调用方
  // 映射过来 —— 这样池不认识 SnowLuma，换实现也不用动这里。
  //
  // @param ev.kind    见 `KINDS`（不接受 `message`，消息走 `addMessage`）
  // @param ev.subject `{ messageId }` —— 指向"这件事发生在哪条消息上"；poke 没有
  // @param ev.actor   谁做的
  // @param ev.author  被撤那条的作者（只 recall 用）
  // @param ev.target  被戳的人（只 poke 用）
  // @param ev.emoji   表情 id（只 reaction 用）
  // @param ev.isAdd   true = 加表情 / false = 取消（只 reaction 用）
  // @param ev.payload 原始事件的裁剪快照，只给排障用，**不参与任何判定**
  // @returns 条目（新追加的，或合并进去的那条旧条目）
  addEvent(ev = {}) {
    const kind = str(ev.kind);
    if (kind === '' || kind === KINDS.MESSAGE) {
      throw new TypeError(`TurnPool.addEvent: kind 不能是「${kind}」，消息请用 addMessage()`);
    }
    const tsMs = toMs(ev.tsMs, this.#now());
    const next = {
      kind,
      tsMs,
      // 最后一次到达的时刻（合并时更新，`tsMs` 保持第一条的）。
      lastTsMs: tsMs,
      // 合并了几次（撤回重复通知也会 +1，用来识别"撤了好几遍"这种怪事）。
      count: 1,
      subject: ev.subject?.messageId ? { messageId: str(ev.subject.messageId) } : undefined,
      actor: str(ev.actor),
      author: str(ev.author),
      target: str(ev.target),
      emoji: str(ev.emoji),
      isAdd: typeof ev.isAdd === 'boolean' ? ev.isAdd : undefined,
      payload: ev.payload,
    };

    // *先找可合并的条目，再决定要不要分配编号。**
    //
    // ⚠️ 顺序不能反：合并进来的那次**不占新编号** —— 它就是原来那条（同一条消息的
    //    重复撤回通知、同一个人重复 +1）。先分配的话，水位线会多出一个"永远对不上
    //    条目"的号，`since()` 就永远差一条、每次都以为有新事件。
    const at = this.#findMergeable(next);
    if (at >= 0) {
      const prev = this.#items[at];
      prev.count += 1;
      prev.lastTsMs = tsMs;
      return prev;
    }
    next.tid = this.#nextTid(kind);
    return this.#append(next);
  }

  // 分配该类型下的下一个编号（**每种事件各一套，只增不减**）。
  //
  // ⚠️ 与 `#seq` 是两件事：
  //    · `seq` —— 全池到达顺序（消息和事件共用），用来排序、用来对回条目；
  //    · `tid` —— **同类事件**的序号，只给水位线用。撤回#3 与 表情#12 互不相干。
  // ⚠️ 编号**不复用**：条目被上限挤掉后继续往上编（池里最老的可能是撤回#10，
  //    而水位线还可能停在 #8 —— 这是对的，剩下 #9#10 就是要交出去的那两条）。
  #nextTid(kind) {
    const n = (this.#typeSeq.get(kind) ?? 0) + 1;
    this.#typeSeq.set(kind, n);
    return n;
  }

  // 追加 + 截断。**唯一的写入口** —— 上限只在这里生效，别处 splice 一定会漏。
  #append(fields) {
    this.#seq += 1;
    const entry = { ...fields, seq: this.#seq };
    this.#items.push(entry);
    const over = this.#items.length - this.limit;
    if (over > 0) this.#items.splice(0, over);
    return entry;
  }

  // 找一条可以合并进去的旧条目（**从最新往回**，合并只可能发生在最近那条上）。
  //
  // ⚠️ 不建索引：条目会因为超限被 `splice` 掉，索引一失效就会把事件合到**别的消息**上。
  //    500 条线性扫，一天也就几十次事件，不值得为它冒这个风险。
  #findMergeable(next) {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const it = this.#items[i];
      if (it.kind !== next.kind) continue;
      if (it.actor !== next.actor) continue;

      if (next.kind === KINDS.RECALL) {
        // 撤回幂等：同一条消息只留一条，**不管隔了多久**（本地又撤一次也算同一件事）。
        if (sameSubject(it, next)) return i;
        continue;
      }
      if (next.kind === KINDS.REACTION) {
        if (it.emoji !== next.emoji) continue;
        // ⚠️ **`isAdd` 不同就不合并**（加了 vs 取消是两件事）。
        //
        // 早先这里把"来回点两下"合并成一条、`isAdd` 取最后一次 —— 在"逐条标记"模式下
        // 没问题（反正看的是当前状态）。但换成水位线之后**会丢**：合并进已经消费过的
        // 那条（`tid` 不变），水位线就不会前移，于是"他取消了"永远呈现不出来。
        if (it.isAdd !== next.isAdd) continue;
        if (sameSubject(it, next)) return i;
        continue;
      }
      if (next.kind === KINDS.POKE) {
        if (it.target !== next.target) continue;
        // 连戳：窗口内合并。窗口外是"又戳了一次"，那是新的一件事。
        if (next.tsMs - toMs(it.lastTsMs, it.tsMs) > POKE_MERGE_MS) continue;
        return i;
      }
      // 未知 kind：不合并（宁可多一条，不要把两条不相干的事搅在一起）。
      return -1;
    }
    return -1;
  }

  // #endregion

  // #region 标记（代替清空）

  // 给条目**打记号** —— "这件事对它做过了"。
  //
  // 标记写的是**时间戳**（毫秒），不是 `true`：排障时要能回答"这批是几秒前交付的、
  // 之后群里又发生了什么"，一个布尔值答不了。`isMarked()` 只判真值，不影响这个选择。
  //
  // ⚠️ **只在成功之后调**。投递抛错、落库失败时都不要打 —— 没打就是"没成功"，
  //    这样不存在"取消标记 / 回滚"这种必须写对才能不出事的路径。
  // ⚠️ 打不存在的条目（已被上限挤掉）**不报错**，只是什么也不做：调用方不该因为
  //    "池里刚好没有它"就以为投递失败。
  //
  // @param target 条目 / 条目数组 / 消息（`{messageId}`）/ 它们的混合
  // @param name   见 `MARKS`
  // @returns 实际打上标记的条目（可能为空数组）
  mark(target, name, { tsMs } = {}) {
    const key = str(name);
    if (key === '') throw new TypeError('TurnPool.mark: name 不能为空');
    const at = toMs(tsMs, this.#now());
    const hit = this.#resolve(target);
    for (const it of hit) {
      if (!it.marks) it.marks = {};
      it.marks[key] = at;
    }
    return hit;
  }

  // 给条目打**已读**（`MARKS.READ`），**并回写存储**。
  //
  // 语义只有一句：**模型已经知道这条内容了**。两条路径都会走到这里：
  //   · 投递成功（`#deliver`）—— 送到即已读；
  //   · `qq_wait` 返回（`#settleWait`）—— 这批是当场交给模型看的。
  //
  // ⚠️ **它是"已读"的唯一作者**：打完池里的标记，立刻把 `[{ date, seq }]` 交给
  //    `onMarkRead` 去写存储的 `readCount`（见构造参数）。别处**不要再直调**
  //    `markRead(store, …)` —— 那会立刻变成两条账。
  // ⚠️ 回写失败不回滚池里的标记：这一回合它确实看过了；存储那份只是投影，
  //    最坏是重启后重给一遍。
  // ⚠️ 单独开这个方法而不是让调用方写 `mark(…, 'read')`：调用点读起来是意图
  //    （"这批它看过了"），将来改标记名也只改这一处。
  //
  // @returns 实际打上标记的条目（可能为空数组：已被上限挤掉的不报错）
  markRead(target, { tsMs } = {}) {
    const hit = this.mark(target, MARKS.READ, { tsMs });
    // *池 → 存储 的标记回写**（唯一方向，见构造参数 `onMarkRead`）。
    //
    // ⚠️ 回写失败**不让内存标记回滚**：这一回合里它确实看过了，池里的账是对的；
    //    存储那份只是投影，丢了下一次标记还会补上（最坏是重启后重给一遍）。
    if (this.#onMarkRead && hit.length) {
      const refs = [];
      for (const it of hit) {
        const ref = splitId(it.id);
        if (ref) refs.push(ref);
      }
      if (refs.length) {
        try {
          this.#onMarkRead(refs);
        } catch {
          // 见上：投影失败不影响内存账。
        }
      }
    }
    return hit;
  }

  // 打过某个记号的全部条目。
  //
  // 合并进来的事件会**带着标记一起走**（同一条目），所以"撤回后又被投递一次"不会
  // 变成两条 —— 那正是合并的意义。
  marked(name) {
    const key = str(name);
    return this.#items.filter((it) => isMarked(it, key));
  }

  // *没**打过某个记号的全部条目 —— "还没交付 / 还没落库的"。
  //
  // 这是"不清池"之后的**主读取入口**：`#poolWake` 必须走 `unmarked(DELIVERED)`，
  // 否则已经交付过的消息会让它每次开 wait 都立刻返回（模型等一秒就回、再等再回，
  // 一轮空转）。
  unmarked(name) {
    const key = str(name);
    return this.#items.filter((it) => !isMarked(it, key));
  }

  // 按**定位符**找一条消息：**先内存，找不到再回源**。
  //
  // 这是"工具 → 池 → 存储"这条间接层的最小入口 —— recall 定位、引用解析、取卡片都只要它。
  //
  // ⚠️ **默认会回源**（万一那条已经被窗口挤掉了）。
  //    recall 那种场景其实永远命中内存（QQ 只允许 2 分钟内撤回，必在窗口里）；
  //    回源是兜底，免得太久以前的消息变成"这条不存在"这种谎话。
  //
  // @param ref 定位符：池内 `id`（`date#seq`）或裸 `seq`（群 msgSeq / 私聊 `MMDD#no`）
  // @returns `{ message, date, from: 'pool' | 'store' }` 或 `null`
  find(ref) {
    const key = str(ref);
    if (key === '') return null;

    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (it.id === key || (it.id && it.id.endsWith(`#${key}`))) {
        return { message: it.msg, date: splitId(it.id)?.date ?? dateOf(it.msg.tsMs), from: 'pool' };
      }
    }

    const found = this.#store?.findByRef?.(key);
    return found ? { ...found, from: 'store' } : null;
  }

  // 按 `messageId` 找一条 —— 同样内存优先、回源兜底。
  findByMessageId(messageId) {
    const id = str(messageId);
    if (id === '') return null;

    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (String(it.msg.messageId ?? '') === id) {
        return { message: it.msg, date: splitId(it.id)?.date ?? dateOf(it.msg.tsMs), from: 'pool' };
      }
    }

    const found = this.#store?.findByMessageId?.(id);
    return found ? { ...found, from: 'store' } : null;
  }

  // 在池里**搜消息** —— 所有条件都是"与"关系，可以自由组合。
  //
  //     pool.search({ seq: [100, 200] })                          // 定位符区间
  //     pool.search({ qq: ['123', '456'] })                       // 某几个人
  //     pool.search({ from: '2026-10-17 20:00', contains: '副本' }) // 某时段带某词
  //     pool.search({ unreadOnly: true, limit: 20 })              // 还欠读的
  //     pool.search({ kinds: ['image'], excludeRecalled: true })  // 只看未撤回的图
  //
  // ── 取条数的两种模式（本方法唯一的特殊语义）
  //
  //   · **给了 `seq` 区间** → 区间本身限定范围，按区间拿（**不受 `limit` 约束**）。
  //   · 其它情况 → **从最新往回**数，凑满 `limit` 就停（默认 50）。
  //
  // ── 内存不够会自动回源（见 `#needsStore`）
  //
  // 窗口没覆盖查询下界（或压根没给下界）时，整批改从存储取 —— 存储是全集，
  // 所以**不需要和内存结果合并**，也没有去重问题。
  //
  // @param options.seq            `[lo, hi]`（含端点）；单个值 = 精确匹配
  // @param options.qq / sender    发送者 QQ：一个或多个（`sender` 是旧写法，单个）
  // @param options.from/to        时间区间（毫秒 / 秒 / `Date` 可解析的字符串）
  // @param options.since/until    **unix 秒**（`qq_read_chat` 的历史口径）
  // @param options.dates          只查这几天（`['2026-10-17']`）
  // @param options.role           群内身份：`owner` / `admin` / `member`
  // @param options.kinds          msgType：`text` / `image` / `face` / `record` / `video` / `forward` / `json` / `mixed`
  // @param options.unreadOnly     只要未读（`readCount === 0`）
  // @param options.readRounds     `{ eq, min, max }` —— 按"读过几轮"筛
  // @param options.contains       正文包含（不分大小写；搜正文 + 发言人昵称）
  // @param options.excludeRecalled / includeRecalled  撤回的要不要
  // @param options.limit          默认 50（只有非 `seq` 模式生效）
  // @param options.order          `'desc'`（默认，最新在前）/ `'asc'`
  // @returns 消息记录数组：`{ ...原始记录, date }`
  search(filters = {}) {
    const f = normalizeSearch(filters);

    // ① 内存：从最新往回，凑满 `cap` 就停（`seq` 区间模式下 cap 是无穷，区间自己限条数）。
    const fromPool = this.#collectPool(f);
    if (!this.#needsStore(f, fromPool.length)) return this.#orderRows(fromPool, f);

    // ② 回源：窗口覆盖不到查询下界（或压根没给下界）时，到存储里按同一套判断再跑一遍。
    const fromStore = this.#collectStore(f);
    return this.#orderRows(fromStore ?? fromPool, f);
  }

  // 内存这一边：条目 → 消息记录（最新在前）。
  #collectPool(f) {
    const rows = [];
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const it = this.#items[i];
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      const parts = splitId(it.id);
      const date = parts?.date ?? dateOf(it.tsMs);
      if (f.dates.length && !f.dates.includes(date)) continue;
      if (!matchesSearch(it.msg, parts?.seq ?? '', f)) continue;
      rows.push({ ...it.msg, date });
      if (rows.length >= f.cap) break;
    }
    return rows;
  }

  // 存储那一边：**同一套 `matchesSearch`**，按日期倒序、每天从末尾往前。
  //
  // ⚠️ 存储是消息的**全集**（池里每条都先落过库），所以回源时**不需要和内存结果合并** ——
  //    整批用存储的结果就是准确的，也就没有"去重"这件事。
  #collectStore(f) {
    const store = this.#store;
    if (!store || typeof store.load !== 'function' || typeof store.dates !== 'function') return null;

    const dates = (f.dates.length ? f.dates : store.dates()).slice().sort().reverse();
    const rows = [];
    for (const date of dates) {
      const doc = store.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        const m = doc.messages[i];
        if (!matchesSearch(m, seqOf(m, date), f)) continue;
        rows.push({ ...m, date });
        if (rows.length >= f.cap) break;
      }
      if (rows.length >= f.cap) break;
    }
    return rows;
  }

  // 内存够不够 —— 判据是"**窗口有没有覆盖到查询的下界**"，不是"条数够不够"。
  //
  //   · 已经取满 `cap` ⇒ 更旧的再符合也挤不进来，不用回源；
  //   · 窗口里最老的一条比查询下界还新 ⇒ 下界之外可能还有候选，必须回源；
  //   · 压根没给下界（无时间/日期/seq 范围）⇒ 天然要看全历史，回源。
  #needsStore(f, got) {
    if (!this.#store) return false;
    if (got >= f.cap) return false;
    const start = this.#windowStart();
    if (!start) return true; // 池里一条消息都没有
    if (f.bySeq) {
      if (!f.numericSeq) return true;
      return Number(f.seqLo) < Number(start.seq);
    }
    if (f.dates.length) return f.dates.some((d) => d < start.date);
    if (Number.isFinite(f.fromTs)) return f.fromTs < start.tsMs;
    return true;
  }

  // 窗口里最老的那条消息（按 `tsMs`，不按到达顺序 —— 事件会打乱后者）。
  #windowStart() {
    let best = null;
    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (best === null || it.tsMs < best.tsMs) {
        best = { tsMs: it.tsMs, date: splitId(it.id)?.date ?? dateOf(it.tsMs), seq: splitId(it.id)?.seq ?? '' };
      }
    }
    return best;
  }

  // 输出顺序。收集时一律"最新在前"，`asc` 时整体翻过来。
  #orderRows(rows, f) {
    return f.order === 'asc' ? rows.slice().reverse() : rows;
  }

  // #region 门面（给工具用的最小表面）

  // 本号 —— 渲染要看它（〔本号〕/`[@你]`）。来源是 store 的账号配置，不是历史数据。
  get selfQq() {
    return String(this.#store?.selfQq ?? '');
  }

  // 有哪些日期可选（工具返回里给 AI 做下次查询用的）。
  dates() {
    return typeof this.#store?.dates === 'function' ? this.#store.dates() : [];
  }

  // 未读统计 —— **窗口内自算，更早的天回源数**。
  //
  // 为什么不能全从内存数：窗口只有 500 条，更早的未读（离线积压）根本不在池里。
  // 也不能全走存储：窗口覆盖的这几天每次都要重扫。
  unreadStats() {
    const perDay = [];
    let total = 0;
    const start = this.#windowStart();

    for (const date of this.dates()) {
      let n = 0;
      let oldest = null;
      const covered = start !== null && date >= start.date;

      if (covered) {
        for (const it of this.#items) {
          if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
          if (splitId(it.id)?.date !== date) continue;
          if ((it.msg.readCount ?? 0) !== 0) continue;
          n += 1;
          if (oldest === null) oldest = Number(it.msg.tsMs ?? 0) || null;
        }
      } else {
        const doc = this.#store?.load?.(date);
        if (!doc) continue;
        for (const m of doc.messages) {
          if ((m.readCount ?? 0) !== 0) continue;
          n += 1;
          if (oldest === null) oldest = Number(m.tsMs ?? 0) || null;
        }
      }

      if (n > 0) perDay.push({ date, unread: n, oldestTs: oldest });
      total += n;
    }
    return { total, perDay, newestUnreadTs: null };
  }

  // 订阅"有新消息落库" —— 池把 store 的 `appended` 转出来。
  //
  // 给 `qq_send` 等"发完等回推补 seq"的场景用：它们只需要知道"到货了"，
  // 不必自己拿着 store 订阅再查。
  //
  // @returns 取消订阅函数
  onAppend(fn) {
    const store = this.#store;
    if (!store || typeof store.on !== 'function' || typeof fn !== 'function') return () => {};
    const handler = (payload) => {
      try {
        fn(payload);
      } catch {
        // 订阅方抛错不该影响落库流程。
      }
    };
    store.on('appended', handler);
    return () => store.off?.('appended', handler);
  }

  // #endregion

  // 把 target 解析成池里的条目。
  //
  // 三种写法都收，因为调用方手里可能是哪一种：
  //   · **条目**（有 `seq` + `kind`）—— 来自 `all()` / `pick()`
  //   · **消息** —— 来自 `delivery.items` / `newMessages`
  //     ⚠️ 这些常常是 `{...m}` 出来的**副本**，按引用比会全部落空
  //   · 混着来
  //
  // 消息的身份由构造参数 `identity` 算（见 `constructor`），**不比较对象引用**：
  // 投递那批是 `store` 里消息的浅拷贝，引用必然不同。
  #resolve(target) {
    const list = Array.isArray(target) ? target : [target];
    const seqs = new Set();
    const ids = new Set();
    // 没有 identity 时的兜底：同一对象总该认得出自己。
    const refs = new Set();
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      if (typeof t.seq === 'number' && typeof t.kind === 'string') { seqs.add(t.seq); continue; }
      const msg = t.msg ?? t;
      refs.add(msg);
      const id = this.#idOf(msg);
      if (id) ids.add(id);
    }
    if (seqs.size === 0 && ids.size === 0 && refs.size === 0) return [];

    const hit = [];
    for (const it of this.#items) {
      if (seqs.has(it.seq)) { hit.push(it); continue; }
      if (it.id && ids.has(it.id)) { hit.push(it); continue; }
      if (it.kind === KINDS.MESSAGE && refs.has(it.msg)) hit.push(it);
    }
    return hit;
  }

  // 算一条消息的身份键。
  //
  // ⚠️ 没传 `identity` 就返回 `''` —— 那时只能按条目（`seq`）或对象引用标记。
  //    这不是"凑合能用"：调用方若拿的是 `{...m}` 副本，会**一条都标不上**。
  //    `state.js` 必须传（用 `seqOf`），否则"标记代替清池"整条设计失效。
  #idOf(msg) {
    if (!this.#identity || !msg) return '';
    try {
      return str(this.#identity(msg));
    } catch {
      // identity 是外部函数，它抛错不该把投递流程带塌 —— 大不了这条按引用匹配。
      return '';
    }
  }

  // #endregion

  // #region 水位线（整批消费）

  // 水位线当前值（没设过 = 0）。
  cursor(name) {
    return this.#cursors.get(str(name)) ?? 0;
  }

  // 前移水位线。**只在成功之后调**（与 `mark` 同一条规矩）。
  //
  // ⚠️ **编号空间由名字决定**：
  //    · `'recall'` / `'recall:shown'` → 记 `entry.tid`（该类事件的序号）
  //    · `'*wait'` → 记 `entry.seq`（全池到达序号）
  //    两种都是普通数字，**传错空间不会报错** —— 所以传值前想清楚这是哪一种。
  //
  // ⚠️ **只进不退**：传一个更小的值会被忽略。水位线一倒退，同一批东西就会被重复消费。
  // ⚠️ 接受比池里最老条目还大的编号：那些条目可能已被上限挤掉，但"消费到过这里"
  //    仍然是个事实，不该因为池变小而回退。
  // ⚠️ 名字格式不合法（空 / 只有 `*` / 冒号前为空）直接报错 —— 静默失败的代价太大。
  advance(name, toNumber) {
    const key = str(name);
    if (key === '') throw new TypeError('TurnPool.advance: name 不能为空');
    scopeOfCursor(key);
    const to = Number(toNumber);
    if (!Number.isFinite(to) || to <= this.cursor(key)) return this.cursor(key);
    this.#cursors.set(key, to);
    return to;
  }

  // 按"这批条目"前移水位线。
  //
  // 取哪个编号由名字的范围决定：
  //   · 按类型（`'recall'`）→ 这批里**该类型**最大的 `tid`
  //   · 跨类型（`'*wait'`）→ 这批里**全部条目**最大的 `seq`
  //
  // ⚠️ 空批次 / 批次里没有对应条目 → **不动**：一次"什么都没取到"不该把它推到哪里去。
  // ⚠️ 它**不检查**这批有没有被截断 —— 传进来的必须是"全部要给的"，否则会跨过没交出去的。
  advancePast(name, entries) {
    const key = str(name);
    const scope = scopeOfCursor(key);
    const list = Array.isArray(entries) ? entries : [entries];
    let max = 0;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const n = scope.all
        ? (typeof it.seq === 'number' ? it.seq : 0)
        : (it.kind === scope.kind && typeof it.tid === 'number' ? it.tid : 0);
      if (n > max) max = n;
    }
    return max > 0 ? this.advance(key, max) : this.cursor(key);
  }

  // 水位线之后的条目 —— "上次消费之后新来的"。
  //
  //   · 按类型（`'recall'` / `'recall:shown'`）→ 只返回该 `kind`，比 `tid`
  //   · 跨类型（`'*wait'`）→ 返回**全部**条目（消息 + 所有事件），比 `seq`
  //
  // ⚠️ 被上限挤掉的条目不在结果里，但水位线本身仍然正确（它只是个数字）。
  //    这正是水位线比"逐条标记"强的地方：截断不会让它失真。
  since(name) {
    const key = str(name);
    const scope = scopeOfCursor(key);
    const from = this.cursor(key);
    if (scope.all) return this.#items.filter((it) => it.seq > from);
    return this.#items.filter((it) => it.kind === scope.kind && (it.tid ?? 0) > from);
  }

  // `since(name)` 里**只要消息**（回调拿到消息本身）。
  //
  // 给 `qq_wait` 的触发判定用：它只关心"有没有人说话算叫到它"，不关心事件。
  // ⚠️ 别在调用方手写 `since(...).filter(kind === MESSAGE)` —— 那等于把
  //    "哪些东西算触发"这件事散到外面，迟早和别的判据漂移。
  sinceMessages(name) {
    return this.since(name)
      .filter((it) => it.kind === KINDS.MESSAGE)
      .map((it) => it.msg);
  }

  // #endregion

  // #region 读

  // 有没有满足 `predicate` 的**消息**（回调收到消息本身 + 条目）。短路，不分配数组。
  someMessage(predicate) {
    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE) continue;
      if (predicate(it.msg, it)) return true;
    }
    return false;
  }

  // 有没有满足 `predicate` 的**条目**（含事件）。
  some(predicate) {
    return this.#items.some(predicate);
  }

  // 满足 `predicate` 的全部条目（**不删除**）。
  pick(predicate) {
    return this.#items.filter(predicate);
  }

  // 全部消息（按到达顺序）。投递取样用。
  messages() {
    return this.#items.filter((it) => it.kind === KINDS.MESSAGE).map((it) => it.msg);
  }

  // 全部事件（按到达顺序）。
  events() {
    return this.#items.filter((it) => it.kind !== KINDS.MESSAGE);
  }

  // 全部条目（浅拷贝，外部改不到内部数组）。排障用。
  all() {
    return this.#items.slice();
  }

  // #endregion
}
