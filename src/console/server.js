// 控制台后端 —— 给浏览器用的 API。
//
// 与工具面 API（:3110）不共用鉴权：那边只认宿主令牌（`state/host-token`，
// 调用方是 dsh 里的 qq-dsh-tools 插件），这边是**一个密码**（能看全部会话、改配置、
// 看日志、编人格卡）。AI 拿到的只是"能读一个群"，不该因此能改全局配置。
//
// 鉴权：`console.password` 非空 ⇒ 除 `POST /api/login` 与 `GET /api/session` 外都要会话 Cookie；
// 密码为空 ⇒ 登录禁用、`/api/*` 全部放行（允许，但启动时会 WARN —— 默认绑 0.0.0.0）。
//
// ⚠️ **密码是唯一防线**：没有回环绑定、没有 Origin 校验、没有额外头校验 ——
//    它们解决的是"没密码时防第三方页面改配置"，与密码重复，且与 0.0.0.0 +
//    局域网 IP 访问冲突。Cookie 是 SameSite=Lax（跨站 POST 不带）；同网段
//    可以直接试密码，失败 5 次锁 5 分钟。


import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  checkConfig, writeConfigFile, readConfigForConsole, mergeChangedOnly,
} from '../config/write.js';
import { SESSION_OVERRIDABLE } from '../config/schema.js';
import {
  readRoleContent, writeRoleContent, validateRoleName, selectRoleText,
} from '../prompt/role.js';

// 静态资源白名单。
//
// ⚠️ **必须是白名单**：若把 URL 直接拼进路径，`GET /../../.credentials.yaml`
// 就能读走 DSH 凭据。这里只有固定几个名字，拼不出目录穿越。
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/console.js', ['console.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// 会话 Cookie 名。改动它等于让所有人重新登录一次。
export const SESSION_COOKIE = 'qqbridge_console';

// 会话绝对有效期：12 小时（不做滑动续期 —— 简单、可预期）。
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 连续失败多少次开始锁。
const MAX_ATTEMPTS = 5;

// 锁多久。
const LOCKOUT_MS = 5 * 60 * 1000;

export class ConsoleError extends Error {
  constructor(message, { status = 400, code = '', errors = [] } = {}) {
    super(message);
    this.name = 'ConsoleError';
    this.status = status;
    this.code = code;
    // 字段级错误列表（校验失败的明细）。
    //
    // 必须显式接收并带到响应里 —— 前端要靠它显示"哪一项错了"。
// （errors 被静默丢掉时，前端只看到一句"配置校验未通过"，用户无从知道错在哪。）
    this.errors = errors;
  }
}

// 控制台。
//
// @param options.staticRoot   `public/console` 目录（前端三件套）
// @param options.configFile    config.json 路径
// @param options.getEffective  `() => 当前生效配置`（密码、端口都从它读）
// @param options.getRuntime    `() => 运行时快照`（会话状态、统计）
// @param options.getLogTail    `(n) => 日志尾部`
// @param options.onConfigSaved `(config) => void` 写完通知外层（可选）
// @param options.roleStore     人格卡仓库（可空 —— 没有它只是没有人格页）
// @param options.overrides     **会话覆盖层**（config/sessions.js，可空）。
//                              注意字段名不能叫 `sessions` —— 那个名字已经被
//                              "登录会话 Map"占了（见构造函数下方），撞名会让
//                              `this.sessions` 被覆盖成配置对象，登录直接错乱。
// @param options.logger
export class ConsoleServer {
  constructor({
    staticRoot,
    configFile,
    getEffective,
    getRuntime,
    getLogTail,
    onConfigSaved,
    roleStore,
    overrides,
    // `(info) => void` 会话覆盖被控制台改完之后通告外层（可选）。
    // 外层据此重发 `sessions-change` → `reconcileRoles()`。
    onSessionsChanged,
    logger,
  } = {}) {
    this.staticRoot = staticRoot
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'console');
    this.configFile = configFile;
    this.getEffective = getEffective ?? (() => ({}));
    this.getRuntime = getRuntime ?? (() => ({}));
    this.getLogTail = getLogTail ?? (() => []);
    this.onConfigSaved = onConfigSaved;
    // 人格卡仓库（可空 —— 没有它只是没有人格页签）。
    this.roleStore = roleStore ?? null;
    // 会话覆盖层（可空 —— 没有它只是没有"会话配置"页签）。
    this.overrides = overrides ?? null;
    this.onSessionsChanged = typeof onSessionsChanged === 'function' ? onSessionsChanged : null;
    this.logger = logger;

