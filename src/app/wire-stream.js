// 订阅 dsh 的事件流，并把插件的帧直接喂给状态机与会话统计。

// #region 接线

import { TurnTracker } from '../turn/turn.js';

export function wireTurnTracking({
  host, logger, registry, sessionMap,
  resubscribeDelayMs = 2000,
  maxReplaySpread = 400,
}) {
  const turnTracker = new TurnTracker({ logger });

  // #region 状态
  const convOf = (sessionId) => [...registry.conversations.values()].find(
    (c) => sessionMap.get(c.key) === sessionId,
  );

  const lastKnown = new Map();

  const setRunning = (conv, running, source) => {
    if (!conv) return;
    if (conv.agentRunning === running) return;
    logger.info('agent 状态（权威）', { conv: conv.key, agentRunning: running, source });
    conv.setAgentRunning(running, source);
  };

  const applyStatus = (sessionId, running) => {
    const id = String(sessionId ?? '');
    if (!id) return;
    lastKnown.set(id, running === true);
    setRunning(convOf(id), running === true, 'status');
  };

  const applyKnown = () => {
    for (const conv of registry.conversations.values()) {
      const sid = sessionMap.get(conv.key);
      if (!sid || !lastKnown.has(sid)) continue;
      setRunning(conv, lastKnown.get(sid) === true, 'cache');
    }
  };

  // 对账：补上"订阅建立之前"的状态，也填满 lastKnown（失败只告警，对账是补强不是承重）。
  const reconcile = async (why) => {
    try {
      const out = await host.sessions({ cold: false, titles: false });
      const items = out?.sessions ?? [];
      for (const s of items) if (s?.sessionId) lastKnown.set(String(s.sessionId), s.status === 'running');
      applyKnown();
      logger.info('权威状态对账完成', {
        why, sessions: items.length, mapped: registry.conversations.size,
      });
    } catch (error) {
      logger.warn('权威状态对账失败（继续用推送）', { why, error: String(error) });
    }
  };
  // #endregion

  // #region 订阅
  const followed = new Set();
  // sessionId → 已收到的最大 seq（续传游标）。
  const lastSeq = new Map();
  let stopped = false;
  let abort = null;
  let gen = 0;         // 每次连接一个代号：旧连接收尾时靠它对号，别和新连接抢重试
  let retry = null;
  let attempts = 0;    // 连续失败次数（退避用）
  let helloSeen = false;

  // 续传起点：有游标就显式带上，否则断线期间的 turn 事件永远补不回来。
  // seq 是每个会话各自的，所以要取最小值；差得太多宁可不续传（丢统计，
  // 也好过为一个会话把别的会话几千条历史全刷一遍）。
  const sinceFor = (sessions) => {
    const known = sessions.map((id) => lastSeq.get(id)).filter((n) => Number.isFinite(n));
    if (!known.length) return undefined;
    const min = Math.min(...known);
    const max = Math.max(...known);
    return max - min > maxReplaySpread ? undefined : min;
  };

  const open = () => {
    if (stopped || followed.size === 0 || abort) return;
    const controller = new AbortController();
    const myGen = gen;
    abort = controller;
    helloSeen = false;
    void run(myGen, controller);
  };

  async function run(myGen, controller) {
    const sessions = [...followed];
    try {
      await host.subscribe({
        sessions,
        since: sinceFor(sessions),
        lean: true,
        signal: controller.signal,
        onFrame,
      });
      // 服务端正常收尾（极少见）也按断线处理，走下面的重连。
    } catch (error) {
      if (myGen !== gen || stopped) return;  // 主动重连/退出造成的 abort，不是故障
      // 404 = 订阅的会话里有一个已经不在了（被删/换实例）。不摘掉它就会永远重连失败。
      if (error?.status === 404) await dropMissing();
      logger.warn('事件流断开，稍后重连', {
        error: String(error?.message ?? error), attempts,
      });
    } finally {
      if (abort === controller) abort = null;
      if (myGen === gen && !stopped) schedule();
    }
  }

  // 断线退避 2s → 4s → … 上限 30s（dsh 重启期间别把日志刷满）。
  function schedule() {
    clearTimeout(retry);
    const delay = Math.min(resubscribeDelayMs * 2 ** Math.min(attempts, 4), 30_000);
    attempts += 1;
    retry = setTimeout(() => { retry = null; open(); }, delay);
    retry.unref?.();
  }

  // 换订阅集合：掐掉旧连接立刻重连（不排队等重试间隔）。
  function reopen(reason) {
    logger.debug('事件流重订阅', { reason, sessions: followed.size });
    gen += 1;
    attempts = 0;
    const old = abort;
    abort = null;
    old?.abort();
    open();
  }

  async function dropMissing() {
    try {
      const out = await host.sessions({ cold: true, titles: false });
      const alive = new Set((out?.sessions ?? []).map((s) => String(s.sessionId)));
      for (const id of [...followed]) {
        if (alive.has(id)) continue;
        followed.delete(id);
        lastSeq.delete(id);
        logger.warn('会话已不存在，退出事件订阅', { sessionId: id });
      }
      attempts = 0;
    } catch (error) {
      logger.debug('摘除失效会话失败', { error: String(error) });
    }
  }

  // 插件帧 → 状态机 / 统计。**这里就是唯一的落点**，没有中间层。
  function onFrame({ type, id, data }) {
    const sessionId = String(data?.sessionId ?? '');

    // 任何一帧都说明"权威端还在" —— 看门狗（state.sweep）只认这个时间戳。
    // 放在最前面：hello / status / event / lifecycle 都算，不挑类型。
    if (sessionId) convOf(sessionId)?.touchAlive();

    if (type === 'hello') {
      // 首帧带该会话当前 seq 与忙闲：游标以服务器为准（实例重启后 seq 会从头计数）。
      if (sessionId) lastSeq.set(sessionId, Number(data?.seq) || 0);
      applyStatus(sessionId, data?.status === 'running');
      turnTracker.resync(sessionId, data?.seq);
      applyKnown(); // 新会话可能就是在这时露头的
      if (!helloSeen) {
        helloSeen = true;
        attempts = 0;
        void reconcile('hello');
      }
      return;
    }

    if (sessionId && id !== undefined) {
      lastSeq.set(sessionId, Number(id) || lastSeq.get(sessionId) || 0);
    }

    if (type === 'agent.status') {
      applyStatus(sessionId, data?.status === 'running');
      return;
    }
    if (type === 'session.event') {
      turnTracker.handle({ sessionId, event: data.event });
      return;
    }
    if (type === 'session.lifecycle') {
      // 路由把 lifecycle 事件摊平进了 data：{ sessionId, type, seq, time }
      turnTracker.handle({
        sessionId,
        event: { type: data?.type, seq: Number(data?.seq) || 0, time: data?.time ?? Date.now() },
      });

      // 会话/agent 被销毁
      const kind = String(data?.type ?? '');
      if (kind.endsWith('disposed')) {
        const conv = convOf(sessionId);
        if (conv) {
          conv.waits.cancel('disposed');
          conv.setAgentRunning(false, 'disposed');
          if (kind === 'session/disposed') {
            sessionMap.delete(conv.key);
            followed.delete(String(sessionId));
            lastSeq.delete(String(sessionId));
          }
        }
      }
      return;
    }
  }

  const stream = {
    start: () => { open(); return stream; },
    follow(sessionId) {
      const id = String(sessionId ?? '');
      if (!id || followed.has(id)) return;
      followed.add(id);
      if (abort) reopen('follow');
      else open();
    },
    unfollow(sessionId) {
      if (!followed.delete(String(sessionId ?? ''))) return;
      if (abort) reopen('unfollow');
    },
    stop() {
      stopped = true;
      gen += 1;
      clearTimeout(retry);
      retry = null;
      abort?.abort();
      abort = null;
    },
    get following() { return [...followed]; },
  };
  // #endregion

  // #region 回合统计
  turnTracker.on('turn-start', ({ sessionId }) => {
    logger.debug('回合开始（仅统计）', { conv: convOf(sessionId)?.key, sessionId });
  });
  turnTracker.on('turn-end', ({ sessionId, durationMs, toolCalls, sentText, orphan }) => {
    logger.debug('回合结束（仅统计）', {
      conv: convOf(sessionId)?.key, sessionId, durationMs, toolCalls, sentText, orphan,
    });
  });
  // #endregion

  stream.start();
  return { stream, turnTracker };
}
// #endregion
