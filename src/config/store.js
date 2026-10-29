// 配置仓库 + 热重载。
//
// 热重载的几个必须处理的现实问题（每条都对应一个具体的失败模式）：
//
//  1. **编辑器不是原子写。** VS Code / vim 保存时会「写临时文件 → 重命名」，
//     产生 rename 事件而不是 change。只监听 change 会漏掉最常见的一类保存。
//     所以这里监听整个目录，按文件名过滤。
//
//  2. **一次保存触发多次事件。** 编辑器可能写多次（截断 + 写入），或同时改
//     config.json 与其备份。所以要 debounce，且 debounce 后重读一次为准。
//
//  3. **写到一半的 JSON 会解析失败。** 绝不能因此把配置清空或回退默认值——
//     必须**保留上一份可用配置**，并报告错误 —— 回退默认值等于
//     "保存到一半的瞬间行为突变"。
//
//  4. **校验失败要保留旧配置。** 同上：新配置不合法时继续用旧的，并持续告警，
//     直到用户改对。这比「拒绝启动」体验好，也比「带着坏配置跑」安全。
//
//  5. **文件被删除不是"清空配置"。** 删除 config.json 应当保留当前生效配置
//     并告警，而不是静默回落到默认值（否则删文件 = 权限闸门全关）。

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from './load.js';
import { ConfigError } from './schema.js';
import { stableStringify } from '../util/value.js';

export class ConfigStore extends EventEmitter {
  // 覆盖层变更订阅的取消函数（`attachSessions` 里挂上/换掉）。
  #sessionsUnsub = null;

  // @param options.root        仓库根（config.json 所在目录）
  // @param options.configPath  显式配置文件路径
  // @param options.env         环境变量表
  // @param options.argv        命令行参数
  // @param options.strict      未知键是否算错
  constructor({ root = process.cwd(), configPath, env = process.env, argv = [], strict = true } = {}) {
    super();
    this.root = root;
    this.configPath = configPath ?? path.join(root, 'config.json');
    this.env = env;
    this.argv = argv;
    this.strict = strict;

    this.current = null;
    this.loadErrors = [];
    this.watcher = null;
    this.timer = null;
    this.lastLoadAt = 0;
    // 每次成功热重载递增；调用方可据此判断"配置变了没有"。
    this.revision = 0;
    // 会话覆盖层（`config/sessions.js`）。**可选** —— 没挂上时行为与从前完全一致。
    //
    // 为什么由 store 统一持有监听：两个文件在同一个目录，共用一次 fs.watch 与
    // 同一个 debounce。各开一个 watcher 会让"一次保存触发两次重载"的窗口翻倍，
    // 而且两个 debounce 会互相错开（配置已经生效、覆盖层还差 250ms）。
    this.sessions = null;
    // 覆盖层变更订阅的取消函数（`attachSessions` 里挂）。
    this.#sessionsUnsub = null;
  }

