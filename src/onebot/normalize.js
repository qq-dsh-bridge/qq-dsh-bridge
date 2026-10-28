
import { conversationOf, normalizeSegments, summarizeSegments } from './parse.js';
import { deriveMsgType } from '../chatlog/segments.js';
import { toHostPathStrict } from '../util/path-map.js';
import { isPlainObject } from '../util/value.js';

// #region 常量

// 入参只有一种形状：**一个字段就是一个值**。
//   at / reply / image / voice / sticker / face 都不接受对象 —— 要发的东西
//   在别处（reply 的 seq 来自 [seq:]、image 的地址来自 /m/ 或上下文）。
//   对象只会让"到底该填哪个键"变成猜谜。

// #endregion

// #region 出站：气泡与段落

export async function normalizeOutgoingBubble(bubble, { resolveReply, resolveSticker } = {}) {
  if (!bubble || typeof bubble !== 'object' || Array.isArray(bubble)) {
    return { ok: false, segments: [], errors: ['这一条不是对象'] };
  }

  const keys = Object.keys(bubble);
  if (keys.length === 0) {
    return { ok: false, segments: [], errors: ['这一条是空对象'] };
  }

  const hasSegments = 'segments' in bubble;

  // 混用要报错。
  if (hasSegments && keys.some((k) => k !== 'segments')) {
    const others = keys.filter((k) => k !== 'segments').join('、');
    return {
      ok: false,
      segments: [],
      errors: [
        `这一条里既有 segments 又有 ${others} —— **二选一**：\n`
        + '  · 常用：`{ "reply": 1, "at": "123", "text": " 内容" }`（顺序固定）\n'
        + '  · 要自定义顺序：`{ "segments": [ { "at": "123" }, { "text": " 内容" } ] }`',
      ],
    };
  }

  // ── ② 自定义顺序
  if (hasSegments) {
    return normalizeOutgoingSegments(bubble.segments, { resolveReply, resolveSticker });
  }

  // ── ③ 合并聊天记录：`forward` 独占一条
  if ('forward' in bubble) {
    if (keys.length !== 1) {
      return {
        ok: false,
        segments: [],
        errors: ['`forward` 要单独一条：不能和 text / reply / at / image 等混在同一个气泡里'],
      };
    }
    const r = normalizeForward(bubble.forward, { depth: 1 });
    if (!r.ok) return { ok: false, segments: [], errors: r.errors };
    return {
      ok: true,
      segments: [{ type: 'forward', data: { nodes: r.nodes } }],
      errors: [],
    };
  }

  // ── ① 属性式：按固定顺序展开
  const order = ['reply', 'at', 'image', 'voice', 'video', 'sticker', 'face', 'text'];
  const unknown = keys.filter((k) => !order.includes(k));
  if (unknown.length) {
    return {
      ok: false,
      segments: [],
      errors: [`不认识的键 ${unknown.join('、')}（可用：${order.join(' / ')}；要自定义顺序用 segments）`],
    };
  }

  if (('voice' in bubble || 'video' in bubble) && keys.length > 1) {
    return {
      ok: false,
      segments: [],
      errors: [
        `${'video' in bubble ? 'video' : 'voice'} 要单独一条：不能和 text / reply / at / image 等混在同一个气泡里。`
        + '要同时发文字就拆成两条 —— `messages` 里放两个元素。',
      ],
    };
  }

  const flat = [];
  for (const kind of order) {
    if (!(kind in bubble)) continue;
    const value = bubble[kind];
    if ((kind === 'at' || kind === 'reply') && Array.isArray(value)) {
      for (const one of value) flat.push({ [kind]: one });
    } else {
      flat.push({ [kind]: value });
    }
  }

  const r = await normalizeOutgoingSegments(flat, { resolveReply, resolveSticker });
  if (!r.ok) return r;

  return { ok: true, segments: spaceAfterAt(r.segments), errors: [] };
}

// *在 `at` 后面补一个空格 —— 只在下一个是 text、且它自己没有前导空白时。
//
// 别在 reply / 另一个 at / 图片前后插空格：那会多出一个空的 text 段，
// 回显成 `[text:]`，纯噪音。
export function spaceAfterAt(segments) {
  const out = [];
  for (const [i, seg] of segments.entries()) {
    out.push(seg);
    if (seg?.type !== 'at') continue;

    const next = segments[i + 1];
    if (!next || next.type !== 'text') continue;

    const t = String(next.data?.text ?? '');
    if (t === '' || t.startsWith(' ') || t.startsWith('\n') || t.startsWith('\r')) continue;
    out.push({ type: 'text', data: { text: ' ' } });
  }
  return out;
}

