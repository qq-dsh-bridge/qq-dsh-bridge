// #region 常量与错误

// OneBot v11 事件与消息段的解析。


export const POST_TYPES = Object.freeze(['message', 'notice', 'request', 'meta_event']);

export const POST_TYPE_MESSAGE_SENT = 'message_sent';

export class OneBotParseError extends Error {
  constructor(message, { detail = '' } = {}) {
    super(message);
    this.name = 'OneBotParseError';
    this.detail = detail;
  }
  toString() {
    return this.detail ? `${this.name}: ${this.message}\n  ${this.detail}` : `${this.name}: ${this.message}`;
  }
}

// 普通对象判定在**本文件内**还要用（normalizeSegments 等）。
//
// 实现只在 `util/value.js`，这里只 import，不要再对外暴露一份。
import { isPlainObject } from '../util/value.js';

// #endregion

// #region 帧分类

// 把一帧原始数据归一成事件或响应。


export function classifyFrame(raw) {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!isPlainObject(value)) {
    throw new OneBotParseError('帧不是对象', { detail: preview(raw) });
  }

  if (typeof value.post_type === 'string'
    && (POST_TYPES.includes(value.post_type) || value.post_type === POST_TYPE_MESSAGE_SENT)) {
    return { kind: 'event', event: value };
  }
  // 响应：OneBot v11 用 status/retcode/echo
  if (typeof value.status === 'string' || 'retcode' in value || 'echo' in value) {
    return { kind: 'response', response: value };
  }
  // meta_event 之外未知 post_type：不当作错误丢掉，而是显式标记，便于发现新协议。
  if (typeof value.post_type === 'string') {
    return { kind: 'unknown', raw: value, reason: `未知 post_type "${value.post_type}"` };
  }
  return { kind: 'unknown', raw: value, reason: '既没有 post_type 也没有 status/retcode/echo' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OneBotParseError('不是合法 JSON', { detail: `${error.message}；原文 ${preview(text)}` });
  }
}

// #endregion

// #region 消息段

// 归一化消息段数组。

export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message.map((seg, i) => normalizeSegment(seg, i)).filter(Boolean);
  }
  if (typeof message === 'string') {
    return parseCqString(message);
  }
  if (message === undefined || message === null) return [];
  throw new OneBotParseError('message 既不是数组也不是字符串', { detail: typeof message });
}

// 单个段的归一化。

function normalizeSegment(seg, index) {
  if (!isPlainObject(seg)) {
    throw new OneBotParseError(`第 ${index} 个消息段不是对象`, { detail: JSON.stringify(seg) });
  }
  const type = String(seg.type ?? '');
  if (type === '') throw new OneBotParseError(`第 ${index} 个消息段缺少 type`);

  const raw = isPlainObject(seg.data) ? seg.data : {};
  // data 允许缺省（如某些纯标记段），归成空对象避免下游判空。
  const data = type === 'at' ? normalizeAtData(raw) : raw;
  return { type, data };
}

// at 段：**只认 `qq`**，`name` 属于"有就带上、没有就算了"。
function normalizeAtData(d) {
  const out = { qq: String(d.qq ?? '') };
  // at=all 也走 qq（值为 'all'），由调用方判定。
  if (d.name !== undefined && d.name !== null) out.name = String(d.name);
  return out;
}

// #endregion

// #region CQ 文本

// 解析 CQ 码字符串。

export function parseCqString(text) {
  const out = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const plain = decodeCqText(text.slice(last, m.index));
      if (plain !== '') out.push({ type: 'text', data: { text: plain } });
    }
    const type = m[1];
    const data = {};
    const params = m[2] ? m[2].slice(1) : '';
    if (params !== '') {
      for (const pair of params.split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        data[pair.slice(0, eq)] = decodeCqText(pair.slice(eq + 1));
      }
    }
    out.push({ type, data: type === 'at' ? normalizeAtData(data) : data });
    last = re.lastIndex;
  }

  if (last < text.length) {
    const plain = decodeCqText(text.slice(last));
    if (plain !== '') out.push({ type: 'text', data: { text: plain } });
  }
  return out;
}

// CQ 文本转义解码。`&amp;` 最后处理。
export function decodeCqText(text) {
  return String(text)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

// #endregion

// #region 摘要与会话

// 把消息段数组归一化，并抽出判定需要的结构化信息。


export function summarizeSegments(segments, { selfQq = 0 } = {}) {
  const parts = [];
  let atSelf = false;
  let atAll = false;
  let quote = null;
  const ats = [];

  for (const seg of segments) {
    const d = seg.data ?? {};
    switch (seg.type) {
      case 'text': {
        parts.push(String(d.text ?? ''));
        break;
      }
      case 'at': {
        const qq = String(d.qq ?? '');
        if (qq === 'all') {
          atAll = true;
        } else if (qq !== '') {
          if (Number(qq) === Number(selfQq)) atSelf = true;
          ats.push(qq);
        }
        break;
      }
      case 'reply': {
        quote = { id: String(d.id ?? '') };
        break;
      }
      default:
        break;
    }
  }

  return {
    // 纯文本（**只含 text 段**）。仅用于判定与日志，不落盘。
    text: parts.join('').trim(),
    atSelf,
    atAll,
    // 被真正 @ 到的 QQ 号列表（诊断用，见上面的说明）。
    ats,
    quote,
    segments,
  };
}

// 从消息事件里取出会话坐标。

export function conversationOf(event) {
  if (event.message_type === 'group') {
    return { kind: 'group', id: String(event.group_id ?? ''), key: `group:${event.group_id}` };
  }
  if (event.message_type === 'private') {
    return { kind: 'private', id: String(event.user_id ?? ''), key: `private:${event.user_id}` };
  }
  throw new OneBotParseError(`未知的 message_type "${event.message_type}"`);
}

// 把动作响应拆成 `{ ok, data, retcode, message }`。

export function unwrapResponse(response) {
  if (!isPlainObject(response)) {
    return { ok: false, retcode: null, data: null, message: '响应不是对象' };
  }
  const retcode = typeof response.retcode === 'number' ? response.retcode : null;
  const status = String(response.status ?? '');
  const ok = status === 'ok' && (retcode === 0 || retcode === null);
  return {
    ok,
    retcode,
    data: response.data ?? null,
    message: ok ? '' : String(response.message ?? response.wording ?? status ?? '未知错误'),
  };
}

function preview(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// #endregion
