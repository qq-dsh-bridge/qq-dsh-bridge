// 单个会话的聊天记录存储。
//
// 布局（v3）：
//   <root>/<conv dir>/conv.json                    会话级：{ schemaVersion, conv, selfQq }
//   <root>/<conv dir>/chat/YYYY-MM-DD.jsonl        消息：一行一条，只追加（落盘后永不改）
//   <root>/<conv dir>/chat/YYYY-MM-DD.state.jsonl  状态增量：一行一条，后写覆盖先写
//
// 为什么拆两个：消息永不改变，会变的只有 readCount 与撤回状态（state）。
// v2 每次 flush 全量重写日文件（实测平均 3.1 MB、最大 7.9 MB，且每条新消息触发一次）；
// 现在新消息追加一行、状态变化追加一行 —— 不需要重写任何东西。
//
// 状态行用「行号 + guard」定位：messageId 是 32 位哈希、会碰撞（生日界 3 万条约 19%），
// 而追加文件的行号稳定唯一；guard（群 msgSeq / 私聊 messageId）用来在文件被外部改动时
// *发现**错位，而不是把状态套到别的消息上。

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// #region 常量

export const SCHEMA_VERSION = 3;

// 引用最多嵌套几层（不设限会无限嵌套，体积失控）。
export const MAX_QUOTE_DEPTH = 3;

// 内存里最多缓存几天的已解析文档；超过就驱逐最旧的**干净**天。
const MAX_CACHED_DAYS = 8;

// 记录上挂"上次已落盘状态"的私有键。**不可枚举** → 不参与 {...record}、也不进 JSON.stringify。
const PERSISTED = Symbol('persisted');

// #endregion

// #region 工具函数

// 深拷贝一条记录（放进 quote 用），并在指定深度截断更深的 quote。
function copyRecord(record, depth) {
  if (!record || depth <= 0) return undefined;
  const out = { ...record };   // PERSISTED 不可枚举 → 不会被带过来
  // 只深拷贝会被原地修改的部分；其余是值类型或不再变动。
  if (Array.isArray(record.segments)) out.segments = record.segments.map((s) => ({ ...s }));
  if (record.quote?.data) {
    const inner = copyRecord(record.quote.data, depth - 1);
    if (inner) out.quote = { date: record.quote.date, data: inner };
    else delete out.quote;
  }
  return out;
}

