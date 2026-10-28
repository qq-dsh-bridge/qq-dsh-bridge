// 工具面 op 清单 —— **整个项目里 op 名只有这一份**。
//
// ════════════════════════════════════════════════════════════════════════════
// 为什么要有这个文件
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ **只写这一份**：手写两遍的后果是其中一组整段不可达（JS 的 `switch` 跳到
// 第一个匹配的 case 后顺序执行），白名单校验与发送日志被静默跳过，而消息照发。
//
// 之后 10-14 发出 210 条、10-15 发出 35 条，而该行 **0 次**。
//
// ⇒ 结论：**同一个东西手写两遍，就一定会漂移**。所以这里收敛成一份表，
//   `server.js` 只按表分派，不再认识任何 op 名。
//
// ════════════════════════════════════════════════════════════════════════════
// 新增一个工具要改哪里
// ════════════════════════════════════════════════════════════════════════════
//
//   1. 加一个 `handlers/{read,write}/<op>.js`（按下面的"目录 = 契约"选），
//      导出 `op` + `run`（+ 需要的元数据）
//   2. 在下面的 `BY_DIR` 里加一行 import 与条目
//   3. 在 `plugins/qq-dsh-tools/lib/tools/` 加一个工具文件，并在 `lib/index.js` 注册
//   4. 在 `prompts/4-qq-tools.md` 里写清怎么用
//
// 第 2 步开始就有机器保障：清单漏了 → 工具调不通（401/404），一调就知道；
// 依赖漏了 → `buildHandlers` 启动期就抛错（见下）；
// 目录放错了 → `assertDirs` 在 import 时就抛（见下）。

// ── 目录 = 契约（别按"消息/表情/成员"再分）
//
//   `read/`   **不改变外部可见状态**。`needsAllow` 与 `authFree` 必须都为假。
//   `write/`  **会改外部可见状态**（发消息、撤回、改名片/昵称、收藏或改表情）。
//             `needsAllow` 必须为真 —— 那是白名单闸门，fail-closed。
//   根目录    只有两样东西：这张分派表（`index.js`）、以及**不绑会话**的辅助 op
//             （`imagePublish`：`authFree`，给 mcp-latex / mcp-md 把 base64 换短链）。
//
// 为什么按"读/写"分而不是按"操作对象"分：
//   · 读写是**契约**，已经由 `needsAllow` 编码在代码里 → 可被机器检查（见下面 `ASSERT_DIR`）；
//   · 对象归属是**口味**（`wait` 算消息还是算等待？`userInfo` 算成员还是算查询？），
//     一旦按口味分，新工具放哪儿每次都要重新讨论一次，三个月后必然分不齐。
//
// 按对象找东西请用这张表 —— 它同时是唯一的分派表，永远最新。

// ── read/：纯查询
import * as unread from './read/unread.js';
import * as readChat from './read/readChat.js';
import * as wait from './read/wait.js';
import * as getMessageContent from './read/getMessageContent.js';
import * as listStickers from './read/listStickers.js';
import * as groupInfo from './read/groupInfo.js';
import * as memberList from './read/memberList.js';
import * as userInfo from './read/userInfo.js';

// ── write/：needsAllow，改外部可见状态
import * as send from './write/send.js';
import * as recall from './write/recall.js';
import * as setNickname from './write/setNickname.js';
import * as setGroupCard from './write/setGroupCard.js';
import * as stickerCollect from './write/stickerCollect.js';
import * as stickerRename from './write/stickerRename.js';

// ── 根目录：不绑会话的辅助 op（authFree）
import * as imagePublish from './imagePublish.js';

// 目录 → op 模块。**这张表就是分派表本身**（不再是"目录 + 另一份清单"）。
//
// 键是目录名，值是该目录下的模块。目录名同时声明契约，由 `assertDirs()` 核对。
const BY_DIR = Object.freeze({
  // 纯查询：不改外部可见状态。
  read: [
    unread,
    readChat,
    wait,
    // 图 / 语音 / 视频 / 文件 / 转发 —— 一个入口（原 getMessageImages /
    // getVoice / getForwardMessages 三合一，参数语义见该文件头）。
    getMessageContent,
    listStickers,
    groupInfo,
    memberList,
    userInfo,
  ],
  // 改外部可见状态：一律 needsAllow。
  write: [
    send,
    recall,
    // 「改自己」的两个：对外可见、且**只能作用于本号**。
    // 与 recall 同口径（needsAllow + logsAsSend）—— 理由写在各自文件头部。
    setNickname,
    setGroupCard,
    // 表情库的写操作：收一张进来 / 改描述（看清单是读，在 read/）。
    stickerCollect,
    stickerRename,
  ],
  // 根目录：只有"不绑会话"的辅助 op。
  '.': [imagePublish],
});

