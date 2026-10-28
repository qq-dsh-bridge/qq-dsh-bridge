// 消息段 —— 归一化与渲染。
//
// ── 为什么单独一个模块
//
// 新结构下 `segments` 是**唯一数据源**：正文、媒体、@、引用全部在里面，
// 不再有外层的 text / media / atSelf 字段。所以"从 segments 读出什么"
// 这件事被很多地方需要（投喂渲染、AI 查询、搜索、msgType 判定），
// 而它必须**只有一份实现** —— 否则投喂看到的和 AI 查到的会不一致。
//
// ── 段形状（新结构）
//
//   { type, data }
//
//   text    data: { text }
//   image   data: { url, file, sub_type, summary?, emoji_id?, … }
//   face    data: { id, name? }
//   at      data: { id, name }
//   reply   data: { id, seq? }
//   record  data: { file, url }
//   video   data: { file, url }
//   forward data: { id }
//   json    data: { … }（QQ 富卡片原始数据，先不动）
//
// ⚠️ `data` 的形状**不固定**。实测 image 段在 emoji 表情时会多出
//    `emoji_id` / `emoji_package_id` / `key`。所以读取一律用可选链 + 兜底。

import { dateOf, seqOf } from './store.js';

// 内容是"非文本"的段类型（用于 msgType 判定与 marker 渲染）。
export const NON_TEXT_TYPES = Object.freeze([
  'image', 'face', 'record', 'video', 'forward', 'json',
]);

// at / reply **不算结构**（刻意）。
//
// 一条 `@某人` 或 `引用某条` 本身不构成"这是一条多媒体消息"，
// 它只是修饰。若把它们算进 msgType，那么"@某人 你好"会变成 mixed，
// 而实际上它就是一条文本消息。
const STRUCTURAL_TYPES = new Set(NON_TEXT_TYPES);

// 媒体段类型（取图/取文件用）。
export const MEDIA_TYPES = Object.freeze(['image', 'record', 'video']);

export function segmentsOf(m) {
  if (Array.isArray(m)) return m;
  return Array.isArray(m?.segments) ? m.segments : [];
}

// 媒体段（image / record / video）。
export function mediaOf(m) {
  const want = new Set(MEDIA_TYPES);
  return segmentsOf(m)
    .filter((s) => want.has(s?.type))
    .map((s) => ({ kind: s.type, ...(s.data ?? {}) }));
}

