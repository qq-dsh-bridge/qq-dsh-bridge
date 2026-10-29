// 配置默认值与校验。
//
// 设计原则（踩过的坑，别改回去）：
//
//  1. **默认值只写一遍。** 旧桥接把同一个 `sticker.collect` 默认值在同一个对象字面量里
//     写了两遍（后一份静默覆盖前一份），排查了很久。这里 defaults 是唯一的真相来源。
//
//  2. **未知字段要报错，不静默忽略。** 配置写错键名却毫无反应是最贵的一类 bug：
//     你以为改了行为，其实什么也没发生。`strict` 模式（默认开）会对未知键抛错，
//     并用编辑距离给出「你是不是想写 X」。
//
//  3. **类型错了要报错，不做隐式转换。** `"3000"` 和 `3000` 不是一回事；
//     `Number(x) > 0 ? Number(x) : default` 这种"猜意图"的写法会无声降级。
//
//  4. **fail-closed。** 涉及权限（allow、allowAllWhenEmpty）的取值宁可拒绝启动，
//     也不要降级成"全部放行"。

// 普通对象判定在**本文件内也要用**（validateConfig / validateSessionOverrides）。
// ⚠️ `export { x } from '...'` 不会在模块作用域里创建绑定 —— 只写 re-export 的话，
//    下面所有 `isPlainObject(...)` 都是 ReferenceError。必须是独立的一行 import。
//    （re-export 在文件末尾、原来那两个函数的位置。）
import { isPlainObject } from '../util/value.js';

// 会话覆盖层的版本（`config.sessions.json` 的 `version`）。
//
// 两者演进节奏不同：主配置加字段不需要升覆盖层版本
// （覆盖层是补丁、字段白名单式，新增可覆盖项对老文件无害）。
export const SESSIONS_VERSION = 1;