// 全部 op（顺序只影响可读性，不影响分派）。
export const HANDLERS = Object.freeze(Object.values(BY_DIR).flat());

// 目录与契约不符时**在 import 阶段就抛** —— 不等启动、更不等第一次调用。
//
// 为什么值得单独一段自检：目录名是给人看的，而契约是给机器看的；两者不一致时
// 最坏的形态是"文件在 read/ 里、却声明了 needsAllow" —— 读代码的人会以为它
// 不写状态，而实际上它会。这种"看一眼就被骗"的错，只能靠机器拦。
function assertDirs() {
  const bad = [];
  for (const [dir, specs] of Object.entries(BY_DIR)) {
    for (const spec of specs) {
      if (dir === 'read' && (spec.needsAllow || spec.authFree)) {
        bad.push(`read/${spec.op}：read/ 里的 op 不许声明 needsAllow / authFree`);
      }
      if (dir === 'write' && spec.needsAllow !== true) {
        bad.push(`write/${spec.op}：write/ 里的 op 必须声明 needsAllow = true`);
      }
      if (dir === '.' && spec.authFree !== true) {
        bad.push(`${spec.op}：根目录只能放 authFree 的辅助 op（其余请放 read/ 或 write/）`);
      }
      // 同一个 op 只能登记一次：重复登记会让 Map 静默取最后一个。
      if (HANDLERS.filter((h) => h.op === spec.op).length > 1) {
        bad.push(`${spec.op}：在 BY_DIR 里登记了不止一次`);
      }
    }
  }
  if (bad.length) {
    throw new Error(
      '工具面目录与契约不符（见 handlers/index.js 的"目录 = 契约"）：\n'
      + bad.map((b) => `  · ${b}`).join('\n'),
    );
  }
}
assertDirs();

// op 名 → 该 op 的规格（含 `run` 与元数据）。`server.js` 靠它分派。
export const OPS = new Map(HANDLERS.map((h) => [h.op, h]));

// 从 handler 的**函数签名**里读出它解构了哪些依赖。
//
//     async function run({ storeFor, http, logger }, convKey, args) { … }
//                          ^^^^^^^^^^^^^^^^^^^^^^^ ← 读这段
//
// ⚠️ 为什么读签名，而不是让每个模块再导出一份 `needs: [...]` 列表：
//    `onebot/dispatch.js` 记过一次教训 —— **自检列表本身也会漏**。
//    新增依赖时忘了同步那份列表，就是下一个"消息凭空消失"的事故
//    （漏传 → async 回调里抛 ReferenceError → 被吞成一行日志 →
//      桥接表面在跑，实际每条消息都进不来）。
//
//    签名不会漂移：它就是唯一真源。这条自检和它是同一份东西。
function declaredDeps(fn) {
  const m = /^[^(]*\(\s*\{([^}]*)\}/.exec(String(fn));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/[=:]/)[0].trim())
    .filter(Boolean);
}

// 把 `deps` 与各 handler 绑成 `registerHandlers` 要的形状。
//
// ⚠️ **启动期自检**：任何 handler 解构了但 `deps` 里没有的字段，这里当场抛
//    `ReferenceError`。这样"漏传依赖"会在**启动时**炸，而不是等第一条消息
//    到达、被 async 回调吞掉 —— 后者是这个项目里最贵的一类故障。
//
// @param deps 所有 handler 依赖的并集（见 main.js 的调用点）
// @returns `{ [op]: (convKey, args) => Promise|any }`
export function buildHandlers(deps) {
  const out = {};
  const missing = [];

  for (const spec of HANDLERS) {
    const lack = declaredDeps(spec.run).filter((k) => !(k in deps));
    if (lack.length) missing.push(`${spec.op} 需要 ${lack.join(', ')}`);
    out[spec.op] = (convKey, args) => spec.run(deps, convKey, args);
  }

  if (missing.length) {
    throw new ReferenceError(
      '工具面 handler 缺少依赖（启动期自检）—— 检查 main.js 传给 buildHandlers 的 deps：\n'
      + missing.map((m) => '  · ' + m).join('\n'),
    );
  }
  return out;
}
