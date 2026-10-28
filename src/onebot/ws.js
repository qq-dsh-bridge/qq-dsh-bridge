// OneBot WebSocket 事件客户端（SnowLuma :3001）。
//
// 这个文件承载了旧实现用**真实事故**换来的全部可靠性知识。每条都有实测依据，
// 不要因为"看起来多余"而删掉：
//
// ── 1. 心跳必须是**主动探针**，不能靠"多久没事件"
//
//   TCP 连接会「半开」：一端以为还连着，实际对端早已不可达。
//   ⚠️ **必须主动探活**：半开时两端都不报错、不触发 onclose，而 SnowLuma 对
//   掉线期间的消息**不重放** —— 那些消息永久丢失。
//   **而且双方都不报错、不触发 onclose**。更糟的是 SnowLuma 对掉线期间的消息
//   **不重放** —— 那些消息永久丢失。
//
//   为什么不用「多久没事件就重连」：群里安静几分钟是正常的，那会造成无谓重连。
//   **必须主动探测**才能区分「安静」和「死了」。
//
// ── 2. 重连必须幂等，用**连接代次**而不是"摘处理器"
//
//   重连用**代次计数器**：摘处理器那条路不够 —— 旧 socket 稍后触发 onclose 仍会
//   再排一次重连，结果"两个连接同时活着、各自收一半事件"（日志里出现过同一秒
//   两条 `WS 断开 code=1006`）。每个连接带一个 gen，回调里先校验
//   `myGen === this.gen`，不匹配就直接 return —— 任何路径都无法造成重复重连。
//
// ── 3. 握手期必须单独设超时
//
//   SnowLuma 启动初期事件循环可能被 member warmup（上千成员建档）占满 ——
//   它的 `:3001 listening` 日志早早打出来了，但实际 accept 会被拖很久
//   （**实测拖过 72 秒**）。而 WebSocket 握手挂起时**既不会触发 onopen
//   也不会触发 onclose**，只靠 onclose 重试就会一直干等，一次重试都没有。
//
// ── 4. echo 关联必须校验
//
//   响应帧靠 `echo` 找对应请求：每个请求带唯一 echo，再用超时兜底，避免回包
//   错配、以及挂起的 promise 永不 settle。
//   这里每个请求带唯一 echo，且用超时兜底，避免挂起的 promise 永不 settle。

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { classifyFrame, OneBotParseError } from './parse.js';
import { normalizeBase } from './http.js';

// #region 错误与常量

export class OneBotWsError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'OneBotWsError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

// #endregion

// #region 客户端

export class OneBotWsClient extends EventEmitter {
  constructor({
    wsUrl,
    accessToken = '',
    heartbeatMs = 45_000,
    heartbeatTimeoutMs = 12_000,
    connectTimeoutMs = 20_000,
    reconnect = {},
    logger,
    WebSocketImpl = globalThis.WebSocket,
    jitter = Math.random,
  } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.heartbeatMs = heartbeatMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectMinMs = reconnect.minDelayMs ?? 1000;
    this.reconnectMaxMs = reconnect.maxDelayMs ?? 30_000;
    this.logger = logger;
    this.WebSocket = WebSocketImpl;
    this.jitter = jitter;
    this.gen = 0;
    this.ws = null;
    this.state = 'idle';
    this.pending = new Map(); 
    this.heartbeatTimer = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUs = false;
    this.lastFrameAt = 0;
    this.upstreamGood = null;
  }

  get connected() {
    return this.state === 'open' && this.ws?.readyState === 1;
  }

  applyConfig({ wsUrl, accessToken, heartbeatMs, heartbeatTimeoutMs, connectTimeoutMs } = {}) {
    const wsChanged = wsUrl !== undefined && normalizeBase(wsUrl) !== normalizeBase(this.wsUrl);
    const tokenChanged = accessToken !== undefined && accessToken !== this.accessToken;
    if (wsUrl !== undefined) this.wsUrl = normalizeBase(wsUrl);
    if (accessToken !== undefined) this.accessToken = accessToken;
    if (heartbeatMs !== undefined) this.heartbeatMs = heartbeatMs;
    if (heartbeatTimeoutMs !== undefined) this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    if (connectTimeoutMs !== undefined) this.connectTimeoutMs = connectTimeoutMs;
    if (wsChanged || tokenChanged) {
      this.logger?.info('OneBot 连接参数变更，正在重连', { wsUrl: this.wsUrl, tokenChanged });
      void this.reconnectNow();
    }
  }

