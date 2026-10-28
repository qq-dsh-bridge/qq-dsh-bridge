// OneBot 事件接收与路由 —— 所有入站事件的唯一入口。

import { normalizeEvent, isConvAllowed } from './normalize.js';
import { textOf } from '../chatlog/segments.js';
import { KINDS } from '../turn/pool.js';
import { persistMessage } from '../chatlog/intake.js';

// #region 事件分类（纯函数）

export function classifyEvent(event) {
  const post = event?.post_type;

  if (post === 'meta_event') return 'meta';

  // message_sent（本号回推）与普通 message 同路。
  if (post === 'message' || post === 'message_sent') return 'message';

  if (post === 'notice') {
    // 撤回的形状是单值 notice_type，不是 notice_type + sub_type 两字段。
    const nt = event.notice_type;
    if (nt === 'group_recall' || nt === 'friend_recall') return 'recall';
    // 表情回应（"谁对哪条点了个什么"）。SnowLuma 给 `sub_type: 'add' | 'remove'`。
    if (nt === 'group_msg_emoji_like') return 'reaction';
    // 戳一戳 —— 必须连 `sub_type` 一起判：`notify` 底下还混着
    // `input_status`（对方正在输入）。把"在打字"当成一件事喂给模型，它只会抢话。
    if (nt === 'notify' && event.sub_type === 'poke') return 'poke';
    return 'notice';
  }

  return 'unknown';
}

// #endregion


// #region 接线

export function attachOneBotEvents(ws, deps) {
  const { logger } = deps;

  // 连接层：只记日志，细节归 ws.js。
  ws.on('open', () => logger.info('OneBot 事件通道就绪'));

  ws.on('upstream-health', ({ good, online }) => {
    logger[good ? 'info' : 'warn']('SnowLuma 上游状态', { good, online });
  });

  ws.on('heartbeat-timeout', () => {
    logger.warn('心跳超时：连接判定已死，正在重连（SnowLuma 不重放掉线期间的消息）');
  });

  ws.on('reconnect-scheduled', ({ reason, attempt, delayMs }) => {
    logger.info('OneBot 重连排期', { reason, attempt, delayMs });
  });

  ws.on('malformed', ({ error }) => {
    logger.warn('收到无法解析的 OneBot 帧', { error: String(error) });
  });

  // 业务事件：唯一入口。全部 fire-and-forget（不阻塞 WS），
  // 所以每个 handler 必须自己把异常吃掉 —— 见 handleMessage 末尾。
  ws.on('event', (event) => {
    switch (classifyEvent(event)) {
      case 'meta':
        logger.debug('meta_event', { type: event.meta_event_type, sub: event.sub_type });
        return;

      case 'recall':
        void handleRecall(event, deps);
        return;

      case 'reaction':
        void handleReaction(event, deps);
        return;

      case 'poke':
        void handlePoke(event, deps);
        return;

      case 'message':
        void handleMessage(event, deps);
        return;

      default:
        // 这里必须把 `notice_type` 和 `sub_type` **都**打出来。
        //
    // 只记 `sub: notice_type` 是不够的：`notify` 底下混着 `poke`（戳一戳）和
    // `input_status`（对方正在输入），日志里只看到 `sub=notify` 就答不出"到底
    // 收到过没有戳一戳"。一个日志字段的缺失，会让后面所有"接入哪个事件"的
    // 决定失去依据。
        logger.debug('非消息事件', {
          post_type: event?.post_type,
          notice_type: event?.notice_type ?? '',
          sub_type: event?.sub_type ?? event?.request_type ?? '',
        });
    }
  });
}

// #endregion


// #region 接收：消息

