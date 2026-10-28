// 插件侧客户端（qq-dsh-host，默认 127.0.0.1:3130）。
//
// 桥接访问 dsh 的唯一入口：会话、投递、标题、归档、事件流全走这里，
// 不再碰 dsh web 的 /api 协议（那套是内部协议，随版本变）。

import fs from 'node:fs';

// #region 错误

export class HostClientError extends Error {
  constructor(message, { status, path, body, hint } = {}) {
    super(message);
    this.name = 'HostClientError';
    this.status = status;
    this.path = path;
    this.body = body;
    this.hint = hint;
  }
  toString() {
    const bits = [this.name + ': ' + this.message];
    if (this.path) bits.push('  path: ' + this.path);
    if (this.status) bits.push('  status: ' + this.status);
    if (this.hint) bits.push('  ' + this.hint);
    return bits.join('\n');
  }
}

// #endregion

// #region 客户端

export function createHostClient({ baseUrl, tokenFile, timeoutMs = 30_000, logger } = {}) {
  if (!baseUrl) throw new Error('host-client: 缺少 baseUrl');
  if (!tokenFile) throw new Error('host-client: 缺少 tokenFile（state/host-token）');

  const root = String(baseUrl).replace(/\/+$/, '');

  // 每次现读：换令牌不用重启。
  const auth = () => ({ authorization: 'Bearer ' + String(fs.readFileSync(tokenFile, 'utf8')).trim() });

  async function call(method, path, body, { timeoutMs: perCall, signal } = {}) {
    const ms = perCall ?? timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(root + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...auth(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok || json?.ok === false) {
        throw new HostClientError(json?.message ?? json?.error ?? `HTTP ${res.status}`, {
          status: res.status, path, body: json ?? text.slice(0, 200),
          hint: res.status === 401 ? '检查 state/host-token 是否与插件配置的一致' : '',
        });
      }
      return json;
    } catch (error) {
      if (error instanceof HostClientError) throw error;
      throw new HostClientError(error?.name === 'AbortError' ? `超时（${ms}ms）` : String(error?.message ?? error), {
        path, hint: '确认 dsh 实例在跑、插件端口与 tokenFile 正确',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // #endregion

  // #region 事件流

  // 订阅 SSE，逐帧回调，直到 signal 中止或服务端关闭。
  //
  // 自己分帧：`event:` / `id:` / `data:` 三行一组，空行结束。
  async function subscribe({ sessions = [], since, lean = true, onFrame, signal } = {}) {
    const q = new URLSearchParams();
    if (sessions.length) q.set('session', sessions.join(','));
    if (since !== undefined) q.set('since', String(since));
    if (lean) q.set('lean', '1');

    const res = await fetch(`${root}/events?${q}`, { headers: { ...auth(), accept: 'text/event-stream' }, signal });
    if (!res.ok) throw new HostClientError(`订阅失败 HTTP ${res.status}`, { status: res.status, path: '/events' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let type = '';
        let id;
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('id: ')) id = line.slice(4).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!type || !data) continue;
        try {
          onFrame?.({ type, id, data: JSON.parse(data) });
        } catch (error) {
          logger?.warn?.('host-client: 事件帧不是 JSON', { type, error: String(error) });
        }
      }
    }
  }
  // #endregion

  // #region 端点

  return {
    // 探活：活会话数 / 活 agent 数 / 插件版本。
    health: () => call('GET', '/health', undefined, { timeoutMs: 4000 }),

    // 建会话（不投递）。workspaceId 优先，否则 cwd —— **只能给一个**。
    ensure: ({ workspaceId, cwd, preset } = {}) =>
      call('POST', '/ensure', {
        ...(workspaceId ? { workspaceId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(preset ? { preset } : {}),
      }),

    // 投递一回合。
    prompt: ({ sessionId, text }) => call('POST', '/prompt', { sessionId, text }),

    // 取消当前回合。
    cancel: ({ sessionId }) => call('POST', '/cancel', { sessionId }),

    // 改会话标题。
    rename: ({ sessionId, title }) => call('POST', '/rename', { sessionId, title }),

    // 会话列表（含 archived / status / title / seq）。
    sessions: ({ cold = true, titles = true } = {}) =>
      call('GET', `/sessions?cold=${cold ? 1 : 0}&titles=${titles ? 1 : 0}`),

    // 单个会话的存活快照：`{ exists, live, status, seq, archived }`。
    //
    // 比 `/sessions` 便宜得多（一次查表 vs 扫全部会话+磁盘快照），
    // 所以"这条消息该不该重建会话"用它，不用列表。
    sessionInfo: ({ sessionId }) =>
      call('GET', `/session-info?sessionId=${encodeURIComponent(sessionId)}`),

    // 归档 / 恢复。
    archive: ({ sessionId, restore = false, stopActivity = true }) =>
      call('POST', '/archive', { sessionId, restore, stopActivity }),

    // 注册 / 复用工作区。
    workspace: ({ path, title }) => call('POST', '/workspace', { path, title }),

    // 会话用量（token / 上下文压力）。
    usage: ({ sessionId }) => call('GET', `/session/usage?session=${encodeURIComponent(sessionId)}`),

    subscribe,
  };
}

// #endregion