    // 会话：token → { expiresAt }。只存内存 —— 重启即全部失效，这是有意的。
    this.sessions = new Map();
    // 登录失败计数：来源 IP → { count, resetAt }。
    this.attempts = new Map();
    // 上一次见到的密码。
    //
    // 用途：热重载改了密码 ⇒ 旧会话必须立刻作废（否则改了密码等于没改）。
    // `null` 表示"还没同步过"，不能当成"密码为空"。
    this.passwordSeen = null;
  }

  // ---------------------------------------------------------------- 鉴权

  #password() {
    return String(this.getEffective()?.console?.password ?? '');
  }

  // 把会话与当前密码对齐。
  //
  // 每个请求都跑一次（读的是内存里的生效配置，代价可忽略）—— 这样热重载
  // 改密码后，**下一个请求**就生效，不需要重启，也不需要额外的钩子。
  #syncPassword() {
    const current = this.#password();
    if (this.passwordSeen === current) return;
    if (this.passwordSeen !== null) {
      const dropped = this.sessions.size;
      this.sessions.clear();
      this.attempts.clear();
      if (dropped > 0) {
        this.logger?.warn('控制台密码已变更，全部登录会话已失效', { sessions: dropped });
      }
    }
    this.passwordSeen = current;
  }

  // 是否需要登录。
  #required() {
    this.#syncPassword();
    return this.passwordSeen !== '';
  }

  // 这个请求是否已经通过鉴权。
  #authed(req) {
    if (!this.#required()) return true;
    const token = readCookie(req.headers?.cookie, SESSION_COOKIE);
    if (!token) return false;
    const info = this.sessions.get(token);
    if (!info) return false;
    if (Date.now() >= info.expiresAt) {
      this.sessions.delete(token);   // 惰性清理：没有定时器
      return false;
    }
    return true;
  }

  // 锁定期还剩多少毫秒；0 = 没锁。
  #lockLeft(ip, now) {
    const rec = this.attempts.get(ip);
    if (!rec) return 0;
    if (now >= rec.resetAt) {
      this.attempts.delete(ip);
      return 0;
    }
    return rec.count >= MAX_ATTEMPTS ? rec.resetAt - now : 0;
  }

  // 登录。
  //
  // 失败计数按**来源 IP**，不是全局：家里两个人同时输错不该互相拖累。
  // 密码比较用等长摘要做常量时间比较（原文长度会泄露信息，`timingSafeEqual`
  // 又要求两段等长，所以两边都先过 sha256）。
  #login(req, body) {
    const now = Date.now();
    const ip = req.socket?.remoteAddress ?? 'unknown';

    if (!this.#required()) {
      return json(200, { ok: true, result: { ok: true, note: '未设置密码，登录已禁用' } });
    }

    const locked = this.#lockLeft(ip, now);
    if (locked > 0) {
      const sec = Math.ceil(locked / 1000);
      return json(429, {
        ok: false,
        error: `登录失败次数过多，请 ${sec} 秒后再试`,
        code: 'locked',
        retryAfterSec: sec,
      }, { 'retry-after': String(sec) });
    }

    let submitted = '';
    try {
      const parsed = JSON.parse(body || '{}');
      submitted = typeof parsed?.password === 'string' ? parsed.password : '';
    } catch {
      submitted = '';
    }

    if (!sameSecret(submitted, this.#password())) {
      const rec = this.attempts.get(ip) ?? { count: 0, resetAt: now + LOCKOUT_MS };
      rec.count += 1;
      rec.resetAt = now + LOCKOUT_MS;
      this.attempts.set(ip, rec);
      const left = MAX_ATTEMPTS - rec.count;
      return json(401, {
        ok: false,
        error: left > 0
          ? `密码不正确（再错 ${left} 次将锁定 ${LOCKOUT_MS / 60000} 分钟）`
          : `密码不正确，已锁定 ${LOCKOUT_MS / 60000} 分钟`,
        code: 'bad-password',
        attemptsLeft: Math.max(0, left),
      });
    }

    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { expiresAt: now + SESSION_TTL_MS });
    return json(200, { ok: true, result: { ok: true } }, {
      'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
    });
  }

  #logout(req) {
    const token = readCookie(req.headers?.cookie, SESSION_COOKIE);
    if (token) this.sessions.delete(token);
    return json(200, { ok: true, result: { ok: true } }, {
      'set-cookie': sessionCookie('', 0),
    });
  }

  // ---------------------------------------------------------------- 静态资源

  // 读一份静态资源。白名单保证不会目录穿越。
  //
  // `no-store`：控制台是"改完刷新即可"的开发面板，缓存只会帮倒忙。
  #static(pathname) {
    const hit = STATIC.get(pathname);
    if (!hit) return null;
    const [file, type] = hit;
    try {
      return {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'no-store' },
        body: fs.readFileSync(path.join(this.staticRoot, file), 'utf8'),
      };
    } catch (error) {
      // 读不到要说清缺的是哪个文件 —— 否则浏览器里只有一片空白。
      return {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: `读不到 ${file}：${String(error.message)}\n（期望位置：${this.staticRoot}）`,
      };
    }
  }

  // ---------------------------------------------------------------- 入口

  // 处理一次控制台请求。
  //
  // @param req  `{ method, url, headers, socket }`（由 startConsoleServer 传来）
  // @param body 原始请求体
  // @returns `{ status, headers, body }`
  async handle(req, body) {
    const url = new URL(req.url ?? '/', 'http://console.invalid');
    const p = url.pathname;

    // 静态资源（`GET /` 就是首页）。**不需要登录** —— 登录页本身就是它，
    // 而三个前端文件里没有任何业务数据。
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = this.#static(p);
      if (file) return file;
    }

    // 未登录探针：前端首屏靠它决定"渲染登录页"还是"拉数据"。
    //
    // 它必须免鉴权（否则前端无法区分"没登录"和"密码没配"），
    // 所以只回两个布尔值，不碰任何业务数据。
    if (p === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
      const required = this.#required();
      return json(200, { ok: true, result: { required, authed: !required || this.#authed(req) } });
    }

    if (p === '/api/login' && req.method === 'POST') return this.#login(req, body);

    // 登出允许未登录调用（幂等：清掉 Cookie 就行，不必先登录）。
    if (p === '/api/logout' && req.method === 'POST') return this.#logout(req);

    if (!this.#authed(req)) {
      return json(401, {
        ok: false,
        error: '需要登录后才能访问控制台 API',
        code: 'unauthorized',
      });
    }

    try {
      const result = await this.#route(req.method, p, body, url);
      return json(200, { ok: true, result });
    } catch (error) {
      const status = error instanceof ConsoleError ? error.status : 500;
      return json(status, {
        ok: false,
        error: error?.message ?? String(error),
        code: error instanceof ConsoleError ? error.code : 'internal',
        errors: error?.errors ?? undefined,
      });
    }
  }

  async #route(method, pathname, body, url) {
    // GET
    if (method === 'GET') {
      switch (pathname) {
        case '/api/state':
          return {
            effective: redactEffective(this.getEffective()),
            // 磁盘配置也打码 —— 前端不需要明文，编辑器拿占位符就够（保存时服务端还原）。
            file: redactFileConfig(readConfigForConsole({ file: this.configFile })),
            runtime: this.getRuntime(),
          };
        case '/api/logs':
          return { lines: this.getLogTail(200) };
        case '/api/roles':
          return this.#listRoles();
        case '/api/sessions':
          return this.#listSessions();
        case '/api/role': {
          // 读单张卡的**原始文件内容**（编辑器要原文，不是筛完的注入文本）。
          const name = url.searchParams.get('name') ?? '';
          try {
            return { name, content: readRoleContent({ dir: this.#requireRoles().dir, name }) };
          } catch (e) {
            throw new ConsoleError(String(e.message ?? e), { status: 404, code: 'no-role' });
          }
        }
        default:
          throw new ConsoleError(`未知路径 ${pathname}`, { status: 404, code: 'not-found' });
      }
    }

    // POST
    if (method === 'POST') {
      if (pathname === '/api/config/check') {
        const candidate = this.#restoreCandidate(parseBody(body));
        return checkConfig(candidate, { current: this.getEffective() });
      }
      if (pathname === '/api/config/save') {
        return this.#save(body);
      }
      if (pathname === '/api/roles/select') {
        return this.#selectRole(body);
      }
      if (pathname === '/api/roles/clear') {
        this.roleStore?.clear();
        return { current: '' };
      }
      if (pathname === '/api/roles/save') {
        return this.#saveRole(body);
      }
      if (pathname === '/api/roles/create') {
        return this.#createRole(body);
      }
      if (pathname === '/api/roles/preview') {
        return this.#previewRole(body);
      }
      if (pathname === '/api/sessions/save') {
        return this.#saveSession(body);
      }
      if (pathname === '/api/sessions/clear') {
        return this.#clearSession(body);
      }
      if (pathname === '/api/sessions/unset') {
        return this.#unsetSession(body);
      }
      throw new ConsoleError(`未知路径 ${pathname}`, { status: 404, code: 'not-found' });
    }

    throw new ConsoleError(`不支持的方法 ${method}`, { status: 405, code: 'bad-method' });
  }

  // ---------------------------------------------------------------- 人格卡

  #requireRoles() {
    if (!this.roleStore) {
      throw new ConsoleError('人格卡功能不可用（未挂载 roleStore）', { status: 503, code: 'no-roles' });
    }
    return this.roleStore;
  }

  // 列出所有角色卡，并**预先算好各自的实际注入字符数**。
  //
  // 为什么要预先算：人格卡每条消息都注入，超出上限会被截断 ——
  // 用户必须能直接看到"这张卡实际会注入多少"，而不是自己数。
  #listRoles() {
    const store = this.#requireRoles();
    const max = store.maxChars;
    const names = store.list();

    const roles = names.map((name) => {
      let chars = 0;
      let truncated = false;
      let error = '';
      try {
        const content = readRoleContent({ dir: store.dir, name });
        const sel = selectRoleText({ content, maxChars: max });
        chars = sel.chars;
        truncated = sel.truncated;
      } catch (e) {
        error = String(e.message ?? e);
      }
      return { name, chars, truncated, over: chars >= max, error };
    });

    return { current: store.name, maxChars: max, dir: store.dir, roles };
  }

  // ---------------------------------------------------------------- 会话配置

  // 会话覆盖层的全貌（给"会话配置"页签）。
  //
  // 返回的都是**字段名**，不含值 —— 页面需要的是"哪些群配了什么"的索引，
  // 具体值在按会话取详情时才回（`/api/sessions` 里带 `patches`）。
  #requireOverrides() {
    if (!this.overrides) {
      throw new ConsoleError('会话配置功能不可用（未挂载覆盖层）', { status: 503, code: 'no-overrides' });
    }
    return this.overrides;
  }

  #listSessions() {
    const ov = this.#requireOverrides();

    // 白名单里的会话（config.json 的 `allow.groups` / `allow.private`）。
    //
    // 页面拿它当**下拉选项**用 —— 否则每配一个会话都得手工敲 `group:<群号>`，
    // 而那串数字本来就已经在 config.json 里写着了。数字校验放在这里做：
    // 白名单里混进非数字时不渲染成选项（它本来也匹配不上 `CONV_KEY_RE`）。
    const allow = readConfigForConsole({ file: this.configFile })?.value?.allow ?? {};
    const asConversations = (list, kind) => (Array.isArray(list) ? list : [])
      .map((id) => String(id ?? '').trim())
      .filter((id) => /^\d+$/.test(id))
      .map((id) => ({
        key: `${kind}:${id}`,
        kind,
        id,
        label: kind === 'group' ? `群 ${id}` : `私聊 ${id}`,
        hasOverride: Object.keys(ov.patchFor(`${kind}:${id}`) ?? {}).length > 0,
      }));
    const conversations = [
      ...asConversations(allow.groups, 'group'),
      ...asConversations(allow.private, 'private'),
    ];
    const allowed = new Set(conversations.map((one) => one.key));

    const keys = ov.keys().map((key) => ({
      key,
      // 这个会话**此刻**用的角色（覆盖优先、否则全局）—— 页面直接显示，
      // 省得用户自己去比对两张卡。
      role: this.roleStore?.nameFor?.(key) ?? '',
      fields: ov.describe(key),
      patch: ov.patchFor(key) ?? {},
      // 不在白名单里的覆盖照样要能编辑（可能是手动写的、或后来被移出白名单）。
      inAllow: key === '*' ? null : allowed.has(key),
    }));
    return {
      file: ov.file,
      found: ov.found,
      count: ov.count,
      wildcard: ov.wildcard
        ? { fields: ov.describe('*'), patch: ov.patchFor('*') }
        : null,
      // 解析失败时（热重载保留了上一份可用覆盖层）把错误带回前端。
      errors: (ov.errors ?? []).map(String),
      // 可覆盖的白名单 —— 前端据此渲染表单，**不在前端硬编码一份**。
      overridable: SESSION_OVERRIDABLE,
      // 当前全局值，页面拿来当"继承自"的占位提示。
      global: {
        role: String(this.getEffective()?.role?.current ?? ''),
        chatlog: this.getEffective()?.chatlog ?? {},
        decide: this.getEffective()?.decide ?? {},
      },
      // 白名单会话（下拉选项）+ 已配覆盖的键（表格行）。
      conversations,
      keys,
    };
  }

  // 控制台改完会话覆盖 → 通告外层。
  //
  // ⚠️ 这一步**不能靠文件 watcher 兜**：控制台是直接改的 `SessionOverrides` 实例，
  //    内存与文件当场就一致了；watcher 之后重读会判定"没变化"，`sessions-change`
  //    压根不会发。而 `reconcileRoles()` 只挂在那条事件上 —— 不发，旧角色名下正在
  //    跑的回合就没人停，群里最后收到的仍是旧角色的回复（实测踩过）。
  //
  // 回调抛错不该让"已经写成功"的保存报失败，所以这里吞掉并记日志。
  #announceSessions(action, key) {
    if (!this.onSessionsChanged) return;
    try {
      this.onSessionsChanged({ action, key });
    } catch (error) {
      this.logger?.error('会话覆盖已写入，但通告外层失败（角色对账可能滞后）', {
        action, key, error: String(error?.message ?? error),
      });
    }
  }

  #saveSession(body) {
    const ov = this.#requireOverrides();
    const { key, patch } = parseBody(body);
    if (typeof key !== 'string' || key === '') {
      throw new ConsoleError('缺少会话键 key（"*" / "group:<群号>" / "private:<QQ号>"）', { status: 400, code: 'missing-key' });
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ConsoleError('patch 必须是对象（例：{"role":{"current":"<角色名>"}}）', { status: 400, code: 'bad-patch' });
    }
    try {
      const r = ov.set(key, patch);
      this.logger?.info('控制台写入会话覆盖', { key, fields: ov.describe(key).join(', ') });
      this.#announceSessions('save', key);
      return { key, fields: ov.describe(key) };
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), {
        status: 400,
        code: 'bad-override',
        errors: (e.errors ?? []).map(String),
      });
    }
  }

  #clearSession(body) {
    const ov = this.#requireOverrides();
    const { key } = parseBody(body);
    if (typeof key !== 'string' || key === '') {
      throw new ConsoleError('缺少会话键 key', { status: 400, code: 'missing-key' });
    }
    try {
      const r = ov.clear(key);
      this.logger?.info('控制台清除会话覆盖（恢复默认）', { key });
      this.#announceSessions('clear', key);
      return { key };
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), {
        status: 400,
        code: 'bad-override',
        errors: (e.errors ?? []).map(String),
      });
    }
  }

  #unsetSession(body) {
    const ov = this.#requireOverrides();
    const { key, path: field } = parseBody(body);
    if (typeof key !== 'string' || key === '') {
      throw new ConsoleError('缺少会话键 key', { status: 400, code: 'missing-key' });
    }
    if (typeof field !== 'string' || field === '') {
      throw new ConsoleError('缺少字段路径 path（例：chatlog.triggerWho）', { status: 400, code: 'missing-path' });
    }
    try {
      const r = ov.unset(key, field);
      this.logger?.info('控制台取消单个会话覆盖项', { key, field });
      this.#announceSessions('unset', key);
      return { key, path: field, fields: ov.describe(key) || [] };
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), {
        status: 400,
        code: 'bad-override',
        errors: (e.errors ?? []).map(String),
      });
    }
  }

  #selectRole(body) {
    const store = this.#requireRoles();
    const { name } = parseBody(body);
    if (!name) throw new ConsoleError('缺少 name', { status: 400, code: 'missing-name' });
    try {
      const role = store.set(name);
      return { current: role };
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), { status: 400, code: 'bad-role' });
    }
  }

  #saveRole(body) {
    const store = this.#requireRoles();
    const { name, content } = parseBody(body);
    if (!name) throw new ConsoleError('缺少 name', { status: 400, code: 'missing-name' });
    if (typeof content !== 'string') {
      throw new ConsoleError('content 必须是字符串', { status: 400, code: 'bad-content' });
    }
    try {
      const r = writeRoleContent({ dir: store.dir, name, content });
      // 保存后如果正是当前角色，立即回显新的注入字数。
      //
      // ⚠️ maxChars 必须一起返回：前端拿它拼 "实际注入 N / M 字符"。
      // ⚠️ maxChars 必须一起返回：前端拿它拼 "实际注入 N / M 字符"。漏了就会
      //    显示成 "实际注入 4123 / undefined 字符"。
      const sel = selectRoleText({ content, maxChars: store.maxChars });
      return {
        file: r.file,
        bytes: r.bytes,
        chars: sel.chars,
        truncated: sel.truncated,
        maxChars: store.maxChars,
      };
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), { status: 400, code: 'bad-role' });
    }
  }

  #createRole(body) {
    const store = this.#requireRoles();
    const { name } = parseBody(body);
    if (!name) throw new ConsoleError('缺少 name', { status: 400, code: 'missing-name' });

    let safe;
    try {
      safe = validateRoleName(name);
    } catch (e) {
      throw new ConsoleError(String(e.message ?? e), { status: 400, code: 'bad-name' });
    }
    if (store.list().includes(safe)) {
      throw new ConsoleError(`角色「${safe}」已存在`, { status: 409, code: 'exists' });
    }

    // 给一个新卡模板：只写人设，不写工具用法（这是设计约束，模板要照做）。
    const template = `# 角色卡：${safe}

## 一、你是谁
- 身份、自我认知、别人怎么称呼你、你的雷点。

## 二、说话风格
- 句子长短、口头禅、标点习惯、用不用 emoji/颜文字。
- 明确写「不要什么」通常比写「要什么」更有效（例如：不要总结、不要升华、不要客服腔）。

## 三、性格与反应
- 被夸 / 被怼 / 被无视时分别怎么反应。

## 四、梗与背景（可选）
- 你的来历、和群友的关系、常用梗。

## 五、回复示例（示范语气与长度）
- 几条「群友说 → 你回」的例子。
- 例子只示范**语气和长度**，不要在这里规定分条机制（那是仿真层的事）。
`;
    writeRoleContent({ dir: store.dir, name: safe, content: template });
    return { name: safe, created: true };
  }

  // 预览：给一段内容，返回实际会被注入的文本与统计。
  //
  // 两条修正：
  //  · `content` 只要是字符串就用它（**包括空串**）—— 用户把文本域清空后点
  //    预览，想看的是"空的效果"，不是磁盘上那份旧文件。
    // · 两者都缺时抛 400 `missing-name` —— 别甩裸 `Error`（会被 handle 兜成
    //   `500 internal`，跟"参数没给"完全不匹配）。
  #previewRole(body) {
    const store = this.#requireRoles();
    const { content, name } = parseBody(body);

    let text;
    if (typeof content === 'string') {
      text = content;
    } else if (name) {
      try {
        text = readRoleContent({ dir: store.dir, name });
      } catch (e) {
        throw new ConsoleError(String(e.message ?? e), { status: 404, code: 'no-role' });
      }
    } else {
      throw new ConsoleError('缺少 content 或 name', { status: 400, code: 'missing-name' });
    }

    // ⚠️ `selectRoleText` 的参数名是 **`content`**，不是 `text`。
    //
    // 早先这里传 `{ text, maxChars }` —— 函数收不到内容，
    // 于是**永远返回 0 字符**。而且它不报错，只是安静地返回空，
    // 所以这个 bug 一直藏着（前端显示"实际注入 0 字符"，
    // 看着像角色卡是空的）。
    const sel = selectRoleText({ content: text, maxChars: store.maxChars });
    return { ...sel, maxChars: store.maxChars };
  }

  // 把**前端提交回来的候选配置**收拾成"能过严格校验"的样子。
  //
  // 两件事，缺一不可：
  //
  // ① **还原打码的密码**（见 `PASSWORD_MASK`）。前端拿到的 `console.password`
  //    是占位符 `<已设置>`；如果提交回来还是那个占位符，说明用户没动它 ——
  //    用磁盘上的真值填回去。漏了这一步，用户随手点一次保存就会把字面量
  //    `<已设置>` 写成新密码，把登录彻底改坏。
  //
  // ② **丢掉展示专用的派生键**。`passwordSet` 只该出现在「生效配置」里，
  //    但浏览器里那个 JSON 文本框可能是**改动前**加载的（页面没刷新），
  //    里面还留着它。不清掉就会撞上 `strict` 校验：
  //    `未知的配置项 "passwordSet"（位于 console.passwordSet）`。
  //    这条实测踩过，所以这里做防御性删除，而不是只靠"服务端不再下发"。
  //
  // `/api/config/check` 与 `/api/config/save` 都调它：两条路看到的候选值必须一致，
  // 否则"只校验"和"校验并保存"会对同一份输入给出不同结论。
  #restoreCandidate(candidate) {
    if (!candidate?.console || typeof candidate.console !== 'object') return candidate;

    // ② 先删派生键（它不参与语义，删了不该有副作用）
    if ('passwordSet' in candidate.console) delete candidate.console.passwordSet;

    // ① 再把占位符还原成磁盘上的真值
    if (candidate.console.password === PASSWORD_MASK) {
      const onDiskPassword = readConfigForConsole({ file: this.configFile }).value?.console?.password;
      candidate.console.password = typeof onDiskPassword === 'string' ? onDiskPassword : '';
    }
    return candidate;
  }

  #save(body) {
    const candidate = parseBody(body);
    const effective = this.getEffective();

    this.#restoreCandidate(candidate);

    // ① 先校验 —— 不过就什么都不写。
    const check = checkConfig(candidate, { current: effective });
    if (!check.ok) {
      throw new ConsoleError('配置校验未通过，未写入', {
        status: 400,
        code: 'invalid-config',
        errors: check.errors,
      });
    }

    // ② **只写改过的键**，而不是整份覆盖。
    //
    // 整份覆盖会洗掉"只存在于运行时、不在文件里"的值 ——
    // 最典型的是 SnowLuma 的 `wsToken`（桥接从 SnowLuma 配置里**发现**的）。
    // 实测：在控制台改一下 windowWho，保存后 token 变空，
    // 热重载 `tokenChanged=true`、重连 URL 没有 `?access_token=`，
    // 于是连不上 SnowLuma（日志刷 `close:1006`，而 SnowLuma 那边一切正常）。
    //
    // 见 config/write.js 的 mergeChangedOnly 说明。
    const merged = mergeChangedOnly({
      onDisk: readConfigForConsole({ file: this.configFile }).value ?? {},
      submitted: candidate,
      effective,
    });

    // 合并结果可能带出新的非法组合（例如空 allow + allowAllWhenEmpty），再校验一次。
    const recheck = checkConfig(merged, { current: effective });
    if (!recheck.ok) {
      throw new ConsoleError('合并后的配置校验未通过（可能是运行时值与提交值冲突）', {
        status: 400,
        code: 'invalid-merged',
        errors: recheck.errors,
      });
    }

    // ③ 原子写（不备份：备份里是明文密码与 token）。
    const written = writeConfigFile({ file: this.configFile, config: merged });

    // ④ 通知外层（热重载由文件监听自动触发，这里只是即时反馈）。
    try {
      this.onConfigSaved?.(merged);
    } catch (error) {
      this.logger?.warn('配置保存后的回调失败', { error: String(error) });
    }

    this.logger?.info('控制台写入了配置', { file: written.file });

    return {
      file: written.file,
      warnings: check.warnings,
      // 提醒：环境变量/命令行层的覆盖优先于文件，控制台改完可能"看起来没生效"。
      note: '文件已更新；若某些项被环境变量覆盖，生效值以"生效配置"栏为准。',
    };
  }
}