async function handleMessage(event, deps) {
  const {
    registry, allow, logger,
  } = deps;

  // ① 解析成内部形状。失败要可见地丢，不能静默。
  let normalized;
  try {
    // 身份判定不在这一层：状态机按 registry.ownerQq 现读（传快照会静默失效）。
    normalized = normalizeEvent(event);
  } catch (error) {
    logger.warn('消息事件解析失败', {
      error: String(error),
      raw: JSON.stringify(event).slice(0, 300),
    });
    return;
  }
  if (!normalized) return;

  // ② 白名单 —— 必须在任何副作用之前（否则会建目录、写库）。
  if (!isConvAllowed(normalized.convKey, allow)) {
    logger.debug('会话不在白名单内，完全忽略', {
      conv: normalized.convKey,
      sender: normalized.message.sender?.name,
      text: textOf(normalized.message).slice(0, 40),
    });
    return;
  }

  try {
    // *落库 → 反应** 两步，顺序固定（见 `intake.js` 的文件头）：
    //   ① `persistMessage` —— 到达即落库（本号回推顺带标已读），与状态机无关；
    //   ② `conv.accept`    —— 触发 / 闸门 / 投递，纯反应。
    const message = {
      ...normalized.message,
      event,
      atSelf: normalized.summary.atSelf,
      quote: normalized.summary.quote,
    };
    const conv = registry.conversationFor(normalized.convKey);
    const { stored, selfSent } = persistMessage(conv.store, message);
    const r = await conv.accept(stored, message, { selfSent });

    if (r.action === 'buffered') {
      // 把"为什么没投递"说到能照排查：not-triggered 混了三种情况。
      // 派生量在这里现算（入口不再产出 diag）：@ 了谁，直接看 segments。
      const atOthers = (normalized.message.segments ?? [])
        .filter((s) => s?.type === 'at')
        .map((s) => String(s.data?.qq ?? ''))
        .filter((q) => q !== '' && q !== normalized.selfQq);
      let hint = '';
      if (r.reason === 'not-triggered') {
        if (atOthers.length) {
          hint = `这条 @ 的是别人（${atOthers.join(',')}），不是本号；要叫它请从 @ 候选列表里选它`;
        } else if (!normalized.summary.atSelf && /^\s*@/.test(normalized.summary.text ?? '')) {
          hint = '正文以 @ 开头，但那只是手打的纯文本（QQ 不当作提及）；请从 @ 候选列表里选中它';
        } else {
          hint = '没有 @ 它也没有引用它';
        }
      }
      logger.debug('已入缓冲（未投递）', {
        conv: normalized.convKey,
        why: r.reason,
        seq: r.seq,
        hint: hint || undefined,
      });
    }
  } catch (error) {
    // 这层 catch 必需：本函数是 fire-and-forget 调用的，
    // 没有它异常会变成"未处理的 Promise 拒绝"，表现成消息凭空消失。
    logger.error('处理消息事件出错', { conv: normalized.convKey, error: String(error) });
  }
}

// #endregion


// #region 接收：撤回

export async function handleRecall(event, deps) {
  const { registry, logger } = deps;

  // 群撤回给 group_id；私聊撤回（friend_recall）没有群号，用 user_id。
  const isGroup = event.notice_type === 'group_recall';
  const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;

  // 只查不建：一条撤回不该凭空开一个工作区（registry.get 会建）。
  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('撤回：该会话还没建立，无法标记', { conv: key, msgId: event.message_id });
    return;
  }

  // OneBot 的 time 是**秒**，本项目统一毫秒。
  const atMs = (Number(event.time) || 0) * 1000;

  // 撤回者 —— 群/私聊**判据不同**，不能共用一句 `operator_id ?? user_id`。
  //
  // 群：只能用 `operator_id`。**不能退化成 `user_id`** —— 那条通知里
  //     `user_id` 是"**消息作者**"（SnowLuma 传的是 `authorUin`），而群
  //     管理员可以撤别人的，两者常常不是同一个人。缺了就留空 + 告警。
  //
  // 私聊：`friend_recall` **只给 `user_id`（= 会话对方）**，没有
  //     `operator_id`（SnowLuma 把 `recalledBySelf` 留在内部、不放线上）。
  //     但私聊**只能撤自己的消息**，所以按"被撤那条是谁发的"判即可：
  //     本号发的 ⇒ 本号撤的，否则 ⇒ 对方撤的。
  let operatorQq = '';
  if (isGroup) {
    operatorQq = String(event.operator_id ?? '');
    if (operatorQq === '') {
      logger.warn('群撤回通知没有 operator_id，撤回者未知', { conv: key, msgId: event.message_id });
    }
  } else {
    operatorQq = String(conv.store.findByMessageId(event.message_id)?.message?.sender?.qq ?? '');
    if (operatorQq === '') {
      logger.debug('私聊撤回：本地查不到原消息，撤回者未知', { conv: key, msgId: event.message_id });
    }
  }

  // 撤回是**原地标记**原消息，不新增行。
  //  `atMs` 缺失必须传 undefined —— store 里是 `info.atMs ?? Date.now()`，
  //    传 0 会被当成有效值，落盘变成 1970。
  const r = conv.store.recall(event.message_id, {
    sender: operatorQq ? { qq: operatorQq } : undefined,
    atMs: atMs || undefined,
  });

  if (r.found) {
    conv.store.flush(r.date);
    logger.info('撤回已标记', {
      conv: key, msgId: event.message_id, date: r.date, by: operatorQq || '(未知)', at: atMs || '(事件没带时间)',
    });
  } else {
    // 本地没有原文（桥接刚重启 / 消息早于建库）：只记一行，不写库。
    logger.info('撤回但本地无原文（不写记录）', {
      conv: key, msgId: event.message_id, by: operatorQq || '(未知)',
    });
  }

  // *入池** —— 给"呈现给模型"那条路用（`pool.since(CURSORS.RECALL)`）。
  //
  // **无条件入池，不看 `agentRunning`**：回合之间发生的撤回也得留到下次投递时
  //    呈现出来。池是滑动窗口，不是"回合内缓存"。
  //  `found === false`（本地没原文）**也要入**：模型该知道"群里有人撤了一条、
  //    我们没存到原文" —— 那和"没人撤回"是两件完全不同的事。
  //  这里**不额外落原始事件行**：撤回的事实已经在 `state.jsonl` 里
  //    （`recalled` + 撤回者 + 时间，见 `store.recall`）。池里这份是**视图**，
  //    只为了让"上次呈现之后又撤了哪几条"能算出来。
  //  `atMs` 为 0（事件没带时间）时传 undefined，让池取当前时刻。
  conv.turnPool?.addEvent({
    kind: KINDS.RECALL,
    subject: { messageId: String(event.message_id ?? '') },
    actor: operatorQq,
    author: String(event.user_id ?? ''),
    tsMs: atMs || undefined,
  });
}

