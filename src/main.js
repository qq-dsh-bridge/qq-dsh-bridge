#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config/store.js';
import { updateConfigFile } from './config/write.js';
import { createSessionOverrides, SESSIONS_FILE } from './config/sessions.js';
import { reportConfigFailure, logEffectiveConfig } from './config/report.js';
import { stateConfig } from './config/state-view.js';
import { Logger } from './util/logger.js';
import { probeHost, probeOneBotHttp } from './app/probe.js';
import { wireTurnTracking } from './app/wire-stream.js';
import { installShutdown } from './app/shutdown.js';
import { applyLiveConfig } from './app/live-config.js';
import { createStoreFor, createDeliverHandler } from './app/deliver-pipeline.js';
import { verifySelfQq } from './app/identity.js';
import { createHostClient } from './dsh/host-client.js';
import { OneBotHttpClient } from './onebot/http.js';
import { OneBotWsClient } from './onebot/ws.js';
import { resolveSnowLumaEndpoints } from './onebot/snowluma.js';
import { attachOneBotEvents } from './onebot/dispatch.js';
import { dirNameOf } from './chatlog/store.js';
import { ConversationRegistry } from './turn/state.js';
import { RoleStore } from './prompt/role.js';
import { createJudge } from './prompt/judge.js';
import { createDecideLog } from './prompt/decide-log.js';
import { SessionMap, DshDeliverer } from './turn/adapter.js';
import { syncWorkspaces, ensureWorkspace, defaultTitle } from './dsh/workspace-sync.js';
import { BridgeApi, startBridgeApiServer } from './api/server.js';
import { buildHandlers } from './api/handlers/index.js';
import { createMediaStore } from './media/store.js';
import { configureMediaStore } from './api/media.js';
import { ConsoleServer, startConsoleServer } from './console/server.js';
import { acquireLock } from './util/lock.js';
import { stickerFile } from './chatlog/stickers.js';
import { readLogTail } from './util/logger.js';
import { fetchImageBuffer } from './util/image-fetch.js';
import { fetchBinary } from './util/media-fetch.js';
import { configurePathMap } from './util/path-map.js';