// 默认配置。**这是唯一的默认值来源**——schema 只负责类型，不再重复写默认值。
export function defaultConfig() {
  return {
    dsh: {
      // 插件侧传输（qq-dsh-host）：会话/投递/事件/归档都走它。
      // 监听哪个端口由 dsh 的 cordis.patch.yml 决定，这里只是桥接要连的地址。
      hostUrl: 'http://127.0.0.1:3130',

      // 宿主令牌文件（相对仓库根或绝对路径），插件用它校验 Bearer。
      // *必须与插件配置里的 token 是同一个值** —— 不一致就是 401。
      hostTokenFile: 'state/host-token',

      // 单次请求超时。
      requestTimeoutMs: 30_000,

      // 建会话时用的 Agent preset 名。
      //
      // *安全关键**：不指定时 dsh 给默认 preset（通常是 `standard`，
      // 含 bash / 文件读写 / 子 agent）。而 QQ 会话是暴露给群友的 ——
      // 群里任何人一句提示词注入就能指挥它。
      //
      // 默认 `qq`，对应 qq-dsh-home 里定义的那个只有聊天工具的 preset。
      // 若这个 preset 不存在，dsh 会**回落到默认** —— 所以要看会话列表里的
      // `agentPreset` 字段确认它真的是 qq。
      agentPreset: 'qq',
    },

    snowluma: {
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',
      // HTTP token（用于 :3000 动作调用）。
      //
// *注意**：这与 `wsToken` 是两个不同的值 —— 合成一个字段会让启动后的第一次
// WS 连接必然失败一次。留空则从 homeDir 自动发现。
      accessToken: '',
      // WS token（用于 :3001 事件连接）。
      //
      // 与 accessToken 分开是刻意的 —— 混用会被 SnowLuma 拒绝。
      wsToken: '',
      // SnowLuma 安装目录。配置后会自动从
      // `<homeDir>/config/onebot_<QQ号>.json` 读出端点与**两个** token。
      homeDir: '',
      // 本号 QQ。**字符串**（已定：全项目 QQ 号一律 string）。
      //
      // 为什么不用 number：QQ 号是 19 位量级，而 JS 的 number 只能安全表示
      // 2^53 以内的整数 —— 用 number 存迟早会丢精度。OneBot 的 user_id
      // 也建议当字符串处理。
      //
      // *必填。** SnowLuma 一台机器上可以挂多个账号，所以不替你猜 ——
      // 拿它去 `config/onebot_<QQ号>.json` 里挑文件，并在连接后核对实际登录号
      // （不一致直接退出，见 app/identity.js）。
      selfQq: '',
      // 主动探测间隔。**必须是主动探针**：SnowLuma 对掉线期间的消息不重放，
      // 且 TCP 半开时两端都不会报错、不触发 onclose（旧方案实测过三次）。
      heartbeatMs: 45_000,
      heartbeatTimeoutMs: 12_000,
      // 握手超时。SnowLuma 启动初期可能被 member warmup 占满事件循环，
      // 实测 accept 拖过 72 秒，而握手挂起时 onopen/onclose 都不触发。
      connectTimeoutMs: 20_000,
      // 重连指数退避。
      reconnectMinMs: 1000,
      reconnectMaxMs: 30_000,
      // 单次动作超时。
      actionTimeoutMs: 30_000,
    },

    owner: {
      // 管理者（你）的 QQ 号。**字符串**（与全项目口径一致）。
      //
      // ⚠️ 与"群管理员"无关 —— 那是 OneBot 给的 `groupRole: 'admin'`。
      qq: '',
    },

    // 当前启用的人格卡 —— `roles/<name>.md`，空串 = 不启用人设。
    //
    // ── 为什么在配置里，而不是单独一个 state 文件
    //
    // 放在配置里只为三件事：
    //   ① 换角色**不再分裂成两处真源** —— 配置层已经有三层叠加与热重载，
    //      角色在这上面天然即时生效，不用另写一套读写与落盘。
    //   ② 控制台切角色 = 改配置 = 走同一条写入路径（备份 + 校验 + 原子写）。
    //   ③ 插件（qq-prompt-sections）本来就要读 `config.json` 取 `owner.qq`，
    //      顺手取 `role.current` 即可，少一个需要同步的落盘文件。
    //
    // ⚠️ 角色名就是文件名，只写名字，不要写路径或 `.md`。
    role: {
      current: '',
    },

    // 权限闸门。fail-closed：空的 allow 列表 + allowAllWhenEmpty=false ⇒ 谁都不放行。
    allow: {
      private: [],
      groups: [],
      allowAllWhenEmpty: false,
    },

    // 热重载。
    watch: {
      enabled: true,
      debounceMs: 250,
    },

    // 工具面 API —— MCP server 通过它访问聊天记录与发送能力。
    //
    // 只监听回环（MCP server 是独立进程，拿不到桥接的内存态）。
    api: {
      port: 3110,
    },

    // 统一媒体仓库：图片 / 语音 / 视频 / 文件共用一套存储与路由（见 src/media/）。
    //
    // `root` 留空 → `<仓库>/state/media`（自包含、拷走就能跑）。
    // 想把它挪出仓库就写绝对路径，比如 `C:\path\to\media`。
    // 目录会自动按 QQ 号分层：`<root>/<uin>/{image,ptt,video,file,emoji}`。
    media: {
      root: '',
      // 总量配额（MB）。超了按创建时间删；emoji 永不自动删。
      totalMb: 500,
      // agent 看到的媒体根（WSL 里通常是 `/ws/media`）。
      //
      // 留空 = **没有共享文件系统**：工具结果只给 `/m/<id>` 地址，不给路径。
      // 填了就在 `qq_get_content` 的结果里附一行 agent 路径
      // —— 但只有 agent 和桥接在同一台机器上时才有意义。
      //
      // ⚠️ 只给 agent 路径，**不给宿主路径**（盘符与仓库位置不进模型上下文）。
      // 默认留空；WSL 部署要显式写 `/ws/media`（或留空让它在 `chatlog.agentRoot`
      // 下自动推导 —— 只要 `media.root` 在 `chatlog.root` 里面）。
      agentRoot: '',
    },

    // 控制台 —— 你自己用的运维面板（看状态、改配置、编人格卡、看日志）。
    //
    // ⚠️ **只靠一个密码**，见 src/console/server.js 的文件头。
    //
    // `password` 为空 = 禁用登录（所有 `/api/*` 放行）。这是**刻意保留**的开关：
    // 在只绑回环的时代它有道理，而现在默认绑 0.0.0.0，空密码等于把面板开放给
    // 同网段的任何人 —— 所以启动时会打一条 WARN。
    //
    // `host` 默认 0.0.0.0（允许局域网访问，只凭密码）。想只给自己用就改成 127.0.0.1。
    console: {
      port: 3111,
      host: '0.0.0.0',
      // 控制台登录密码。明文放在配置文件里（用户的选择），**但绝不进日志**：
      // 见 config/report.js（只打印是否已设置）。
      //
      // ⚠️ 仓库根的 config.json 是被 git 跟踪的配置模板。真实密码建议用
      // `QQBRIDGE_CONSOLEPASSWORD` 环境变量覆盖，或写进未跟踪的本地副本。
      password: '',
    },

    // 聊天记录与状态机。
    //
    // 工作区根：每个 QQ 会话一个项目文件夹，里面 chat/ 一天一个 JSON。
    chatlog: {
      // 工作区根目录。相对路径按仓库根解析。
      root: 'workspaces',
      // 同一个目录 **agent 看到的路径**（WSL 里是 `/ws`；原生同机部署可以留空，
      // 或写成和 `root` 一样表示恒等映射）。
      //
      // 用途：agent 传进来的图片/语音路径可能是它的命名空间（`/ws/…`），而
      // SnowLuma 是宿主进程 —— 发之前要翻成宿主路径，否则它会去 `C:\path\to\…` 找文件
      // （实测报 `ENOENT: stat 'C:\path\to\歌.flac'`）。
      //
      // 留空 = **没有映射**：路径不翻译，原样交给 SnowLuma（原生同机部署用）。
      // 填了 = **只接受该前缀下的路径**：`qq_send` 拒绝本机路径，防止模型猜中
      // `C:\Windows\…` 之类的宿主路径把重要文件发出去。
      // 默认留空，不假设任何人的 agent 跑在 WSL 里。
      agentRoot: '',
      // 唤醒时取多少条未读（最新优先）。
      wakeLimit: 60,
      // 回应期被插话时取多少条。
      replyLimit: 20,
      // 取未读时最多回溯几天。
      maxDays: 7,
      // 提示词里上下文文本的字符上限，超出整行取舍。
      maxChars: 4000,
      // 人格卡注入上限（字符）。
      //
// 人格卡**每次唤醒都注入**，所以这是成本护栏。
// 12000 是照实际卡长定的：6000 会在段落边界处切掉「回复示例」整节，
// 而示例正是最管用的那一节。
      roleMaxChars: 12000,
      // *醒着窗口**：从它开口起算，静默多久就回睡眠（毫秒）。
      //
      // 它决定"它醒着多久"，**不决定谁能把话递进来**（那是闸门的事）。
      //
      // 窗口内被 @ 到时它接话，但**不重新注入人设** —— 人设已经在它上下文里，
      // 重发是浪费；只有从睡眠被叫醒时才重发（那时上下文可能被压缩过）。
      //
      // 默认 5 分钟。
      //
      // ⚠️ 与 `waitDefaultMs` 是**两个不同的时间**，别混：
      //   本项  它醒着多久（窗口到点回睡眠）
      //   wait  `qq_wait` 单次最多等多久
      idleMs: 300_000,
      // 谁能叫醒它：'owner' | 'everyone'。
      // fail-closed —— 写错一律按 owner（"谁都能叫醒"是更危险的失败方向）。
      triggerWho: 'owner',
      // 醒着时谁的话能把它叫回来（独立于 triggerWho）。
      // 与 triggerWho 一样**也要求 @/引用** —— @ 是"我在跟你说话"的信号。
      windowWho: 'owner',
      // 等待工具**滑动窗口**的时长（"多久没人说话算结束"）。
      //
      // ⚠️ 这是**滑动**的，不是固定超时：等待期间只要还有人过
      //    `windowWho` 闸门说话，就刷新计时、继续等。
      //    只有连续这么久**没人说话**才结束。
      //
// 为什么是"滑动"而不是固定 `setTimeout`：正聊着 5 分钟一到就得回去，
// 而**得重新被 @ 才回来** —— 中间硬断一拍。没人说话才真的睡。
      waitDefaultMs: 300_000,
      // 等待工具**总上限** —— 从开始算，硬封顶。
      //
      // ⚠️ **必须有**：只滑动不封顶的话，**一个活跃的群永远不超时**，
      //    它会一直挂着（上下文不放、回合不结束，可能挂一整晚）。
      //
      // 默认 30 分钟 —— 一次聊天会话通常不会超过；到了就收摊，
      // 对方再 @ 它会重新唤醒。
      waitMaxMs: 1_800_000,
      // `qq_wait` 是否要求对方 **@ 它**才算"等到了"（默认 true）。
      //
    },

    log: {
      level: 'info',
      // 同时写文件的路径；空 = 只输出到控制台。
      file: '',
      // 单文件轮转上限。
      maxBytes: 8 * 1024 * 1024,
      maxFiles: 5,
    },

    // 决策层 —— 唤醒前先判"这一轮她要不要开口"（见 `prompt/judge.js`）。
    //
    // `mode`：`off` 不接 / `shadow` **只记日志不改行为** / `enforce` 真的拦。
    // 默认 off —— 没配就是没接，不该因为漏配就把群里的话拦掉。
    decide: {
      mode: 'off',
      // 判断用哪个模型。只输出十几字 JSON，flash 档够了；实测 1.6s。
      model: 'cn:deepseek-v4.1-flash',
      apiBase: 'http://127.0.0.1:7863/v1',
      // 内联 key；空则看 `apiKeyFile`，再空看环境变量 `QQ_DECIDE_API_KEY`。
      apiKey: '',
      // 从哪个文件里按 `apiKeyRef` 抠 key（本机网关的凭据文件）。
      apiKeyFile: '',
      apiKeyRef: 'WB2API_KEY',
      // 超时后按"放行"处理（宁可多回，不可漏消息）。
      timeoutMs: 3000,
      // 输出上限。**不能给小**：这类模型会先花 token 想（实测 reasoning 80–94），
      // 给 80 时返回空内容、finish_reason=length —— 看起来像"它没判断"。
      maxTokens: 900,
      // 拼进判断上下文的历史条数。
      maxRecentLines: 8,
      // 判不判之前先"想"。`off`（默认）= 关掉思考，`on` = 走模型默认。
      //
      // 实测（同 24 条）：开思考 1802ms / 2182 思考 token；关掉 1642ms / 0 token，
      // 结论只差 6 条且偏保守。判"要不要开口"不需要推演，所以默认关。
      thinking: 'off',
      // 从角色卡里取哪几节（标题包含这些子串就算）。**空 = 整张卡**（截到 `cardMaxChars`）。
      // 不写死在代码里，是因为这层要能换角色 —— 节选是"哪个角色"，代码只提供机制。
      cardSections: [],
      // 整张卡太长时的截断上限（不配节选时才用得上）。
      cardMaxChars: 3000,
      // "她能干什么" —— 拼进判断说明，让模型知道哪些话题落在这人的活上。
      // 留空 = 完全靠角色卡自己判断。
      capabilities: '',
      // `enforce` 下主人直放 —— 他是唯一会被派活的人，判错代价最高，也省一次调用。
      ownerAlways: true,
    },
  };
}

