// 探活 —— 启动后立刻暴露"配错了"这类问题。
//
// 两个探活都**不致命**：失败只告警，进程继续跑 —— dsh / SnowLuma 可能晚于桥接启动，
// 而两边的鉴权都是**每次调用现做**，所以"起来之后不用重启本进程"。
// #region OneBot

// HTTP 侧探活：尽早暴露 token 配错（HTTP token 与 WS token 不同）。
export async function probeOneBotHttp(http, logger) {
  try {
    const login = await http.getLoginInfo();
    const status = await http.probeStatus();
    logger.info('OneBot HTTP 动作通道正常', {
      selfQq: login?.user_id,
      nickname: login?.nickname,
      online: status.online,
      good: status.good,
    });
  } catch (error) {
    logger.warn('OneBot HTTP 探活失败', { error: String(error) });
  }
}
// #endregion

// #region dsh（插件）
// `quiet` 给后台重试用：重试期间连不上是常态，只在最终放弃时告警。
export async function probeHost(host, logger, { quiet = false } = {}) {
  try {
    const r = await host.health();
    logger.info('dsh 插件（qq-dsh-host）正常', {
      version: r.version, protocol: r.protocol, sessions: r.sessions, agents: r.agents,
    });
    return true;
  } catch (error) {
    if (!quiet) logger.warn('dsh 插件探活失败', { error: String(error) });
    return false;
  }
}
// #endregion
