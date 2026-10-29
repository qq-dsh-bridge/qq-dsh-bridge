// 会话级配置覆盖层（`config.sessions.json`）。
//
// ── 它解决什么
//
// `config.json` 里的 `role.current` 是**全局单值** —— 所有群共用一张人格卡。
// 而会话映射（`state/sessions.json`）本来就是"一个键挂几张卡"的形状，
// 插件（qq-prompt-sections）也早就能按会话反查角色。缺的只是"谁告诉它这个群用哪张"。
//
// 所以这一层只做一件事：**按会话给出"覆盖补丁"**，其余配置仍然来自 `config.json`。
//
// ── 为什么是补丁，不是 AstrBot 那种"整份配置副本"
//
// AstrBot 的 profile 是完整配置副本（`abconf_<uuid>.json`），因为它是多租户面板，
// 一份 profile 要能整份套给任意租户。桥接是**单号单进程**，整份复制只有坏处：
//   · `snowluma.selfQq` / `console.port` / `dsh.hostUrl` 会同时出现在几份文件里，
//     成了多个真源；改一处忘一处，症状是"配置改了但行为没变"，且没有任何报错。
//   · 新增一个配置项要迁移 N 份文件。
//   · 整份副本让"权限与凭据"变成可被覆盖的项 —— 那是安全边界，不该可配。
//
// 补丁层的代价是"只有白名单里的键能覆盖"，收益是新增配置项**零迁移**，
// 且不会意外造出第二个 `selfQq`。白名单在 schema.js 的 SESSION_OVERRIDABLE。
//
// ── 优先级（为什么会话补丁压过环境变量）
//
//   默认值 < config.json < 环境变量 < 命令行 < `"*"` < 精确会话键
//
// 会话补丁在**最后**，因为它比"全局环境变量"更具体 —— 更具体的意图应当赢。
// 代价是"我设了 QQBRIDGE_TRIGGERWHO=everyone 却没生效"可能发生，所以：
// **被会话补丁压掉的环境变量/命令行项会在加载时打 WARN**（见 `maskedEnvKeys`）。
// 这与 load.js 里 `envOverridden` 的处理是同一个立场：宁可吵，不要静默。
//


import path from 'node:path';

import {
  ConfigError,
  SESSIONS_VERSION,
  deepMerge,
  isPlainObject,
  sessionsDefault,
  validateSessionOverrides,
} from './schema.js';
import { readConfigFile } from './load.js';
import { writeConfigFile } from './write.js';
import { stableStringify } from '../util/value.js';

// 覆盖层文件名（与 config.json 并排，仓库根）。
//
// 与 config.json 分开而不是塞进它的一个 `sessions` 段，原因：
//   · config.json 将来要变成可提交的模板，会话覆盖是**本机运行态**
//     （哪个群配了哪张卡跟机器绑定）；
//   · 覆盖层写坏了不该影响主配置的启动校验；
//   · 但**写路径仍然只有一条** —— 都走 write.js 的原子写 + 备份。
export const SESSIONS_FILE = 'config.sessions.json';

// 会话键形状。与 api/server.js 的 `authenticate` 口径一致（同样的正则）。
export const CONV_KEY_RE = /^(group|private):\d+$/;

// 通配键：兜底覆盖，优先级低于精确键。
export const WILDCARD = '*';

export function isConvKey(key) {
  return CONV_KEY_RE.test(String(key ?? ''));
}

export class SessionOverrides {
  // @param options.file   覆盖层路径（默认 `<root>/config.sessions.json`）
  // @param options.root   仓库根
  // @param options.logger
  // @param options.envKeys 被环境变量覆盖的配置路径（`config.load` 的 source.envKeys）
  //                        —— 只用于"被会话补丁压掉"的告警
  // @param options.argvKeys 同上（命令行层）
  constructor({
    file, root = process.cwd(), logger, envKeys = [], argvKeys = [],
  } = {}) {
    this.file = file ?? path.join(root, SESSIONS_FILE);
    this.logger = logger;
    this.envKeys = envKeys;
    this.argvKeys = argvKeys;
    this.doc = sessionsDefault();
    this.errors = [];
    this.found = false;
    // 每次成功热重载递增。与 ConfigStore.revision 是**两个**计数器：
    // 一个会话补丁变了、主配置没变，下游也要能看出"该重算了"。
    this.revision = 0;
    // convKey → { rev, patch }（'*' 与精确键的合并结果）
    this.patchCache = new Map();
    // convKey → { base, rev, out }（最终生效配置）
    this.effectiveCache = new Map();
  }

  // 首次加载。**不合法时抛错** —— 与 config.json 一样 fail-closed：
  // 带着坏覆盖层跑，等于"配了的人设/闸门静默不生效"。
  loadInitial() {
    const result = this.#read();
    if (!result.ok) {
      const first = result.errors[0] ?? new ConfigError('会话覆盖层校验未通过');
      first.errors = result.errors;
      throw first;
    }
    this.doc = result.doc;
    this.found = result.found;
    this.errors = [];
    this.revision += 1;
    return result;
  }