const FORWARD_MAX_NODES = 200;
const FORWARD_MAX_DEPTH = 3;

// 合并聊天记录的节点数组 —— 语法与 `messages` 一致：
//   · { seqs: [...] }       真实消息，每个 seq 一条节点
//   · { text/image/face }   本号自造节点（也可用 segments 自定义顺序）
//   · { forward: [...] }    套娃
function normalizeForward(raw, { depth = 1, path = 'forward' } = {}) {
  if (!Array.isArray(raw)) {
    return { ok: false, nodes: [], errors: [`${path} 要是数组（每个元素是一条聊天记录节点，语法同 messages）`] };
  }
  if (raw.length === 0) {
    return { ok: false, nodes: [], errors: [`${path} 是空数组 —— 至少放一条`] };
  }
  if (raw.length > FORWARD_MAX_NODES) {
    return {
      ok: false,
      nodes: [],
      errors: [`${path} 有 ${raw.length} 条，最多 ${FORWARD_MAX_NODES} 条`],
    };
  }

  const nodes = [];

  for (const [i, item] of raw.entries()) {
    const at = `${path}[${i}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, nodes: [], errors: [`${at} 不是对象`] };
    }

    const keys = Object.keys(item);
    if (keys.length === 0) {
      return { ok: false, nodes: [], errors: [`${at} 是空对象`] };
    }

    if ('forward' in item) {
      if (keys.length !== 1) {
        return { ok: false, nodes: [], errors: [`${at}.forward 要独占一条节点，不能和 ${keys.filter((k) => k !== 'forward').join('、')} 同层`] };
      }
      if (depth >= FORWARD_MAX_DEPTH) {
        return { ok: false, nodes: [], errors: [`${at} 套娃太深（最多 ${FORWARD_MAX_DEPTH} 层）`] };
      }
      const r = normalizeForward(item.forward, { depth: depth + 1, path: `${at}.forward` });
      if (!r.ok) return r;
      nodes.push({ kind: 'forward', nodes: r.nodes });
      continue;
    }

    if ('seqs' in item) {
      if (keys.length !== 1) {
        return { ok: false, nodes: [], errors: [`${at}.seqs 要独占一条节点，不能和 ${keys.filter((k) => k !== 'seqs').join('、')} 同层`] };
      }
      if (!Array.isArray(item.seqs) || item.seqs.length === 0) {
        return { ok: false, nodes: [], errors: [`${at}.seqs 要是非空数组（消息定位符）`] };
      }
      if (item.seqs.length > FORWARD_MAX_NODES) {
        return { ok: false, nodes: [], errors: [`${at}.seqs 有 ${item.seqs.length} 条，最多 ${FORWARD_MAX_NODES} 条`] };
      }
      const seqs = [];
      for (const v of item.seqs) {
        if (typeof v !== 'string' && typeof v !== 'number') {
          return { ok: false, nodes: [], errors: [`${at}.seqs 里只能是消息定位符（字符串/数字）`] };
        }
        const s = String(v).trim();
        if (s === '') return { ok: false, nodes: [], errors: [`${at}.seqs 里有空定位符`] };
        seqs.push(s);
      }
      nodes.push({ kind: 'seqs', seqs });
      continue;
    }

    const allowed = ['text', 'image', 'face', 'segments'];
    const bad = keys.filter((k) => !allowed.includes(k));
    if (bad.length) {
      return {
        ok: false,
        nodes: [],
        errors: [`${at} 里不能用 ${bad.join('、')} —— 聊天记录节点只允许 text / image / face / segments（reply、at 暂时禁用）`],
      };
    }

    if ('segments' in item && keys.length !== 1) {
      return { ok: false, nodes: [], errors: [`${at}.segments 不能和 text / image / face 同层`] };
    }

    let segs;
    if ('segments' in item) {
      const r = normalizeForwardContent(item.segments, `${at}.segments`);
      if (!r.ok) return r;
      segs = r.segments;
    } else {
      const flat = [];
      for (const kind of ['text', 'image', 'face']) {
        if (kind in item) flat.push({ [kind]: item[kind] });
      }
      if (flat.length === 0) {
        return { ok: false, nodes: [], errors: [`${at} 没有内容（text / image / face / segments 至少给一个）`] };
      }
      const r = normalizeForwardContent(flat, at);
      if (!r.ok) return r;
      segs = r.segments;
    }

    nodes.push({ kind: 'self', segments: segs });
  }

  return { ok: true, nodes, errors: [] };
}

function normalizeForwardContent(raw, path) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, segments: [], errors: [`${path} 要是非空数组`] };
  }

  const segments = [];

  for (const [i, item] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, segments: [], errors: [`${at} 不是对象`] };
    }

    const keys = Object.keys(item);
    if (keys.length !== 1) {
      return { ok: false, segments: [], errors: [`${at} 只能有一个键（text / image / face）`] };
    }

    const kind = keys[0];
    const value = item[kind];

    if (kind === 'text') {
      if (typeof value !== 'string') {
        return { ok: false, segments: [], errors: [`${at}.text 要是字符串`] };
      }
      if (value === '') {
        return { ok: false, segments: [], errors: [`${at}.text 不能是空字符串`] };
      }
      segments.push({ type: 'text', data: { text: value } });
      continue;
    }

    if (kind === 'image') {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, segments: [], errors: [`${at}.image 要是非空字符串（URL 或路径）`] };
      }
      const src = value.trim();
      if (/^(base64:|data:)/i.test(src) || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(src)) {
        return { ok: false, segments: [], errors: [`${at}.image 只收 URL 或路径；base64 不收`] };
      }
      const checked = toHostPathStrict(src);
      if (!checked.ok) {
        return { ok: false, segments: [], errors: [`${at}.image ${checked.reason}`] };
      }
      segments.push({ type: 'image', data: { url: checked.value } });
      continue;
    }

    if (kind === 'face') {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, segments: [], errors: [`${at}.face 需要正整数 id`] };
      }
      segments.push({ type: 'face', data: { id } });
      continue;
    }

    return {
      ok: false,
      segments: [],
      errors: [`${at} 的类型 "${kind}" 不能用 —— 聊天记录节点只允许 text / image / face（reply、at 暂时禁用）`],
    };
  }

  return { ok: true, segments, errors: [] };
}

// *把 AI 写的段规格规范成 OneBot 能发的段数组**。
export async function normalizeOutgoingSegments(raw, { resolveReply, resolveSticker } = {}) {
  const list = Array.isArray(raw) ? raw : [raw];
  const segments = [];
  const errors = [];
  let stickerCount = 0;

  if (list.length === 0) {
    return { ok: false, segments: [], errors: ['segments 是空数组 —— 至少要有一段'] };
  }

  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`第 ${i + 1} 段不是对象`);
      continue;
    }

    const keys = Object.keys(item);
    if (keys.length === 0) {
      errors.push(`第 ${i + 1} 段是空对象`);
      continue;
    }
    if (keys.length > 1) {
      // 一段只能有一种类型 —— 多个键是"想发多段"，但那要拆成多个元素。
      errors.push(`第 ${i + 1} 段有多个键（${keys.join(',')}）—— 一段只能有一个类型，多段请写成数组`);
      continue;
    }

    const [kind] = keys;
    const value = item[kind];

    switch (kind) {
      case 'text': {
        const t = String(value ?? '');
        if (t === '') errors.push(`第 ${i + 1} 段 text 是空的`);
        else segments.push({ type: 'text', data: { text: t } });
        break;
      }

      case 'at': {
        // 只收 QQ 号。属性式里可以给数组（多个 @），那段式就拆成多段。
        if (Array.isArray(value)) {
          errors.push(`第 ${i + 1} 段 at 一次只能 @ 一个人 —— 多个请拆成多段`);
          break;
        }
        if (isPlainObject(value)) {
          errors.push(`第 ${i + 1} 段 at 不要给对象 —— 直接给 QQ 号`);
          break;
        }
        const qq = String(value ?? '').trim();
        if (!/^\d+$/.test(qq)) {
          errors.push(`第 ${i + 1} 段 at 需要纯数字 QQ 号（收到 ${JSON.stringify(value)}）`);
          break;
        }
        segments.push({ type: 'at', data: { qq } });
        break;
      }

      case 'reply': {
        // 只收 seq（消息定位符）；messageId 是内部值，模型不该接触。
        if (Array.isArray(value)) {
          errors.push(`第 ${i + 1} 段 reply 只收一个 seq —— 一条气泡只能引用一条消息`);
          break;
        }
        if (isPlainObject(value)) {
          errors.push(`第 ${i + 1} 段 reply 不要给对象 —— 直接给 seq（消息定位符）`);
          break;
        }
        const seq = String(value ?? '').trim();
        if (seq === '') {
          errors.push(`第 ${i + 1} 段 reply 缺少 seq`);
          break;
        }
        const messageId = resolveReply ? String((await resolveReply(seq)) ?? '') : '';
        if (!messageId) {
          errors.push(`第 ${i + 1} 段 reply 引用的 seq=${seq} 找不到对应消息`);
          break;
        }
        segments.push({ type: 'reply', data: { id: messageId, seq } });
        break;
      }

      case 'image': {
        // 只收一个地址：URL 或本地路径；base64 走 imagePublish ——
        // 渲染类工具（latex / md）自己会换成 /m/<id>。
        if (Array.isArray(value) || isPlainObject(value)) {
          errors.push(`第 ${i + 1} 段 image 不要给对象/数组 —— 直接给 URL 或路径`);
          break;
        }
        const src = String(value ?? '').trim();
        if (src === '') {
          errors.push(`第 ${i + 1} 段 image 缺少地址（URL、/m/<id> 或本地路径）`);
          break;
        }
        if (/^(base64:|data:)/i.test(src) || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(src)) {
          errors.push(`第 ${i + 1} 段 image 只收 URL 或路径；base64 先用 imagePublish 换成 /m/<id> 地址`);
          break;
        }
        const checked = toHostPathStrict(src);
        if (!checked.ok) {
          errors.push(`第 ${i + 1} 段 image ${checked.reason}`);
          break;
        }
        segments.push({ type: 'image', data: { url: checked.value } });
        break;
      }

      case 'voice': {
        if (Array.isArray(value) || isPlainObject(value)) {
          errors.push(`第 ${i + 1} 段 voice 只给一个地址字符串（/m/<id> 或本地路径）`);
          break;
        }
        const checked = toHostPathStrict(String(value ?? '').trim());
        if (!checked.ok) {
          errors.push(`第 ${i + 1} 段 voice ${checked.reason}`);
          break;
        }
        const file = checked.value;
        if (file === '') {
          errors.push(`第 ${i + 1} 段 voice 需要一个地址（/m/<id> 或本地路径）`);
          break;
        }
        if (/^(base64:|data:)/i.test(file)) {
          errors.push(`第 ${i + 1} 段 voice 只收 URL 或路径；base64 先存进媒体库，用 /m/<id> 地址`);
          break;
        }
        segments.push({ type: 'record', data: { file } });
        break;
      }

      case 'video': {
        if (Array.isArray(value) || isPlainObject(value)) {
          errors.push(`第 ${i + 1} 段 video 只给一个地址字符串（URL、/m/<id> 或本地路径）`);
          break;
        }
        const src = String(value ?? '').trim();
        if (src === '') {
          errors.push(`第 ${i + 1} 段 video 缺少地址（URL、/m/<id> 或本地路径）`);
          break;
        }
        if (/^(base64:|data:)/i.test(src) || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(src)) {
          errors.push(`第 ${i + 1} 段 video 只收 URL 或路径；base64 不收`);
          break;
        }
        const checked = toHostPathStrict(src);
        if (!checked.ok) {
          errors.push(`第 ${i + 1} 段 video ${checked.reason}`);
          break;
        }
        const file = checked.value;
        if (file === '') {
          errors.push(`第 ${i + 1} 段 video 需要一个地址（URL、/m/<id> 或本地路径）`);
          break;
        }
        segments.push({ type: 'video', data: { file } });
        break;
      }

      case 'face': {
        if (isPlainObject(value) || Array.isArray(value)) {
          errors.push(`第 ${i + 1} 段 face 直接给数字 id，不要给对象/数组`);
          break;
        }
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) {
          errors.push(`第 ${i + 1} 段 face 需要正整数 id（收到 ${JSON.stringify(value)}）`);
          break;
        }
        segments.push({ type: 'face', data: { id } });
        break;
      }

      case 'sticker': {
        if (isPlainObject(value) || Array.isArray(value)) {
          errors.push(`第 ${i + 1} 段 sticker 直接给 ref，不要给对象/数组`);
          break;
        }
        const ref = String(value ?? '').trim();
        if (ref === '') {
          errors.push(`第 ${i + 1} 段 sticker 缺少表情引用（传 qq_list_stickers 给的 ref / shortId / 描述）`);
          break;
        }
        if (!resolveSticker) {
          errors.push(`第 ${i + 1} 段 sticker 无法解析（内部未注入 resolveSticker）`);
          break;
        }
        let resolved;
        try {
          resolved = await resolveSticker(ref);
        } catch (error) {
          errors.push(`第 ${i + 1} 段 sticker 取图失败：${error?.message ?? error}`);
          break;
        }

        // 有 QQ 收藏表情的 emoji_id：走 `send_custom_face`，保留表情样式。
        // 没有（旧的 collected_*）：退回图片，至少还能发出去。
        const emojiId = String(resolved?.emojiId ?? '').trim();
        const desc = String(resolved?.desc ?? '').trim();

        if (emojiId !== '') {
          segments.push({
            type: 'sticker',
            data: {
              emoji_id: emojiId,
              ...(resolved?.md5 ? { md5: String(resolved.md5) } : {}),
              ...(desc ? { desc } : {}),
            },
          });
        } else if (resolved?.base64) {
          segments.push({
            type: 'image',
            data: {
              file: `base64://${resolved.base64}`,
              ...(desc ? { summary: desc } : {}),
            },
          });
        } else {
          errors.push(`第 ${i + 1} 段找不到表情 "${ref}"（先用 qq_list_stickers 看有哪些）`);
          break;
        }
        stickerCount += 1;
        break;
      }

      default:

        errors.push(`第 ${i + 1} 段的类型 "${kind}" 不认识（可用：text / at / reply / image / voice / video / sticker / face）`);
    }
  }

  // 独占 / 一次性规则 —— 属性式与段式共用同一份判断。
  const voiceCount = segments.filter((s) => s.type === 'record').length;
  if (voiceCount > 1) {
    errors.push(`一条气泡只能放一段语音（现在 ${voiceCount} 段）—— 多段拆成多条`);
  } else if (voiceCount === 1 && segments.length > 1) {
    errors.push('voice 要单独一条：不能和文字/引用/@/图片混在同一个气泡里');
  }

  if (stickerCount > 1) {
    errors.push(`一条气泡只能放一个 sticker（现在 ${stickerCount} 个）`);
  } else if (stickerCount === 1 && segments.length > 1) {
    errors.push('sticker 要单独一条：不能和文字/引用/@/图片混在同一个气泡里');
  }

  const videoCount = segments.filter((s) => s.type === 'video').length;
  if (videoCount > 1) {
    errors.push(`一条气泡只能放一段视频（现在 ${videoCount} 段）—— 多段拆成多条`);
  } else if (videoCount === 1 && segments.length > 1) {
    errors.push('video 要单独一条：不能和文字/引用/@/图片混在同一个气泡里');
  }

  const replyCount = segments.filter((s) => s.type === 'reply').length;
  if (replyCount > 1) {
    errors.push(`一条气泡只能引用一条消息（现在有 ${replyCount} 个 reply）`);
  }

  return { ok: errors.length === 0 && segments.length > 0, segments, errors };
}