// 密码在前端看到的**占位符**。
//
// 同一份 `config.json` 既走「生效配置」也走「配置文件编辑」，两处都不能带明文：
// 编辑框里放这个占位符，**保存时服务端把它还原成磁盘上的真值**（见 `#save`）。
// 否则用户点一次保存，就会把字面量 `<已设置>` 写成新密码。
export const PASSWORD_MASK = '<已设置>';

// 把任意一份配置对象里的 `console.password` 打码（只改拷贝，不动入参）。
//
// ⚠️ **只打码，不许加新键**。这个函数同时被「配置文件编辑框」使用：
// 它返回什么，用户点保存时就会把什么原样提交回来。而配置校验是
// `strict` 的（未知键一律报错），所以任何为了显示方便塞进去的字段
// 都会变成 `未知的配置项 "xxx"`。
//
// 实测踩过：这里曾同时塞 `passwordSet: true`（给状态页的摘要用），
// 于是控制台一保存配置就报 `未知的配置项 "passwordSet"（位于 console.passwordSet）`。
// 展示用的派生字段请放在 `redactEffective` 里（那条路径不会被提交）。
function maskPassword(config) {
  if (!config || typeof config !== 'object') return config;
  const consoleCfg = config.console;
  if (!consoleCfg || typeof consoleCfg !== 'object') return config;
  return {
    ...config,
    console: {
      ...consoleCfg,
      password: consoleCfg.password ? PASSWORD_MASK : '',
    },
  };
}

