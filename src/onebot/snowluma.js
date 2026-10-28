// SnowLuma 端点与凭据发现。



import fs from 'node:fs';
import path from 'node:path';

// #region 错误

export class SnowLumaDiscoveryError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'SnowLumaDiscoveryError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

// #endregion

// #region 读取账号配置

// 从 SnowLuma 安装目录读出一个账号的 OneBot 连接信息。


function readSnowLumaConnection(homeDir, uin) {
  if (!homeDir) {
    throw new SnowLumaDiscoveryError('未提供 SnowLuma 安装目录');
  }
  const configDir = path.join(homeDir, 'config');
  if (!fs.existsSync(configDir)) {
    throw new SnowLumaDiscoveryError(
      `SnowLuma 配置目录不存在：${configDir}`,
      { hint: '确认 snowluma.homeDir 指向真正的 SnowLuma 安装目录（该目录下应有 config/ 与 launcher.bat）。' },
    );
  }

  const file = resolveOneBotConfigFile(configDir, uin);
  if (!file) {
    throw new SnowLumaDiscoveryError(
      `${configDir} 下找不到 onebot_<QQ号>.json`,
      { hint: 'SnowLuma 至少成功连接过一次 QQ 才会写出该文件。' },
    );
  }

  const raw = fs.readFileSync(file, 'utf8');
// 该文件可能带 UTF-8 BOM —— 读的时候要吃掉，写回时要保留。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SnowLumaDiscoveryError(`解析 ${file} 失败：${error.message}`);
  }

  const selfQq = extractUinFromFilename(path.basename(file));
  const httpServer = parsed?.networks?.httpServers?.[0];
  const wsServer = parsed?.networks?.wsServers?.[0];

  if (!httpServer && !wsServer) {
    throw new SnowLumaDiscoveryError(
      `${file} 里既没有 httpServers 也没有 wsServers`,
      { hint: '请在 SnowLuma WebUI 里至少启用一个 HTTP 与一个 WS 服务端。' },
    );
  }

  return {
    selfQq,
    configFile: file,
    http: httpServer
      ? {
        url: `http://${hostOf(httpServer.host)}:${httpServer.port}`,
        token: String(httpServer.accessToken ?? ''),
        name: String(httpServer.name ?? ''),
      }
      : null,
    ws: wsServer
      ? {
        url: `ws://${hostOf(wsServer.host)}:${wsServer.port}`,
        token: String(wsServer.accessToken ?? ''),
        name: String(wsServer.name ?? ''),
      }
      : null,
  };
}

// #endregion

// #region 工具函数

// 该账号的配置文件：只按 QQ 号精确匹配。

function resolveOneBotConfigFile(configDir, uin) {
  const id = String(uin ?? '').trim();
  if (!id) return null;
  const file = path.join(configDir, 'onebot_' + id + '.json');
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

function extractUinFromFilename(name) {
  const m = /^onebot_(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : 0;
}

// 监听地址 → 可连接的 host。
function hostOf(host) {
  const h = String(host ?? '').trim();
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h;
}

// #endregion

// #region 解析端点

// 从配置里解析出最终的 SnowLuma 连接参数。

export function resolveSnowLumaEndpoints(config, logger) {
  const snow = config.snowluma ?? {};
  const result = {
    http: { url: snow.httpUrl ?? 'http://127.0.0.1:3000', token: snow.accessToken ?? '' },
    ws: { url: snow.wsUrl ?? 'ws://127.0.0.1:3001', token: snow.accessToken ?? '' },
    selfQq: snow.selfQq ?? 0,
    source: 'config',
  };

  if (!snow.homeDir) return result;

  try {
    const discovered = readSnowLumaConnection(snow.homeDir, snow.selfQq || undefined);
    // 显式配置优先：只在用户没写 token 时用发现到的值。
    if (discovered.http) {
      if (!snow.httpUrl) result.http.url = discovered.http.url;
      if (!snow.accessToken) result.http.token = discovered.http.token;
    }
    if (discovered.ws && !snow.wsUrl) result.ws.url = discovered.ws.url;

    if (snow.wsToken) {
      result.ws.token = snow.wsToken;
    } else if (discovered.ws) {
      result.ws.token = discovered.ws.token;
    }
    result.source = 'discovered';
    result.configFile = discovered.configFile;

    if (discovered.http && discovered.ws && discovered.http.token !== discovered.ws.token) {
      logger?.debug('已分别取得 HTTP token 与 WS token（两者通常不同）', {
        selfQq: discovered.selfQq,
      });
    }
  } catch (error) {

    if (!snow.httpUrl || !snow.wsUrl) {
      throw new SnowLumaDiscoveryError(
        `找不到 snowluma.selfQq=${snow.selfQq} 对应的 OneBot 配置：${error.message}`,
        {
          hint: '确认这个号已在 SnowLuma 里登录并生成 config/onebot_<QQ号>.json；'
            + '或显式配置 snowluma.httpUrl / wsUrl / accessToken / wsToken。',
        },
      );
    }
    logger?.warn('从 SnowLuma 安装目录自动发现连接信息失败，改用配置中的端点', {
      homeDir: snow.homeDir,
      error: String(error),
    });
  }

  return result;
}

// #endregion
