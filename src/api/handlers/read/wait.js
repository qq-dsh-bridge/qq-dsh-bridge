
// qq_wait

export const op = 'wait';
export const logsAsSend = true;

import { messageRow } from '../../../chatlog/segments.js';

function normalizeQq(v, logger) {
  let raw = v;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        raw = JSON.parse(s);
      } catch {
        raw = s;
      }
    }
    if (typeof raw === 'string' && /[\s,，、]/.test(raw)) raw = raw.split(/[\s,，、]+/);
  }
  const arr = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
  const out = [];
  for (const x of arr) {
    const s = String(x ?? '').trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) out.push(s);
    else logger?.warn('qq_wait：qq 里有非纯数字的项，已忽略', { value: s.slice(0, 40) });
  }
  return out;
}

export async function run({ registry, logger }, convKey, args, meta = {}) {
  const conv = registry.get(convKey);
  const budget = conv.nextWaitMs();

  // 免 @ 名单：填了的人不用 @ 也算叫到它，且不受 windowWho 约束。
  // 判定在 gate.js::waitHit，这里只做归一。
  const qqList = normalizeQq(args?.qq, logger);
  logger.info('qq_wait 开始等', { conv: convKey, qq: qqList, budgetMs: budget });

  // 额度用完就别调 waitForMessages —— 传 0 会被兜成默认 5 分钟，白送一轮。
  if (budget <= 0) {
    logger.debug('本轮等待额度已用完，直接返回', {
      conv: convKey, waitedTotalMs: conv.waitedTotalMs,
    });
    return {
      arrived: false,
      timeout: true,
      budgetExhausted: true,
      note: '本轮等待的总时长已经用完了（各次 qq_wait 累计达上限）—— '
        + '请直接收尾，不要再等。对方再 @ 你会重新唤醒你。',
      newMessages: [],
      messages: [],
      omitted: 0,
    };
  }

  const result = await conv.waitForMessages({
      timeoutMs: budget, maxMs: budget, qq: qqList,
      // 消费者（这条 HTTP 请求）断了就别再挂着 —— 见 turn/wait.js 的 abort 处理
      signal: meta?.signal,
  });

  // 与 qq_read_chat 共用 messageRow —— 两处曾各自实现，分叉出"同名不同义"。
  // mentionsYou 也由它统一给出：模型分不清"谁说的"和"在跟我说"，就会该回不回。
  const selfQq = conv.turnPool.selfQq;
  const shape = (m) => messageRow(m, { selfQq });

  return {
    arrived: result.arrived,
    timeout: result.timeout,
    // 被外部结束（回合收摊 / 进程退出）：既没等到也没超时，必须显式告诉模型，
    // 否则它只会看到两个 false，无从判断。
    ...(result.cancelled ? { cancelled: true, note: '这次等待被结束了（回合收摊），不是超时 —— 有新消息会重新叫醒你。' } : {}),
    // 整条（与 newMessages 同形），不是只给发言人 —— 它接下来多半要引用这句，
    // 那需要 `no`；两处同形也免得 AI 以为是两条不同的消息。
    from: result.from ? shape(result.from) : null,
    // 触发了才是全量新消息（含群友，按 wakeLimit 截断）；没触发就给空 ——
    // 没人叫它时倒一堆闲聊，只会让它自己找话接。
    newMessages: result.newMessages.map(shape),
    // 超过 replyLimit 没列出的条数。不说它会以为这就是全部。
    omitted: result.omitted > 0 ? result.omitted : undefined,
    omittedNote: result.omitted > 0
      ? `更早还有 ${result.omitted} 条没列出（只给最近 ${result.newMessages.length} 条）。要看就用 qq_read_chat。`
      : undefined,
    waitedMs: result.waitedMs,
  };
}