// 入参是**毫秒**（全项目统一毫秒）。
export function dateOf(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 毫秒 → `YYYY-MM-DD HH:MM`（本地时区；与 dateOf 同口径，混用 UTC 会让凌晨差一天）。
export function dateTimeOf(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${dateOf(tsMs)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 会话键 → 工作区目录名：`group:1234567890` → `group_1234567890`。
export function dirNameOf(convKey) {
  return String(convKey).replace(':', '_');
}

// 统一的**定位符**（seq）—— 对外只用它描述"哪条消息"：
//   群聊 → `msgSeq`（服务端给的群序号，群内唯一，纯数字）
//   私聊 → `MMDD#no`（本地序号**必须带日期**：它每天从 1 重来，而窗口会跨天）
export function seqOf(record, date = '') {
  if (!record) return undefined;
  if (record.msgSeq !== undefined && record.msgSeq !== null) return String(record.msgSeq);
  if (record.no === undefined || record.no === null) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  return m ? `${m[2]}${m[3]}#${record.no}` : String(record.no);
}

export class ChatStoreError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'ChatStoreError';
    this.hint = hint;
  }
}

// #endregion

export class ChatStore extends EventEmitter {
  // #region 构造与初始化

  constructor({ root, convKey, logger, flushDelayMs = 2000, selfQq = '', maxCachedDays = MAX_CACHED_DAYS } = {}) {
    super();
    this.root = root;
    this.convKey = convKey;
    this.dir = path.join(root, dirNameOf(convKey));
    this.chatDir = path.join(this.dir, 'chat');
    this.logger = logger;
    this.flushDelayMs = flushDelayMs;
    this.selfQq = selfQq ? String(selfQq) : '';
    this.maxCachedDays = Number(maxCachedDays) > 0 ? Number(maxCachedDays) : MAX_CACHED_DAYS;
    // 私聊才分配本地 `no`（群聊的定位键是服务端给的 msgSeq）。
    this.isPrivate = String(convKey).startsWith('private:');

    // date → { doc, dirty }。`doc` = { date, messages, lastNo | lastMsgSeq }。
    this.cache = new Map();
    // 待落盘的定时器（按日期）。
    this.flushTimers = new Map();
    this.conv = null;
  }

  init() {
    fs.mkdirSync(this.chatDir, { recursive: true });
    this.#guardOldFormat();
    this.#loadConv();
    return this;
  }

  // 确保**会话目录本身**存在：DSH 注册 workspace 要求路径先存在（见 main.js 的 ensureWorkspaces）。
  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.chatDir, { recursive: true });
    return this;
  }

  fileFor(date) {
    return path.join(this.chatDir, `${date}.jsonl`);
  }

  stateFileFor(date) {
    return path.join(this.chatDir, `${date}.state.jsonl`);
  }

  // 空文档。计数字段按会话类型分：私聊 `lastNo`（本地序号）、群聊 `lastMsgSeq`（群序号）。
  emptyDoc(date) {
    return this.isPrivate
      ? { date, lastNo: 0, messages: [] }
      : { date, lastMsgSeq: 0, messages: [] };
  }

  // #endregion
 
  
  // #region 版本闸门 / 会话元数据

  // v2 的日文件是 `YYYY-MM-DD.json`（整份 JSON）。发现它就**拒绝启动** ——
  // 静默忽略会让历史看起来"凭空消失"，而强行读只会得到一堆错位字段。
  #guardOldFormat() {
    let old = [];
    try {
      old = fs.readdirSync(this.chatDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    } catch {
      // 目录刚建，必然为空
    }
    if (old.length) {
      throw new ChatStoreError(
        `${this.chatDir} 里还有 ${old.length} 个 v2 旧日文件（如 ${old.sort()[0]}），当前结构版本是 v${SCHEMA_VERSION}`,
        {
          hint: '新格式是 .jsonl（一行一条消息）+ .state.jsonl（状态增量）。'
            + '旧文件请移走备份（例如移到 chat/_v2-archive/）后再启动 —— 不要留在原地，'
            + '否则每次启动都会停在这里。',
        },
      );
    }
  }

  // 会话级元数据（版本闸门 + 本号）：读进来就留着。
  #loadConv() {
    const file = path.join(this.dir, 'conv.json');
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new ChatStoreError(`解析 ${file} 失败：${error.message}`, {
          hint: '会话元数据损坏。修好它，或把它移走后重启（只会重建这一份元数据）。',
        });
      }
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        throw new ChatStoreError(
          `${file} 的结构版本是 ${parsed.schemaVersion ?? '(缺失)'}，期望 ${SCHEMA_VERSION}`,
          { hint: '这是旧结构的会话。请把整个会话目录（或其 chat/ 下的旧文件）移走备份后重启。' },
        );
      }
      // 本号兜底补上（换了配置也能补）
      if (!parsed.selfQq && this.selfQq) {
        parsed.selfQq = this.selfQq;
        this.#writeConv(parsed);
      }
      this.conv = parsed;
      return parsed;
    }

    const fresh = {
      schemaVersion: SCHEMA_VERSION,
      conv: this.convKey,
      selfQq: this.selfQq || undefined,
    };
    this.#writeConv(fresh);
    this.conv = fresh;
    return fresh;
  }

  #writeConv(conv) {
    const file = path.join(this.dir, 'conv.json');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(conv, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);   // 同盘 rename 是原子的
  }

  // #endregion
 
  
  // #region 读一天

  // 读一天。不存在则返回空文档（不落盘）。
  load(date) {
    const hit = this.cache.get(date);
    if (hit) return hit.doc;

    const messages = [];
    const file = this.fileFor(date);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (raw === '') continue;
        try {
          messages.push(JSON.parse(raw));
        } catch (error) {
          // 坏行**必须可见** —— 静默跳过等于凭空少一条消息。
          this.logger?.error('聊天记录有坏行，已跳过', {
            conv: this.convKey, date, line: i + 1, error: String(error), preview: raw.slice(0, 120),
          });
        }
      }
    }

    const doc = this.emptyDoc(date);
    doc.messages = messages;
    this.#foldStates(date, doc);
    if (this.isPrivate) {
      for (const m of doc.messages) {
        const no = Number(m.no);
        if (Number.isFinite(no) && no > doc.lastNo) doc.lastNo = no;
      }
    } else {
      for (const m of doc.messages) {
        const seq = Number(m.msgSeq);
        if (Number.isFinite(seq) && seq > doc.lastMsgSeq) doc.lastMsgSeq = seq;
      }
    }

    this.cache.set(date, { doc, dirty: false });
    this.#evict(date);
    return doc;
  }

  // 把状态增量折进消息（后写覆盖先写）。
  // 每折一条都更新 PERSISTED 标记 —— 于是 flush 只写**新的**变化，不需要任何磁盘基线。
  #foldStates(date, doc) {
    for (const m of doc.messages) this.#track(m, m.readCount ?? 0, m.state);

    const file = this.stateFileFor(date);
    if (!fs.existsSync(file)) {
      for (const m of doc.messages) m.readCount = m.readCount ?? 0;
      return;
    }

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let applied = 0;
    for (let ln = 0; ln < lines.length; ln += 1) {
      const raw = lines[ln].trim();
      if (raw === '') continue;
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch (error) {
        // 崩溃时最后一行可能只写了一半 —— 记一行，别当致命错误。
        this.logger?.warn('状态日志有坏行，已跳过', {
          conv: this.convKey, date, line: ln + 1, error: String(error), preview: raw.slice(0, 120),
        });
        continue;
      }
      const i = Number(patch?.i);
      const m = Number.isInteger(i) ? doc.messages[i] : undefined;
      if (!m) {
        this.logger?.warn('状态日志指向不存在的行号，已跳过', {
          conv: this.convKey, date, line: ln + 1, i: patch?.i,
        });
        continue;
      }
      // guard 只用来**发现**错位：对不上就跳过，绝不把状态套到别的消息上。
      if (patch.g !== undefined && String(patch.g) !== String(this.#guardOf(m))) {
        this.logger?.warn('状态日志与消息对不上（文件被外部改动过？），已跳过', {
          conv: this.convKey, date, line: ln + 1, i, guard: patch.g, got: this.#guardOf(m),
        });
        continue;
      }
      if (patch.r !== undefined) m.readCount = Number(patch.r);
      // null = 清空状态（正常流程不会出现，防御一下）
      if (patch.s !== undefined) m.state = patch.s === null ? undefined : patch.s;
      applied += 1;
    }

    for (const m of doc.messages) {
      m.readCount = m.readCount ?? 0;
      this.#track(m, m.readCount, m.state);
    }
    if (applied) this.logger?.debug('已折叠状态增量', { conv: this.convKey, date, applied });
  }

  #track(record, r, s) {
    Object.defineProperty(record, PERSISTED, {
      value: { r, s }, writable: true, enumerable: false, configurable: true,
    });
  }

  // 状态行里的 guard：群用 msgSeq、私聊用 messageId（与去重键同口径）。
  #guardOf(record) {
    if (!this.isPrivate && record?.msgSeq !== undefined && record?.msgSeq !== null) return record.msgSeq;
    return record?.messageId;
  }

  // 落盘投影：消息行**不含** readCount / state（那两个走状态日志）。
  #toLine(record) {
    const out = {
      messageId: record.messageId,
    };
    // `no` 只有私聊有（它是对外定位键）；群聊的身份是服务端的 msgSeq。
    if (record.no !== undefined) out.no = record.no;
    if (record.msgSeq !== undefined) out.msgSeq = record.msgSeq;
    out.tsMs = record.tsMs;
    out.sender = record.sender;
    if (record.segments !== undefined) out.segments = record.segments;
    if (record.quote !== undefined) out.quote = record.quote;
    return out;
  }

  // #endregion
  
  
  // #region 查一条

  // 按 messageId 找一条（跨天，从新到旧）。
  // 保持线性倒扫：实测单次约 0.037ms，而引用消息占比不到 10%；倒排索引出 bug 的症状是
  // "引用解析到错的那条"，极难查 —— 慢但绝对正确。
  findByMessageId(messageId) {
    const id = String(messageId ?? '');
    if (!id) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (String(doc.messages[i].messageId) !== id) continue;
        return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  // 按 QQ 的 `msgSeq` 找一条（群聊定位键；私聊不产出该字段）。
  findByMsgSeq(msgSeq) {
    const want = Number(msgSeq);
    if (!Number.isFinite(want) || want === 0) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (Number(doc.messages[i].msgSeq) !== want) continue;
        return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  // 按本地 `no` 找一条（从最新往回扫，先命中就返回）。
  // ⚠️ 跨天会撞号（`no` 每天从 1 重来）—— 新代码请用 `findByRef('MMDD#no')`。
  findByNo(no) {
    const want = Number(no);
    if (!Number.isFinite(want) || want <= 0) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (Number(doc.messages[i].no) === want) return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  // 按 `MMDD` + 本地 `no` 精确找（跨天不撞号）。
  findByDateNo(mmdd, no) {
    const want = String(no);
    for (const date of this.#datesDescending()) {
      if (date.slice(5, 7) + date.slice(8, 10) !== String(mmdd)) continue;
      const doc = this.load(date);
      for (const m of doc.messages) {
        if (String(m.no) === want) return { message: m, date };
      }
    }
    return null;
  }

  // 按统一**定位符**找一条。四种形状都认（对 AI 只暴露第一种）：
  //   `1001#7`     日期 + 本地 no → 精确命中（**新**，私聊用）
  //   `1234`      群：msgSeq / 私聊：本地 no（旧行为，先这样找）
  //   `-100002` messageId（旧行为，兜底）
  // @returns `{ message, date }` 或 null
  findByRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    const dated = /^(\d{4})#(\d+)$/.exec(s);
    if (dated) return this.findByDateNo(dated[1], dated[2]);
    if (/^\d+$/.test(s)) {
      if (!this.isPrivate) {
        const hit = this.findByMsgSeq(Number(s));
        if (hit) return hit;
      } else {
        const hit = this.findByNo(Number(s));
        if (hit) return hit;
      }
    }
    return this.findByMessageId(s);
  }

  // #endregion
  
  
  // #region 引用

  // 把引用解析成 `{ date, data }`，data 是被引用消息的**整个快照**（深拷贝）。
  // 整条抄进来：只抄几个字段时，被引用的是纯图片就会得到空 text，AI 只能回"我没看到那条"。
  // 深拷贝是必须的 —— 否则那条被标已读/被撤回时，引用里的副本会跟着变。
  #resolveQuote(quote) {
    if (!quote) return undefined;
    const id = String(quote.id ?? quote.messageId ?? '');
    if (!id) return undefined;
    const found = this.findByMessageId(id);
    if (!found) return undefined;
    return { date: found.date, data: copyRecord(found.message, MAX_QUOTE_DEPTH) };
  }

  // 给 segments 里的 reply 段补上被引用那条的**定位符 seq**。
  // OneBot 的 reply 段只给 messageId，而 AI 的定位走 `seq`；入库时补最合适。
  // 查不到就**不补**（渲染成 `[reply:messageId=…]`）—— 伪造一个错的 seq 会让 AI 去查不相干的消息。
  #stampReplySeq(segments) {
    if (!Array.isArray(segments)) return segments;
    if (!segments.some((s) => s?.type === 'reply')) return segments;

    return segments.map((seg) => {
      if (seg?.type !== 'reply') return seg;
      const id = String(seg.data?.id ?? '');
      if (!id) return seg;
      const found = this.findByMessageId(id);
      if (!found) return seg;
      return { ...seg, data: { ...seg.data, seq: seqOf(found.message, found.date) } };
    });
  }

  // #endregion
  
  
  // #region 落盘

  // 落盘一天：**只追加状态增量**（消息在 append 时就已落盘）。
  // 把与"上次已落盘值"不同的挑出来追加一行 → 一次 flush 的成本是 O(增量)，与文件大小无关。
  flush(date) {
    const entry = this.cache.get(date);
    if (!entry || !entry.dirty) return false;

    const lines = [];
    const msgs = entry.doc.messages;
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      const r = Number(m.readCount ?? 0);
      const s = m.state;
      const last = m[PERSISTED] ?? { r: 0, s: undefined };
      const patch = {};
      if (r !== last.r) patch.r = r;
      if (JSON.stringify(s ?? null) !== JSON.stringify(last.s ?? null)) patch.s = s ?? null;
      if (patch.r === undefined && patch.s === undefined) continue;

      const line = { i, g: this.#guardOf(m) };
      if (patch.r !== undefined) line.r = patch.r;
      if (patch.s !== undefined) line.s = patch.s;
      lines.push(`${JSON.stringify(line)}\n`);
      this.#track(m, r, s);
    }

    if (!lines.length) {
      entry.dirty = false;
      return false;
    }

    // 先写盘、后清脏：写失败时保持脏，下次 flush 会重试（否则状态静默丢失）。
    fs.appendFileSync(this.stateFileFor(date), lines.join(''), 'utf8');
    entry.dirty = false;
    this.emit('flushed', { date, count: msgs.length, stateLines: lines.length });
    return true;
  }

  flushAll() {
    let n = 0;
    for (const date of [...this.cache.keys()]) if (this.flush(date)) n += 1;
    return n;
  }

  // 安排一次延迟落盘（状态变化会成批到达，每条都写会放大 IO；消息本身已在 append 时落盘）。
  // ⚠️ 标脏与 scheduleFlush 必须成对：`flush()` 第一行就是 `if (!entry.dirty) return false`。
  scheduleFlush(date) {
    if (this.flushTimers.has(date)) return;
    const t = setTimeout(() => {
      this.flushTimers.delete(date);
      try {
        this.flush(date);
      } catch (error) {
        // 落盘失败不能拖垮主流程，但必须可见。
        this.logger?.error('聊天记录落盘失败', { date, conv: this.convKey, error: String(error) });
      }
    }, this.flushDelayMs);
    t.unref?.();
    this.flushTimers.set(date, t);
  }

  // 立即把所有待落盘的都写掉（退出时用）。
  flushPending() {
    for (const [date, t] of this.flushTimers) {
      clearTimeout(t);
      this.flushTimers.delete(date);
    }
    return this.flushAll();
  }

  // #endregion
  
  
  // #region 写一条

  // 追加一条消息。**消息行立刻落盘**（一条 appendFileSync）；状态变化由调用方标脏走 flush。
  append(message) {
// 去重键按会话类型选：群 → msgSeq（服务端保证唯一，实测上万条零重复）；
    // 私聊 → messageId（私聊的 message_seq 是发送方本地的、双向会撞）。
    const seq = Number(message.msgSeq);
    const hasSeq = !this.isPrivate && Number.isFinite(seq) && seq > 0;
    if (hasSeq) {
      // 群聊有 msgSeq 时**只按它去重**：退回 messageId 会把"撞了号的两条不同消息"
      // 当成重复丢掉（messageId 是 32 位哈希、会碰撞，正是要消灭的那个静默故障）。
      const hit = this.findByMsgSeq(seq);
      if (hit) return hit.message;
    } else {
      // 私聊、或群聊缺 msgSeq（极少：调用方合成的行）→ 按 messageId 去重。
      const incomingId = String(message.messageId ?? '');
      if (incomingId !== '') {
        const found = this.findByMessageId(incomingId);
        if (found) return found.message;
      }
    }

    // ⚠️ 时间**必须是真毫秒**（全项目统一；旧结构同时存过 ts(秒) 与 tsMs）。
    const tsMs = Number(message.tsMs) || Date.now();
    const date = dateOf(tsMs);
    const doc = this.load(date);

      // ⚠️ 发送者 qq 是空串时**主动报出来**：那意味着上游字段名对不上（谁说的
      //    全丢、本号判定与门禁全失效，而日志里一行错都没有）。只警告不抛：
      //    丢一条消息比整条链路停摆好。
    if (String(message.sender?.qq ?? '') === '') {
      this.logger?.error('消息的发送者 qq 是空串 —— 落盘后"谁说的"会丢失', {
        conv: this.convKey,
        messageId: message.messageId,
        gotSender: JSON.stringify(message.sender ?? null),
        hint: '大概率是调用方写了 sender.id 而这里读 sender.qq（字段名必须统一成 qq）',
      });
    }

    const msgSeq = message.msgSeq === undefined || message.msgSeq === null
      ? undefined
      : Number(message.msgSeq);
    if (!this.isPrivate && Number.isFinite(msgSeq) && msgSeq > (doc.lastMsgSeq ?? 0)) {
      doc.lastMsgSeq = msgSeq;
    }

    // `no` **只有私聊有**：它是私聊的对外定位键（群聊用服务端的 msgSeq）。
    // 群聊这里给 undefined，下面的"去掉 undefined 字段"会把它整个删掉。
    const no = this.isPrivate ? (doc.lastNo ?? 0) + 1 : undefined;
    if (this.isPrivate) doc.lastNo = no;

    const record = {
      no,
      messageId: String(message.messageId ?? ''),
      msgSeq,
      tsMs,
      sender: {
        qq: String(message.sender?.qq ?? ''),
        name: String(message.sender?.name ?? ''),
        // 只存群内**事实**；"是不是你的主人"由投喂时按 owner.qq 现算（换人格卡就变）。
        groupRole: normalizeGroupRole(message.sender?.groupRole),
      },
      // segments 是**唯一数据源**（正文/媒体/@/引用都在里面）；
      // 这里会就地补上 reply 段的 no（OneBot 只给 messageId）。
      segments: this.#stampReplySeq(
        Array.isArray(message.segments) ? message.segments : undefined,
      ),
      // 引用只在本地解析（查不到就不写这个字段 → 提示词层说明"查不到"）。
      quote: this.#resolveQuote(message.quote),
      readCount: 0,
    };
    // 去掉 undefined 字段，让文件干净（AI 也读它）。
    for (const k of Object.keys(record)) {
      if (record[k] === undefined) delete record[k];
    }

    doc.messages.push(record);
    this.#track(record, 0, undefined);
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.appendFileSync(this.fileFor(date), `${JSON.stringify(this.#toLine(record))}\n`, 'utf8');
    this.emit('appended', { date, message: record });
    return record;
  }

  // #endregion
  
  
  // #region 撤回

  // 撤回：**原地**标记（不新增行），状态在下次 flush 时追加进状态日志。
  // ⚠️ `info.atMs` 缺失必须传 undefined —— `??` 只挡 null/undefined，传 0 会落成 1970。
  recall(messageId, info = {}) {
    const id = String(messageId);
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (doc.messages[i].messageId !== id) continue;
        const msg = doc.messages[i];
        // 撤回者身份：撤回通知通常**只有 QQ**，所以拿他之前说过话时的
        // 昵称/群内身份补全 —— 否则会落盘 `name:""` + `groupRole:"member"`
        // 这种"不知道却写死"的假事实（实测：群主撤自己的消息被记成 member）。
        // 两样都查不到就**不写这两个字段**（空着才是诚实的）。
        const qq = String(info.sender?.qq ?? '');
        const known = qq === '' ? undefined : this.#knownIdentityOf(qq);
        const name = String(info.sender?.name || known?.name || '');
        const roleRaw = info.sender?.groupRole || known?.groupRole;
        msg.state = {
          ...msg.state,
          recalled: 1,
          recalledTime: info.atMs ?? Date.now(),
          ...(qq === '' ? {} : {
            sender: {
              qq,
              ...(name === '' ? {} : { name }),
              ...(roleRaw ? { groupRole: normalizeGroupRole(roleRaw) } : {}),
            },
          }),
        };
        this.cache.get(date).dirty = true;
        this.scheduleFlush(date);
        this.emit('recalled', { date, message: msg });
        return { found: true, message: msg, date };
      }
    }
    return { found: false, message: null, date: null };
  }

  // #endregion
  
  
  // #region 内存与日期

  // 这个人在本会话里**最近一次**留下的身份（昵称 + 群内身份）。
  //
  // 撤回通知里只有 QQ（`group_recall` 只给 `operator_id`，没有昵称、
  // 也没有群内身份），而"同一个人说过话的记录"里两样都有。
  // 找不到就返回 undefined —— 调用方**不写**这些字段，不猜。
  #knownIdentityOf(qq) {
    const want = String(qq);
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        const s = doc.messages[i]?.sender;
        if (String(s?.qq ?? '') !== want) continue;
        if (s.name || s.groupRole) return s;
      }
    }
    return undefined;
  }

  // 驱逐最旧的**干净**天，把内存压在上限内。
  // 现在才敢做：状态已落在 `.state.jsonl`，重新 load 能原样重建；而 markRead 那类调用都是
  // "先 load(date)、再按定位符原地改"，所以即便中途被驱逐，它改的也是重新加载出来的那份。
  #evict(protect = '') {
    if (this.cache.size <= this.maxCachedDays) return;
    const dates = [...this.cache.keys()].sort();   // 升序（最旧的在前）
    const newest = dates.slice(-2);
    for (const date of dates) {
      if (this.cache.size <= this.maxCachedDays) break;
      // 刚加载的那天不能驱逐：调用方正拿着它准备改（改了却不在缓存里 = 静默丢状态）
      if (date === protect) continue;
      if (newest.includes(date)) continue;
      const entry = this.cache.get(date);
      if (entry.dirty) continue;
      this.cache.delete(date);
      this.logger?.debug('已驱逐内存中的历史天', { conv: this.convKey, date, cached: this.cache.size });
    }
  }

  #datesDescending() {
    // 内存里已有的日期 + 磁盘上的日期，倒序（最新的先找）
    const set = new Set(this.cache.keys());
    try {
      for (const f of fs.readdirSync(this.chatDir)) {
        // 只认消息文件：`2026-10-15.jsonl`（状态文件是 `….state.jsonl`，不匹配）
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m) set.add(m[1]);
      }
    } catch {
      // 目录还不存在
    }
    return [...set].sort().reverse();
  }

  // 所有有记录的日期，升序。
  dates() {
    return this.#datesDescending().reverse();
  }

  // #endregion
}

// #region 归一化

// 群内身份归一化：只认 groupOwner / admin / member，其余一律 member。
// ⚠️ 是 `groupOwner` 而不是 `owner`：配置里的 `owner.qq` 指**"你的主人"**，而 OneBot 的
//    `role: 'owner'` 指**群主** —— 两者曾共用一个值，结果群主被渲染成【主人】。
export function normalizeGroupRole(value) {
  const v = String(value ?? '');
  if (v === 'groupOwner' || v === 'owner') return 'groupOwner';
  if (v === 'admin') return 'admin';
  return 'member';
}

// #endregion
