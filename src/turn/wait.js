// `qq_wait` 的生命周期


import { CURSORS, MARKS } from './pool.js';
import { takeMessages } from './take.js';
import { normalizeWho, waitHit, evaluateWait } from './gate.js';

export class Waits {
  constructor(host) {
    this.host = host;
    this.active = null;
    this.waitedTotalMs = 0;
  }

  get activeWait() {
    return this.active;
  }

  // 开始等
  wait({ timeoutMs = 300_000, maxMs = 1_800_000, quietMs = 0, qq } = {}) {

    if (this.active) return this.active.promise;

    this.host.notifyActivity();

    const waitedFromTs = Date.now();

    const idleMs = Math.max(1, Number(timeoutMs) || 300_000);
    const capMs = Math.max(idleMs, Number(maxMs) || idleMs);
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });

    const timer = setTimeout(() => this.#settle('timeout'), idleMs);
    timer.unref?.();

    const capTimer = setTimeout(() => this.#settle('timeout'), capMs);
    capTimer.unref?.();

    const wanted = (Array.isArray(qq) ? qq : (qq === undefined ? [] : [qq]))
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);

    this.active = {
      promise,
      resolveFn,
      waitedFromTs,
      timeoutMs: idleMs,
      maxMs: capMs,
      quietMs,
      timer,
      capTimer,
      qq: wanted,
      lastActivityTs: waitedFromTs,
    };

    if (this.poolWake()) {
      const t = setTimeout(() => this.#settle('arrived'), 0);
      t.unref?.();
    }
    return promise;
  }

  // 主动结束
  cancel(how = 'cancelled') {
    if (!this.active) return;
    this.noteEnd(how);
    this.#settle('cancelled');
  }

  refresh() {
    const w = this.active;
    if (!w) return false;
    const now = Date.now();
    // 总上限已到：不续。剩下的交给 capTimer，它会立刻到点。
    if (now - w.waitedFromTs >= w.maxMs) return false;

    w.lastActivityTs = now;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.#settle('timeout'), w.timeoutMs);
    w.timer.unref?.();
    return true;
  }

  allows(m) {
    const w = this.active;
    if (!w) return false;
    return waitHit(m, {
      selfQq: this.host.store.selfQq,
      who: normalizeWho(this.host.config.window?.who),
      ownerQq: this.host.ownerQq,
      qq: w.qq,
    });
  }

  // 池里有没有算等到的消息
  poolWake() {
    return this.host.turnPool
      .sinceMessages(CURSORS.WAIT)
      .some((m) => this.allows(m));
  }


  notify(message) {
    const w = this.active;
    if (!w) return;
    if (message && !this.allows(message)) return;

    if (w.quietMs > 0) {
      if (w.recheckTimer) clearTimeout(w.recheckTimer);
      w.recheckTimer = setTimeout(() => this.#settle('arrived'), w.quietMs);
      w.recheckTimer.unref?.();
      return;
    }
    this.host.decider.waitReturn({
      conv: this.host.key,
      pool: this.host.turnPool,
      selfQq: this.host.store.selfQq,
      w,
      message,
      isCurrent: () => this.active === w,
      onArrived: () => this.#settle('arrived'),
    });
  }

  noteEnd(how) {
    const w = this.active;
    if (!w) return;
    this.host.decideLog?.write({
      ts: Date.now(),
      conv: this.host.key,
      kind: 'wait-end',
      mode: this.host.judge?.mode ?? 'off',
      act: how,
      reason: how === 'sleep' ? '回合结束' : (how === 'disposed' ? '会话已销毁' : '外部中断'),
      ms: Math.max(0, Date.now() - (Number(w.waitedFromTs) || Date.now())),
      waitedMsQueued: Number(w.qq?.length) || 0,
      qq: Array.isArray(w.qq) ? w.qq : [],
    });
  }

  budgetMs() {
    const perCall = Number(this.host.config.waitDefaultMs) > 0
      ? Number(this.host.config.waitDefaultMs)
      : 300_000;
    const total = Number(this.host.config.waitMaxMs) > 0
      ? Number(this.host.config.waitMaxMs)
      : 1_800_000;
    const remaining = total - (this.waitedTotalMs || 0);
    return Math.max(0, Math.min(perCall, remaining));
  }

  resetBudget() {
    this.waitedTotalMs = 0;
  }

  #settle(how) {
    const host = this.host;
    const w = this.active;
    if (!w) return;
    this.active = null;
    clearTimeout(w.timer);
    if (w.capTimer) clearTimeout(w.capTimer);
    if (w.recheckTimer) clearTimeout(w.recheckTimer);

    this.waitedTotalMs = (this.waitedTotalMs || 0) + Math.max(0, Date.now() - w.waitedFromTs);
    const takeLimit = Number(host.config.replyLimit) > 0 ? Number(host.config.replyLimit) : 20;
    const { messages: taken, omitted } = takeMessages({ store: host.store, pool: host.turnPool, limit: takeLimit });

    const evaluation = evaluateWait({
      who: normalizeWho(host.config.window?.who),
      ownerQq: host.ownerQq,
      messages: taken,
      selfQq: host.store.selfQq,
      qq: w.qq,
    });

    const result = {
      arrived: evaluation.arrived,
      timeout: how === 'timeout' && !evaluation.arrived,
      ...(how === 'cancelled' ? { cancelled: true } : {}),
      from: evaluation.from,
      messages: evaluation.messages,
      newMessages: evaluation.arrived ? taken : [],
      omitted: evaluation.arrived ? omitted : 0,
      waitedMs: Date.now() - w.waitedFromTs,
    };

    if (result.newMessages.length && how === 'arrived') {
      if (host.agentRunning === false) {
        host.logger?.warn('qq_wait 返回时回合已结束：这批不标已读（结果没人接）', {
          conv: host.key, count: result.newMessages.length,
        });
      } else {
        host.turnPool.markRead(result.newMessages);
        host.turnPool.mark(result.newMessages, MARKS.DELIVERED);
      }
    }

    w.resolveFn(result);

    // 推进 wait 判定水位线
    host.turnPool.advancePast(CURSORS.WAIT, host.turnPool.all());
  }
}