// 纯文本 —— **只拼 text 段**，不含任何标记。
//
// 用途：搜索（contains）、msgType 判定"有没有文字"、日志截断。
// ⚠️ **不要**用它生成给 AI 看的消息行 —— 那样会丢掉 @ 和媒体标记。
//    给 AI 看用 `segmentsToText()`。
export function textOf(m) {
  return segmentsOf(m)
    .filter((s) => s?.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join('')
    .trim();
}

// 这条消息有没有文字。
export function hasText(m) {
  return textOf(m) !== '';
}

// *把 segments 文本化** —— 唯一的"段 → 文本"实现。
//
// ── 职责范围（刻意收窄）
//
// 它**只做一件事**：把一段 segments 按顺序拼成文本。
// 它**不管**：
//   · 行首的 `[seq]`（那是行格式的事，调用方自己拼）
//   · 发言人、时间、身份（同上）
//   · 引用块（那是 `quote` 字段的事）
//
// 收窄是为了能同时服务两种场景：
//   · 整条消息的正文（`segmentsToText(m.segments, { selfQq })`）
//   · 引用块里被引用那条的正文（`segmentsToText(q.segments, { selfQq })`）
//
// ══ 格式：一律 `[type:形态]`，**形状稳定**
//
//     段         输出
//     text       [text:你好]                  ← 方括号包起来，不裸输出
//                [@你]                        ← 命中 selfQq
//                [@999()]                     ← 没昵称也给空括号（形状固定）
//                [@全体成员]                   ← at=all
//     reply      [reply:seq=8]                ← 查得到定位符
//                [reply:?]                    ← 查不到（MessageId 不给 AI，见下）
//     face       [face:微笑] / [face]
//     image      [image:动画表情] / [image]
//     record     [record]  video [video]  forward [forward]  json [json]
//
// ── 为什么 text 也包起来
//
// 正文必须包起来（`你好` 渲染成 `{你好}`）。裸输出的问题：AI 看到
// `[image:图片]你好`，没法确定 `你好` 是文字还是某个标记的一部分。
//
// 统一包成 `[text:...]` 之后：**每个段都有明确的边界**，
// 且格式可预测（`[type]` 或 `[type:形态]`）。
//
// ── 为什么 at 的空括号要保留
//
// `[@999()]` 看起来丑，但**形状固定**比"有时有括号有时没有"好：
// 格式一旦稳定，解析它的规则就能写死；否则要考虑三种变体。
//
// ── 为什么 reply 查不到时不把 messageId 给出去
//
// 引用一律只给定位符（seq）。messageId 是内部标识：引用、查询、撤回都不认它，
// 填进去必定失败，写进上下文只是噪音。
//
// 所以现在回到 `[reply:?]`：形状依旧固定（有引用就有标记），
// 但 AI 看到的是"这里有一条我库里没有的引用"，而不是"一段可以填进参数的数字"。
//
// ── 关于 image 的描述
//
// OneBot 的图片段带 `summary`，实测值形如 `[图片]` / `[动画表情]` / `[吃瓜]`
// —— **自带方括号**，所以这里要**剥掉**再重新包成 `[image:动画表情]`，
// 否则会渲染成 `[[动画表情]]`。
//
// 「动画表情」这几个字**信息量有限**（具体画的是什么仍要 AI 自己去识图），
// 但它至少区分了"截图"与"表情包"这个语义差别；真要知道内容
// 得调 `qq_get_content`（kind: "image"）。
//
// @param source 消息对象，或 segments 数组
// @param options.selfQq 本号 —— 命中的 at 渲染成 `[@你]`
// @returns 一行文本（**不含**行首 `[seq]`）
// ── 给 AI 看之前的转义
//
// 威胁：昵称和正文都是别人能改的，而它们直接拼进 `[name:…]` / `[text:…]`。
// 昵称写成 `小明的][QQ:10001`，这一行就会凭空多出一个**排在真号前面**的
// 身份字段；正文写 `}}{[seq:999]…` 能造出一条"看起来像真的"消息。
//
// 只在渲染层做 —— 盘上保留原话（排查、检索、`raw: true` 都要用）。
//
// ── 转义符为什么是 `⧵`（U+29F5），不是反斜杠
//
// `\[` 在 LaTeX 里是**行间公式开头**，模型和这台机器上的 latex 工具都可能把它
// 当命令吃掉。`§` 又会在正常文本里出现，还得转义它自己。`⧵` 在中文和聊天里
// 几乎不会出现，长得又像"被划掉的括号"，一眼能看出是转义。
//
// 规则（**顺序不能反**）：
//   1. 先转义转义符自己：`⧵` → `⧵⧵`
//   2. 再转义结构符：`[` → `⧵[`（`]` `{` `}` 同理）
// 反过来的话，名字末尾那个 `⧵` 会把后面的 `[` 吃掉，字段就闭不上。
export const ESC = '⧵';

// 控制符 / 零宽 / 双向控制：能拼出"看起来一样、字节不同"的行，直接删。
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
// 换行在折叠空白前先换成私有区字符，折叠完再换回来。
const NL_PLACEHOLDER = '\uE000';

// 正文：**内容不能改**，只把结构符转义掉。
//
// `newline` / `trim` 给发送回执用：
//   · 换行保留成 `\n`（不压成空格，模型能看出自己分段了）；
//   · 不 trim，保留 `" 内容"` 的前导空格（那是和 @ 之间的分隔）。
// 提示词里的行**不传**这两个参数 —— 那里必须是单行、去掉首尾空白。
export function escapeText(value, { newline = '', trim = true } = {}) {
  let s = String(value ?? '');
  if (newline) s = s.replace(/\r\n|\r|\n/g, NL_PLACEHOLDER);
  s = s
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .replaceAll(ESC, ESC + ESC)
    .replace(/[\[\]{}]/g, (c) => ESC + c);
  if (newline) s = s.replaceAll(NL_PLACEHOLDER, newline);
  return trim ? s.trim() : s;
}

// 非昵称标签（表情名 / 图片摘要 / 类型）：只需要挡住所在字段的闭合符
// `]`（以及伪造嵌套的 `[`），不需要 `{}`。
//
// `closers` 可调整；昵称和正文分别用 escapeName / escapeText。
export function escapeLabel(value, { max = 32, closers = '[]' } = {}) {
  let s = String(value ?? '')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .replaceAll(ESC, ESC + ESC);
  s = Array.from(s)
    .map((c) => (closers.includes(c) ? ESC + c : c))
    .join('')
    .trim();
  if (max > 0 && s.length > max) s = s.slice(0, max);
  return s;
}

// 昵称：与正文同一套转义 —— `[` `]` `{` `}` `⧵` 都加 `⧵`。
export function escapeName(value, { max = 32, closers = '[]{}' } = {}) {
  return escapeLabel(value, { max, closers });
}

export function segmentsToText(source, { selfQq = '', newline = '', trimText = true } = {}) {
  const segs = segmentsOf(source);
  const want = String(selfQq ?? '');
  const out = [];

  // 已撤回 —— 在段列表**最前面**标一个 `[recall]`。
  //
  // 为什么放这里：撤回是**这条消息的状态**（和 `[text:]` `[at:]` 一样属于
  // "这条是什么"），所以在大括号**里面**；放最前面是为了不被正文淹没 ——
  // AI 扫一眼就知道"这条已经没了"，而不是照着一个已经被撤掉的内容去回应。
  if (source?.state?.recalled) out.push('[recall]');

  for (const seg of segs) {
    const type = seg?.type;
    const d = seg?.data ?? {};
    switch (type) {
      case 'text':
        // 包起来 —— 让每个段的边界明确（见上面的说明）。
        // 正文**保原样**，只转义结构符（`[` → `⧵[`），`]` / `}` 顶不穿。
        out.push(`[text:${escapeText(d.text, { newline, trim: trimText })}]`);
        break;

      case 'at': {
        const qq = String(d.qq ?? '').replace(/[^\d]/g, '');
        if (String(d.qq ?? '') === 'all') {
    // at=all 不是 QQ 号 —— 渲染成 `[@all()]` 是个残缺形状。
    // 正常消息里它会被 normalizeEvent 整条丢弃，但**引用块里**可能出现
    // （被引用那条没走丢弃逻辑），所以必须处理。
          out.push('[at:全体成员]');
        } else if (want !== '' && qq === want) {
          // @ 到本号时给可读标记 —— 否则模型看到的是一串数字，
          // 得自己悟出"这就是我"（实测样例：[@123456789(小助手)]）。
          out.push('[at:你]');
        } else {
          // at 只给 QQ 号 —— 名字不是身份，也不再拼进结构里。
          out.push(`[at:${qq}]`);
        }
        break;
      }

      case 'reply': {
        // `seq` 由**入库时**补上（OneBot 的 reply 段只给 messageId，
        // 见 store.js `#stampReplySeq`）。所以盘上是 `{ id, seq? }`。
        //
        // ── AI 只看 seq
        //
        // 早先查不到 seq 时会退回 `[reply:messageId=-100001]`。
        // 那是**给排查用的原始 id**，模型拿它什么也做不了：
        // `qq_send` 的 reply / `qq_read_chat` 的 seq 都只认定位符，
        // 填 messageId 会引错或查不到。给一个"看起来能用、实际不能用"
        // 的值，等于制造一次必定失败的调用。
        //
        // 现在查不到就只写 `[reply:?]` —— 形状仍然固定（每种情况都有标记），
        // 但**不再把内部 id 喂出去**。messageId 依旧留在 segments 里，
        // 供服务端自己排查（`raw: true` 也看不到渲染层的这个东西 —— 它只在盘上）。
        const seq = d.seq;
        out.push(seq !== undefined && seq !== null
          ? `[reply:seq=${String(seq).replace(/[^\d#]/g, '')}]`
          : '[reply:?]');
        break;
      }

      case 'forward': {
        const n = Array.isArray(d.nodes)
          ? d.nodes.reduce((sum, node) => sum + (node?.kind === 'seqs' && Array.isArray(node.seqs) ? node.seqs.length : 1), 0)
          : 0;
        out.push(n ? `[forward:${n}条]` : '[forward]');
        break;
      }

      case 'video':
        out.push('[video]');
        break;

      case 'sticker': {
        const desc = escapeLabel(d.desc, { max: 20 });
        out.push(desc ? `[sticker:${desc}]` : '[sticker]');
        break;
      }

      case 'image': {
        // summary 自带方括号（`[动画表情]`），剥掉再重新包，
        // 免得渲染成 `[[动画表情]]`（实测踩过）。
        const desc = escapeLabel(String(d.summary ?? '').replace(/^\[|\]$/g, ''), { max: 20 });
        out.push(desc ? `[image:${desc}]` : '[image]');
        break;
      }

      case 'face': {
        const name = escapeLabel(d.name, { max: 16 });
        // 名字只是索引，**具体长什么样要 AI 自己识图**。
        out.push(name ? `[face:${name}]` : '[face]');
        break;
      }

      default:
        // record / video / forward / json / 未知
        // 这几类 OneBot **不给** summary，没有可用的描述文本，只给类型名。
        out.push(`[${escapeLabel(type ?? 'unknown', { max: 12 })}]`);
    }
  }

  return out.join('');
}


// 这条消息有没有 @ 指定的人。
//
// ── 为什么要显式传 selfQq
//
// 新结构删掉了 `atSelf` 字段（实测落盘 0 条、从未生效）。判定改为
// *拿 segments 里的 at.qq 与 selfQq 比对** —— 所以 selfQq 必须传进来。
// 它存在日文件顶层的 `selfQq`（见 store.js）。
//
// 注意 `at=all`（@全体成员）**不算** @ 到它：那条消息在入库前就被
// main.js normalizeEvent 丢掉了，这里再兜一层。
export function mentionsId(m, selfQq) {
  const want = String(selfQq ?? '');
  if (want === '') return false;
  return segmentsOf(m).some(
    (s) => s?.type === 'at' && String(s?.data?.qq ?? '') === want,
  );
}

// 从 segments 派生 msgType。
//
// ── 规则（已定）
//
//   按**内容段**（image/face/record/video/forward/json）判定，
//   `at` 与 `reply` **不算结构**：
//
//     没有内容段                      → 'text'
//     只有一个内容段，且没有文字       → 该段的类型（'image' / 'face' / …）
//     其余（多个内容段，或有文字）     → 'mixed'
//
// 为什么 at/reply 不算：一条「@某人 你好」只是文本消息加了修饰，
// 归成 mixed 会让 AI 的 kinds 筛选失去意义。
//
    // ⚠️ 媒体**不只是** image/record/video：forward（12 条）和 json（7 条）
    //    也算，否则它们会被静默归成 'text'，AI 用 kinds:["text"] 筛选会捞到
    //    转发和卡片。
export function deriveMsgType(m) {
  const segs = segmentsOf(m);
  const structural = segs.filter((s) => STRUCTURAL_TYPES.has(s?.type));

  if (structural.length === 0) return 'text';
  if (structural.length === 1 && !hasText(m)) return structural[0].type;
  return 'mixed';
}

// 一条消息 → **给 AI 看的行对象**（工具返回与提示词上下文共用同一形状）。
//
// ══ 为什么必须只有一份实现
//
// 这个形状有**两个出口**：`qq_read_chat_text` 的返回、`qq_wait` 的返回。
// 所以实现只有一份 —— 两份必然会分叉出"同名不同义"：
//
//     who     一边裸昵称 `"小明"`、一边带尾号 `"小明(0001)"`
//     身份     一边 `groupRole: "admin"`、一边 `tag: "群管理"`
//     引用     一边 `quoteNo`/`quoteDate` 平铺、一边 `replyTo: {...}` 嵌套
//     [seq]   一边有、一边没有（后者是漏的，实测已踩）
//
// AI 会以为是两种东西。所以统一到这里，两边都调它 ——
// *一处实现，不可能再分叉**。
//
// ══ 形状
//
// ```jsonc
// {
//   "seq": "1234", "time": "2026-10-09 12:03", "tsMs": …,   // 群序号；私聊是 "1001#7"
//   "sender": { "qq": "10001", "name": "小明", "groupRole": "member" },
//   "segmentsText": "[image:图片]更新好慢[@你]",   // ← 只是 segments 的文本化
//   "quote": { "seq": "1233", "date": "2026-10-08",
//              "sender": { … }, "segmentsText": "万一花生是萝莉呢" }
// }
// ```
//
// ── 几个命名的取舍（都踩过）
//
//   `time`  不用 `at` —— `at` 与"@（提及）"形近，且 segments 里就有
//           `type: "at"`。同一个词两个意思，读代码和读 JSON 都会混。
//   `sender` 不用 `who` —— 消息记录里本来就叫 `sender`（含 qq/name/
//           groupRole 三件套），行对象没理由换一个名字再说同样的事。
//   `segmentsText` 不用 `text` —— `text` 与 segments 里的
//           `{ "type": "text" }` 同词；而且这个字段**只是 segments 的
//           文本化**，名字要说出这件事。
//   `date`  已删。它和 `time` 是**部分重叠**（time 前 10 位就是日期），
//           需要日期时截取即可，不值得让 AI 面对两个都像日期的字段。
//   `msgType` 已删。segments 是唯一数据源，类型从它派生即可；
//           落盘的那个字段也一并取消（见 store.js）。
//   `mentionsYou` 已删。"有没有 @ 我" AI 从 `segmentsText` 里的 `[@你]`
//           一眼可见，再给一个布尔字段是冗余，且两个来源可能不一致。
//
// ── 定位靠 `no` 字段，不靠文本里的方括号
//
    // `segmentsText` 里**不带**行首编号 —— 行首编号是**行格式**的事，不该混进
    // "segments 的文本化"里：
//   · `seq` 已经是独立字段，AI 直接用它写 `reply` 更可靠
// ⚠️ **字段名是 `segmentsText`，不是 `text`** ——
//    `text` 与 segments 里的 `{ "type": "text" }` 同词，读 JSON 时会混。
//    这个名字一看就知道"这是把 segments 文本化之后的结果"。
//
// ⚠️ **它只管 segments**：不带行首 `[seq]`、不带 `[时间]`、不带 `↪引用`、
//    不带发言人。那些都是**行格式**，由 `renderContext`（提示词侧）
//    或工具的消费方去拼 —— 这个函数在两种场合都要能用：
//      · 整条消息的正文（工具返回）
//      · 引用块里被引用那条的正文（`quote.segmentsText`）
//    后一种不该带行首编号。
//
// @param m      消息记录（`date` 字段只用于 quote，不再输出到行上）
// @param options.selfQq 本号 —— 用于渲染〔本号〕、`[@你]`
// @param options.raw    true 时额外带**原始 segments**
//
// ── `raw` 是干什么的（实测需求）
//
// 默认只给 `segmentsText`（文本化后的正文）—— AI 平时读这个就够了，
// 也**只该学一套读法**。
//
// 但实测它报告过一次限制：「原始 json 我这边拿不到」。确实：
// `segmentsText` 把结构压成了文本，**精确字段就丢了**：
//   · 图片的 `url` / `file` / `sub_type`（想复用那张图时要用）
//   · 转发卡片的 `id`（`qq_get_content` 的 kind: "forward" 要用 —— 虽然传 no 也行）
//   · `at` 的完整 QQ 号（文本里是 `[at:999]`，能读但不便于程序化处理）
//
// 所以加一个**显式开关**：默认不给（保持一套读法），
// 真要精确字段时传 `raw: true`。
//
// ⚠️ 为什么不默认给：`segments` 里含完整 url，一条消息能到几百字节。
//    60 条上下文全带上会让返回体积翻几倍，而 AI 多数时候并不需要。
export function messageRow(m, { selfQq = '', raw = false } = {}) {
  const out = {
    // 定位符（群 = 群序号、私聊 = `MMDD#no`）—— 口径与上下文行首的 [seq] 一致。
    seq: seqOf(m, m?.date || dateOf(m?.tsMs)),
    // 时间只给 `time` 这一份：`tsMs` 与它同源，多一列只是让模型多一个可能算错的数。
    time: formatDateTime(m?.tsMs),
    sender: senderOf(m, selfQq),
    // 把 segments 文本化（不含 [seq]、不含行首任何前缀）。
    segmentsText: segmentsToText(m, { selfQq, newline: '\n' }),
    // 消息类型（text / mixed / image / record / ...）—— 与 kinds 筛选用同一套派生，
    // 这样"按 image 筛出来的这些，哪条是真图"不用再猜。
    msgType: deriveMsgType(m),
  };

  // 原始段 —— **按需才给**（见上面 raw 的说明）。
  //
  // 形状与落盘时**完全一致**（`{ type, data }`），不做任何转换 ——
  // 这样 AI 拿到的字段名与它读 `segmentsText` 时见到的一致。
  if (raw && Array.isArray(m?.segments)) out.segments = m.segments;

  if (m?.state?.recalled) out.recalled = 1;

  // 引用：`quote.data` 是被引用消息的**整条**（store 入库时抄的），
  // 所以这里能直接给出它的 no / 日期 / sender / 文本化正文。
  //
  // ⚠️ **字段与外层同形**（`sender` 是对象、`segmentsText` 是同样规则的文本），
  //    AI 不必为"引用里的发言人"再学一套读法。
  if (m?.quote?.data) {
    const q = m.quote.data;
    out.quote = {
      seq: seqOf(q, m.quote.date || dateOf(q?.tsMs)),
      date: m.quote.date,
      sender: senderOf(q, selfQq),
      segmentsText: segmentsToText(q, { selfQq, newline: '\n' }),
    };
    // 引用的原文也按需给（同一个开关，不然"精确取被引用那条的字段"做不到）。
    if (raw && Array.isArray(q.segments)) out.quote.segments = q.segments;
  } else if (m?.quote) {
    // 有引用标记但查不到原文（跨重启的老消息）。
    out.quote = { unresolved: 1 };
  }

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// 发言人 → `{ qq, name, groupRole }`（与消息记录里 sender 完全同形）。
//
// `name` 的渲染规则：**本号显示成〔本号〕**，其余保留原昵称。
// 尾号不在数据里拼 —— 那是**渲染**的事（`text` 或行格式负责），
// 结构化字段应该给干净的原值。
export function senderOf(m, selfQq = '') {
  const qq = String(m?.sender?.qq ?? '');
  const self = String(selfQq ?? '') !== '' && qq === String(selfQq);
  return {
    qq,
    name: self ? '〔本号〕' : String(m?.sender?.name || qq),
    groupRole: m?.sender?.groupRole || 'member',
  };
}

// `2026-10-09 12:03`（本地时区，分钟精度）。
function formatDateTime(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
