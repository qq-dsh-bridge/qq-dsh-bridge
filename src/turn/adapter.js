// 投递 DSH 会话
// 每个 QQ 会话 对应一个 DSH 会话
import { EventEmitter } from 'node:events';

export class DshDeliveryError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'DshDeliveryError';
    this.hint = hint;
  }

  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}


//
// 值是字符串时，记到**启动那一刻的当前角色**名下 —— 那几乎可以肯定就是当初创建它的
// 角色（切角色只在控制台做，启动时读到的就是上次跑的那张卡）。拿不到角色才落到
// `*` 兜底槽：谁读都算数，一旦有人 `set` 就转正。
export class SessionMap {
  // @param options.file    落盘路径（`state/sessions.json`）
  // @param options.logger
  // @param options.getRole 读"某个会话当前角色名"的函数（`(convKey) => role`）。
  //                        **每次读写都现取**，所以运行中切角色/改会话覆盖立刻生效，
  //                        不需要重启。不传 convKey 时应返回全局角色（v1 迁移用）。
  constructor({ file, logger, getRole } = {}) {
    this.file = file;
    this.logger = logger;
    this.getRole = typeof getRole === 'function' ? getRole : () => '';
    // @type {Map<string, Record<string, string>>} 会话键 → { 角色名: sessionId }
    this.map = new Map();
    // sessionId → 启用日期（'YYYY-MM-DD'）。
    //
    // 标题要带日期（`<角色名> · 2026-10-23`），归档后靠它认出"这是哪阵子的会话"。
    // 必须落盘：否则每次重启都会把日期刷成今天，标题天天变。
    // 老会话没有记录 → 第一次见到时记当天。
    this.since = new Map();
    this.fs = null;
    this.path = null;
  }

  // 注入 fs/path（避免在纯逻辑测试里碰磁盘）。
  attach({ fs, path }) {
    this.fs = fs;
    this.path = path;
    this.#load();
    return this;
  }