// 深合并 / 普通对象判定 / 稳定序列化 —— **实现只有一份**，见 util/value.js。
// 不要就地再写一份：语义一旦分叉，"配置有没有变"就会有两个答案（热重载时灵时不灵）。
//
// 这里保留 re-export：外部调用点（write.js / sessions.js / 维护脚本）一直是从
// `config/schema.js` 拿这两个函数的，改它们的 import 路径没有收益。
export { deepMerge, isPlainObject } from '../util/value.js';

// ---------------------------------------------------------------- 校验

export class ConfigError extends Error {
  constructor(message, { path = '', hint = '' } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
    this.hint = hint;
  }
  toString() {
    const at = this.path ? `（位于 ${this.path}）` : '';
    const hint = this.hint ? `\n  ${this.hint}` : '';
    return `${this.name}: ${this.message}${at}${hint}`;
  }
}

// 各配置项的期望类型。`null` 表示"任意"。
const SCHEMA = {
  dsh: {
    hostUrl: 'string',
    hostTokenFile: 'string',
    requestTimeoutMs: 'positiveInt',
    agentPreset: 'string',
  },
  snowluma: {
    wsUrl: 'string',
    httpUrl: 'string',
    accessToken: 'string',
    wsToken: 'string',
    homeDir: 'string',
    selfQq: 'qqString',
    heartbeatMs: 'positiveInt',
    heartbeatTimeoutMs: 'positiveInt',
    connectTimeoutMs: 'positiveInt',
    reconnectMinMs: 'nonNegativeInt',
    reconnectMaxMs: 'nonNegativeInt',
    actionTimeoutMs: 'positiveInt',
  },
  owner: {
    qq: 'qqString',
  },
  role: {
    // 只写名字，不写路径。空串合法（= 不启用人设）。
    current: 'string',
  },
  allow: {
    private: 'intList',
    groups: 'intList',
    allowAllWhenEmpty: 'boolean',
  },
  watch: {
    enabled: 'boolean',
    debounceMs: 'nonNegativeInt',
  },
  api: {
    port: 'positiveInt',
  },
  media: {
    root: 'string',
    totalMb: 'positiveInt',
    agentRoot: 'string',
  },
  console: {
    port: 'positiveInt',
    host: 'string',
    password: 'string',
  },
  chatlog: {
    root: 'string',
    agentRoot: 'string',
    wakeLimit: 'positiveInt',
    replyLimit: 'positiveInt',
    maxDays: 'positiveInt',
    maxChars: 'positiveInt',
    roleMaxChars: 'positiveInt',
    idleMs: 'positiveInt',
    triggerWho: 'string',
    windowWho: 'string',
    waitDefaultMs: 'positiveInt',
    waitMaxMs: 'positiveInt',
  },
  log: {
    level: 'string',
    file: 'string',
    maxBytes: 'positiveInt',
    maxFiles: 'positiveInt',
  },
  decide: {
    mode: 'string',
    model: 'string',
    apiBase: 'string',
    apiKey: 'string',
    apiKeyFile: 'string',
    apiKeyRef: 'string',
    timeoutMs: 'positiveInt',
    maxTokens: 'positiveInt',
    maxRecentLines: 'positiveInt',
    cardSections: 'stringList',
    cardMaxChars: 'positiveInt',
    capabilities: 'string',
    thinking: 'string',
    ownerAlways: 'boolean',
  },
};

