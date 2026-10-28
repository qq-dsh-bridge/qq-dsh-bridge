import fs from 'node:fs';
import path from 'node:path';

import { ConfigError, defaultConfig, validateConfig } from './schema.js';
import { deepMerge } from '../util/value.js';

// 配置的读取与分层合并。
//
// 优先级（后者覆盖前者）：
//   **默认值 < config.json < 环境变量 < 命令行**
//
// ── 为什么环境变量优先于文件
//
// 环境变量是**临时覆盖**（调试、试参数），文件是持久配置。
// 如果文件赢，那"设了环境变量却没生效"会变成一个很难查的问题。
// 反过来时，至少在日志里能看到"该配置项被环境变量覆盖"。
//
// ── envOverrides 的作用
//
// 返回**被环境变量改掉的键**，让桥接打一条显眼的警告。
// 没有这个的话，用户改了 config.json 发现没生效，
// 会以为是热重载坏了 —— 实际是被一个自己早先设的环境变量压住了。

// 环境变量名前缀。
//
// 拼出来是 `QQBRIDGE_BASEURL`、`QQBRIDGE_ALLOWGROUPS` 这样的**扁平**名字
// （前缀 + `flat.toUpperCase()`，见下面的 `envOverrides`）。
//
// ⚠️ 这里曾写成 `QQBRIDGE_DSH__BASEURL` 这种分层样子，与下表的扁平键
//    自相矛盾 —— 按它去拼环境变量名永远匹配不上。以 `ENV_TYPES` 为准。
const ENV_PREFIX = 'QQBRIDGE_';

// 环境变量 → 配置路径的类型表。
//
// 键是**小写、去掉下划线**的扁平名字（如 `hosturl` → `dsh.hostUrl`）。
// 为什么不用嵌套的 `DSH__BASE_URL`：Windows 的 setx 不区分大小写、
// 且下划线的层数容易记错，扁平名字更容易用对。
const ENV_TYPES = {
  hosturl: 'string',
  hosttokenfile: 'string',
  requesttimeoutms: 'positiveInt',
  agentpreset: 'string',
  apiport: 'positiveInt',
  consoleport: 'positiveInt',
  consolehost: 'string',
  // 控制台密码。
  //
  // ⚠️ **名字刻意叫 `consolepassword`**（扁平拼接的结果）。它存在的原因就是
  // 「别把密码写进被 git 跟踪的 config.json」：环境变量层比文件层优先，
  // 所以 `setx QQBRIDGE_CONSOLEPASSWORD …` 就能覆盖文件里的值。
  //
  // 历史：这里曾写着「刻意没有 console token 一项」。那句话现在**只对一半**：
  // 没有**令牌**（不需要翻文件找），但有一个**密码**。两者别混为一谈 ——
  // 令牌是系统生成的，密码是人选的、可记忆的、能改的。
  consolepassword: 'string',
  chatlogroot: 'string',
  // agent 看到的同一个目录（WSL 里是 /ws）。留空 = 没有共享文件系统。
  chatlogagentroot: 'string',
  mediaagentroot: 'string',
  wakelimit: 'positiveInt',
  replylimit: 'positiveInt',
  maxdays: 'positiveInt',
  maxchars: 'positiveInt',
  rolemaxchars: 'positiveInt',
  idlems: 'positiveInt',
  triggerwho: 'string',
  windowwho: 'string',
  waitdefaultms: 'positiveInt',
  waitmaxms: 'positiveInt',
  loglevel: 'string',
  logfile: 'string',
  ownerQq: 'string',
  allowprivate: 'csv',
  allowgroups: 'csv',
  allowallwhenempty: 'boolean',
  snowlumahttpurl: 'string',
  snowlumawsurl: 'string',
  snowlumahttptoken: 'string',
  snowlumawstoken: 'string',
  snowlumahomedir: 'string',
  selfQq: 'string',
  watch: 'boolean',
  // ⚠️ 这里**刻意没有** console token 一项 —— 控制台不再有「系统生成的令牌」。
  //
// 控制台鉴权只有**一个密码**（见上面的 `consolepassword`）：没有令牌、没有
// 落盘凭据。别照别的方案的注释加回来。
  //
  // 现在的模型（src/console/server.js 文件头有完整版本）：
  //   · 默认绑 0.0.0.0，允许局域网访问；
  //   · `console.password` 非空 ⇒ 登录后才碰得到 `/api/*`；
  //   · 密码为空 ⇒ 完全不鉴权（启动时打 WARN）。
};

