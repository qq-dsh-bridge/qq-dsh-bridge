// 热重载：把能即时生效的配置应用到**运行中**的组件。
//
// ── 这一层现在只管"必须主动推"的东西
//
// 状态机配置、白名单、主人 QQ **都不再推**了：会话与两道闸门每次通过
// `config/facade.js` 现取（`facade.state(conv)` / `facade.allow()` /
// `facade.ownerQq()`），所以它们天然跟着热重载走，也不会再有
// "就地 Object.assign 还是换引用"两套语义并存的问题。
//
// 剩下的只有真正**持有连接状态**的组件：`http` / `ws` —— 地址或 token 变了要重连。
//
// ── 依赖怎么来
//
// `deps` 是调用方每次现拼的 `{ onebot: { http, ws } }`（见 main.js 的"配置热重载"一节）。
// 缺依赖直接抛，不做 `if (onebot)` 这类静默守卫：那会把"回调早于组件"的时序错误吃掉，
// 表现成"配置改了、日志说已热重载、运行时还是旧值"。
//
// ── 这里**没有**覆盖的东西（改配置前先看这一节）
//
// 下列项是"构造时快照进组件、之后没人再读"，因此**热重载不生效，要重启**：
//   · `dsh.hostUrl` / `dsh.hostTokenFile` → host-client 构造参数（令牌现读，地址不换）
//   · `dsh.agentPreset` → DshDeliverer 构造参数
//   · `chatlog.roleMaxChars` → RoleStore 构造参数
//   · `chatlog.root` / `chatlog.agentRoot` / `media.root` / `media.agentRoot`
//     / `api.port` / `console.port` → 路径映射与监听端口
//   · `watch.enabled` → 只在 `startWatching()` 里读过一次，运行中改成 false 不会停监听
//
// 其余都是即时生效的：`snowluma.*`（这里推给 http/ws）、`chatlog.*` 的状态机项、
// `allow.*`、`owner.qq`、`log.*`（`log.level` 由 Logger.applyConfig 吃）。
//
// ── 已知"改了也不起作用"的配置
//
// **当前为空**。下次再发现「改了没反应」的键就记在这里 —— 假旋钮是最难被发现
// 的配置故障：磁盘变了、日志说已热重载、运行时不理会。
import { resolveSnowLumaEndpoints } from '../onebot/snowluma.js';

// 热重载后把能即时生效的项应用到运行中的组件。
export function applyLiveConfig(deps, config, logger) {
  const { onebot } = deps ?? {};
  if (!onebot) throw new Error('applyLiveConfig 缺少依赖：onebot');
  const { http, ws } = onebot;
  if (!http || !ws) throw new Error('applyLiveConfig 的 onebot 需要同时给 http 与 ws');

  // 只读地报一下"现取的那份现在长什么样"，方便对照日志排查。
  const allow = config?.allow ?? {};
  logger.debug('状态机 / 白名单 / 主人 QQ 都是现取的，无需推送', {
    triggerWho: config?.chatlog?.triggerWho,
    windowWho: config?.chatlog?.windowWho,
    allowPrivate: allow.private?.length ?? 0,
    allowGroups: allow.groups?.length ?? 0,
    allowAllWhenEmpty: Boolean(allow.allowAllWhenEmpty),
    ownerQq: String(config?.owner?.qq ?? '') || '(未设置)',
  });

  // ── dsh 侧（插件）：不用在这里做任何事
  //
  // `dsh.hostUrl` / `dsh.hostTokenFile` 是 host-client 的构造参数 —— 令牌每次调用现读，
  // 地址是构造时定的，所以**改 hostUrl 要重启**（见上面的"要重启"清单）。

  // ── OneBot / SnowLuma 端点
  const snow = config.snowluma;
  // ⚠️ **必须和启动时走同一条取值路径**（resolveSnowLumaEndpoints）。
  //
  // token 的默认值是**空串**：直接读 `config.snowluma` 会把"启动时发现到的"真 token
  // 覆盖成 ''，桥接立刻失聪且失声。所以这里必须走同一条取值路径。
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
