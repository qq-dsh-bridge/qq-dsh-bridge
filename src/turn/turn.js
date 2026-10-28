// 回合生命周期 —— 判断这一轮什么时候开始、结束、说没说话。
//
// 状态机在 waiting 里等两件事之一：
//   1. AI 调用等待工具（`qq_wait_for_messages`）→ 保持 waiting
//   2. AI 回合结束且没在等 → 回 sleeping
//
// "忙不忙"由插件的 `agent.status` 帧决定（见 app/wire-stream.js），**不归这里管**。
// 这里只做统计：时长、工具调用次数、它到底说没说话。
//
// 输入是插件 /events 的事件本体（`{ type, seq, time, data }`），不是旧 mux 的包装帧。
// #region 常量
import { EventEmitter } from 'node:events';

export const TURN_START = 'turn/start';
export const TURN_END = 'turn/end';
// #endregion

// #region 跟踪器

export class TurnTracker extends EventEmitter {
  constructor({ logger } = {}) {
    super();
    this.logger = logger;
    // sessionId → { startedAt, toolCalls, sentText }
    this.turns = new Map();
    // sessionId → 已处理到的 seq。
    //
    // 为什么按 seq 去重：SSE 断线续传是 `(since, last]`，边界那条会再送一次；
    // 而统计最怕重复计数（工具次数翻倍、时长重算）。seq 是插件给的单调游标，
    // 拿它当"处理到哪了"最直接。
    this.lastSeq = new Map();
  }

  // 喂一条事件。
  //
  // @param args.sessionId 会话 id（插件帧里的那个）
  // @param args.event     `{ type, seq, time, data }`
  // @returns `{ kind, sessionId }` 或 null
  handle({ sessionId, event } = {}) {
    const id = String(sessionId ?? '');
    const type = event?.type;
    if (!id || !type) return null;

    const seq = Number(event?.seq) || 0;
    const seen = this.lastSeq.get(id) ?? 0;
    if (seq && seq <= seen) return null; // 续传边界上的重复帧
    if (seq) this.lastSeq.set(id, seq);

    if (type === TURN_START) {
      this.turns.set(id, { startedAt: Date.now(), toolCalls: 0, sentText: false });
      this.emit('turn-start', { sessionId: id });
      return { kind: 'turn-start', sessionId: id };
    }

    if (type === TURN_END) {
      // ⚠️ **不能用 `Date.now()` 兜底 `startedAt`。**
      //
      // 早先写成 `?? { startedAt: Date.now() }`，于是"没收到 turn/start 就收到
      // turn/end"时 `durationMs` 恒为 0 —— 日志里像"这一轮瞬间结束、什么都没干"，
      // 实际那次跑了 173 秒、22 步工具、29403 token（实测）。看错这个会让人去查
      // 根本不存在的问题。所以宁可为 null 也别编一个 0。
      const state = this.turns.get(id) ?? null;
      this.turns.delete(id); // 必须删，否则会泄漏到下一轮
      const now = Date.now();
      const info = state
        ? { ...state, endedAt: now, durationMs: now - state.startedAt }
        : { startedAt: null, endedAt: now, durationMs: null, toolCalls: 0, sentText: false, orphan: true };
      this.emit('turn-end', { sessionId: id, ...info });
      return { kind: 'turn-end', sessionId: id, info };
    }

    const st = this.turns.get(id);
    if (!st) return null;
    if (type.startsWith('tool/')) st.toolCalls += 1;
    // lean 帧保留了 assistant 的文本块（reasoning 被剥掉），所以这里判得出"说过话"。
    else if (type === 'assistant/message' && hasText(event)) st.sentText = true;
    return null;
  }

  // 丢掉在途回合（流断开/重连时用）。
  forget(sessionId) {
    this.turns.delete(String(sessionId ?? ''));
  }

  // 用插件的首帧（hello）核对游标。
  //
  // 只在**倒退**时对齐：dsh 重启后 session 的 seq 从头开始，而我们手里还留着旧的大值 ——
  // 那样之后所有事件都会被当成"旧的"丢掉，统计从此静默失效。
  // 正常前进时**不要**动游标：首连没有游标，回放里可能有在途回合的 `turn/start`，
  // 拿 hello 的 seq 当游标会把它们全挡掉（表现为每个回合都是孤儿）。
  resync(sessionId, seq) {
    const id = String(sessionId ?? '');
    if (!id) return;
    const n = Number(seq) || 0;
    const seen = this.lastSeq.get(id) ?? 0;
    if (n && n < seen) {
      this.lastSeq.set(id, n);
      this.logger?.debug('事件游标回退（实例重启过），已对齐', { sessionId: id, from: seen, to: n });
    }
    this.turns.delete(id);
  }
  // #endregion
}

// 这条 assistant/message 里有没有真正的文本（数组里可能只有工具调用）。
function hasText(event) {
  const parts = event?.data?.message?.content;
  if (!Array.isArray(parts)) return false;
  return parts.some((p) => p?.type === 'text' && String(p.text ?? '').trim() !== '');
}