// #endregion

// #region 入站与白名单


export function isConvAllowed(convKey, allow = {}) {
  const [kind, id] = String(convKey).split(':');
  const list = kind === 'group' ? allow.groups : allow.private;
  if (Array.isArray(list) && list.map(String).includes(String(id))) return true;

  const empty = !allow.groups?.length && !allow.private?.length;
  return Boolean(allow.allowAllWhenEmpty) && empty;
}

export function normalizeEvent(event) {
  const conv = conversationOf(event);
  const isGroup = conv.kind === 'group';
  const segments = normalizeSegments(event.message);
  const summary = summarizeSegments(segments, { selfQq: event.self_id });

  const selfQq = String(event.self_id ?? '');
  const senderQq = String(event.user_id ?? '');
  const name = event.sender?.card || event.sender?.nickname || senderQq;

  // 群内身份：只存**事实**（群主 / 管理员 / 成员）
  const groupRole = event.sender?.role === 'owner' ? 'groupOwner'
    : event.sender?.role === 'admin' ? 'admin'
      : 'member';

  return {
    convKey: conv.key,
    summary,
    selfQq,   
    message: {
      messageId: String(event.message_id ?? event.msg_id ?? ''),

      msgSeq: isGroup ? (event.message_seq ?? event.msg_seq) : undefined,

      // 时间统一毫秒（OneBot 的 time 是秒）。
      tsMs: (Number(event.time) || Math.floor(Date.now() / 1000)) * 1000,

      sender: {

        qq: senderQq,
        name,
        groupRole,
      },

      segments,

      // 引用的 id；store 入库时解析成 { date, data }。
      quote: summary.quote ? { id: summary.quote.id } : undefined,
    },
  };
}
export { deriveMsgType };

// #endregion