// #endregion


// #region 接收：表情回应

// 表情回应（`group_msg_emoji_like`）—— "谁对哪条点了个什么"。
//
// 形状（SnowLuma `event-converter/to-notice.ts`）：
//   `sub_type: 'add' | 'remove'`、`operator_id`（点的人）、`message_id`、
//   `likes: [{ emoji_id, count }]` —— 注意 `count` 是**该消息上这个表情的总数**，不是增量。
export async function handleReaction(event, deps) {
  const { registry, logger } = deps;
  const key = `group:${event.group_id}`;

  // 只查不建：一条表情不该凭空开一个工作区。
  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('表情回应：该会话还没建立，忽略', { conv: key, msgId: event.message_id });
    return;
  }

  const likes = Array.isArray(event.likes) ? event.likes : [];
  const first = likes[0] ?? {};
  const emoji = String(first.emoji_id ?? '');
  //  **`emoji` 为空就别入池**：池的合并判据里有 `it.emoji !== next.emoji`，
  //    两个空 emoji 会被当成"同一个表情"合并成一条 —— 把两件不同的事搅在一起。
  //    正常通知一定带 `emoji_id`，空值说明形状与预期不符，宁可丢一条并告警。
  if (emoji === '') {
    logger.warn('表情回应没有 emoji_id，形状与预期不符，已忽略', {
      conv: key, msgId: event.message_id, raw: JSON.stringify(event).slice(0, 300),
    });
    return;
  }

  conv.turnPool?.addEvent({
    kind: KINDS.REACTION,
    subject: { messageId: String(event.message_id ?? '') },
    actor: String(event.operator_id ?? event.user_id ?? ''),
    emoji,
    // `sub_type` 才是"加了 / 取消了"；缺了留 undefined（池不会拿它当合并判据）。
    isAdd: event.sub_type === 'add' ? true : event.sub_type === 'remove' ? false : undefined,
    tsMs: (Number(event.time) || 0) * 1000 || undefined,
    // `count` 是总数不是增量 —— 只留作排障，本地一律用自己合并出来的 `count`。
    payload: { count: first.count, messageSeq: event.message_seq },
  });

  logger.info('表情回应入池', {
    conv: key, msgId: event.message_id, emoji,
    by: event.operator_id ?? event.user_id ?? '(未知)',
    act: event.sub_type ?? '?',
  });
}

// #endregion


// #region 接收：戳一戳

// 戳一戳（`notify` + `sub_type: 'poke'`）。
//
// 形状（SnowLuma）：群版 `group_id / user_id（戳的人）/ target_id（被戳的）`；
// 私聊版没有 `group_id`，而且 `user_id` 是**对方**、真正戳的人在 `sender_id`。
//
//  它**没有 messageId** —— 戳一戳不挂在任何一条消息上。所以它只能以自身为条目，
//    也永远做不成"消息的属性"（这就是 `pool.js` 里"事件为什么是追加条目"的第 ③ 条）。
export async function handlePoke(event, deps) {
  const { registry, logger } = deps;
  const isGroup = event.group_id !== undefined;
  const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;

  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('戳一戳：该会话还没建立，忽略', { conv: key, target: event.target_id });
    return;
  }

  //  `actor` 不能一律取 `user_id`：私聊里 `user_id` 是**对方**（`peerUin`），
  //    是谁戳的在 `sender_id`。群里没有 `sender_id`，`user_id` 就是戳的人。
  const actor = String(event.sender_id ?? event.user_id ?? '');
  const target = String(event.target_id ?? '');
  const selfQq = String(conv.store.selfQq ?? '');

  conv.turnPool?.addEvent({
    kind: KINDS.POKE,
    actor,
    target,
    tsMs: (Number(event.time) || 0) * 1000 || undefined,
    // `action` / `suffix` 是"戳了戳 / 拍了拍"的文案，只给呈现层用，不参与判定。
    payload: { action: event.action, suffix: event.suffix },
  });

  // `toSelf` 打出来是为了排障：只有"戳它"才可能值得让它回应，戳别人基本是群里的自娱。
  logger.info('戳一戳入池', {
    conv: key, by: actor || '(未知)', to: target || '(未知)',
    toSelf: target === selfQq && selfQq !== '' ? 'yes' : 'no',
  });
}

// #endregion