function checkType(value, kind) {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'positiveInt':
      return Number.isSafeInteger(value) && value > 0;
    case 'nonNegativeInt':
      return Number.isSafeInteger(value) && value >= 0;
    case 'string':
      return typeof value === 'string';
    // QQ 号：**必须是字符串，且是纯数字**（或空串 = 未设置）。
    //
    // 为什么单独一种类型而不是复用 `string`：
    //  · 有人写 `"selfQq": 123456789`（不带引号）是**最常见的错** ——
    //    复用 string 会直接报"期望字符串"，但他不知道自己错在哪；
    //    这里可以给出"QQ 号要写成字符串"的专属提示（见 describeKind）。
    //  · 纯数字校验能挡住 `"123456789 "`（带空格）这类会静默不匹配的值 ——
    //    而 QQ 号比对是精确字符串比较，一个空格就导致"认不出主人"。
    case 'qqString':
      return typeof value === 'string' && (value === '' || /^\d+$/.test(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'intList':
      return Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v >= 0);
    // 字符串数组（如"从角色卡里取哪几节"）。空数组合法 = 不节选。
    case 'stringList':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default:
      return true;
  }
}

function describeKind(kind) {
  return {
    number: '数字',
    positiveInt: '正整数',
    nonNegativeInt: '非负整数',
    string: '字符串',
    qqString: 'QQ 号（**用字符串写**，如 "123456789"；不带引号会丢精度）',
    boolean: '布尔值',
    intList: '非负整数数组',
    stringList: '字符串数组',
  }[kind] ?? kind;
}