  // 重读。失败时**保留上一份可用覆盖层**（与 ConfigStore 同一策略：
  // 保存到一半的瞬间不能让行为突变）。
  //
  // @returns `{ changed, errors }`
  reload() {
    let result;
    try {
      result = this.#read();
    } catch (error) {
      this.errors = [error instanceof ConfigError ? error : new ConfigError(String(error?.message ?? error))];
      return { changed: false, errors: this.errors };
    }
    if (!result.ok) {
      this.errors = result.errors;
      return { changed: false, errors: result.errors };
    }

    const changed = stableStringify(this.doc) !== stableStringify(result.doc);
    this.doc = result.doc;
    this.found = result.found;
    this.errors = [];
    if (changed) {
      this.revision += 1;
      this.patchCache.clear();
      this.effectiveCache.clear();
    }
    return { changed, errors: [] };
  }

  #read() {
    const { found, value } = readConfigFile(this.file);
    const doc = found ? value : sessionsDefault();
    const { ok, errors } = validateSessionOverrides(doc);
    return { ok, errors, doc: ok ? normalizeDoc(doc) : this.doc, found };
  }

  // 有几个会话配了覆盖（不含 `"*"`）。启动日志/`--check` 用。
  get count() {
    return Object.keys(this.doc.sessions ?? {}).filter((k) => k !== WILDCARD).length;
  }

  get wildcard() {
    return isPlainObject(this.doc.sessions?.[WILDCARD]) ? this.doc.sessions[WILDCARD] : null;
  }

  // 所有配了覆盖的会话键（不含 `"*"`）。
  keys() {
    return Object.keys(this.doc.sessions ?? {}).filter((k) => k !== WILDCARD).sort();
  }

  // 某个会话的**原始补丁**（`"*"` 与精确键已合并）；没配就是 `null`。
  //
  // 返回 `null` 而不是 `{}` 很重要：`resolve()` 靠它判断"要不要造新对象"，
  // 而 `deepMerge(base, {})` 会返回一个**新对象** —— 那会让下游以为配置变了。
  patchFor(convKey) {
    const hit = this.patchCache.get(convKey);
    if (hit && hit.rev === this.revision) return hit.patch;

    const all = this.doc.sessions ?? {};
    const star = isPlainObject(all[WILDCARD]) ? all[WILDCARD] : null;
    const own = isPlainObject(all[convKey]) ? all[convKey] : null;

    let patch = null;
    if (star && own) patch = deepMerge(star, own);
    else if (own) patch = own;
    else if (star) patch = star;

    this.patchCache.set(convKey, { rev: this.revision, patch });
    return patch;
  }

  // 生效配置：`base` 是主配置，返回合并了会话补丁的那份。
  //
  // **没有补丁时原样返回 `base`（同一个引用）** —— 这不是契约，只是省一次拷贝：
  // `ConfigFacade` 拿到它之后统一 deepFreeze，谁都不许改（见 config/facade.js）。
  // 有补丁时返回新对象，同样由门面冻结并记忆。
  //
  // ⚠️ memo 的键是 `(convKey, base 引用, revision)`：主配置热重载会换 `base`，
  //    会话补丁热重载会换 `revision`，两者任一变化都要重算。
  resolve(base, convKey) {
    const patch = this.patchFor(convKey);
    if (!patch) {
    // 顺手把缓存清掉：否则删掉覆盖后，旧对象会一直被复用。
      this.effectiveCache.delete(convKey);
      return base;
    }
    const hit = this.effectiveCache.get(convKey);
    if (hit && hit.base === base && hit.rev === this.revision) return hit.out;

    const out = deepMerge(base, patch);
    this.effectiveCache.set(convKey, { base, rev: this.revision, out });
    return out;
  }

  // ── 告警：会话补丁压掉了哪些环境变量/命令行项 ─────────────────────────
  //
  // 只在**确实压掉**时才报，且每项只报一次（启动、每次热重载各一次即可）。
  // 不做去重表：调用点只有两处（启动 + 热重载），重复两次反而是好事。
  maskedEnvKeys() {
    const paths = new Set([...(this.envKeys ?? []), ...(this.argvKeys ?? [])]);
    if (!paths.size) return [];
    const masked = [];
    for (const key of this.keys()) {
      const patch = this.patchFor(key);
      for (const leaf of flattenLeaves(patch)) {
        if (paths.has(leaf)) masked.push(`${key} → ${leaf}`);
      }
    }
    // 通配层也要算 —— 它对每个会话都生效，危害更大。
    const star = this.wildcard;
    if (star) {
      for (const leaf of flattenLeaves(star)) {
        if (paths.has(leaf)) masked.push(`${WILDCARD} → ${leaf}`);
      }
    }
    return masked;
  }

  // 只留**覆盖了哪些字段**的形状（控制台会话列表用，不泄露值）。
  describe(convKey) {
    const patch = this.patchFor(convKey);
    if (!patch) return [];
    return flattenLeaves(patch);
  }

  // ── 写：改一个会话的覆盖（控制台用） ──────────────────────────────────
  //
  // 语义与 `updateConfigFile` 一致：**读盘 → 深合并补丁 → 校验 → 原子写**。
  // 只改目标会话那一支，其余会话原样保留。
  //
  // @param options.convKey 会话键（或 `"*"`）
  // @param options.patch   要合并进去的补丁
  // @returns `{ file, doc }`
  set(convKey, patch, { now = Date.now } = {}) {
    const key = String(convKey ?? '');
    if (key !== WILDCARD && !isConvKey(key)) {
      const err = new ConfigError(`会话键格式不对："${key}"`, {
        path: 'sessions',
        hint: '必须是 "*"、group:<群号> 或 private:<QQ号>（全数字）',
      });
      // `errors` 是控制台 API 的统一字段（信封见 src/console/server.js）。
      // 不挂的话这个错在页面上只会显示一行标题，用户不知道该怎么改。
      err.errors = [String(err)];
      throw err;
    }
    return this.#mutate((doc) => {
      const sessions = { ...(doc.sessions ?? {}) };
      const cur = isPlainObject(sessions[key]) ? sessions[key] : {};
      sessions[key] = deepMerge(cur, patch ?? {});
      return { ...doc, sessions };
    }, { now });
  }

  // 清掉一个会话的全部覆盖（"恢复默认"）。
  clear(convKey, { now = Date.now } = {}) {
    const key = String(convKey ?? '');
    return this.#mutate((doc) => {
      const sessions = { ...(doc.sessions ?? {}) };
      delete sessions[key];
      return { ...doc, sessions };
    }, { now });
  }

  // 删掉某个会话里**单个字段**的覆盖（留着同会话的其他字段）。
  unset(convKey, dottedPath, { now = Date.now } = {}) {
    const key = String(convKey ?? '');
    const parts = String(dottedPath ?? '').split('.').filter(Boolean);
    if (!parts.length) {
      throw new ConfigError('要删的字段路径不能为空', { path: 'sessions' });
    }
    return this.#mutate((doc) => {
      const sessions = { ...(doc.sessions ?? {}) };
      if (!isPlainObject(sessions[key])) return doc;
      const next = structuredClone(sessions[key]);
      let node = next;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!isPlainObject(node[parts[i]])) return doc;
        node = node[parts[i]];
      }
      delete node[parts[parts.length - 1]];
      // 空对象不留（与 write.js 的 applyDiff 同一取向）
      pruneEmpty(next);
      if (Object.keys(next).length) sessions[key] = next;
      else delete sessions[key];
      return { ...doc, sessions };
    }, { now });
  }

  #mutate(fn, { now }) {
    const { found, value } = readConfigFile(this.file);
    const base = found && isPlainObject(value) ? value : sessionsDefault();
    const next = fn({ ...sessionsDefault(), ...base });

    const { ok, errors } = validateSessionOverrides(next);
    if (!ok) {
      const detail = errors.map(String);
      // 把**第一条**明细拼进标题：控制台的提示条只显示 `message`，
      // 只给"校验未通过"等于让用户自己去猜哪个字段错了。
      const err = new ConfigError(`会话覆盖层校验未通过，未写入：${detail[0] ?? ''}`, { path: 'sessions' });
      err.errors = detail;
      throw err;
    }

    const written = writeConfigFile({ file: this.file, config: next });
    // 写完之后立刻同步内存态：控制台保存后下一条消息就该生效，
    // 不等文件监听（那条是给"人手工改文件"用的）。
    this.doc = normalizeDoc(next);
    this.found = true;
    this.errors = [];
    this.revision += 1;
    this.patchCache.clear();
    this.effectiveCache.clear();
    return { ...written, doc: this.doc };
  }
}

// 把文档规整成"一定有 sessions 对象"的形状（缺段补空）。
function normalizeDoc(doc) {
  return {
    version: Number(doc?.version) || SESSIONS_VERSION,
    sessions: isPlainObject(doc?.sessions) ? doc.sessions : {},
  };
}

// 深度删掉空对象（`{ role: {} }` → `{}`）。数组不碰（空数组是**有意**的值）。
function pruneEmpty(node) {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (isPlainObject(value)) {
      pruneEmpty(value);
      if (Object.keys(value).length === 0) delete node[key];
    }
  }
}

// 把嵌套补丁拍平成 `chatlog.triggerWho` 这样的路径列表。
export function flattenLeaves(patch, prefix = '') {
  if (!isPlainObject(patch)) return [];
  const out = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...flattenLeaves(value, path));
    else out.push(path);
  }
  return out.sort();
}

// 键排序后序列化 —— 实现已收敛到 `util/value.js`（store.js 里那份也在用同一个）。

// 便于 `main.js` 一句创建（与 ConfigStore 的用法对称）。
export function createSessionOverrides(options) {
  return new SessionOverrides(options);
}