  // 挂上会话覆盖层，让它跟着同一个目录监听一起热重载。
  //
  // ⚠️ 必须在 `startWatching()` **之前**调用，否则覆盖层的首次监听会缺失
  //    （症状：改了 config.sessions.json 没反应，直到重启）。
  attachSessions(sessions) {
    this.sessions = sessions ?? null;
    // 会话覆盖层的**写操作**（控制台 set / unset / clear）改完内存会自己宣布，
    // 这里把它转成 `sessions-change` —— 于是"改了要立刻对账"不再需要调用方
    // 用 `force: true` 手动补发（写入方自己知道状态变了，比事后比对文件更准）。
    this.#sessionsUnsub?.();
    this.#sessionsUnsub = this.sessions?.onChange?.(({ reason, revision }) => {
      this.emit('sessions-change', {
        sessions: this.sessions,
        previous: null,
        reason: reason || 'sessions-mutate',
        changed: true,
        revision,
      });
    }) ?? null;
    return this;
  }

  // 首次加载。配置不合法时抛错（启动期 fail-closed）。
  loadInitial() {
    const result = loadConfig({
      root: this.root,
      configPath: this.configPath,
      env: this.env,
      argv: this.argv,
      strict: this.strict,
    });
    this.current = result.config;
    this.loadErrors = result.errors;
    this.source = result.source;
    this.lastLoadAt = Date.now();
    this.revision += 1;
    return result;
  }


  get() {
    if (this.current === null) throw new Error('ConfigStore.loadInitial() 尚未调用');
    return this.current;
  }

  // 重新读取配置。成功则替换并 emit('change')；失败则保留旧配置并 emit('error')。
  //
  // @returns `{ changed, errors }`
  reload({ reason = 'manual' } = {}) {
    let result;
    try {
      result = loadConfig({
        root: this.root,
        configPath: this.configPath,
        env: this.env,
        argv: this.argv,
        strict: this.strict,
      });
    } catch (error) {
      // 文件读不了 / JSON 语法错 —— 保留旧配置。这是关键：绝不因一次坏读而清空。
      const configError = error instanceof ConfigError ? error : new ConfigError(String(error?.message ?? error));
      this.loadErrors = [configError];
      this.emit('error', configError, { reason, keptPrevious: true });
      return { changed: false, errors: this.loadErrors };
    }

    if (!result.ok) {
      // 类型/未知键等校验错 —— 同样保留旧配置。
      this.loadErrors = result.errors;
      this.emit('error', result.errors, { reason, keptPrevious: true });
      return { changed: false, errors: result.errors };
    }

    const previous = this.current;
    const changed = !shallowEqualConfig(previous, result.config);
    this.current = result.config;
    this.loadErrors = [];
    this.source = result.source;
    this.lastLoadAt = Date.now();
    if (changed) {
      this.revision += 1;
      this.emit('change', { config: result.config, previous, reason });
    }
    return { changed, errors: [] };
  }

  // 开始监听配置文件所在**目录**（而不是文件本身）。
  //
  // 监听目录而非文件的原因：编辑器保存常走「临时文件 + rename」，
  // 替换后原 inode 的 watcher 会失效/丢失后续事件。
  //
  // 目录里**同时**放着会话覆盖层，所以按文件名分派：两个文件任一变化都触发一次
  // debounce，然后**各读各的**（没变的那个不会 emit）。
  startWatching() {
    if (this.watcher) return;
    if (!this.get().watch.enabled) {
      this.emit('watch-disabled');
      return;
    }

    const dir = path.dirname(this.configPath);
    const targets = this.#watchTargets();

    try {
      // persistent: true（默认）**必须**。用 false 的话 watcher 不会让事件循环保持存活，
// 进程会在启动后立刻退出——一个"监听配置的服务"自己先没了。
      this.watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
        // filename 在某些平台/场景下可能为 null；此时保守地当作可能相关。
        if (filename && !targets.has(filename)) return;
        this.#scheduleReload();
      });
    } catch (error) {
      // 目录不存在等 —— 不该阻断启动，降级为"无热重载"并明确告警。
      this.emit('error', new ConfigError(`无法监听 ${dir}：${error.message}`, { hint: '热重载已禁用，配置改动需重启进程生效。' }), { reason: 'watch-start' });
      return;
    }

    this.watcher.on('error', (error) => {
      this.emit('error', new ConfigError(`配置监听出错：${error.message}`), { reason: 'watch' });
    });

    this.emit('watch-started', { dir, targets: [...targets] });
  }

  // 这个目录里我们要跟着热的文件（basename）。
  #watchTargets() {
    const set = new Set([path.basename(this.configPath)]);
    if (this.sessions?.file) set.add(path.basename(this.sessions.file));
    return set;
  }

  stopWatching() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.emit('watch-stopped');
    }
  }

  #scheduleReload() {
    const { debounceMs } = this.get().watch;
    // debounce 期间若又收到事件，重置计时器。**用最后一次为准重读文件**，
    // 而不是把多次事件累积起来。
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reload({ reason: 'file-watch' });
      this.reloadSessions({ reason: 'file-watch' });
    }, debounceMs);
    // 注意：这里**不能** unref()。unref 的定时器不阻止进程退出，
    // 在"只监听配置"的空闲期会让进程直接结束，热重载永远不会生效。
    // 让进程存活由 watcher（persistent: true）与这个定时器共同保证。
  }

  // 重读会话覆盖层。失败时**保留上一份可用覆盖层**（与 reload 同一策略）。
  //
  // 只负责"文件变了没有"：内容没变就不发事件。
  // 而"控制台改了内存"这种**不是文件变化**的变更，由 `SessionOverrides` 的
  // 写操作自己 `onChange` 通告（见 `attachSessions`）—— 不再需要 `force`。
  //
  // @returns `{ changed, errors }`
  reloadSessions({ reason = 'manual' } = {}) {
    if (!this.sessions) return { changed: false, errors: [] };
    const result = this.sessions.reload();
    if (result.errors?.length) {
      this.emit('error', result.errors, { reason, keptPrevious: true, target: 'sessions' });
      return result;
    }
    if (result.changed) {
      this.emit('sessions-change', {
        sessions: this.sessions,
        previous: null,
        reason,
        changed: true,
        revision: this.sessions.revision,
      });
    }
    return result;
  }
}

// 只比较"会影响行为"的顶层结构，避免每层都深比导致热重载判定过于敏感
// （比如数组顺序变化不该算变更——不过我们数组是整体替换，顺序变化确实是变更）。
//
// 用 JSON 比较是刻意的：配置是小对象，且值都是 JSON 可序列化的。
// 这样能保证"相同语义的配置"不会触发无谓的下游重建。
//
// `stableStringify` 的实现已收敛到 `util/value.js`（sessions.js 用的也是它）。
function shallowEqualConfig(a, b) {
  if (a === null || b === null) return a === b;
  return stableStringify(a) === stableStringify(b);
}
