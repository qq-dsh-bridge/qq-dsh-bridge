// 投递 —— 把消息组织成给 agent 的结构，并标记已读。
//
// ── 一个 phase，两种时机
//
// 唤醒（被 @）与回应期窗口是**同一个动作**：桥接强制把消息喂进上下文，
// 然后自动标为已读。行为没有区别，所以不区分 cold/hot（见 PHASES）。
// 区别只在**取多少条**和**取多宽**：
//
//   唤醒      最新 N 条未读（默认 60）—— 让它知道"刚才都发生了什么"
//   回应期    最新 N 条（默认 20）    —— 让它知道"这几句在聊什么"
//
// ── 两种上下文，用途不同（这是从旧实现学到的关键一点）
//
// 旧 v3 的注释写得很清楚：
//
//   > 为什么用 recentMessages 而不是 unread：主人常常只发「1」「干啥呢」这种短句，
//   > 必须能看到前文（**包括自己刚说过什么**）才接得上。
//
// 所以窗口里必须有**自己说过的话**，否则 AI 看到一句「1」完全不知道在接什么。
// 但自己发的消息不该算"未读"（那是我说的话，不是我欠读的）。
//
// 结论：窗口 = **未读的别人消息 + 夹在其中的自己的发言**。
// 取法仍是"从最新往上、遇已读即停"，只是把范围内的自己发言也一并带出。
//
// ── 关于「触发」
//
// 触发消息本身就是最新那条未读，**包含在窗口里、不重复列出**，
// 打 `isTrigger` 标记由提示词层显示（如行尾 `← 本次触发`）。

import { takeLatestUnreadAcrossDays, PHASES } from '../chatlog/read.js';
import { dateOf, seqOf } from '../chatlog/store.js';
import { segmentsToText, escapeName, ESC } from '../chatlog/segments.js';

// 数一数某段文本里出现了几次**未被转义**的 needle。
//
// 转义符 `⧵` 后面的字符一律跳过 —— 这是"转义必须靠状态机"的最小实现：
// 正则 `\[(.*?)\]` 会把 `⧵[` 也算进去，这里不会。
function countUnescaped(text, needle) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ESC) {
      i += 1;   // 跳过被转义的那个字符（`⧵⧵` 也走这条）
      continue;
    }
    if (text.startsWith(needle, i)) n += 1;
  }
  return n;
}

// 默认取用条数。可被 config 覆盖。
export const DEFAULTS = Object.freeze({
  wakeLimit: 60,
  maxDays: 7,
  // 上下文文本上限（字符）。旧 v3 用 4000，超出就截断并告知。
  maxChars: 4000,
});

