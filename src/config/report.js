// 配置的加载期报告：失败怎么说、生效了什么。
//
// 为什么单独一个文件：这些日志是**排查配置问题的唯一入口**，
// 而 `main.js` 里它们夹在组件装配中间，很容易在改动时被顺手改掉。

import { ConfigError } from './schema.js';

// 配置加载期抛错（文件读不了、JSON 语法错）时的报告。
export function reportConfigFailure(logger, error) {
  if (error instanceof ConfigError) {
    logger.error('配置无法加载，拒绝启动');
    logger.error(String(error));
    return;
  }
  logger.error('配置加载出现未预期错误', { error: error?.stack ?? String(error) });
}

// 打印一份**脱敏后**的生效配置摘要。
//
// 脱敏由 logger 负责（见 util/logger.js）—— 这里只挑该看的字段，
// 不打印任何 token 明文。
//
// @param options.onReload true = 这次是热重载后的，日志措辞不同
export function logEffectiveConfig(logger, config, { onReload = false } = {}) {
  const summary = {
    dshHostUrl: config.dsh.hostUrl,
    snowlumaWs: config.snowluma.wsUrl,
    ownerQq: config.owner.qq || '(未设置)',
    allowPrivate: config.allow.private.length,
    allowGroups: config.allow.groups.length,
    allowAllWhenEmpty: config.allow.allowAllWhenEmpty,
    watch: config.watch.enabled,
    logLevel: config.log.level,
    // 控制台只报「监听在哪」和「有没有密码」。
    //
    // ⚠️ **密码明文绝不能进日志**，哪怕只是一次。这里的取值方式就是
    // `password ? '已设置密码' : …` —— 别改成打印 config.console.password。
    consoleListen: `${config.console.host}:${config.console.port}`,
    consoleAuth: config.console.password ? '已设置密码' : '未设置（不鉴权）',
  };
  logger.info(onReload ? '生效配置（重载后）' : '生效配置', summary);

  if (config.allow.allowAllWhenEmpty && config.allow.private.length === 0 && config.allow.groups.length === 0) {
    logger.warn('高危：allowAllWhenEmpty=true 且 allow 列表为空 —— 会对所有人开放');
  }

  // 空密码 + 绑 0.0.0.0 = 把「改配置 / 读日志 / 看聊天记录」的入口开放给同网段。
  //
  // 这是**允许**的组合（不想登录就留空），但必须在启动日志里说清楚，
  // 否则用户不会知道自己的面板正在裸奔。
  if (!config.console.password) {
    logger.warn('控制台未设置密码（console.password 为空）—— 它会监听在 '
      + `${config.console.host}:${config.console.port}，同网络内任何人都能读写配置与日志`);
  }
}
