// OneBot HTTP 动作客户端（SnowLuma :3000）。
//
// 实测确认（SnowLuma 1.14.21）：
//   - 鉴权走 `Authorization: Bearer <httpServers.accessToken>`
//   - 请求体 `{ action, params, echo }`，响应 `{ status, retcode, data, echo }`
//   - **HTTP token 与 WS token 是两个不同的值**，不能混用
//
// 这里只做动作调用；事件接收在 ws.js（走 :3001 WS）。

import { unwrapResponse } from './parse.js';

// #region 错误与错误码提示

export class OneBotActionError extends Error {
  constructor(message, { action, retcode, status, hint } = {}) {
    super(message);
    this.name = 'OneBotActionError';
    this.action = action;
    this.retcode = retcode;
    this.status = status;
    this.hint = hint;
  }
  toString() {
    const bits = [this.name + ': ' + this.message];
    if (this.action) bits.push(`  action: ${this.action}`);
    if (this.retcode !== undefined && this.retcode !== null) bits.push(`  retcode: ${this.retcode}`);
    if (this.status) bits.push(`  status: ${this.status}`);
    if (this.hint) bits.push(`  ${this.hint}`);
    return bits.join('\n');
  }
}

// 常见的 OneBot retcode 含义，用于给出可操作的提示。
const RETCODE_HINTS = {
  1: '异步动作已提交，结果需另查',
  100: '参数格式错误',
  102: '参数缺失或类型不对',
  103: '动作未实现 —— 该动作不被当前 OneBot 实现支持',
  104: '权限不足（可能是机器人不是管理员）',
  200: '机器人账号被禁言或不可用',
  201: '消息内容为空',
  202: '消息过长',
  203: '发送失败（可能被风控）',
};

// #endregion

// #region 客户端

export class OneBotHttpClient {
  constructor({ httpUrl, accessToken = '', timeoutMs = 30_000, logger, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.httpUrl = normalizeBase(httpUrl);
    this.accessToken = accessToken;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.consecutiveFailures = 0;
  }

  // 热重载时应用新配置。
  applyConfig({ httpUrl, accessToken, timeoutMs } = {}) {
    if (httpUrl !== undefined) this.httpUrl = normalizeBase(httpUrl);
    if (accessToken !== undefined) this.accessToken = accessToken;
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
  }

  // 调用一个动作。

  async call(action, params = {}, { signal, timeoutMs } = {}) {
    if (!this.httpUrl) {
      throw new OneBotActionError('未配置 OneBot HTTP 地址', { action });
    }

    const url = `${this.httpUrl}/`;
    const body = JSON.stringify({ action, params, echo: action });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response;
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      response = await this.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      this.consecutiveFailures += 1;
      if (error?.name === 'AbortError') {
        throw new OneBotActionError(`动作 ${action} 超时（${timeoutMs ?? this.timeoutMs}ms）`, {
          action,
          hint: 'SnowLuma 可能在忙于 member warmup（上千成员建档会占满事件循环，实测拖过 72 秒）。',
        });
      }
      throw new OneBotActionError(`动作 ${action} 请求失败：${error.message}`, {
        action,
        hint: '确认 SnowLuma 在运行、snowluma.httpUrl 指向正确的端口。',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    // 401/403：token 不对。**这是最容易误诊的一类**——HTTP token 与 WS token 不同。
    if (response.status === 401 || response.status === 403) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(`动作 ${action} 鉴权被拒（HTTP ${response.status}）`, {
        action,
        status: response.status,
        hint: 'SnowLuma 的 HTTP token 与 WS token 是两个不同的值，'
          + 'httpServers.accessToken 用于这里、wsServers.accessToken 用于事件连接，不能混用。',
      });
    }
    if (!response.ok) {
      this.consecutiveFailures += 1;
      const text = await safeText(response);
      throw new OneBotActionError(`动作 ${action} 返回 HTTP ${response.status}`, {
        action,
        status: response.status,
        hint: text.slice(0, 200),
      });
    }

    let json;
    try {
      json = await response.json();
    } catch (error) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(`动作 ${action} 的响应不是 JSON：${error.message}`, { action });
    }

    // *关键**：HTTP 200 不代表动作成功，必须看 status/retcode。
    const result = unwrapResponse(json);
    if (!result.ok) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(
        `动作 ${action} 失败：${result.message || '未知错误'}`,
        {
          action,
          retcode: result.retcode,
          status: json.status,
          hint: RETCODE_HINTS[result.retcode] ?? '',
        },
      );
    }

    this.consecutiveFailures = 0;
    return result.data;
  }