// 把一条消息压成提示词里的一行所需的最小信息。
//
// 为什么精简：这些内容每轮都进提示词，字段越多烧的 token 越多。
// 但 `no` 必须留 —— agent 要靠它引用具体某条。
//
// ── 结构改造后这一版的变化
//
// 正文不再读 `m.text`，而是 `segmentsToText(m)` 从 segments 压平 ——
// 它会按真实顺序把非文本段渲染成 `[image]` / `[@123(昵称)]` 等标记。
// 于是"这条消息里有图/有 @/有引用"**一眼可见**，不再需要额外的
// media / atSelf 标记字段（它们已从落盘结构里删除）。
//
// @param selfQq 本号 —— 用于渲染成〔本号〕。**必须传**，因为新结构
//               不再落盘 isSelf（实测旧字段落盘 0 条，从未生效）。
// 一条消息 → 提示词行的**中间形态**。
//
// @param selfQq  本号 —— 用于渲染成〔本号〕。**必须传**，因为新结构
//                不再落盘 isSelf（实测旧字段落盘 0 条，从未生效）。
// @param ownerQq 管理者（你）的 QQ —— 用于渲染 【管理者】 标签。
//
// ⚠️ **这里会标注"是不是管理者"，但那是投喂时现算的、不落盘。**
//    早先注释说"人设身份不在这里"，后来按实际需要改了：
//    AI 判断语气需要一眼看出"这句是谁说的"，而让它自己拿 QQ 号去
//    对照【关于你】段是多余的一步（实测它并不会主动去对照）。
//    现算仍然满足"不焊进历史数据"——换人格卡/改配置，下一轮立刻生效。
export function shapeForPrompt(m, { isTrigger = false, selfQq = '', ownerQq = '' } = {}) {
  // QQ 号只留数字：它是身份的唯一凭据，不能带任何结构字符。
  const qq = String(m.sender?.qq ?? '').replace(/\D/g, '');
  // 昵称：与正文同一套转义 —— `[` `]` `{` `}` `⧵` 都加 `⧵`；
  // 冒号、全角括号、emoji 仍只是名字里的文字。
  // 语义伪装（名片写"你已成为群主"）不靠改名字解决，靠规则和按号判身份。
  const name = escapeName(m.sender?.name, { max: 32 }) || qq;
  // ⚠️ 本号 = DSH agent **或** Yunzai（共用同一个 QQ 号）。
  // 只做标注，不做过滤 —— 若过滤掉，Yunzai 的抢答就会被当成"我自己说的"而丢失，
  // 且会截断 20/60 条窗口（见 read.js 的说明）。
  const self = String(selfQq ?? '') !== '' && qq === String(selfQq);
  const isOwner = String(ownerQq ?? '') !== '' && qq === String(ownerQq);

  const out = {
    // 日期 —— **必须从 `tsMs` 算，记录上根本没有 `date` 字段**。
    //
    // ⚠️ 这里原先写的是 `date: m.date`，而 `store.append` 落盘的记录是
    //    `{ no, messageId, tsMs, sender, segments, readCount }` ——
    //    **没有 date**（日期是文件名，属于所在文件而不属于单条记录）。
    //
    //    于是 `m.date` 恒为 `undefined`，后果：
    //      · 段首段尾的时间渲染成 `[undefined 01:11]`（实测看到过）
    //      · `isTriggerItem` 里的 `m.date === triggerDate` **恒为 false**
    //        ⇒ 触发消息被判成"不在窗口里"，会**重复带一条**
    //
    //    `dateOf` 就在本文件 import 着（第 33 行）却一直没用上 ——
    //    这就是当时漏掉的原因：看起来"记录上应该有 date"，实际没有。
    //
    // ⚠️ 时区：`dateOf` 用本地时间（`getFullYear`/`getMonth`/`getDate`），
    //    与 `formatTime`/`formatDateTime` **同一套口径** —— 混用 UTC 会让
    //    凌晨的消息日期差一天。
    date: dateOf(m.tsMs),
    // 定位符 `seq` —— 对 AI **只暴露这一个编号**：
    //   群聊 = `msgSeq`（服务端给的群序号）
    //   私聊 = `MMDD#no`（本地序号**必须带日期**：它每天从 1 重来，而窗口会跨天）
    seq: String(seqOf(m, dateOf(m.tsMs)) ?? '').replace(/[^\d#]/g, '') || '?',
    // 昵称原值（没取到就退回 QQ）—— 行里单独成 `[name:…]`，不再拼尾号。
    name,
    qq,
    // 群内身份：`群主` / `群管理` / 空。
    // 「成员」不写：那是默认值，写了只是噪音。
    role: identityTag(m.sender?.groupRole),
    // 是不是管理者（你）—— 见函数头关于"投喂时现算"的说明。
    isOwner,
    // ⚠️ 字段名是 `at` 而**不是 `time`** —— 这里是**提示词渲染的中间形态**，
    // 只在 renderContext 内部用，不对外暴露成 JSON。
    // 对 AI 输出的行对象（messageRow）用的是 `time`，避开与 @ 混淆。
    at: formatTime(m.tsMs),
    // 压平后的正文 —— 含 `[动画表情]` / `[@你]` 等标记。
    //
    // `selfQq` 要传进去：命中本号的 @ 会渲染成 `[@你]`，
    // 否则模型看到的是 `[@123456789(小助手)]`，得自己悟出"这就是我"。
    text: segmentsToText(m, { selfQq, newline: '\\n' }),
  };
  if (self) out.self = true;

  // 引用**不在这一层**渲染：它就在 segments 里，由 segments.js 渲染成
  // `[reply:seq=…]`。这里曾抄过 quoteNo/quoteDate/quoteWho/quoteText 四个字段，
  // 但没有任何读者（实测 grep 只有赋值）—— 已删。
  if (isTrigger) out.isTrigger = true;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// 身份 → 行首标签。
//
// 为什么不给「成员」也加标签：那是默认值，每行都挂一个 `[成员]` 纯属噪音，
// 60 条上下文就是 300+ 字符。**只标出例外的身份**，信息密度更高。
//
// ⚠️ 这里**只认群内身份**。
//
// 曾经 `owner`（你的主人）也走这个函数 —— 那是错的：`owner` 是**人设**
// 概念（配置 owner.qq），换一张人格卡就可能不再有"主人"这回事，
// 而它被焊进了历史消息行的渲染里。
//
// 现在"是不是主人"由 main.js 在【触发】段里说（每次投喂现算），
// 消息行只反映**群里的事实**。
//
// @param role `'groupOwner' | 'admin' | 'member' | 其他`
export function identityTag(role) {
  switch (role) {
    case 'groupOwner': return '群主';
    // ⚠️ **是「群管理」，不是「管理员」**。
    //
    // 提示词里「管理员」这个词指的是**管理者本人**（配置 owner.qq，
    // 由人设声明称呼，默认就叫"管理员"）。而这里是 OneBot 给的
    // *群内身份** `groupRole: 'admin'` —— 两者毫无关系。
    //
    // 曾经两处都叫「管理员」，同一份提示词里出现两个含义不同的
    // 「管理员」，模型没法分辨哪个有最高优先级。
    case 'admin': return '群管理';
    default: return '';
  }
}

function formatTime(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 渲染成提示词里的一段文本。
//
// 格式：
//   - 一行一条：`[seq:…][name:…][QQ:…]{正文}`；时间单独一行（`[date:]` / `[time:]`）
//     **带日期**：跨天是常态（取未读支持跨天）。若只显示 `[23:58]` 与 `[00:01]`，
//     AI 会以为相隔 3 分钟，实际差一天。多 3 个字符换掉一类误判。
//   - 发言人写成 `【身份】昵称(id后四位)` —— 身份只有群主/群管理才标（见 identityTag），
//     昵称带尾号是因为**只写昵称无法区分重名**（旧方案遗留问题）。
//   - 本号显示为 `〔本号〕`（括号包起来，一眼看出是标记而非人名）
//   - 正文来自 `segmentsToText(m)` —— 非文本段已在里面渲染成 `[动画表情]` / `[@你]`
//   - 超过 maxChars 就**提前停止**并报告 truncated（不是硬切字符串）
//
// ── 行格式（prompts/2-read-format.md 逐字解释了它，改这里要同步改那里）
//
//     [seq:1234][role:群管理|管理者][name:小明][QQ:10001]{[text:你好]}
//
//   `[seq:…]` 在最前 —— AI 引用某条时唯一能用的定位符（写进 `messages[].reply`）。
//   `[role:…]` 只在有例外身份时出现；`[name:…]` 是昵称原值；`[QQ:…]` 是完整号，
//   主人/本号都靠它对号，不再拼尾号。
//
// ⚠️ **不再有 `↪引用 …` 前缀**。引用信息已经由正文里的 `[reply:seq=N]`
//    表达（segmentsToText 的产物）—— 早先两处都写，同一件事说两遍。
// `append`：这条消息**不在** `shaped` 里，但要一起渲染（触发那条被重投时常见）。
// 它会出现在块尾（最新那侧），带 `← 本次触发`，也算进 `[lines:]` / `[mentions:]`；
// 但**不算进 `count`** —— `count` 是"渲染出去几条 items"，state.js 靠它标已读。
export function renderContext(shaped, { maxChars = DEFAULTS.maxChars, append = [] } = {}) {
  const main = Array.isArray(shaped) ? shaped : [];
  const extra = Array.isArray(append) ? append : [];
  // 触发那条的时间**可能比窗口里最新的更早**（它是被标过已读的旧消息）。
  // 直接接在块尾会让时间标倒退（10-24 后面跟一个 10-23），所以要按时间插进去。
  const list = main.map((m) => ({ m, extra: false }));
  for (const m of extra) list.push({ m, extra: true });
  if (extra.length > 1) {
    list.sort((x, y) => String(x.m.date).localeCompare(String(y.m.date))
      || String(x.m.at).localeCompare(String(y.m.at)));
  } else if (extra.length === 1) {
    // 单条也插到位（稳定排序，同一时间保持原顺序）。
    const only = list.pop();
    const at = list.findIndex((r) => String(r.m.date) > String(only.m.date)
      || (String(r.m.date) === String(only.m.date) && String(r.m.at) > String(only.m.at)));
    list.splice(at === -1 ? list.length : at, 0, only);
  }
  const rows = [];
  let chars = 0;
  let truncated = false;

  // ⚠️ **从最新往回攒行**，最后再翻转输出。
  //
  // 下面这段的标题是"最新 N 条"，而且**触发它的那条就在最新那头**。
  // 早先是从最旧往最新攒，超 maxChars 时丢的是**最新**的 ✗ —— AI 拿到
  // 一堆旧消息，却看不到叫它的那一句（症状：只看到"某人 @ 了你"＋一堆闲聊）。
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const { m, extra: isExtra } = list[i];
    // 行首字段（都是 `[键:值]`，与正文里的段同一套写法）：
    //   [seq:1234]          定位符
    //   [role:群管理|管理者]   只在有例外身份时出现
    //   [name:路人甲]        昵称原值
    //   [QQ:10001]       完整号 —— 主人/本号都靠它对号
    const roles = [];
    if (m.role) roles.push(m.role);
    if (m.isOwner) roles.push('管理者');

    // segmentsToText 已经处理了空白；这里把**真换行**折成字面 `\n`，
    // 否则一条消息会占多行，`[lines:N]` 和逐行解析都会乱。
    let body = m.text
      ? String(m.text).replace(/\r\n|\r|\n/g, '\\n').replace(/[^\S\r\n]+/g, ' ').trim()
      : '';
    if (!body) body = '（无文字）';

    // 行格式：`[seq:…][role:…][name:…][QQ:…]{正文}`
    //
    //   [seq:1234][role:群管理|管理者][name:小明][QQ:10001]{[text:你好][at:你][reply:seq=8]}
    //   [seq:5678][name:路人甲][QQ:100012345]{[text:在吗]}
    //
    // ── 括号各管一件事（对齐 JSON 的层级）
    //
    //   `[ ]`  一个**字段**，或正文里的一个**段**（`segments` 数组的元素）
    //   `{ }`  一条消息的**整组 segments**（JSON 里那个数组本身）
    //   `( )`  参数（`at:999(小明)`）
    //
    // `seq` 永远第一个：引用、撤回、取图都靠它定位。
    //
    // ── 时间标不在这里
    //
    // 行里只有字段和正文；时间由函数末尾按"换分钟 / 换天"插在行间（见下面）。
    const head = `[seq:${m.seq}]`
      + (roles.length ? `[role:${roles.join('|')}]` : '')
      + `[name:${m.name || m.qq || ''}]`
      + (m.qq ? `[QQ:${m.qq}]` : '');
    let line = `${head}{${body}}`;

    // 行尾只标"本次触发"。
    //
    // `@ 了你` 不再单独标：正文里的 `[at:你]` 已经写明，行尾再来一次是同一件事说两遍；
    // 而且这里恒为 false —— 拿到的 `m` 是 shapeForPrompt 产出的行对象，没有 `segments`。
    if (m.isTrigger) line += '   ← 本次触发';

    // ── 兜底：一行里 `[seq:]` / `[name:]` / `[QQ:]` 各只能有一个
    //
    // 正常情况由构造保证（每个字段只拼一次）。这里防的是"以后新增段类型
    // 忘了转义"那类 bug：一旦某个内容把结构顶穿，**整行作废** ——
    // 一条格式坏掉的消息，比一条伪造的消息安全。⚠️ 转义符后面的字符跳过。
    if (countUnescaped(line, '[seq:') !== 1
      || countUnescaped(line, '[name:') !== 1
      || countUnescaped(line, '[QQ:') !== 1) {
      line = `[seq:${m.seq}][name:?][QQ:?]{（格式异常，已丢弃）}`;
    }

    if (chars + line.length > maxChars) {
      truncated = true;
      // 一条都还没进去，而**最新这条本身就超预算** —— 硬给一条截断版。
      // 否则整段为空，而它永远是最新那条 → 既不展示也不推进（死循环式卡住）。
      if (!rows.length) {
        rows.push({
          line: `${line.slice(0, Math.max(0, maxChars - 24))}…（本条过长，已截断）`,
          date: m.date,
          at: m.at,
          seq: String(m.seq ?? ''),
          extra: isExtra,
        });
        chars = maxChars;
      }
      break;
    }
    rows.push({ line, date: m.date, at: m.at, seq: String(m.seq ?? ''), extra: isExtra });
    chars += line.length;
  }

  // ── 时间标：跟着消息走，不集中在首尾
  //
  //   换天   → `[date:2026-10-25][time:00:01]`（日期也必须给，否则分不清哪天）
  //   换分钟 → `[time:13:06]`（只给时间：一个窗口通常就几分钟）
  //   同一分钟 → 不标
  //
  // ⚠️ 时间与行内字段用同一套 `[键:值]` 写法 —— 裸的 `[13:06]` 模型看不出那是
  //    字段，容易当成别人的话。
  //
  // 这样"隔了多久"是直接可读的：13:05 连说三句，13:06 才有人接。
  // 只按**实际渲染出来的行**取时间 —— maxChars 可能截掉更早的行，
  // 第一行必须是"最早一条真的给了它的"，否则 AI 会以为看到了更早的消息。
  rows.reverse();

  const out = [];
  let day = '';
  let minute = '';
  for (const r of rows) {
    if (r.date !== day) {
      // 换天：日期和时间都变了，两个字段写在同一行。
      out.push(`[date:${r.date}][time:${r.at}]`);
      day = r.date;
      minute = r.at;
    } else if (r.at !== minute) {
      // 同一天内换分钟：只写时间。
      out.push(`[time:${r.at}]`);
      minute = r.at;
    }
    out.push(r.line);
  }

  // ⚠️ 两个数不一样，别混：
  //   count  = 消息**条数** —— state.js 靠它推进"读到哪了"
  //   lines  = 这段的**物理行数**（时间标各占一行）—— 提示词块头 `[lines:N]` 用它
  //
  // `mentions` = 这段里**真的提到你**（正文含未转义的 `[at:你]`）的消息 seq，按出现顺序。
  //
  // ⚠️ 必须在**截断之后**算：maxChars 会砍掉最早那几行，若按完整数据算，
  //    列出来的 seq 在块里根本找不到 —— 那比不给还坏。
  // ⚠️ 用 countUnescaped：正文里 `⧵[at:你]`（用户自己打的字）不能算提到你。
  // ⚠️ 触发那条若原本不在窗口里，会被 `append` 插进块内（按时间）但不进 mentions ——
  //    所以"叫醒你"与"mentions 非空"不是同一件事：可能没人 @ 你，只是有人说话。
  // ⚠️ `[at:全体成员]` 不算 —— 那不是冲你来的。
  // 只扫**列出来的行**，不另维护"未读集合" —— 块里的行本来就只有未读的。
  // 唯一例外是 `append` 补进来的触发那条：它可能已被上一轮标过已读，
  // 补进来只是让你知道"在回哪句"。它不算 mentions（不算"未读里提到了你"），
  // 行尾的 `← 本次触发` 已经说明它是谁。
  const mentions = rows
    .filter((r) => !r.extra && countUnescaped(r.line, '[at:你]') > 0)
    .map((r) => r.seq);

  return {
    text: out.join('\n'), count: rows.filter((r) => !r.extra).length, lines: out.length, mentions, truncated, maxChars,
  };
}

// 投递：取未读 → 渲染 → 标记已读。
//
// @param store
// @param options.limit      最多取几条未读（唤醒 60 / 回应期 20）
// @param options.triggerSeq 触发消息的定位符（回应期用，用于打标记）
// @param options.triggerDate
// @param options.mark       是否自动标记（默认 true —— 强制投递就该标）
// @param options.maxDays / maxChars
export function deliver(store, {
  limit = DEFAULTS.wakeLimit,
  // *外部取样**（`items`）—— 传了就用它，不再自己扫库。
  //
  // 取自 `ConversationState#takeMessages`：**池优先、池不够再回库补**，规则与 `qq_wait`
  // 完全一致（跳过本号、遇已读即停）。于是两条消费路径共用一套取样，不会各说各话。
  items: givenItems = null,
  triggerSeq,
  triggerDate,
  maxDays = DEFAULTS.maxDays,
  maxChars = DEFAULTS.maxChars,
  mark = true,
  now = Date.now(),
  selfQq = '',
  // 管理者（你）的 QQ —— 用来给发言人行加 `管理者` 标签。
  //
  // ⚠️ 这是**投喂时现算**的（从 config 的 owner.qq 来），**不落盘** ——
  //    换人格卡或改配置，下一轮立刻生效，历史记录不会说谎。
  ownerQq = '',
} = {}) {
  const items = Array.isArray(givenItems)
    ? givenItems
    : takeLatestUnreadAcrossDays(store, { limit, maxDays });

  // 触发落在窗口内？（它就是最新那条未读，通常一定在）
  const isTriggerItem = (m) => triggerSeq !== undefined
    && seqOf(m, m.date) === String(triggerSeq)
    && (!triggerDate || m.date === triggerDate);
  const triggerInWindow = items.some(isTriggerItem);

  const shapeOpts = { selfQq, ownerQq };
  const shaped = items.map((m) => shapeForPrompt(m, { ...shapeOpts, isTrigger: isTriggerItem(m) }));

  // 触发不在窗口里（比如它已被上一轮标记过）—— 单独带上，免得 AI 不知道在回什么。
  let trigger = null;
  if (triggerSeq !== undefined && !triggerInWindow) {
    const found = store.findByRef(triggerSeq);
    if (found) {
      trigger = shapeForPrompt({ ...found.message, date: found.date }, { ...shapeOpts, isTrigger: true });
    }
  }

  // ⚠️ **这里不再标已读**（已定：改成"投递成功之后才标"）。
  //
  // 标记改由**调用方**在 `deliverer.deliver()` 返回**成功之后**做 ——
  // 用返回里给出的 `items`。
  //
  // ── 为什么必须等投递成功
  //
  // `readCount > 0` 的语义是"**它看过了**"。而这里只是**拼提示词** ——
  // 拼好了不代表送到了（DSH 会话可能不存在、流断了、进程刚好被杀）。
  //
  // 早先在这里标，后果是**那批未读被永久吞掉**：投递失败 → 状态已经是
  // "已读" → 下次 `takeLatestUnreadAcrossDays` 直接跳过它们 →
  // *它永远看不到那几条**，而且日志里一行错都没有。
  //
  // 实测踩过（用 `readCount` 当"它没见过"的判据时暴露）：
  // 投递过的消息 `readCount=1`，但它实际上只看到了 `lines=1` 那一条。
  return {
    phase: PHASES.PUSH,
    // 未读消息 —— **投递成功后由调用方按这个列表标已读**。
    items,
    // 投递用的精简行
    shaped,
    // 渲染好的文本块
    context: renderContext(shaped, { maxChars, append: trigger ? [trigger] : [] }),
    trigger,
    // 触发那条（若不在窗口里）已经并进上面那段了（renderContext 的 `append`）。
    // 不再单独给 `triggerLine`：两个块说同一件事，提示词里白花二十来个字，
    // 而且模型会以为那是"另一个人的另一条消息"。
    triggerInWindow,
    span: spanOf(items),
    // 还有多少未读**不在这段里**（比它更早）。
    //
    // ⚠️ **不能直接给 `countUnread(store)`** —— 那是全库总数，包含了下面这段
    //    自己。而提示词写的是"另有 N 条未读（比下面这段更早）"，于是 AI 会被告知
    //    "还有 21 条更早的没看到"，而它其实正在看那 21 条（实测就是这么矛盾的：
    //    「另有 21 条未读」+「以下是最新 21 条」同时出现，它会以为一共 42 条）。
    //
    // 减掉本段条数才是"更早的"。这与 `wait` 那条路的 `omitted` 是同一个口径
    // （那边早就是对的）。
    remainingUnread: Math.max(0, countUnread(store) - items.length),
    // 本号 —— 提示词层要拿它写【关于你】。
    selfQq,
  };
}

// 全库未读**总数**（跨天）—— 注意它**包含**即将投递的这一段。
export function countUnread(store) {
  let n = 0;
  for (const date of store.dates()) {
    const doc = store.load(date);
    for (const m of doc.messages) if ((m.readCount ?? 0) === 0) n += 1;
  }
  return n;
}

function spanOf(items) {
  if (!items.length) return null;
  return {
    from: items[0].date,
    to: items.at(-1).date,
    firstTs: items[0].tsMs,
    lastTs: items.at(-1).tsMs,
    crossDay: items[0].date !== items.at(-1).date,
  };
}

export { dateOf };