// 编辑距离，用于"你是不是想写 X"。
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nearestKey(key, candidates) {
  let best = '';
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // 只在足够接近时才提示，否则会给出误导性的建议。
  return bestScore <= Math.max(2, Math.floor(key.length / 3)) ? best : '';
}

// 校验配置。返回 `{ ok, errors }`，不抛异常——调用方决定是拒绝启动还是降级。
//
// @param config 已合并的配置对象
// @param options `{ strict }` —— strict 时未知键算错误（默认 true）
export function validateConfig(config, { strict = true } = {}) {
  const errors = [];

  const walk = (value, schema, path) => {
    if (isPlainObject(schema)) {
      if (!isPlainObject(value)) {
        errors.push(new ConfigError(`应为对象，实际是 ${typeName(value)}`, { path }));
        return;
      }
      for (const [key, child] of Object.entries(schema)) {
        if (!(key in value)) continue; // 缺项由 deepMerge(defaults) 保证存在
        walk(value[key], child, path ? `${path}.${key}` : key);
      }
      if (strict) {
        const known = Object.keys(schema);
        for (const key of Object.keys(value)) {
          if (known.includes(key)) continue;
          const suggestion = nearestKey(key, known);
          errors.push(new ConfigError(
            `未知的配置项 "${key}"`,
            {
              path: path ? `${path}.${key}` : key,
              hint: suggestion ? `你是不是想写 "${suggestion}"？` : `可用的项：${known.join(', ')}`,
            },
          ));
        }
      }
      return;
    }
    if (!checkType(value, schema)) {
      errors.push(new ConfigError(
        `应为${describeKind(schema)}，实际是 ${typeName(value)}${preview(value)}`,
        { path },
      ));
    }
  };

  walk(config, SCHEMA, '');

  // 语义校验：跨字段的约束。
  if (config.dsh?.hostUrl && !/^https?:\/\//.test(config.dsh.hostUrl)) {
    errors.push(new ConfigError('必须以 http:// 或 https:// 开头', { path: 'dsh.hostUrl' }));
  }
  if (config.snowluma?.wsUrl && !/^wss?:\/\//.test(config.snowluma.wsUrl)) {
    errors.push(new ConfigError('必须以 ws:// 或 wss:// 开头', { path: 'snowluma.wsUrl' }));
  }
  // 本号必须显式配置。
  //
  // SnowLuma 一台机器上可以挂多个账号，"自动猜一个"在那种情况下就是**发错号**。
  // 所以这里不猜：没配就拒绝启动，运行时还要和实际登录号核对（见 app/identity.js）。
  if (!String(config.snowluma?.selfQq ?? '').trim()) {
    errors.push(new ConfigError(
      '必须填写（SnowLuma 可能同时挂多个 QQ 号，不写就不知道要用哪个）',
      { path: 'snowluma.selfQq' },
    ));
  }
  // 监听地址是**地址**，不是 URL —— 也不能带端口。
  //
// 把 `0.0.0.0` 当连接目标看起来像配置好了，实际一个连接都建不起来。
  if (config.console?.host === '') {
    errors.push(new ConfigError('不能为空（想只给自己用请填 127.0.0.1）', { path: 'console.host' }));
  } else if (config.console?.host && /:\/\/|\/|\s/.test(config.console.host)) {
    errors.push(new ConfigError('是监听地址，不是 URL（例：0.0.0.0 或 127.0.0.1）', { path: 'console.host' }));
  }
  if (
    config.allow
    && config.allow.allowAllWhenEmpty === true
    && config.allow.private.length === 0
    && config.allow.groups.length === 0
  ) {
    errors.push(new ConfigError(
      'allowAllWhenEmpty 为 true 但 allow 列表为空 —— 这会对所有人开放',
      {
        path: 'allow',
        hint: '这是有意的 fail-closed 保护。确认要开放请显式填写列表，或接受启动时的高危告警。',
      },
    ));
  }

  return { ok: errors.length === 0, errors };
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return { undefined: 'undefined', string: '字符串', number: '数字', boolean: '布尔值' }[typeof value] ?? typeof value;
}