  // 探活。用 `get_status` 而不是 `get_login_info`：

  async probeStatus(options = {}) {
    const data = await this.call('get_status', {}, options);
    return {
      online: Boolean(data?.online),
      good: Boolean(data?.good),
      raw: data,
    };
  }

  async getLoginInfo(options = {}) {
    return this.call('get_login_info', {}, options);
  }

  // 撤回一条消息。

  async deleteMessage(messageId, options = {}) {
    const id = String(messageId ?? '').trim();
    if (id === '') throw new Error('delete_msg 需要 message_id');
    return this.call('delete_msg', { message_id: id }, options);
  }

  // 改**本号账号昵称**。

  async setNickname(nickname, options = {}) {
    const name = String(nickname ?? '');
    if (name.trim() === '') throw new Error('set_qq_profile 需要 nickname（不能为空）');
    return this.call('set_qq_profile', { nickname: name }, options);
  }

  // 改**群名片**。

  async setGroupCard(groupId, userId, card, options = {}) {
    const gid = Number(groupId);
    const uid = Number(userId);
    if (!Number.isFinite(gid) || gid <= 0) throw new Error('set_group_card 需要 group_id');
    if (!Number.isFinite(uid) || uid <= 0) {
      // 本号拿不到时必须**在这里也炸** —— 不能让 NaN 发出去改到别人身上。
      throw new Error('set_group_card 需要 user_id（本号；拿不到就不该改）');
    }
    if (card === undefined || card === null) {
      throw new Error("set_group_card 需要 card —— 要**清空**名片就传空字符串 ''，这不是「没传」");
    }
    return this.call('set_group_card', { group_id: gid, user_id: uid, card: String(card) }, options);
  }

  // 用**稳定的 file 标识**重新签发一个图片地址。
  async getImageUrl(file, options = {}) {
    const f = String(file ?? '').trim();
    if (f === '') return null;
    try {
      const data = await this.call('get_image', { file: f }, options);
      // 实测/文档：返回 { file, url } 或直接一个 url 字符串
      const url = typeof data === 'string' ? data : (data?.url ?? data?.file ?? '');
      return url ? String(url) : null;
    } catch {
      // 重签失败不是异常情况（图可能已被删除/不在缓存）—— 让调用方决定怎么报。
      return null;
    }
  }

  // 语音：取回并**让服务端转码**（`get_record` + `out_format`）。
  //
  // 为什么优先走它、而不是直接下 `record` 段里的 url：
  //   · url 带 rkey、会过期；`file` 是稳定的，服务端缓存里还能查
  //   · QQ 原始语音是 amr/silk，转成 mp3 后 ffmpeg / ASR / 转发都省事
  //
  // @returns `{ base64, format, duration }` 或 null（不在缓存里 / 转码失败）
  async getRecord(file, { outFormat = 'mp3', ...options } = {}) {
    const f = String(file ?? '').trim();
    if (f === '') return null;
    try {
      const data = await this.call('get_record', { file: f, out_format: outFormat }, options);
      const b64 = String(data?.base64 ?? '');
      if (!b64) return null;
      return {
        base64: b64,
        format: String(data?.out_format ?? outFormat),
        duration: Number(data?.duration) || 0,
      };
    } catch {
      // 转码失败不是异常情况（老语音不在缓存里）—— 让调用方退回下载原文件。
      return null;
    }
  }

  // 展开一条**合并转发**消息的内容。
  async getForwardMessages(id, options = {}) {
    const fid = String(id ?? '').trim();
    if (fid === '') return null;
    try {
      const data = await this.call('get_forward_msg', { id: fid }, options);
      return data ?? null;
    } catch {
      return null;
    }
  }
}

// #endregion

// #region 工具函数

// 去掉 base URL 结尾的斜杠（`wsUrl` 的比对与拼接都依赖它）。
//
// ⚠️ 实现只有这一份，`ws.js` 从这里 import（同一层，无循环）。别就地再写一遍：
//    两份一旦分叉（比如一边去掉了查询串），就会出现"配置没改却每条都重连"
//    或者"地址改了却不重连"，而两边各自看都对。
export function normalizeBase(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// #endregion
