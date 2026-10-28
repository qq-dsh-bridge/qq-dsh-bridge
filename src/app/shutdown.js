// 退出路径。

export function installShutdown({ logger, store, ws, stream, stores, lock, timers }) {
  const shutdown = async (signal) => {
    logger.info('收到退出信号，正在停止', { signal });
    store.stopWatching();
    ws.close(1000, 'shutdown');
    stream.stop();
    // 后台重试之类的定时器：不清掉会拖住进程（也让退出后的日志继续刷）。
    for (const t of timers ?? []) clearTimeout(t);
    // 把内存里还没落盘的聊天记录写掉 —— 否则退出会丢掉最近 2 秒的消息。
    for (const s of stores.values()) {
      try {
        s.flushPending();
      } catch (error) {
        logger.warn('退出时落盘失败', { error: String(error) });
      }
    }
    lock?.release();
    await logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => lock?.release());
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常', { error: error?.stack ?? String(error) });
    lock?.release();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason: reason?.stack ?? String(reason) });
  });
}