  // 某个会话的角色名（空串 = 未启用角色，兜底槽记为 `*`）。
  //
  // @param convKey 会话键；**缺省表示"全局"**（只有 v1 迁移会这样调）
  #role(convKey) {
    try {
      return String(this.getRole(convKey) || '').trim();
    } catch {
      return '';
    }
  }

  #load() {
    if (!this.file || !this.fs) return;
    try {
      if (!this.fs.existsSync(this.file)) return;
      const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      for (const [sessionId, date] of Object.entries(raw.since ?? {})) {
        if (typeof date === 'string' && date) this.since.set(sessionId, date);
      }
      const atLoad = this.#role();
      let migrated = 0;
      let dropped = 0;
      for (const [key, value] of Object.entries(raw.sessions ?? {})) {
        if (typeof value === 'string') {
          // v1：一条键只有一个 id，归给启动时的当前角色。
          if (!value) { dropped += 1; continue; }
          this.map.set(key, { [atLoad || '*']: value });
          migrated += 1;
          continue;
        }
        if (!value || typeof value !== 'object') { dropped += 1; continue; }
        const buckets = {};
        for (const [role, id] of Object.entries(value)) {
          if (typeof id === 'string' && id) buckets[role] = id;
        }
        if (Object.keys(buckets).length) this.map.set(key, buckets);
        else dropped += 1;
      }
      this.logger?.debug('已载入会话映射', { count: this.map.size, file: this.file, migrated, dropped });
      if (migrated) {
        // 一次性转存：否则每次启动都要重新推断这些 id 属于谁。
        this.logger?.info('会话映射已升级为按人格记录', { role: atLoad || '*', migrated });
        this.save();
      }
    } catch (error) {
      // 映射坏掉不该阻断启动 —— 大不了新建会话。
      this.logger?.warn('会话映射载入失败，将新建会话', { file: this.file, error: String(error) });
    }
  }

  save() {
    if (!this.file || !this.fs || !this.path) return;
    try {
      const dir = this.path.dirname(this.file);
      if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      const payload = {
        schemaVersion: 3,
        sessions: Object.fromEntries(this.map),
        since: Object.fromEntries(this.since),
      };
      this.fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      this.fs.renameSync(tmp, this.file); // 原子替换
    } catch (error) {
      this.logger?.warn('会话映射保存失败', { file: this.file, error: String(error) });
    }
  }

  // 该会话**当前角色**名下的 DSH 会话 id；没有就 `null`。
  //
  // 没有启用角色时退回兜底槽 `*`；再退一步，如果这个键只有一个 id，就当它是自己的
  // —— 只有"角色被清空"这种边缘状态才走得到那里。
  get(key) {
    const buckets = this.map.get(key);
    if (!buckets) return null;
    const role = this.#role(key);
    if (role && buckets[role]) return buckets[role];
    if (!role) {
      if (buckets['*']) return buckets['*'];
      const ids = Object.values(buckets).filter((v) => typeof v === 'string' && v);
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

  // 记下"该会话当前角色"在这个 QQ 会话上的 DSH 会话 id。别的人格不受影响。
  set(key, value) {
    const role = this.#role(key) || '*';
    const buckets = { ...(this.map.get(key) ?? {}) };
    buckets[role] = value;
    if (role !== '*') delete buckets['*']; // 落到具体角色之后，兜底槽该退休了
    this.map.set(key, buckets);
    this.markSince(value);
    this.save();
  }

  // 这个 session 的启用日期；没有记录就记当天并落盘。
  markSince(sessionId, date = todayStamp()) {
    const id = String(sessionId ?? '');
    if (!id) return date;
    const known = this.since.get(id);
    if (known) return known;
    this.since.set(id, date);
    this.save();
    return date;
  }

  // 已有记录则返回，否则 `null`（不写盘）。
  sinceOf(sessionId) {
    return this.since.get(String(sessionId ?? '')) ?? null;
  }

  // 只删"该会话当前角色"那一条。
  //
  // ⚠️ **别的人格的会话必须留着** —— 那是以后能接回去的唯一凭据。
  // 早先这里删整个键，等于"换个角色就把上一个人格的会话连根拔掉"。
  delete(key) {
    const buckets = this.map.get(key);
    if (buckets) {
      const role = this.#role(key) || '*';
      const next = { ...buckets };
      delete next[role];
      if (Object.keys(next).length) this.map.set(key, next);
      else this.map.delete(key);
    }
    this.save();
  }

  // 所有 QQ 会话键（与角色无关）。
  keys() {
    return [...this.map.keys()];
  }

  // 某个角色名下的所有 `[键, id]`。
  entriesFor(role) {
    const name = String(role ?? '').trim();
    const out = [];
    for (const [key, buckets] of this.map) {
      const id = buckets[name || '*'];
      if (id) out.push([key, id]);
    }
    return out;
  }

  // **每个会话按它自己的角色**取到的 `[键, id]`（启动重订阅用）。
  //
  // ⚠️ 这**不能**写成 `entriesFor(globalRole)`。会话角色一分叉，"当前角色"就不再是
  //    一个全局量：群 A 用甲卡、群 B 用乙卡，按全局角色筛出来的只会是一半。
  //    症状极隐蔽 —— 重启后某些群 @ 它完全没有反应，而日志里一行错都没有
  //    （那些会话根本没被 `stream.follow` 订阅，事件压根不进桥接）。
  activeEntries() {
    const out = [];
    for (const key of this.map.keys()) {
      const id = this.get(key);
      if (id) out.push([key, id]);
    }
    return out;
  }

  // 这个会话的 id 现在住在哪个角色桶里（空串 = 没有活跃会话）。
  //
  // 用于"角色变了要停掉旧回合"的对账：判据得是**变更前后**的 active 角色，
  // 而不是"是否等于某个桶" —— 后者会把历史人格桶全判成过期，
  // 于是每次重载都对早已结束的会话发一遍 cancel。
  activeRoleOf(key) {
    const id = this.get(key);
    if (!id) return '';
    for (const [role, sid] of Object.entries(this.map.get(key) ?? {})) {
      if (sid === id) return role;
    }
    return '';
  }

  // 拍平：所有角色的所有会话（控制台/排障用）。
  allEntries() {
    const out = [];
    for (const [key, buckets] of this.map) {
      for (const [role, sessionId] of Object.entries(buckets)) out.push({ key, role, sessionId });
    }
    return out;
  }

  get size() { return this.map.size; }
}

// 投递器：把拼好的提示词送进 DSH，并等待这一轮结束。
//
// 用**每会话串行队列**：同一会话绝不并发投递（那会让 AI 同时处理两条，
// 也会撞上 DSH 的 `session is already owned by an active write handle`）。
export class DshDeliverer extends EventEmitter {
  // @param options.host         dsh/host-client.js（插件侧，唯一的 dsh 出口）
  // @param options.sessionMap   SessionMap
  // @param options.cwdFor       `(convKey) => absolutePath` —— 每个会话的 cwd
  // @param options.workspaceFor `async (convKey, cwd) => workspaceId`
  //                             确保该目录已注册为 workspace 并返回它的 id
  // @param options.sessionProbe `async (sessionId) => { exists, live, archived }`
  //                             查当前被归档的会话（见 #checkSession 的说明）
  // @param options.agentPreset  Agent preset 名（如 'qq'）
  // @param options.logger
  constructor({
    host,
    sessionMap,
    cwdFor,
    workspaceFor,
    sessionProbe,
    agentPreset = '',
    logger,
  } = {}) {
    super();
    this.host = host;
    this.sessionMap = sessionMap;
    this.cwdFor = cwdFor;
    this.workspaceFor = workspaceFor;
    this.sessionProbe = sessionProbe;
    this.agentPreset = agentPreset;
    this.logger = logger;
    // key → Promise 链，保证同一会话串行。
    this.queues = new Map();
    // cwd → workspaceId 缓存（避免重复查/建）。
    this.workspaceCache = new Map();
    // 已经写过标题的 sessionId（本进程内只写一次）。
    this.titled = new Set();
    // sessionId → 已尝试次数（失败不无限重试）。
    this.titleTries = new Map();
  }


  async #syncTitle(key, sessionId) {
    if (!sessionId || this.titled.has(sessionId)) return;
    const tries = (this.titleTries.get(sessionId) ?? 0) + 1;
    this.titleTries.set(sessionId, tries);
    if (tries > 3) return; // 试三次还不行就算了 —— 标题只是列表里的观感
    const since = this.sessionMap.markSince(sessionId);
    const title = titleFor(this.sessionMap.getRole(key), since);
    try {
      await this.host.rename({ sessionId, title });
      this.titled.add(sessionId); // 成功才算数，失败留给下一轮重试
      this.logger?.debug('已设置会话标题', { key, sessionId, title });
    } catch (error) {
      this.logger?.debug('设置会话标题失败（不影响投递）', {
        key, sessionId, title, attempt: tries, error: String(error),
      });
    }
  }

  // 把"当前人格"名下已知会话的标题全部同步一次（启动时调）。
  //
  // 老会话的标题是自动命名留下的，切角色之后列表里更分不出谁是谁。
  // 幂等：同进程内每个 sessionId 只写一次。
  //
  // @returns 处理的会话数
  async renameKnown() {
    const entries = this.sessionMap.activeEntries();
    await Promise.all(entries.map(([key, sessionId]) => this.#syncTitle(key, sessionId)));
    return entries.length;
  }

  // 投递一条提示词。
  //
  // @returns `{ sessionId, result }`
  async deliver(key, prompt) {
    // 串行化：同一个 key 的投递排队。
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#deliverOnce(key, prompt));
    // 记录链尾（吞掉错误，否则一次失败会毒化整条链）
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  async #deliverOnce(key, prompt) {
    const sessionId = await this.#ensureSession(key);
    this.logger?.debug('投递提示词', { key, sessionId, chars: prompt.length });

    // 内容形状（user 消息 + requestId）由插件负责拼，这里只给文本。
    const result = await this.host.prompt({ sessionId, text: prompt });

    this.emit('delivered', { key, sessionId });
    return { sessionId, result };
  }

  // 确保该会话有一个 DSH 会话（一对一，持久复用）。
  //
  // ── 为什么必须显式传 cwd
  //
  // DSH 的 workspace 分组规则是「**会话加入它运行目录所在的项目**」——
  // 即新建会话的 cwd 落在哪个已注册的 workspace 目录里，它就归到哪个项目。
  //
  // 不传 cwd 的话，所有会话都用 DSH 进程的默认工作目录（实测是启动目录
  // `…\原神QQBot`），于是**全部挤在同一个项目里**，看不出哪个会话是哪个群。
  //
  // ── 为什么**必须**传 workspaceId（不只是 cwd）
  //
  // 这是分组的关键，我一开始搞错了。参考实现（qq-bridge/scripts/probe-workspace.mjs:26）
  // 的用法是：
  //
  //     session/create { workspaceId }
  //
  // 而 workspace 记录的 `sessionIds` 是**所有权的真源**（DSH 文档原文：
  // 「记录的 sessionIds 顺序是所有权真源」）。也就是说会话归属是在**创建时绑定**的，
  // 光让 cwd 落在 workspace 目录里**不够** —— 实测过：cwd 完全正确，
  // 但 workspace 的 sessionIds 仍是空的，会话照样显示在 Ungrouped。
  //
  // 所以流程是：
  //   1. 确保该会话的目录已注册为 workspace（拿到 workspaceId）
  //   2. session/create 带上这个 workspaceId
  //
  // cwd 仍然要传：它是 agent 的工作目录，也是 DSH 校验会话与 workspace
  // 是否一致的依据。
  async #ensureSession(key) {
    const existing = this.sessionMap.get(key);
    if (existing) {
      // *记住的会话要先验证还活着。**
      //
      // 早先这里是 `if (existing) return existing` —— 只写不验证。
      // 后果（实测踩过）：主人把被污染的会话在 web 里**归档**了，
      // 桥接却一直往那个归档会话投递，于是"群里 @ 它完全没反应"，
      // 而 web 界面上什么都不显示（归档 = 从界面隐藏）。
      // 排查了半天才发现是往一个看不见的会话投。
      //
      // 失效的三种情况：
      //   归档   已从界面隐藏，用户看不到任何动静
      //   删除   会话没了
      //   不存在 服务重启 / 换了实例
      //
      // 验证失败就**丢掉映射重新建**，并在日志里说清是哪种。
      const check = await this.#checkSession(key, existing);
      // ⚠️ 必须读 `.ok`，不能直接 `if (check)`。
      //
      // `#checkSession` 返回的是 `{ ok: true }` / `{ ok: false, why }` ——
      // *对象永远是真值**，写成 `if (alive) return existing` 就等于
      // "永远认为它还活着"，重建分支永远不会执行。
      // 实测踩过：诊断日志明明打出 `isArchived=true`，
      // 却依然往归档会话投递。
      if (check.ok) {
        void this.#syncTitle(key, existing); // 老会话：把被自动命名盖掉的标题改回来
        return existing;
      }
      this.logger?.warn('记住的会话已失效，将重建', {
        key, sessionId: existing, why: check.why, role: this.sessionMap.getRole(key),
      });
      this.sessionMap.delete(key);
    }

    const cwd = this.cwdFor ? this.cwdFor(key) : undefined;
    // 按需注册 workspace 并拿 id（幂等）。
    const workspaceId = await this.#ensureWorkspace(key, cwd);

    // ⚠️ **`workspaceId` 与 `cwd` 只能传一个。**
    //
    // 实测报错（DSH 自己给出的）：
    //     session.create accepts workspaceId or cwd, not both
    //
    // 参考实现（qq-bridge/scripts/probe-workspace.mjs:26）只传 `workspaceId`：
    //     session/create { request: { workspaceId: wsId } }
    //
    // 有 workspaceId 时用它 —— 那才是"所有权的真源"，会话会被登记进
    // 项目的 sessionIds；workspace 自身的 path 就决定了 cwd。
    // 只有拿不到 workspaceId（注册失败）时才退回传 cwd，
    // 这样至少 agent 的工作目录是对的，只是会落在 Ungrouped。
    const res = await this.host.ensure({
      ...(workspaceId ? { workspaceId } : (cwd ? { cwd } : {})),
      preset: this.agentPreset,
    });

    // DSH 的返回形状随版本变过，这里兼容几种常见位置。
    const sessionId = res?.sessionId ? String(res.sessionId) : '';
    if (!sessionId) {
      throw new DshDeliveryError('/ensure 没有返回 sessionId', {
        hint: `实际返回：${JSON.stringify(res).slice(0, 300)}`,
      });
    }

    this.sessionMap.set(key, sessionId);
    this.logger?.info('已创建 DSH 会话', {
      key, sessionId, workspaceId: workspaceId || '(无)', role: this.sessionMap.getRole(key),
    });
    void this.#syncTitle(key, sessionId); // 建完立刻改名，别让自动命名留在列表里
    this.emit('session-created', { key, sessionId, workspaceId });
    return sessionId;
  }

  // 确保 cwd 对应的目录已注册为 workspace，返回它的 id。
  //
  // 幂等 + 缓存：同一个目录只查/建一次。失败返回空串 ——
  // 会话照样要建起来（分组是观感，不是功能），只是会落在 Ungrouped。
  async #ensureWorkspace(key, cwd) {
    if (!cwd || !this.workspaceFor) return '';

    const cached = this.workspaceCache.get(cwd);
    if (cached !== undefined) return cached;

    try {
      const id = await this.workspaceFor(key, cwd);
      this.workspaceCache.set(cwd, id ?? '');
      return id ?? '';
    } catch (error) {
      this.logger?.warn('注册 workspace 失败（会话仍会创建，只是不分组）', {
        key, cwd, error: String(error),
      });
      this.workspaceCache.set(cwd, '');
      return '';
    }
  }

  // 这个会话现在还能用吗？
  //
  // @returns `{ ok: true }` 或 `{ ok: false, why }`
  //
  // 判定依据只有一条：插件 /sessions 里的 `archived`。
  //
  // 踩过的坑（记下来别再走）：dsh 的 `session/list` **没有** archived 字段，
  // 用"列表里找不到"判失效永远判不出来 —— 归档会话照样在列表里，于是桥接
  // 一直往界面看不见的会话投递，表现是"群里 @ 它完全没反应"。
  //
  // 查不通（插件没起 / dsh 正在重启）时**保守放行**：误判成坏的会白白丢掉上下文，
  // 宁可让后续投递去暴露问题（探针返回 null 就是这种情况）。
  async #checkSession(key, sessionId) {
    if (!this.sessionProbe) {
      this.logger?.debug('会话存活检查：未注入探针，跳过', { key });
      return { ok: true };
    }
    try {
      const info = await this.sessionProbe(sessionId);
      // 探针拿不到数据（插件不在 / 请求失败）→ 保守放行，但要说清，
      // 否则"为什么不重建"会变成一个查不出来的问题。
      if (!info) {
        this.logger?.debug('会话存活检查：探针无结果，按活着处理', { key, sessionId });
        return { ok: true };
      }
      this.logger?.debug('会话存活检查', {
        key, sessionId, exists: info.exists, archived: info.archived, live: info.live,
      });
      // 三种"不能用"都要重建：归档（界面里隐藏了）、删除、服务换过实例。
      if (info.exists === false) return { ok: false, why: 'not-found' };
      if (info.archived === true) return { ok: false, why: 'archived' };
      return { ok: true };
    } catch (error) {
      this.logger?.debug('会话存活检查失败，按活着处理', { key, sessionId, error: String(error) });
      return { ok: true };
    }
  }

  // 当前各会话的映射（控制台用）。**按人格拍平**，一行一个 (键, 角色, id)。
  snapshot() {
    return {
      sessions: this.sessionMap.allEntries(),
      pending: [...this.queues.keys()].filter((k) => this.queues.has(k)).length,
    };
  }
}


function titleFor(role, date) {
  const name = String(role || '').trim() || '未启用';
  return date ? `${name} · ${date}` : name;
}

// 本地日期戳 `YYYY-MM-DD`。
function todayStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
