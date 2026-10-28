// 热重载：把能即时生效的配置应用到**运行中**的组件。
//
// 为什么独立成模块：它是"哪些配置项改了就生效、哪些要重启"的**唯一清单**。
// 夹在 main.js 的装配代码里时，改配置语义的人不一定会看到它 —— 而这份清单
// 一旦和实际行为不符，就会变成"日志说生效了、运行时还是旧值"那类静默故障。
import { stateConfig } from '../config/state-view.js';
import { resolveSnowLumaEndpoints } from '../onebot/snowluma.js';

// 热重载后把能即时生效的项应用到运行中的组件。
//
// ── 依赖怎么来
//
// `deps` 是调用方**每次现拼**的对象：`{ onebot: { http, ws }, registry, allow }`
// （见 main.js 的"配置热重载"一节）。
//
// 三个引用**缺一不可**，因此这里不再用 `if (registry)` 这类存在性守卫 ——
// 那种守卫会把"回调早于组件"这个时序错误**静默吃掉**：配置改了、日志说已热重载、
// 运行时还是旧值，而各小节各自跳过，调用方完全看不出来（隔离测试里四个缺依赖的用例
// 全部"静默返回"）。现在缺依赖直接抛，由 main.js 那层的 try/catch 打出来。宁可响，不要静默。
//
// ── 这里**没有**覆盖的东西（改配置前先看这一节）
//
// 下列项是"构造时快照进组件、之后没人再读"，因此**热重载不生效，要重启**：
//   · `dsh.hostUrl` / `dsh.hostTokenFile` → host-client 构造参数（令牌现读，地址不换）
//   · `dsh.agentPreset` → DshDeliverer 构造参数
//   · `chatlog.roleMaxChars` → RoleStore 构造参数
//   · `chatlog.root` / `chatlog.agentRoot` / `media.root` / `media.agentRoot`
//     / `api.port` / `console.port` → 路径映射与监听端口
//     （映射只在启动时 `configurePathMap` / `configureMediaStore` 一次）
//   · `watch.enabled` → 只在 `startWatching()` 里读过一次，运行中改成 false
//     **不会**停掉已经开着的监听（想停只能重启）
//
// 其余都是即时生效的：`snowluma.*`、`chatlog.*` 的状态机项、
// `allow.*`、`owner.qq`、`log.*`（`log.level` 由 Logger.applyConfig 吃）。
//
// ── 已知"改了也不起作用"的配置
//
// **当前为空**。下次再发现「改了没反应」的键就记在这里 —— 假旋钮是最难被发现
// 的配置故障：磁盘变了、日志说已热重载、运行时不理会。
//
// ⚠️ 这一节**空着也要留着**：下次再发现"改了没反应"的键就记在这里。假旋钮是最难
//    被发现的配置故障 —— 磁盘变了、日志说已热重载、运行时不理会。
export function applyLiveConfig(deps, config, logger) {
  const { onebot, registry, allow } = deps;

  const missing = Object.entries({ onebot, registry, allow })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`applyLiveConfig 缺少依赖：${missing.join(', ')}`);

  const { http, ws } = onebot;

  // ── 状态机配置：**必须跟着热重载走**
  //
  // ── 为什么现在交给 `registry.applyConfig()`（2026-10-27 改成按会话解析）
  //
  // 引入会话覆盖层（`config.sessions.json`）之后，各会话的 `config` **不再保证是
  // 同一个引用**：群 A 可能 `triggerWho=owner`、群 B 是 `everyone`。
  // 所以"就地 Object.assign 到同一个对象"这条老路直接失效 —— 它只能更新一份。
  //
  // `applyConfig()` 里做的是：更新 registry 的基准配置 → **逐个会话重新解析**并赋值。
  // 没有覆盖层的部署解析结果仍是同一个对象，等价于旧行为；
  // 有覆盖层时每个会话拿到自己那份（由 `SessionOverrides.resolve()` memo 保证
  // "没变就返回同一引用"）。
  const next = stateConfig(config.chatlog);
  registry.applyConfig(next);
  const cur = registry.config;
  logger.debug('状态机配置已热更新', {
    windowWho: cur.window?.who,
    triggerWho: cur.trigger?.who,
    conversations: registry.conversations.size,
  });

  // ── 白名单**就地改**（出站 BridgeApi 与入站 dispatch 共用同一个对象）
  //
  // ⚠️ 必须 `Object.assign` 到**同一个对象**上 —— 换对象只有本函数能看到，
  //    BridgeApi 与 dispatch 持有的旧引用不会更新。
  Object.assign(allow, {
    private: [...config.allow.private],
    groups: [...config.allow.groups],
    allowAllWhenEmpty: config.allow.allowAllWhenEmpty,
  });
  logger.debug('白名单已热更新（入站与出站同时生效）', {
    allowPrivate: allow.private.length,
    allowGroups: allow.groups.length,
    allowAllWhenEmpty: allow.allowAllWhenEmpty,
  });

  // ── 主人 QQ **就地改**（第三个消费者，也是最容易漏的一处）
  //
  // 消费者是**调用时**读它：
  //   · `ConversationRegistry.ownerQq` → 每个 `ConversationState`（身份标签、
  //     `triggerWho` 闸门、给发言人行加「管理者」）
  //
  // ⚠️ 已经建出来的会话各自**复制**了 ownerQq（构造时传进去的），所以只改
  //    registry 的话老会话仍是旧值 —— 必须一起遍历改掉。这与上面 `config`
  //    那段是同一个道理、同一个做法。
  const prevOwner = String(registry.ownerQq ?? '');
  const nextOwner = String(config.owner.qq ?? '');
  if (prevOwner !== nextOwner) {
    registry.ownerQq = nextOwner;
    for (const conv of registry.conversations.values()) conv.ownerQq = nextOwner;
    logger.info('主人 QQ 已热更新（含已建会话）', {
      from: prevOwner, to: nextOwner, conversations: registry.conversations.size,
    });
  }

  // ── dsh 侧（插件）：不用在这里做任何事
  //
  // `dsh.hostUrl` / `dsh.hostTokenFile` 是 host-client 的构造参数 —— 令牌每次调用现读，
  // 地址是构造时定的，所以**改 hostUrl 要重启**（见文件头的"要重启"清单）。

  // ── OneBot / SnowLuma 端点
  const snow = config.snowluma;
  // ⚠️ **必须和启动时走同一条取值路径**（resolveSnowLumaEndpoints）。
  //
  // token 的默认值是**空串**：直接读 `config.snowluma` 会把"启动时发现到的"真 token
  // 覆盖成 ''，桥接立刻失聪且失声。所以这里必须走同一条取值路径。
  //
  // 发现逻辑自带优先级（显式配置 > 从 SnowLuma 目录发现 > 兜底），
  // 这里复用它，两条路径在结构上就不可能再分叉。
  const ep = resolveSnowLumaEndpoints(config, logger);

  http.applyConfig({
    httpUrl: ep.http.url,
    accessToken: ep.http.token,
    timeoutMs: snow.actionTimeoutMs,
  });

  // WS 的 applyConfig 内部会比对地址/token，**真变了**才重连。
  ws.applyConfig({
    wsUrl: ep.ws.url,
    accessToken: ep.ws.token,
    heartbeatMs: snow.heartbeatMs,
    heartbeatTimeoutMs: snow.heartbeatTimeoutMs,
    connectTimeoutMs: snow.connectTimeoutMs,
  });

  // 重连退避参数不需要重连，直接改。
  ws.reconnectMinMs = snow.reconnectMinMs;
  ws.reconnectMaxMs = snow.reconnectMaxMs;

  logger.info('OneBot 配置已应用', {
    httpUrl: ep.http.url,
    wsUrl: ep.ws.url,
    heartbeatMs: snow.heartbeatMs,
    tokenSource: ep.source,
  });
}
