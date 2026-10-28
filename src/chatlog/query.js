// 给 AI 的查询接口 —— 这是"AI 主动查阅"的落点。
//
// ⚠️ **只和 pool 打交道**：池是访问存储的唯一一层，
//    工具层拿不到 store —— 想绕也绕不过去。窗口覆盖不到的查询由池自己去回源。
//
// ── 默认**不**改已读状态
//
// 为什么默认不标：检索归检索。如果查一次历史就把未读清空了，
// "我还欠什么没读"这个判断就废了 —— AI 查完上周三的聊天，
// 反而以为自己把今天的未读也处理完了。
//
// ── 为什么必须做成工具而不是让 AI grep
//
// 一天一个 JSON、跨天、游标、撤回标记 —— 这些语义 grep 表达不了：
//   · 跨天要读多个文件并按时间归并
//   · "未读"是 readCount 而不是文本内容
//   · 撤回是 state 里的标记，grep 正文会漏
// 而且 grep 一个几万行的 JSON 很慢。所以给结构化参数，不给文本。

import { messageRow } from './segments.js';

// 筛选参数的 JSON Schema **只有一份**：`plugins/qq-dsh-tools/lib/tools/read-chat.js` 的 `PARAMETERS`
// —— 模型看到的就是那一份。
//
// ⚠️ **不要再加副本**：这里曾有一份 `QUERY_SCHEMA`，从**首个提交**起就没有
// 任何消费者，还和真身漂移（少了 `raw`、留着 v2 时代的 `chat/index.json`）。
// 留着它只会在下次有人 import 时把过期的那份变成真的。
//
// ⚠️ 改筛选参数只改那个工具文件。`readChat()` 只是**按名字读 `args`**、
//    不做校验，所以两侧没有第二份需要同步 —— 这正是它该待在被渲染的地方的原因。

// 执行一次查询。
//
// @param pool TurnPool（**不是 store** —— 池负责在窗口不够时回源）
// @param args 见 plugins/qq-dsh-tools/lib/tools/read-chat.js 的 PARAMETERS
// @returns 给 AI 的结果（含摘要，避免它再查一次才知道有多少）
export function readChat(pool, args = {}) {
  // `markRead` 参数暂时忽略（见下），不要解构出来当"用到了"。
  const { raw = false, ...filters } = args;

  // `role` 的口径：落盘里是 `groupOwner / admin / member`（见 store.js 的 normalizeGroupRole），
  // 但让模型写 `groupOwner` 很别扭 —— 它只会写 `owner`。这里替它翻一次，
  // 免得"筛群主永远筛不到"变成一个查不出来的坑。
  if (typeof filters.role === 'string') {
    const k = filters.role.trim().toLowerCase();
    filters.role = (k === 'owner' || k === 'groupowner') ? 'groupOwner'
      : k === 'admin' ? 'admin'
        : k === 'member' ? 'member'
          : filters.role;
  }

  const rows = pool.search({
    ...filters,
    limit: filters.limit ?? 50,
    order: filters.order ?? 'desc',
  });

// ⚠️ **`markRead` 参数暂时不生效**（留了接口，后面再实现）。
  //
  // 标记的唯一作者是池（`pool.markRead()` → 回写存储）；而这里查到的常常是很旧的历史，
  // 早被池的 500 条窗口挤掉了，从这条路径直接写存储会成为第三个写入端。
  // 参数先保留在 schema 里（模型可以照常传），行为是"查得到、不改已读"。
  const marked = 0;

  // 返回**结构化行**（`sender` 是对象、`quote` 是嵌套对象）。
  //
  //    那种行格式只用于**桥接投递提示词**时的 `[lines:N]` 段
  //    （见 deliver.js `renderContext`）。给 AI 反而是限制：它拿到
  //    结构化数组能自己决定怎么呈现，而大块文本里想精确取某个 qq、
  //    想按字段筛选时还得回头再查一次。
  //
  //    每条的 `segmentsText` 已经把正文文本化了 —— 想"读起来方便"
  //    就只看那个字段，没必要另做一个工具。
  return {
    // 命中的消息（见 messageRow —— 与 qq_wait 的返回同一形状）。
    //
    // `raw` 决定要不要**额外**带原始 `segments` —— 默认不带
    // （保持"只有一套读法"），需要精确字段时才传（见 messageRow 的说明）。
    messages: rows.map((m) => toRow(m, { selfQq: pool.selfQq, raw })),
    count: rows.length,
    marked,
    // 未读总数，让 AI 一眼知道还剩多少要看
    unreadRemaining: pool.unreadStats().total,
    // 可用日期列表（下次查询用得上）
    availableDates: pool.dates(),
  };
}


// 未读概览 —— 让 AI 先看这个再决定要不要细查。
export function unreadOverview(pool) {
  const s = pool.unreadStats();
  return {
    totalUnread: s.total,
    perDay: s.perDay,
    availableDates: pool.dates(),
    // 提示：未读是跨天的，取未读会自动回溯
    hint: s.total > 0
      ? `还有 ${s.total} 条未读（跨 ${s.perDay.length} 天）。用 readChat 按 unreadOnly 或 readRounds 筛。`
      : '当前没有未读。',
  };
}

// 一条消息 → 给 AI 的行。
//
// *直接委托给 `messageRow`** —— 这个形状同时被 `qq_read_chat` 与
// `qq_wait` 使用，两处必须一模一样，所以实现只有一份
// （见 segments.js `messageRow` 的说明：曾经分叉出"同名不同义"）。
export function toRow(m, { selfQq = '', raw = false } = {}) {
  return messageRow(m, { selfQq, raw });
}