//仓库根目录
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {

  // #region 启动：配置 → 单实例锁 → 早退

  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const bootLogger = new Logger({ level: 'info' });
  const store = new ConfigStore({ root: ROOT, argv, strict: true });


  let initial;
  try {
    initial = store.loadInitial();
  } catch (error) {
    reportConfigFailure(bootLogger, error);
    await bootLogger.close();
    process.exitCode = 2;
    return;
  }

  if (!initial.ok) {
    bootLogger.error('配置校验未通过，拒绝启动');
    for (const err of initial.errors) bootLogger.error(String(err));
    await bootLogger.close();
    process.exitCode = 2;
    return;
  }

  const bootConfig = initial.config;

  // 会话覆盖层（`config.sessions.json`）—— 与主配置一样 **fail-closed**。
  //
  // 为什么不"读不到就用空"：坏掉的覆盖层不会报错，只会让"配了人设的群"静默
  // 退回全局卡、"配了只认主人的群"静默对所有人开放。那类故障比启动失败难查得多。
  const sessions = createSessionOverrides({
    root: ROOT,
    file: path.join(ROOT, SESSIONS_FILE),
    logger: bootLogger,
    envKeys: initial.source?.envKeys ?? [],
    argvKeys: initial.source?.argvKeys ?? [],
  });
  try {
    sessions.loadInitial();
  } catch (error) {
    bootLogger.error(`${SESSIONS_FILE} 校验未通过，拒绝启动`);
    bootLogger.error(String(error?.message ?? error));
    for (const err of error?.errors ?? []) bootLogger.error(String(err));
    await bootLogger.close();
    process.exitCode = 2;
    return;
  }

  const logger = Logger.fromConfig(bootConfig);
  sessions.logger = logger;

  // 某个会话的**生效配置** = 主配置 + 该会话的覆盖补丁。
  //
  // 没有覆盖时 `resolve()` 原样返回 `store.get()`（同一个引用）—— 所以没配覆盖的
  // 部署行为与引入覆盖层之前**完全一致**。
  //
  // ⚠️ 每次调用都现取 `store.get()`：主配置热重载后 base 换了，memo 会自然失效。
  const effectiveConfig = (convKey) => sessions.resolve(store.get(), convKey);

  // 状态机看到的那份形状（`stateConfig` 的产物）。
  //
  // 为什么要再包一层 memo：`stateConfig()` 每次都造**新对象**，直接把它的结果
  // 交给会话会让"配置没变"也变成"配置变了" —— 每次热重载每个会话都换一次
  // `conv.config`，而 `ConversationState` 的注释里明确依赖"同一个引用、就地有效"。
  // 这里按 `effectiveConfig` 的**引用**做键：它没变，状态机配置就不该变。
  const stateConfigCache = new Map();
  const resolveStateConfig = (convKey) => {
    const base = effectiveConfig(convKey);
    const hit = stateConfigCache.get(convKey);
    if (hit && hit.base === base) return hit.out;
    const out = stateConfig(base.chatlog);
    stateConfigCache.set(convKey, { base, out });
    return out;
  };

  //锁
  let lock = null;
  if (!checkOnly) {
    try {
      lock = acquireLock({ file: path.join(ROOT, 'state', 'bridge.lock') });
      logger.debug('已获得单实例锁', { pid: lock.pid });
    } catch (error) {
      logger.error('拒绝启动：' + String(error));
      await logger.close();
      process.exitCode = 3;
      return;
    }
  }

  logger.info('qq-dsh-bridge 启动', {
    root: ROOT,
    config: store.configPath,
    configFound: initial.source.fileFound,
    sessions: sessions.count,
    sessionsFile: sessions.file,
    sessionsFound: sessions.found,
  });

  // 会话覆盖层与主配置共用同一次目录监听（同一个 debounce）。
  store.attachSessions(sessions);

  if (sessions.count > 0 || sessions.wildcard) {
    logger.info('会话覆盖已生效', {
      count: sessions.count,
      wildcard: Boolean(sessions.wildcard),
      keys: sessions.keys().join(', ') || '(无)',
    });
  }
  // 会话补丁压掉了环境变量/命令行项 —— 这是"我设了变量却没生效"的唯一线索。
  const masked = sessions.maskedEnvKeys();
  if (masked.length) {
    logger.warn('会话覆盖压过了环境变量/命令行项（会话级更具体，按设计优先）', {
      pairs: masked.join(', '),
    });
  }

  if (!initial.source.fileFound) {
    logger.warn('未找到 config.json，正在使用内置默认值', {
      expected: store.configPath,
      hint: '如需自定义，把默认配置写进该文件即可；保存后会自动热重载。',
    });
  }

  logEffectiveConfig(logger, bootConfig);
  for (const key of initial.envOverridden ?? []) {
    logger.warn('该配置项被环境变量覆盖（优先于 config.json）', { key });
  }
  for (const key of initial.argvOverridden ?? []) {
    logger.warn('该配置项被命令行覆盖', { key });
  }

  if (checkOnly) {
    logger.info('--check：配置校验通过，退出', {
      sessions: sessions.count,
      wildcard: Boolean(sessions.wildcard),
    });
    // 把每个会话"覆盖了哪些字段"打出来 —— 这是核对"我配的到底生没生效"最快的一条路。
    for (const key of sessions.keys()) {
      logger.info(`会话覆盖 ${key}`, { fields: sessions.describe(key).join(', ') || '(空)' });
    }
    await logger.close();
    return;
  }

  // #endregion


  // #region DSH 客户端

  const host = createHostClient({
    baseUrl: bootConfig.dsh.hostUrl,
    tokenFile: path.isAbsolute(bootConfig.dsh.hostTokenFile)
      ? bootConfig.dsh.hostTokenFile
      : path.join(ROOT, bootConfig.dsh.hostTokenFile),
    timeoutMs: bootConfig.dsh.requestTimeoutMs,
    logger,
  });
  // #endregion


  // #region OneBot / SnowLuma

  const endpoints = resolveSnowLumaEndpoints(bootConfig, logger);

  const http = new OneBotHttpClient({
    httpUrl: endpoints.http.url,
    accessToken: endpoints.http.token,
    timeoutMs: bootConfig.snowluma.actionTimeoutMs,
    logger,
  });

  const ws = new OneBotWsClient({
    wsUrl: endpoints.ws.url,
    accessToken: endpoints.ws.token,
    heartbeatMs: bootConfig.snowluma.heartbeatMs,
    heartbeatTimeoutMs: bootConfig.snowluma.heartbeatTimeoutMs,
    connectTimeoutMs: bootConfig.snowluma.connectTimeoutMs,
    reconnect: {
      minDelayMs: bootConfig.snowluma.reconnectMinMs,
      maxDelayMs: bootConfig.snowluma.reconnectMaxMs,
    },
    logger,
  });

  // #endregion


  // #region 身份核对（只连 config 指定的号）

  const verifyIdentity = async (where) => {
    try {
      const r = await verifySelfQq(http, bootConfig.snowluma.selfQq);
      if (r.checked) logger.debug('身份核对通过', { where, selfQq: r.actual });
    } catch (error) {
      logger.error('连上的号与 config 不一致', {
        where,
        configured: String(bootConfig.snowluma.selfQq),
        actual: error?.actual ?? '(未知)',
        hint: 'SnowLuma 里这个号的 onebot 端点没起来，或 httpUrl/wsUrl 指到了另一个号；'
          + '确认 config.snowluma.selfQq 与 SnowLuma 中该号的配置一致。',
      });
    }
  };

  await verifyIdentity('startup');
  ws.on('open', () => void verifyIdentity('ws-open'));

  // #endregion


  // #region 聊天记录与 workspace

  const chatlogRoot = path.isAbsolute(bootConfig.chatlog.root)
    ? bootConfig.chatlog.root
    : path.join(ROOT, bootConfig.chatlog.root);

  // 统一媒体仓库：图片 / 语音 / 视频 / 文件共用一套存储与路由（见 src/media/）。
  const mediaRoot = String(bootConfig.media?.root ?? '').trim() || path.join(ROOT, 'state', 'media');

  // agent 看到的媒体根：显式配置优先；否则若 mediaRoot 在 chatlogRoot 里，
  // 用 `chatlog.agentRoot + 相对路径` 推导（本机是 `/ws/media`）。
  // 推导不出来就给空 —— 工具结果只给 `/m/<id>`，不给一个 agent 看不懂的宿主路径。
  const mediaAgentRoot = (() => {
    const explicit = String(bootConfig.media?.agentRoot ?? '').trim();
    if (explicit) return explicit;
    const agent = String(bootConfig.chatlog?.agentRoot ?? '').trim();
    if (!agent) return '';
    const rel = path.relative(chatlogRoot, mediaRoot);
    if (path.isAbsolute(rel) || rel.startsWith('..')) return '';
    const root = agent.replace(/\/+$/, '');
    return rel ? `${root}/${rel.split(path.sep).join('/')}` : root;
  })();

  // agent 路径 ↔ 宿主路径：agent 在 bash 里看到 `/ws/...`，SnowLuma 只认宿主路径。
  // `agentRoot` 为空 = 没有共享文件系统（不翻译；只接受 URL / `/m/`）。
  // 非 WSL 部署（原生 Windows/Linux）留空即可，路径原样透传。
  //
  // 媒体根可以不在 chatlog 根里面，所以单独给一对；最长前缀优先。
  // 配了任何一对 ⇒ qq_send 拒绝本机路径（见 `toHostPathStrict`）。
  configurePathMap({
    agent: bootConfig.chatlog.agentRoot,
    host: chatlogRoot,
    extra: mediaAgentRoot ? [{ agent: mediaAgentRoot, host: mediaRoot }] : [],
  });

  const { storeFor, stores } = createStoreFor({
    chatlogRoot,
    logger,
    selfQq: endpoints.selfQq,
    getConfig: () => store.get(),
  });

  const saveRoleSelection = (name) => {
    const next = String(name ?? '');
    updateConfigFile({
      file: store.configPath,
      patch: { role: { current: next } },
    });
    store.reload({ reason: 'role-select' });
    logger.info('角色已写入配置', { role: next || '(未启用)' });
    return next;
  };

  const roleStore = new RoleStore({
    dir: path.join(ROOT, 'roles'),
    maxChars: bootConfig.chatlog.roleMaxChars,
    logger,
    getConfig: () => store.get(),
    // 会话覆盖层：每个群可以有自己的角色（`role.current` 的按会话覆盖）。
    getEffective: effectiveConfig,
    persistRole: saveRoleSelection,
  });

  const sessionMap = new SessionMap({
    file: path.join(ROOT, 'state', 'sessions.json'),
    logger,
    // **按会话**取角色：传 convKey 之后，每个群读写的是自己那一桶。
    getRole: (convKey) => roleStore.nameFor(convKey),
  }).attach({ fs, path });

  const convDir = (convKey) => path.join(chatlogRoot, dirNameOf(convKey));

  const deliverer = new DshDeliverer({
    host,
    sessionMap,
    logger,
    cwdFor: convDir,
    workspaceFor: async (convKey, cwd) => {
      const id = await ensureWorkspace({ host, path: cwd, title: titleForConv(convKey), logger });
      return id;
    },
    // 归档状态从插件读
    // 记住的会话还能不能用：一次查表，问插件要单个会话的快照。
    //
    // ⚠️ 别用 /sessions 的列表过滤 —— 归档会话**不在活会话列表里**，
    //    于是"归档"永远被读成"没归档"，桥接会一直往一个界面里看不见的会话投递
    //    （实测症状：群里 @ 它完全没反应，WEB 上什么都不显示）。
    sessionProbe: async (sessionId) => {
      const info = await host.sessionInfo({ sessionId });
      return info ? { exists: info.exists, live: info.live, archived: info.archived } : null;
    },
    agentPreset: bootConfig.dsh.agentPreset,
  });

  function titleForConv(convKey) {
    try {
      const readme = path.join(convDir(convKey), 'README.md');
      if (fs.existsSync(readme)) {
        const first = fs.readFileSync(readme, 'utf8').split('\n')[0].trim();
        const m = /^#\s*(.+)$/.exec(first);
        if (m) return m[1].trim();
      }
    } catch {
      // 读不到就用默认标题
    }
    return defaultTitle(convKey);
  }

  const ensureWorkspaces = async (convKeys) => {
    const paths = convKeys.map((key) => {
      const dir = convDir(key);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        logger.warn('创建会话目录失败（注册 workspace 会跟着失败）', { dir, error: String(error) });
      }
      return { path: dir, title: titleForConv(key) };
    });
    const r = await syncWorkspaces({ host, paths, logger });
    return r;
  };

  // 已知会话：sessions.json 里记着的（重启不丢）+ 配置白名单里的；对账时统一登记成 workspace。
  const knownConvs = new Set([
    ...sessionMap.keys(),
    ...bootConfig.allow.groups.map((id) => `group:${id}`),
    ...bootConfig.allow.private.map((id) => `private:${id}`),
  ]);

  // #endregion


  // #region 状态机（人格卡 + 会话注册表）

  const registry = new ConversationRegistry({
    ownerQq: bootConfig.owner.qq,
    config: stateConfig(bootConfig.chatlog),
    // **会话覆盖层**：`chatlog.*` 也可以按会话覆盖（闸门、上下文条数、窗口时长…）。
    // 没配覆盖的会话拿到的是同一个对象（`SessionOverrides.resolve` 的 identity 保证）。
    resolveConfig: resolveStateConfig,
    storeFor,
    logger,
    // 决策层（唤醒点判"要不要开口"）—— **shadow 期只记不拦**，见 prompt/judge.js。
    judge: createJudge({
      getConfig: () => store.get(),
      // `decide.*` 与角色卡同样按会话取（每个群可以有自己的宽严与节选）。
      getConfigFor: effectiveConfig,
      getRoleName: () => roleStore.name,
      getRoleFor: (convKey) => roleStore.nameFor(convKey),
      logger,
      // 没有角色就不给路径（空串）—— 决策层据此跳过读卡，不拿任何默认人格顶上。
      cardPath: (convKey) => {
        const name = roleStore.nameFor(convKey);
        return name ? path.join(roleStore.dir, `${name}.md`) : '';
      },
    }),
    decideLog: createDecideLog({ file: path.join(ROOT, 'logs', 'decide.jsonl'), logger }),
    // 新会话第一次出现时顺手把它的目录登记成 workspace（失败只记日志）。
    onConversationCreated: (convKey) => {
      void ensureWorkspaces([convKey]).catch((error) => {
        logger.debug('新会话的 workspace 登记失败', { conv: convKey, error: String(error) });
      });
    },
    // 投递流水线见 app/deliver-pipeline.js；getStream/getRegistry 是晚绑定（那里有说明）。
    onDeliver: createDeliverHandler({
      deliverer,
      logger,
      getConfig: () => store.get(),
      getStream: () => stream,
      getRegistry: () => registry,
    }),
  });

  // #endregion


  // #region 工具面：只暴露 pool

  const poolFor = (convKey) => registry.conversationFor(convKey).turnPool;

  // #endregion


  // #region DSH 事件流

  //  必须在 registry 之后 —— 见 app/wire-stream.js。
  // turnTracker 由 wire-stream 自己持有（turn 监听都注册在那里），main 不需要它。
  const { stream } = wireTurnTracking({ host, logger, registry, sessionMap });

  // 一次对账：探活 → 查询 → 注册 workspace → 同步标题 → 订阅事件。
  // 顺序是刻意的：先把 dsh 那边的状态对齐，再 stream.follow。
  const reconcile = async ({ quiet = false } = {}) => {
    if (!(await probeHost(host, logger, { quiet }))) return false;

    // 查询：dsh 上现在有几个活会话（只为报告，失败不拦后面的步骤）
    const list = await host.sessions({ cold: false, titles: false }).catch(() => null);
    const sessionsOnDsh = list?.sessions;

    const r = await ensureWorkspaces([...knownConvs]);
    const renamed = await deliverer.renameKnown().catch((error) => {
      logger.debug('同步会话标题失败（不影响运行）', { error: String(error) });
      return 0;
    });

    const known = sessionMap.activeEntries();
    for (const [, sessionId] of known) stream.follow(sessionId);

    logger.info('dsh 对账完成', {
      liveSessions: Array.isArray(sessionsOnDsh) ? sessionsOnDsh.length : '?',
      workspaces: r.registered.length,
      failed: r.failed.length,
      renamed,
      followed: known.length,
    });
    return true;
  };

  // #endregion


  // #region 工具面 API（MCP 的后端）

  const imageBaseUrl = `http://127.0.0.1:${bootConfig.api.port}`;

  const mediaStore = createMediaStore({
    root: mediaRoot,
    uin: bootConfig.snowluma.selfQq || 'unknown',
    logger,
    totalMb: bootConfig.media?.totalMb,
  });
  configureMediaStore({ store: mediaStore, baseUrl: imageBaseUrl, agentRoot: mediaAgentRoot });
  logger.info('媒体仓库就绪', { ...mediaStore.stats() });
  const mediaSweep = setInterval(() => {
    try {
      mediaStore.sweep();
    } catch (error) {
      logger.warn('媒体清理失败', { error: String(error) });
    }
  }, 10 * 60 * 1000);
  mediaSweep.unref?.();

  const allowView = {
    private: [...bootConfig.allow.private],
    groups: [...bootConfig.allow.groups],
    allowAllWhenEmpty: bootConfig.allow.allowAllWhenEmpty,
  };

  const bridgeApi = new BridgeApi({
    storeFor,
    allow: allowView,
    logger,
    media: mediaStore,
    // 唯一的凭据：同机进程（dsh 里的 qq-dsh-tools 插件）读同一个文件当令牌。
    // 会话 key 由插件从会话 cwd 推导，不走凭据。
    hostTokenFile: path.join(ROOT, 'state', 'host-token'),
  });

  // op 清单只有一份（api/handlers/index.js）；漏传依赖会在 buildHandlers 的启动期自检里抛错。
  bridgeApi.registerHandlers(buildHandlers({
    poolFor,
    http,
    logger,
    registry,
    stickerPath: stickerFile(ROOT, endpoints.selfQq),
    imageBaseUrl,
    apiPort: bootConfig.api.port,
    // 取图函数（带 QQ 图床域名白名单）。显式传是为了通过 buildHandlers 的启动期自检，
    // 同时也让"用哪套下载逻辑"在这一处可见。
    fetchImage: fetchImageBuffer,
    // 语音的下载通道（同一套 QQ 域名白名单，不同的大小上限与文案）。
    fetchBinary,
  }));

  try {
    await startBridgeApiServer({
      api: bridgeApi,
      port: bootConfig.api.port,
      logger,
    });
  } catch (error) {
    logger.error('工具面 API 启动失败（工具将不可用）', { error: String(error) });
  }

  // #endregion


  // #region 控制台

  const consoleServer = new ConsoleServer({
    // 前端三件套（index.html / console.css / console.js）—— 见 public/console/
    staticRoot: path.join(ROOT, 'public', 'console'),
    configFile: store.configPath,
    roleStore,
    // 会话覆盖层：控制台"会话配置"页签读写它（`config.sessions.json`）。
    overrides: sessions,
    getEffective: () => store.get(),
    getRuntime: () => ({
      conversations: registry.snapshot(),
      sessions: deliverer.snapshot(),
      lock: lock ? { pid: lock.pid } : null,
      revision: store.revision,
      role: roleStore.name,
      // 会话覆盖层：页面顶部"3 个会话 / 1 条兜底"用它，不必再拉一次 /api/sessions。
      overrides: { count: sessions.count, revision: sessions.revision, wildcard: Boolean(sessions.wildcard) },
    }),
    getLogTail: (n) => readLogTail(store.get().log.file, n),   // 每次请求都读当前配置
    onConfigSaved: () => {
      // 文件监听会自己触发热重载；这里只记一行便于在日志里看到"刚被改过"。
      logger.info('配置已由控制台写入，等待热重载生效');
    },
    // 会话覆盖被控制台改完 → 让 store 重发一次 `sessions-change`（`force`）。
    //
    // 控制台是直接改的同一个 `SessionOverrides` 实例，内存早就更新了，
    // 所以 watcher 之后重读会判定"没变化"、**不会**发事件；而角色对账
    // （停旧回合 / 重建会话）只挂在那条事件上。详见 `reloadSessions` 的注释。
    onSessionsChanged: ({ action, key }) => {
      logger.info('控制台改了会话覆盖，立即对账', { action, key });
      store.reloadSessions({ reason: 'console', force: true });
    },
    logger,
  });

  try {
    await startConsoleServer({
      console: consoleServer,
      port: bootConfig.console.port,
      host: bootConfig.console.host,
      logger,
    });
    // 鉴权只有一个密码（见 src/console/server.js 文件头）。没设密码时配置层已打过 WARN。
    logger.info('控制台地址', {
      url: `http://${bootConfig.console.host}:${bootConfig.console.port}/`,
      auth: bootConfig.console.password ? '密码' : '无（未设置密码）',
    });
  } catch (error) {
    logger.error('控制台启动失败', { error: String(error), port: bootConfig.console.port });
  }

  // #endregion


  // #region 入站接线 → 常驻

  // 入站事件的唯一入口在 `onebot/dispatch.js`，这里只把依赖交给它。
  //   依赖必须**显式传**：dispatch 里直接引用外层变量，一旦名字对不上就是每条消息
  //   抛 `ReferenceError`、还被 `main().catch(...)` 吞成一行 ERROR ——
  //   **桥接表面在跑、消息一条都进不来**。
  attachOneBotEvents(ws, {
    registry,
    // 不传主人 QQ：身份判定在状态机里按 `registry.ownerQq` 现读（传快照会静默失效）。
    // `allow` 传的是与出站共用的那个对象 —— 热重载就地改它，两把闸门同时生效。
    allow: allowView,
    // 只传它真正用到的三个（registry / allow / logger）：
    // 引用已改为**只在本地解析**，所以 `storeFor` / `http` 也不再需要
    // （见 dispatch.js 的接收段）。
    logger,
  });

  logger.info('OneBot 目标', {
    source: endpoints.source,
    httpUrl: endpoints.http.url,
    wsUrl: endpoints.ws.url,
    selfQq: endpoints.selfQq || '(未设置)',
    httpToken: endpoints.http.token ? '已配置' : '缺失',
    wsToken: endpoints.ws.token ? '已配置' : '缺失',
  });

  logger.info('聊天记录工作区', {
    root: chatlogRoot,
    wakeLimit: bootConfig.chatlog.wakeLimit,
    replyLimit: bootConfig.chatlog.replyLimit,
    triggerWho: bootConfig.chatlog.triggerWho,
    windowWho: bootConfig.chatlog.windowWho,
  });

  // dsh 可能比桥接晚起：先对账一次；不通就在后台重试，恢复后补上登记与订阅。
  const timers = new Set();
  const ready = await reconcile().catch((error) => {
    logger.warn('dsh 对账失败（不影响收消息，会继续重试）', { error: String(error) });
    return false;
  });

  if (!ready) {
    logger.warn('dsh 目前不可达：先照常收消息，恢复后自动补登记并订阅', {
      hostUrl: bootConfig.dsh.hostUrl,
      hint: '不需要重启本进程 —— 鉴权是每次调用时按需完成的。',
    });

    let attempt = 0;
    const retry = async () => {
      attempt += 1;
      const ok = await reconcile({ quiet: true }).catch(() => false);
      if (ok) {
        logger.info('dsh 已恢复，补登记与订阅完成', { attempt });
        return;
      }
      if (attempt >= 40) {
        logger.warn('dsh 仍未恢复，停止后台重试（下一条消息到达时还会试）', { attempt });
        return;
      }
      timers.add(setTimeout(() => void retry(), 30_000));
    };
    timers.add(setTimeout(() => void retry(), 30_000));
  }

  ws.connect();

  // 启动后探活一次，尽早暴露 token 配错（HTTP token 与 WS token 不是同一个值）。
  void probeOneBotHttp(http, logger);

  // 信号处理、落盘、放锁见 app/shutdown.js
  installShutdown({ logger, store, ws, stream, stores, lock, timers });

  // #endregion


  // #region 配置热重载（装配全部完成之后才开始监听）

  // 上一次生效的**全局**角色名 —— 只用于日志（"全局角色切了"是一条有用的信号）。
  let lastRole = String(bootConfig.role?.current ?? '');

  // 每个会话**当前住在哪个角色桶里**（`sessions.json` 里 active 的那一桶）。
  //
  // ── 为什么需要这份快照
  //
  // 会话键可以同时挂几张卡（切过人设的群，旧卡那桶还留着）。所以"生效角色变了"
  // 不能用"roleFor(key) ≠ 某个桶"来判 —— 那样每次重载都会把**所有历史人格桶**
  // 判成"过期"，并对早已结束的会话反复发 cancel。必须比较**变更前后**的 active 角色。
  const activeRoleOf = new Map();
  for (const key of sessionMap.keys()) {
    const sessionId = sessionMap.get(key);
    if (!sessionId) continue;
    activeRoleOf.set(key, { role: sessionMap.activeRoleOf(key), sessionId });
  }
  // 新建会话时同步（那时才确定它落在哪个桶）。
  deliverer.on('session-created', ({ key, sessionId }) => {
    activeRoleOf.set(key, { role: roleStore.nameFor(key), sessionId });
  });

  // 谁的人设变了，就停掉它在**旧人格会话**里正在跑的回合。
  //
  // 为什么要停：DSH 会话里的 assistant 历史是"她说过的话"，拿旧会话换新角色
  // 出来的是"新皮的旧人"（见 turn/adapter.js 文件头）。停掉之后下一次投递时
  // `SessionMap.get(key)` 找不到新角色的桶 → 自然会新建一个干净的会话，
  // 而旧桶原样保留（以后换回去还能接上历史）。
  //
  // ⚠️ 判据是**逐会话**的 `roleStore.nameFor(key)`，不是全局 `role.current`：
  //    改了群 A 的覆盖不该掐掉群 B 正在跑的回合。
  const reconcileRoles = (why) => {
    const stale = [];
    for (const [key, entry] of activeRoleOf) {
      const live = roleStore.nameFor(key);
      if (live === entry.role) continue;
      stale.push({ key, ...entry, live });
    }
    if (!stale.length) return;

    logger.info('生效角色已变更，停掉旧角色名下的回合', { why, count: stale.length });
    for (const { key, role, sessionId, live } of stale) {
      logger.info('切换角色', { conv: key, from: role || '(无)', to: live || '(无)' });
      activeRoleOf.delete(key);
      if (!sessionId) continue;
      void host.cancel({ sessionId }).catch((error) => {
        logger.debug('取消旧角色回合失败（可能已经结束）', { key, sessionId, error: String(error) });
      });
      const conv = registry.conversations.get(key);
      conv?.cancelWait?.();
      conv?.setAgentRunning?.(false, 'role-changed');
    }
  };

  store.on('change', ({ config, reason }) => {
    try {
      logger.info('配置已热重载', { reason, revision: store.revision });
      logger.applyConfig(config);
      logEffectiveConfig(logger, config, { onReload: true });
      applyLiveConfig({ onebot: { http, ws }, registry, allow: allowView }, config, logger);

      const nextRole = String(config.role?.current ?? '');
      if (nextRole !== lastRole) {
        logger.info('全局角色已切换', { from: lastRole || '(无)', to: nextRole || '(无)' });
        lastRole = nextRole;
      }
      // 全局角色变了（或某会话的覆盖改了）→ 逐会话对账。
      reconcileRoles('config-change');
    } catch (error) {
      logger.error('应用热重载配置失败（可能只应用了一部分；下次保存会重跑全部小节）', {
        reason,
        error: error?.stack ?? String(error),
      });
    }
  });

  // 会话覆盖层单独变化（改 `config.sessions.json` / 控制台保存某个会话）。
  //
  // 主配置没变也要重跑一遍 `applyLiveConfig`：闸门与上下文条数都在状态机配置里，
  // 而每个会话的配置是**从覆盖层解析出来的**（见 registry.resolveFor）。
  store.on('sessions-change', ({ sessions: next, reason }) => {
    try {
      logger.info('会话覆盖已热重载', {
        reason, revision: next.revision, count: next.count, wildcard: Boolean(next.wildcard),
      });
      applyLiveConfig({ onebot: { http, ws }, registry, allow: allowView }, store.get(), logger);
      reconcileRoles('sessions-change');
      const masked = next.maskedEnvKeys();
      if (masked.length) {
        logger.warn('会话覆盖压过了环境变量/命令行项（会话级更具体，按设计优先）', { pairs: masked.join(', ') });
      }
    } catch (error) {
      logger.error('应用会话覆盖失败', { reason, error: error?.stack ?? String(error) });
    }
  });

  store.on('error', (errorOrErrors, meta = {}) => {
    const list = Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors];
    logger.error('配置重载失败，继续使用上一份可用配置', { reason: meta.reason });
    for (const err of list) logger.error(String(err));
  });

  store.on('watch-started', ({ dir, targets }) => logger.info('已开始监听配置变更', { dir, targets: targets.join(', ') }));
  store.on('watch-disabled', () => logger.warn('配置热重载已关闭（watch.enabled=false）'));

  store.startWatching();

  // 兜住"装配期间发生的保存"：watcher 那时还没起，那个事件永远不会来。
  // reload() 会与 store.current 比较，**没变就不 emit** —— 正常情况下这里什么都不发生。
  store.reload({ reason: 'post-boot' });

  // #endregion

  logger.info('就绪。等 QQ 消息触发投递。');
}

main().catch((error) => {
  process.stderr.write(`致命错误：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