// 把扁平的环境变量名映射回配置路径。
const ENV_PATHS = {
  hosturl: ['dsh', 'hostUrl'],
  hosttokenfile: ['dsh', 'hostTokenFile'],
  requesttimeoutms: ['dsh', 'requestTimeoutMs'],
  agentpreset: ['dsh', 'agentPreset'],
  apiport: ['api', 'port'],
  consoleport: ['console', 'port'],
  // 控制台的监听地址与密码。
  //
  // 密码走环境变量的意义：仓库根的 config.json 被 git 跟踪，真实密码写进去
  // 就等于提交进版本库。用 `QQBRIDGE_CONSOLEPASSWORD` 可以只在本机生效。
  consolehost: ['console', 'host'],
  consolepassword: ['console', 'password'],
  chatlogroot: ['chatlog', 'root'],
  chatlogagentroot: ['chatlog', 'agentRoot'],
  mediaagentroot: ['media', 'agentRoot'],
  wakelimit: ['chatlog', 'wakeLimit'],
  replylimit: ['chatlog', 'replyLimit'],
  maxdays: ['chatlog', 'maxDays'],
  maxchars: ['chatlog', 'maxChars'],
  rolemaxchars: ['chatlog', 'roleMaxChars'],
  idlems: ['chatlog', 'idleMs'],
  triggerwho: ['chatlog', 'triggerWho'],
  windowwho: ['chatlog', 'windowWho'],
  waitdefaultms: ['chatlog', 'waitDefaultMs'],
  waitmaxms: ['chatlog', 'waitMaxMs'],
  loglevel: ['log', 'level'],
  logfile: ['log', 'file'],
  ownerqq: ['owner', 'qq'],
  allowprivate: ['allow', 'private'],
  allowgroups: ['allow', 'groups'],
  allowallwhenempty: ['allow', 'allowAllWhenEmpty'],
  snowlumahttpurl: ['snowluma', 'httpUrl'],
  snowlumawsurl: ['snowluma', 'wsUrl'],
  // ⚠️ 名字里带 httptoken，目标却是 `snowluma.accessToken` —— schema 里
  // *HTTP token 就叫 `accessToken`**（`wsToken` 才是 WS 那个）。
// ⚠️ 路径写成 `['snowluma', 'httpToken']` 是错的 —— 那是 schema 里不存在的键，
//    设了 `QQBRIDGE_SNOWLUMAHTTPTOKEN` 会注入未知键、**启动直接报错**。
  snowlumahttptoken: ['snowluma', 'accessToken'],
  snowlumawstoken: ['snowluma', 'wsToken'],
  snowlumahomedir: ['snowluma', 'homeDir'],
  selfqq: ['snowluma', 'selfQq'],
  watch: ['watch'],
};