function preview(value) {
  if (typeof value === 'string') return `（"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"）`;
  if (typeof value === 'number' || typeof value === 'boolean') return `（${value}）`;
  return '';
}

// ---------------------------------------------------------------- 会话覆盖层

// `config.sessions.json` 的默认文档。
export function sessionsDefault() {
  return { version: SESSIONS_VERSION, sessions: {} };
}

// **允许被会话覆盖的键**（按分组列出）。
//
// ── 为什么是白名单而不是黑名单
//
// 覆盖层将来会被控制台（甚至 AI）写。黑名单的失效方向是"某个该禁的键漏了，
// 于是它可被覆盖" —— 而那可能是 `allow.groups`（权限闸门）或 `snowluma.selfQq`
// （发错号）。白名单的失效方向是"某个该放开的键没放开"，症状只是"改了不生效"，
// 属于可发现、可修的小问题。所以只能白名单。
//
// ── 为什么这些键
//
// 判据只有一条：**"这个群与人相处的方式" vs "这个进程是什么"**。
//   · 前者（人设、谁能叫醒它、看多少上下文、决策层宽严）→ 按会话配
//   · 后者（连哪个号、哪个端口、凭据、路径、白名单）→ 全局，不可覆盖
//
// 具体地，几个"看起来该放开但不放"的：
//   · `allow.*`      —— 安全边界。让 AI 能给自己开群，等于没有闸门
//   · `owner.qq`     —— 同上
//   · `decide.apiBase` / `apiKeyFile` —— 出站目标与凭据，是 SSRF/外泄面
//   · `dsh.*` / `snowluma.*` / `console.*` / `api.*` / `log.*` / `media.root`
//                    —— 进程级，覆盖只会造出互相矛盾的真源
export const SESSION_OVERRIDABLE = {
  role: ['current'],
  chatlog: [
    'triggerWho',
    'windowWho',
    'wakeLimit',
    'replyLimit',
    'maxChars',
    'maxDays',
    'roleMaxChars',
    'waitDefaultMs',
    'waitMaxMs',
    'idleMs',
  ],
  decide: [
    'mode',
    'capabilities',
    'cardSections',
    'cardMaxChars',
    'maxRecentLines',
    'ownerAlways',
  ],
};

// 枚举型配置的合法取值。写错时**报错**而不是静默降级。
//
// 为什么必须显式校验：这几项在运行时的兜底都是 fail-closed 的静默降级
// （`normalizeWho` 把任何非 everyone 当 owner；`decide.mode` 不认识的字符串
// 等于关闭判定层）。配置写错却"看起来启动了"，是最难查的一类故障。
const SESSION_ENUMS = {
  'chatlog.triggerWho': ['owner', 'everyone'],
  'chatlog.windowWho': ['owner', 'everyone'],
  'decide.mode': ['off', 'shadow', 'enforce'],
};

// 会话键形状。与 config/sessions.js 的 CONV_KEY_RE 同一口径；
// 这里再写一遍是刻意的 —— schema 不该反向依赖使用方。
const SESSION_KEY_RE = /^(group|private):\d+$/;

