// 配置门面：把「主配置 / 会话生效配置 / 状态机配置 / 白名单 / 主人」收敛成
// **按 revision 记忆的不可变快照**。
//
// ── 为什么要有这一层
//
// 以前"生效配置"有四个名字（`store.get()`、`effectiveConfig(conv)`、
// `registry.config`、`conv.config`），而且靠一条**只写在注释里的契约**维持：
// `SessionOverrides.resolve()` 在没有会话补丁时必须返回 `base` **同一个引用**，
// 否则 `live-config` 的"就地 Object.assign"就失效 —— 表现为磁盘变了、日志说已
// 热重载、行为没变，且不报错。
//
// 现在反过来：**没有"就地改"，只有"下次现取"**。
//   · 所有快照都 deepFreeze，谁想改都会立刻抛错（而不是静默失效）
//   · 消费者不再持有配置对象，改成持有 `() => facade.xxx()` 这类取值函数
//   · 记忆的键是 revision（主配置 + 会话覆盖层各一个计数器），不是对象引用
//
// ── 几层各自的含义（别混）
//
//   base()            主配置：默认值 < config.json < env < argv（`loadConfig`）
//   effective(conv)   base + 该会话的覆盖补丁（`config.sessions.json`）
//   state(conv?)      状态机看到的形状（`stateConfig(effective.chatlog)`）
//   allow()           白名单视图（出站与入站共用，只读）
//   ownerQq()         管理者 QQ
import { stateConfig } from './state-view.js';

// 递归冻结。配置里只有 JSON 值，所以不需要处理 Map/Set/循环引用；
// 仍然用一个 seen 集合兜住"有人塞了自引用对象"这种自找麻烦。
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export class ConfigFacade {
  // @param options.store    ConfigStore（主配置 + revision）
  // @param options.sessions SessionOverrides（可空；没有覆盖层时全程只用 base）
  constructor({ store, sessions = null } = {}) {
    if (!store) throw new Error('ConfigFacade 需要 store（ConfigStore 实例）');
    this.store = store;
    this.sessions = sessions;

    this.rev = '';
    this.baseRaw = null;
    this.baseFrozen = null;
    this.allowView = null;
    this.globalState = { base: null, out: null };
    // convKey → { eff, out }
    this.stateByConv = new Map();
    // convKey → 冻结后的 effective（sessions.resolve 自己也有 memo，这里只做冻结缓存）
    this.effCache = new Map();
  }

  // 两个来源的变化合起来才是"当前版本"：主配置一个计数器、覆盖层一个。
  get revision() {
    return `${this.store.revision}.${this.sessions?.revision ?? 0}`;
  }

  // 版本变了就把所有记忆扔掉。**不监听事件**：谁先来取谁触发，
  // 这样"事件还没到但文件已经读了"的情况也不会拿到旧快照。
  #sync() {
    const rev = this.revision;
    if (rev === this.rev) return;
    this.rev = rev;
    this.baseRaw = this.store.get();
    this.baseFrozen = deepFreeze(this.baseRaw);
    this.allowView = null;
    this.globalState = { base: null, out: null };
    this.stateByConv.clear();
    this.effCache.clear();
  }

  /** 主配置（冻结）。 */
  base() {
    this.#sync();
    return this.baseFrozen;
  }

  /** 某个会话的生效配置（base + 覆盖补丁，冻结）。 */
  effective(convKey) {
    this.#sync();
    if (!this.sessions) return this.baseFrozen;
    const cached = this.effCache.get(convKey);
    if (cached && cached.rev === this.rev) return cached.out;
    const resolved = this.sessions.resolve(this.baseRaw, convKey);
    // 没有补丁时 `resolve()` 原样返回 base；别再包一层（冻结一次就够了）。
    const out = resolved === this.baseRaw ? this.baseFrozen : deepFreeze(resolved);
    this.effCache.set(convKey, { rev: this.rev, out });
    return out;
  }

  /** 状态机配置（`stateConfig` 的产物，冻结）。不传 convKey = 全局那份。 */
  state(convKey) {
    this.#sync();
    if (convKey === undefined || convKey === null) {
      if (this.globalState.base !== this.baseRaw) {
        this.globalState = { base: this.baseRaw, out: deepFreeze(stateConfig(this.baseRaw.chatlog)) };
      }
      return this.globalState.out;
    }
    const eff = this.effective(convKey);
    const hit = this.stateByConv.get(convKey);
    if (hit && hit.eff === eff) return hit.out;
    const out = deepFreeze(stateConfig(eff.chatlog));
    this.stateByConv.set(convKey, { eff, out });
    return out;
  }

  /** 白名单视图（冻结；出站 BridgeApi 与入站 dispatch 都从这里现取）。 */
  allow() {
    this.#sync();
    if (!this.allowView) {
      const a = this.baseRaw.allow ?? {};
      this.allowView = Object.freeze({
        private: Object.freeze([...(a.private ?? [])]),
        groups: Object.freeze([...(a.groups ?? [])]),
        allowAllWhenEmpty: Boolean(a.allowAllWhenEmpty),
      });
    }
    return this.allowView;
  }

  /** 管理者 QQ（字符串，本来就是不可变的）。 */
  ownerQq() {
    this.#sync();
    return String(this.baseRaw.owner?.qq ?? '');
  }

  /**
   * 统一的变更订阅：主配置变、覆盖层变，都归到**一个**回调。
   *
   * 这样调用方不必再写两个 handler 各抄一遍 `applyLiveConfig + reconcile`，
   * 也不必用 `force: true` 去补"内存已经改过、事件判定没变"的缺口 ——
   * 回调只看 revision，是否真的变了由门面自己比对。
   *
   * @param fn `({ kind, reason, revision }) => void`  kind = 'config' | 'sessions'
   * @returns 取消订阅的函数
   */
  subscribe(fn) {
    const make = (kind) => (payload = {}) => {
      fn({ kind, reason: payload.reason ?? '', revision: this.revision });
    };
    const onChange = make('config');
    const onSessions = make('sessions');
    this.store.on('change', onChange);
    this.store.on('sessions-change', onSessions);
    return () => {
      this.store.off('change', onChange);
      this.store.off('sessions-change', onSessions);
    };
  }
}

export { deepFreeze };