// 读一个配置文件（不存在时 found=false，**不报错**）。
export function readConfigFile(file) {
  if (!fs.existsSync(file)) return { found: false, value: {} };
  const raw = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${error.message}`, {
      hint: `文件：${file}`,
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('配置文件顶层必须是 JSON 对象', { hint: `文件：${file}` });
  }
  return { found: true, value };
}

// 深合并：后者覆盖前者，对象递归、数组整体替换。
//
// ⚠️ **实现在 `util/value.js`，这里不再自带一份。**
//    别在这里再附带一份 `deepMerge`：两份逐行看都像对的，但语义一旦分叉，
//    "这次配置有没有变"就会有两个答案 —— 症状是热重载时灵时不灵。


// 按类型转换一个环境变量字符串。
function coerce(raw, type, name) {
  switch (type) {
    case 'string':
      return raw;
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      throw new ConfigError(`环境变量 ${name} 不是合法的布尔值："${raw}"`, {
        hint: '可用：1/0、true/false、yes/no、on/off',
      });
    }
    case 'positiveInt': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(`环境变量 ${name} 必须是正整数，实际是 "${raw}"`);
      }
      return n;
    }
    case 'nonNegativeInt': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ConfigError(`环境变量 ${name} 必须是非负整数，实际是 "${raw}"`);
      }
      return n;
    }
    case 'csv':
      // 逗号分隔的 id 列表（QQ 号）。空串 = 空列表。
      return raw.trim() === ''
        ? []
        : raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    default:
      return raw;
  }
}

// 收集环境变量带来的覆盖。
//
// @returns `{ patch, overrides }` —— overrides 是"被改掉的键路径"，给日志用。
export function envOverrides(env = process.env) {
  const patch = {};
  const overrides = [];

  for (const [flat, type] of Object.entries(ENV_TYPES)) {
    const name = `${ENV_PREFIX}${flat.toUpperCase()}`;
    const raw = env[name];
    if (raw === undefined || raw === '') continue;

    const pathArr = ENV_PATHS[flat];
    if (!pathArr) continue;

    const value = coerce(raw, type, name);
    let node = patch;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      node[pathArr[i]] = node[pathArr[i]] ?? {};
      node = node[pathArr[i]];
    }
    node[pathArr[pathArr.length - 1]] = value;
    overrides.push(pathArr.join('.'));
  }

  return { patch, overrides };
}

// 读一条 `--key=value` 命令行参数。
//
// 只认**已知的**扁平名（与 ENV_TYPES 同一张表），
// 这样 `--check` 这类开关不会被误当成配置项。
export function argvOverrides(argv = []) {
  const patch = {};
  const overrides = [];
  const unknown = [];

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      // 无值的形式：不是配置项，交给调用方（如 --check）
      continue;
    }
    const key = body.slice(0, eq).toLowerCase().replace(/[-_]/g, '');
    const raw = body.slice(eq + 1);

    const type = ENV_TYPES[key];
    const pathArr = ENV_PATHS[key];
    if (!type || !pathArr) {
      unknown.push(arg);
      continue;
    }

    const value = coerce(raw, type, arg);
    let node = patch;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      node[pathArr[i]] = node[pathArr[i]] ?? {};
      node = node[pathArr[i]];
    }
    node[pathArr[pathArr.length - 1]] = value;
    overrides.push(pathArr.join('.'));
  }

  return { patch, overrides, unknown };
}

// 分层加载配置。
//
// @param options.root        仓库根（用于解析相对路径）
// @param options.configPath  配置文件路径（默认 `<root>/config.json`）
// @param options.argv        命令行参数
// @param options.env         环境变量
// @param options.strict      是否拒绝未知键（默认 true）
export function loadConfig({
  root,
  configPath,
  argv = [],
  env = process.env,
  strict = true,
} = {}) {
  const file = configPath ?? path.join(root, 'config.json');

  const fromFile = readConfigFile(file);
  const fromEnv = envOverrides(env);
  const fromArgv = argvOverrides(argv);

  let merged = deepMerge(defaultConfig(), fromFile.value);
  merged = deepMerge(merged, fromEnv.patch);
  merged = deepMerge(merged, fromArgv.patch);

  const { ok, errors, warnings = [] } = validateConfig(merged, { strict });

  // 生效配置的来源描述（给日志/控制台用）。
  //
  const source = {
    file,
    fileFound: fromFile.found,
    envKeys: fromEnv.overrides,
    argvKeys: fromArgv.overrides,
  };

  return {
    ok,
    config: merged,
    errors,
    warnings,
    configPath: file,
    configFound: fromFile.found,
    source,
    envOverridden: fromEnv.overrides,
    argvOverridden: fromArgv.overrides,
    unknownArgs: fromArgv.unknown,
  };
}