  connect() {
    if (this.state === 'connecting' || this.state === 'open') return;
    this.closedByUs = false;
    this.#open();
  }

  #open() {
    this.#teardownCurrent('reopen');

    const myGen = ++this.gen;
    this.state = 'connecting';

    const url = this.#buildUrl();
    this.logger?.debug('OneBot 正在连接', { url: redactUrl(url), gen: myGen });

    let ws;
    try {
      ws = new this.WebSocket(url);
    } catch (error) {
      this.logger?.error('OneBot 创建连接失败', { error: error.message });
      this.#scheduleReconnect('create-failed');
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (myGen !== this.gen) return;
      if (this.state === 'connecting') {
        this.logger?.warn('OneBot 握手超时，强制重试', {
          connectTimeoutMs: this.connectTimeoutMs,
          hint: 'SnowLuma 启动初期可能被 member warmup 占满事件循环，实测 accept 可拖过 72 秒。',
        });
        this.#forceReconnect('handshake-timeout');
      }
    }, this.connectTimeoutMs);
    this.connectTimer.unref?.();

    ws.addEventListener('open', () => {
      if (myGen !== this.gen) return; 
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.state = 'open';
      this.reconnectAttempts = 0;
      this.lastFrameAt = Date.now();
      this.logger?.info('OneBot 已连接', { gen: myGen });
      this.emit('open', { gen: myGen });
      this.#startHeartbeat();
      this.probe().then(
        (status) => this.emit('probe', { ok: true, status }),
        (error) => this.emit('probe', { ok: false, error }),
      );
    });

    ws.addEventListener('message', (event) => {
      if (myGen !== this.gen) return;
      this.lastFrameAt = Date.now();
      this.#onFrame(event.data);
    });

    ws.addEventListener('error', (event) => {
      if (myGen !== this.gen) return;
      this.logger?.warn('OneBot 连接错误', {
        message: event?.message || '(无详情)',
        code: event?.code,
        name: event?.name,
      });
    });

    ws.addEventListener('close', (event) => {
      if (myGen !== this.gen) return; 
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.#stopHeartbeat();
      this.state = 'closed';
      this.#rejectAllPending(new OneBotWsError('连接已关闭'));
      this.logger?.warn('OneBot 连接断开', { code: event?.code, reason: event?.reason ?? '' });
      this.emit('close', { code: event?.code, reason: event?.reason });
      if (!this.closedByUs) this.#scheduleReconnect(`close:${event?.code}`);
    });
  }

  #buildUrl() {
    const base = normalizeBase(this.wsUrl);
    const url = new URL(base.endsWith('/') ? base : `${base}/`);
    if (this.accessToken) {
      url.searchParams.set('access_token', this.accessToken);
    }
    return url.toString();
  }

  #onFrame(data) {
    let frame;
    try {
      frame = classifyFrame(typeof data === 'string' ? data : String(data));
    } catch (error) {
      this.logger?.warn('OneBot 收到无法解析的帧', {
        error: error instanceof OneBotParseError ? error.message : String(error),
        preview: previewOf(data),
      });
      this.emit('malformed', { data, error });
      return;
    }

    if (frame.kind === 'response') {
      this.#resolvePending(frame.response);
      this.emit('response', frame.response);
      return;
    }

    if (frame.kind === 'event') {
      this.#trackUpstreamHealth(frame.event);
      this.emit('event', frame.event);
      return;
    }

    this.logger?.debug('OneBot 收到未知帧类型', { reason: frame.reason });
    this.emit('unknown', frame);
  }

  #trackUpstreamHealth(event) {
    const status = event?.status;
    if (status && typeof status === 'object' && 'good' in status) {
      const good = Boolean(status.good);
      if (good !== this.upstreamGood) {
        this.upstreamGood = good;
        this.logger?.[good ? 'info' : 'warn']('OneBot 上游健康状态变化', { good, online: Boolean(status.online) });
        this.emit('upstream-health', { good, online: Boolean(status.online), raw: status });
      }
    }
  }

  #resolvePending(response) {
    const echo = response?.echo;
    if (echo === undefined || echo === null) return; 
    const entry = this.pending.get(String(echo));
    if (!entry) {
      this.logger?.debug('收到无人认领的响应', { echo: String(echo) });
      return;
    }
    this.pending.delete(String(echo));
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  #rejectAllPending(error) {
    for (const [echo, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(echo);
    }
  }

  call(action, params = {}, { timeoutMs } = {}) {
    if (!this.connected) {
      return Promise.reject(new OneBotWsError('OneBot 未连接，无法调用动作', {
        hint: '检查 SnowLuma 是否在运行、snowluma.wsUrl 是否正确。',
      }));
    }
    const echo = `${action}-${crypto.randomUUID()}`;
    const timeout = timeoutMs ?? this.heartbeatTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotWsError(`动作 ${action} 在 ${timeout}ms 内无响应`));
      }, timeout);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new OneBotWsError(`动作 ${action} 发送失败：${error.message}`));
      }
    });
  }


  async probe({ timeoutMs } = {}) {
    const response = await this.call('get_status', {}, { timeoutMs: timeoutMs ?? this.heartbeatTimeoutMs });
    const result = response?.data ?? {};
    return { online: Boolean(result.online), good: Boolean(result.good), raw: result };
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    if (!(this.heartbeatMs > 0)) return;
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          const status = await this.probe();
          this.logger?.debug('OneBot 心跳正常', { online: status.online, good: status.good });
          this.emit('heartbeat-ok', status);
        } catch (error) {
          this.logger?.warn('OneBot 心跳无响应，判定连接已死并重连', {
            error: error.message,
            hint: '半开连接两端都不会报错，必须主动探测；SnowLuma 不重放掉线期间的消息。',
          });
          this.emit('heartbeat-timeout', { error });
          this.#forceReconnect('heartbeat-timeout');
        }
      })();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  #forceReconnect(reason) {
    this.logger?.debug('强制重连', { reason, gen: this.gen });
    this.#teardownCurrent(reason);
    this.#scheduleReconnect(reason);
  }


  #teardownCurrent(reason) {
    const old = this.ws;
    this.ws = null;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.#stopHeartbeat();
    this.#rejectAllPending(new OneBotWsError(`连接被拆掉（${reason}）`));
    if (old) {
      try {
        old.close?.(1000, reason);
      } catch {
       
      }
    }
    if (this.state !== 'idle') this.state = 'closed';
  }


  #scheduleReconnect(reason) {
    if (this.closedByUs) return;
    if (this.reconnectTimer) return; 

    this.reconnectAttempts += 1;
    const base = Math.min(this.reconnectMinMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxMs);
    const delay = Math.round(base * (0.8 + this.jitter() * 0.4));

    this.logger?.info('OneBot 计划重连', { reason, attempt: this.reconnectAttempts, delayMs: delay });
    this.emit('reconnect-scheduled', { reason, attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUs) return;
      this.#open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // 立即重连（配置变更、手动触发）。
  async reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.state = 'idle';
    this.#open();
  }

  // 主动关闭，不再自动重连。
  close(code = 1000, reason = 'client shutdown') {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#teardownCurrent(reason);
    this.state = 'closed';
    try {
      this.ws?.close?.(code, reason);
    } catch {
      // 忽略
    }
  }
}

// #endregion

// #region 工具函数

// `normalizeBase` 从 `http.js` 借（那里是唯一实现）—— 两个文件都用它判断
// "地址变了没"，各写一份的后果是"配置没改却重连"或"改了却不重连"。

// 日志里不打 token。
function redactUrl(url) {
  return String(url).replace(/access_token=[^&]+/, 'access_token=<redacted>');
}

function previewOf(data) {
  const s = typeof data === 'string' ? data : String(data);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// #endregion