// 生效配置的**对外视图**。
//
// `/api/state` 会把它整份吐给浏览器 —— 包括配置文本域里要编辑的字段。
// 密码**必须**在这里打码：它已经存在配置里，没有任何理由再进浏览器内存、
// 更不该被"看一眼状态"顺手抄走。前端的登录态不依赖它。
//
// `passwordSet` 是**给状态页看的派生字段**，只加在这条路径上：
// 生效配置不会被提交回去，所以它不会撞上严格校验。
export function redactEffective(config) {
  const masked = maskPassword(config);
  if (!masked || typeof masked !== 'object' || !masked.console) return masked;
  return {
    ...masked,
    console: { ...masked.console, passwordSet: Boolean(config.console?.password) },
  };
}

// 磁盘配置的对外视图（同样打码，且**不带**任何派生字段 —— 它会原样被提交回来）。
export function redactFileConfig(result) {
  if (!result || typeof result !== 'object') return result;
  return { ...result, value: maskPassword(result.value ?? {}) };
}

// 起控制台 HTTP 服务。
//
// 只有一层了：没有回环白名单、没有跨站校验 —— 鉴权在 `ConsoleServer.handle`
// 里按密码完成（见文件头）。`host` 默认 0.0.0.0，也就是允许局域网访问。
export function startConsoleServer({ console: consoleServer, port, host = '0.0.0.0', logger }) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1024 * 1024) req.destroy(); // 配置不可能这么大
    });
    req.on('end', async () => {
      const out = await consoleServer.handle(
        { method: req.method, url: req.url, headers: req.headers, socket: req.socket },
        body,
      );
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger?.info('控制台已监听', { url: `http://${host}:${port}/` });
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------- 小工具

function json(status, payload, extraHeaders = {}) {
  return {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function sessionCookie(token, maxAgeSec) {
  // SameSite=Lax：跨站 POST 不会带上它（跨站 GET 仍会，但 GET 接口只读）。
  // 不设 Secure：控制台默认跑在局域网 http 上，设了反而登录不上。
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// 从 Cookie 头里取一个值（只解析需要的那个，不引依赖）。
export function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

// 常量时间比较两个字符串。
//
// 两边都先过 sha256：`timingSafeEqual` 要求长度相等，而直接比较长度本身
// 就会泄露"密码多长"。摘要固定 32 字节，长度对比不再有信息量。
function sameSecret(a, b) {
  const da = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const db = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

function parseBody(body) {
  if (!body || body.trim() === '') {
    throw new ConsoleError('请求体为空', { status: 400, code: 'empty-body' });
  }
  try {
    const v = JSON.parse(body);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new ConsoleError('请求体必须是 JSON 对象', { status: 400, code: 'bad-body' });
    }
    return v;
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    throw new ConsoleError(`请求体不是合法 JSON：${error.message}`, { status: 400, code: 'bad-json' });
  }
}