// 校验会话覆盖层。返回 `{ ok, errors }`，不抛异常（调用方决定拒绝启动还是保留旧值）。
//
// @param doc 覆盖层文档 `{ version, sessions }`
export function validateSessionOverrides(doc) {
  const errors = [];
  const at = (p) => `sessions.${p}`;

  if (!isPlainObject(doc)) {
    errors.push(new ConfigError(`应为对象，实际是 ${typeName(doc)}`, { path: 'sessions' }));
    return { ok: false, errors };
  }

  if (doc.version !== undefined && !(typeof doc.version === 'number' && Number.isFinite(doc.version))) {
    errors.push(new ConfigError(`应为数字，实际是 ${typeName(doc.version)}`, { path: 'version' }));
  }

  if (doc.sessions === undefined) return { ok: errors.length === 0, errors };
  if (!isPlainObject(doc.sessions)) {
    errors.push(new ConfigError(`应为对象（会话键 → 补丁），实际是 ${typeName(doc.sessions)}`, { path: 'sessions' }));
    return { ok: false, errors };
  }

  for (const [key, patch] of Object.entries(doc.sessions)) {
    if (key !== '*' && !SESSION_KEY_RE.test(key)) {
      errors.push(new ConfigError(
        `非法会话键 "${key}"`,
        {
          path: at(key),
          hint: '只能是 "*"（全站兜底）、"group:<群号>" 或 "private:<QQ号>"，群号/QQ号必须是纯数字。'
            + '不支持通配前缀 —— 请为每个会话单独写一条。',
        },
      ));
      continue;
    }

    if (!isPlainObject(patch)) {
      errors.push(new ConfigError(`应为对象（要覆盖的配置），实际是 ${typeName(patch)}`, { path: at(key) }));
      continue;
    }

    for (const [group, leaves] of Object.entries(patch)) {
      const allowed = SESSION_OVERRIDABLE[group];
      if (!allowed) {
        const suggestion = nearestKey(group, Object.keys(SESSION_OVERRIDABLE));
        errors.push(new ConfigError(
          `"${group}" 这一组配置不允许按会话覆盖`,
          {
            path: at(`${key}.${group}`),
            hint: suggestion
              ? `你是不是想写 "${suggestion}"？`
              : `可覆盖的组：${Object.keys(SESSION_OVERRIDABLE).join(', ')}`
                + '。其余组（allow / owner / dsh / snowluma / console / api / log / media / watch）是全局项。',
          },
        ));
        continue;
      }

      if (!isPlainObject(leaves)) {
        errors.push(new ConfigError(`应为对象，实际是 ${typeName(leaves)}`, { path: at(`${key}.${group}`) }));
        continue;
      }

      for (const [leaf, value] of Object.entries(leaves)) {
        if (!allowed.includes(leaf)) {
          const suggestion = nearestKey(leaf, allowed);
          errors.push(new ConfigError(
            `"${group}.${leaf}" 不允许按会话覆盖`,
            {
              path: at(`${key}.${group}.${leaf}`),
              hint: suggestion
                ? `你是不是想写 "${group}.${suggestion}"？`
                : `可以覆盖的：${allowed.map((k) => `${group}.${k}`).join(', ')}`,
            },
          ));
          continue;
        }

        const kind = SCHEMA[group]?.[leaf];
        if (kind && !checkType(value, kind)) {
          errors.push(new ConfigError(
            `应为${describeKind(kind)}，实际是 ${typeName(value)}${preview(value)}`,
            { path: at(`${key}.${group}.${leaf}`) },
          ));
          continue;
        }

        const enumPath = `${group}.${leaf}`;
        const allowedValues = SESSION_ENUMS[enumPath];
        if (allowedValues && !allowedValues.includes(value)) {
          errors.push(new ConfigError(
            `只能是 ${allowedValues.map((v) => `"${v}"`).join(' / ')}，实际是 ${preview(value)}`,
            { path: at(`${key}.${group}.${leaf}`) },
          ));
        }
      }
    }

// 角色名即文件名 —— 在这里挡掉路径与保留字符，别等到读卡时才炸
// （读卡失败在插件侧是**静默返回空串**，表现为"这个群没有性格"）。
    const role = patch.role?.current;
    if (typeof role === 'string' && role !== '') {
      if (/[\\/:*?"<>|]/.test(role) || role === '.' || role === '..' || role.length > 40) {
        errors.push(new ConfigError(
          `角色名 "${role}" 不合法`,
          {
            path: at(`${key}.role.current`),
            hint: '只能写角色名，不能带路径分隔符或 / : * ? " < > | ，也不要写 .md 后缀。',
          },
        ));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}


// ══════════════════════════════════════════════════════════════════════════
// 配置项 → 生效方式
//
// 每加一个配置键，**必须**在这里登记一行，否则 `--check` 会报 missing。
// 这是为了让"改了没反应"变成启动前就能看见的问题：
//
//   live     改完立即生效（消费者每次现取，或 applyLiveConfig 会推给组件）
//   restart  只有重启才生效（被构造时快照进组件 —— 见 app/live-config.js 的清单）
//   none     **现在没有任何消费者**：要么去实现，要么把键删掉，别留着当假旋钮
//            （当前为空 —— 2026-10-29 清掉了 configVersion / snowluma.expectSelfMessages）
//
// `auditApplyModes()` 会把 missing / stale / none 都列出来。
// ══════════════════════════════════════════════════════════════════════════
export const APPLY_MODES = Object.freeze({
  // ── 重启才生效
  'dsh.hostUrl': 'restart',
  'dsh.hostTokenFile': 'restart',
  'dsh.agentPreset': 'restart',
  'dsh.requestTimeoutMs': 'restart',
  'snowluma.selfQq': 'restart',
  'snowluma.homeDir': 'restart',
  'chatlog.root': 'restart',
  'chatlog.agentRoot': 'restart',
  'chatlog.roleMaxChars': 'restart',
  'media.root': 'restart',
  'media.agentRoot': 'restart',
  'media.totalMb': 'restart',
  'watch.enabled': 'restart',
  'api.port': 'restart',
  'console.port': 'restart',
  'console.host': 'restart',
  'log.file': 'restart',

  // ── 改完立即生效
  'snowluma.wsUrl': 'live',
  'snowluma.httpUrl': 'live',
  'snowluma.accessToken': 'live',
  'snowluma.wsToken': 'live',
  'snowluma.heartbeatMs': 'live',
  'snowluma.heartbeatTimeoutMs': 'live',
  'snowluma.connectTimeoutMs': 'live',
  'snowluma.reconnectMinMs': 'live',
  'snowluma.reconnectMaxMs': 'live',
  'snowluma.actionTimeoutMs': 'live',
  'owner.qq': 'live',
  'role.current': 'live',
  'allow.private': 'live',
  'allow.groups': 'live',
  'allow.allowAllWhenEmpty': 'live',
  'watch.debounceMs': 'live',
  'chatlog.wakeLimit': 'live',
  'chatlog.replyLimit': 'live',
  'chatlog.maxDays': 'live',
  'chatlog.maxChars': 'live',
  'chatlog.idleMs': 'live',
  'chatlog.triggerWho': 'live',
  'chatlog.windowWho': 'live',
  'chatlog.waitDefaultMs': 'live',
  'chatlog.waitMaxMs': 'live',
  'console.password': 'live',
  'log.level': 'live',
  'log.maxBytes': 'live',
  'log.maxFiles': 'live',
  'decide.mode': 'live',
  'decide.model': 'live',
  'decide.apiBase': 'live',
  'decide.apiKey': 'live',
  'decide.apiKeyFile': 'live',
  'decide.apiKeyRef': 'live',
  'decide.timeoutMs': 'live',
  'decide.maxTokens': 'live',
  'decide.maxRecentLines': 'live',
  'decide.thinking': 'live',
  'decide.cardSections': 'live',
  'decide.cardMaxChars': 'live',
  'decide.capabilities': 'live',
  'decide.ownerAlways': 'live',
});

// 把配置摊平成叶子路径（`a.b.c`）。数组算叶子。
export function leafPaths(config = defaultConfig(), prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, p));
    else out.push(p);
  }
  return out;
}

// 核对"配置项"与"生效方式表"是否对得上。
//
// @returns `{ leaves, missing, stale, none }`
//   missing  schema 里有、表里没有 → 新加的键忘了登记
//   stale    表里有、schema 里没有 → 删键忘删登记
//   none     明确标了 none 的键（现在没人读）
export function auditApplyModes(config = defaultConfig()) {
  const leaves = leafPaths(config);
  const missing = leaves.filter((p) => !(p in APPLY_MODES));
  const stale = Object.keys(APPLY_MODES).filter((p) => !leaves.includes(p));
  const none = leaves.filter((p) => APPLY_MODES[p] === 'none');
  return { leaves, missing, stale, none };
}

// 启动日志/`--check` 用的汇总。
export function applyModeSummary(config = defaultConfig()) {
  const live = [];
  const restart = [];
  const none = [];
  for (const p of leafPaths(config)) {
    const mode = APPLY_MODES[p];
    if (mode === 'live') live.push(p);
    else if (mode === 'restart') restart.push(p);
    else if (mode === 'none') none.push(p);
  }
  return { live, restart, none, total: live.length + restart.length + none.length };
}
