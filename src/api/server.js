// 桥接的 HTTP API 


import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { serveMedia } from './media-route.js';
import { BridgeApiError } from './errors.js';
import { OPS } from './handlers/index.js';


// 请求体上限（字符）。
//
// 4 MB 只够 base64 图片；**大文件不走 JSON/base64** —— 以后加流式上传
// （`POST /media` 裸流）时单独限，不要把视频塞进工具参数。
const MAX_BODY_CHARS = 4 * 1024 * 1024;


function countSendChars(args) {
  if (!args || typeof args !== 'object') return 0;

  // 一个 segment 或 message 元素贡献的正文字数。
  const ofOne = (item) => {
    if (!item || typeof item !== 'object') return 0;
    let n = 0;
    // 属性式：{ text: "…", at, reply, … }
    if (typeof item.text === 'string') n += item.text.length;
    // segments 式：{ segments: [ {text}, {at}, … ] }
    if (Array.isArray(item.segments)) {
      for (const seg of item.segments) {
        if (seg && typeof seg.text === 'string') n += seg.text.length;
      }
    }
    return n;
  };

  // messages 式（主用法）
  if (Array.isArray(args.messages)) {
    return args.messages.reduce((a, m) => a + ofOne(m), 0);
  }
  // 快捷式
  return ofOne(args);
}

// 聊天记录 API。
//
// 只读为主；唯一的写操作是"显式标记已读"（由 AI 指定，见 query.js）。
// 发消息**不在这里** —— 那走桥接的发送路径（含白名单与去重）。
export class BridgeApi {

  constructor({ storeFor, allow, logger, hostTokenFile = '', media = null } = {}) {
    this.storeFor = storeFor;
    this.allow = allow ?? { private: [], groups: [], allowAllWhenEmpty: false };
    this.logger = logger;
    this.hostTokenFile = hostTokenFile;
    // 统一媒体仓库（图片/语音/视频/文件）—— `GET /m/<id>` 从这里取。
    this.media = media;
  }

  // 请求头里的宿主令牌是否匹配（常量时间比较）。每次现读，轮换令牌不用重启。
  #hostMatches(host) {
    if (!this.hostTokenFile || !host) return false;
    let want = '';
    try {
      want = fs.readFileSync(this.hostTokenFile, 'utf8').trim();
    } catch {
      return false;
    }
    if (!want) return false;
    const a = Buffer.from(String(host));
    const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // 校验调用方与 key。
  //
  // @returns 归一后的 convKey
  // @throws BridgeApiError
  authenticate(key, host) {
    if (!key) throw new BridgeApiError('缺少 key 参数', { status: 401, code: 'missing-key' });

    // key 形状先做一次粗校验：它是"操作哪个会话"的唯一声明，
    // 写错了必须当场说清，别让它变成后面"会话不存在"那种含糊报错。
    if (!/^(group|private):\d+$/.test(String(key))) {
      throw new BridgeApiError(
        `key 格式不对："${key}"。必须是 group:<群号> 或 private:<QQ号>，`
        + '全数字，带前缀，例如 group:1234567890。',
        { status: 401, code: 'bad-key-format' },
      );
    }

    if (!this.#hostMatches(host)) {
      throw new BridgeApiError(
        `缺少或错误的宿主令牌（请求头 x-qq-host）。令牌读自 ${this.hostTokenFile || 'state/host-token'}，`
        + '桥接与调用方必须用同一个文件。',
        { status: 401, code: 'bad-host-token' },
      );
    }
    return key;
  }

  // 目标是否在白名单内（发送类操作必须过）。
  //
  // fail-closed：列表为空且没开 allowAllWhenEmpty ⇒ 一律拒绝。
  assertAllowed(convKey) {
    const [kind, id] = String(convKey).split(':');
    const list = kind === 'group' ? this.allow.groups : this.allow.private;
    const inList = Array.isArray(list) && list.map(String).includes(String(id));
    if (inList) return;

    if (this.allow.allowAllWhenEmpty && (!this.allow.groups?.length && !this.allow.private?.length)) {
      return;
    }
    throw new BridgeApiError(
      `目标 ${convKey} 不在白名单内`,
      { status: 403, code: 'not-allowed' },
    );
  }

  // ---------------------------------------------------------------- 路由

  async call(op, args = {}, meta = {}) {
    const spec = OPS.get(op);
    if (!spec) {
      throw new BridgeApiError(`未知操作 "${op}"`, { status: 404, code: 'unknown-op' });
    }

    const key = spec.authFree ? '' : this.authenticate(args.key, meta.host);

    const handler = this.handlers?.[op];
    if (!handler) {
      throw new BridgeApiError(
        `操作 "${op}" 尚未接入（桥接未提供该能力）`,
        { status: 501, code: 'not-implemented' },
      );
    }


    if (spec.needsAllow) this.assertAllowed(key);


    if (spec.authFree) {
      if (!spec.warnOnError) return handler(key, args);
      try {
        return await handler(key, args);
      } catch (error) {
        this.logger?.warn(spec.warnOnError, {
          key,
          url: String(args?.url ?? '').slice(0, 80),
          error: String(error),
        });
        throw error;
      }
    }

    // 只读查询类（unread / readChat）：既不写东西，也不留发送日志。
    if (!spec.logsAsSend) return handler(key, args);

    // 预演（`qq_send` 的 dryRun）：一条都没发。留"发送请求/完成"的痕迹会骗人 ——
    // 排查时会以为群里真收到过（见 handlers/write/send.js 文件头）。
    if (args?.dryRun === true) return handler(key, args);

    const t0 = Date.now();
    // `chars` 的口径、以及"为什么不能只读 args.text"的踩坑记录，
    // 都在 countSendChars 的说明里 —— 这里不再复述一遍（两处写同一件事会互相打架）。
    this.logger?.debug('工具面收到发送请求', { op, key, chars: countSendChars(args) });
    try {
      const out = await handler(key, args);
      this.logger?.debug('工具面发送完成', { op, key, ms: Date.now() - t0 });
      return out;
    } catch (error) {
      // 失败**必须是 WARN** —— 它意味着群里没人看到回复。
      this.logger?.warn('工具面发送失败', { op, key, ms: Date.now() - t0, error: String(error) });
      throw error;
    }
  }

  // 注册需要运行时能力的操作（由 main.js 注入）。
  registerHandlers(handlers) {
    this.handlers = { ...(this.handlers ?? {}), ...handlers };
    return this;
  }
}

// 起一个极小的 HTTP 服务（只监听回环）。
export function startBridgeApiServer({ api, port, host = '127.0.0.1', logger }) {
  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '只接受本机回环连接' }));
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/m\//.test(req.url ?? '')) {
      if (!api.media) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('媒体仓库未初始化');
        return;
      }
      serveMedia(req, res, { store: api.media, urlPath: req.url });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/api') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_CHARS) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: `请求体过大（${body.length} 字符，上限 ${MAX_BODY_CHARS}）。`
            + 'base64 只适合小图；大文件以后走流式上传，不要塞进工具参数。',
        }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body 不是合法 JSON' }));
        return;
      }

      try {
        const result = await api.call(payload.op, payload.args ?? {}, {
          host: req.headers['x-qq-host'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        const status = error instanceof BridgeApiError ? error.status : 500;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error?.message ?? String(error),
          code: error instanceof BridgeApiError ? error.code : 'internal',
        }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger?.info('桥接 API 已监听', { url: `http://${host}:${port}/api` });
      resolve(server);
    });
  });
}
