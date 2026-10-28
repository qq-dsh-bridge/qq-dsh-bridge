

'use strict';



const $ = (id) => document.getElementById(id);

/** 登录态（`required` 由服务端告诉我们，前端不猜）。 */
const AUTH = { required: false, authed: false };

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.code = '';
  err.errors = [];
  return err;
}

/**
 * 调一次控制台 API。
 *
 * 统一信封：成功返回 `result`，失败抛 Error（带 `.status` / `.code` / `.errors`）。
 * 未登录（401）时自动退回登录页 —— 会话过期不该让页面卡在"读状态失败"。
 */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError(`服务端返回了非 JSON（HTTP ${res.status}）`, res.status);
  }

  if (!res.ok || data.ok === false) {
    const err = httpError(data.error || `HTTP ${res.status}`, res.status);
    err.code = data.code || '';
    err.errors = data.errors || [];
    err.retryAfterSec = data.retryAfterSec;
    // 会话失效：除了登录接口自己，其它一律退回登录页。
    if (res.status === 401 && path !== '/api/login') {
      showLogin('登录状态已失效，请重新登录');
    }
    throw err;
  }
  return data.result;
}

/** 提示条。err 留 15 秒，其它 6 秒。 */
function message(kind, text, list = []) {
  const box = document.createElement('div');
  box.className = `msg ${kind}`;
  const body = document.createElement('div');
  body.className = 'body';
  body.appendChild(document.createTextNode(text));
  if (list.length) {
    const ul = document.createElement('ul');
    for (const item of list) {
      const li = document.createElement('li');
      li.textContent = String(item);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  box.appendChild(body);
  $('messages').appendChild(box);
  setTimeout(() => box.remove(), kind === 'err' ? 15000 : 6000);
}

const clearMessages = () => { $('messages').replaceChildren(); };

/** 转义 —— 凡是插进 innerHTML 的字符串都必须过它。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 请求进行中把按钮禁掉 —— 否则双击会重复提交（原来每个按钮都能双击）。 */
async function busy(btn, fn) {
  if (!btn || btn.disabled) return undefined;
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtLeft(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`;
  return `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`;
}

// ══════════════════════════════════════════════════════════ 登录 / 登出

function loginError(text) {
  const box = $('login-error');
  if (!text) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = text;
}

function shakeCard() {
  const card = $('login-form');
  card.classList.remove('shake');
  // 强制回流，让连续两次失败也能重新播一遍动画。
  void card.offsetWidth;
  card.classList.add('shake');
}

function showLogin(reason = '') {
  AUTH.authed = false;
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  document.title = 'qq-dsh-bridge · 登录';
  loginError(reason);
  $('login-password').focus();
}

async function showApp() {
  AUTH.authed = true;
  $('boot').hidden = true;
  $('login').hidden = true;
  $('app').hidden = false;
  // 只有真的启用了登录才显示「登出」—— 没密码时它没有意义。
  $('btn-logout').hidden = !AUTH.required;
  await selectPage(location.hash.slice(1) || 'status');
}

async function doLogin(event) {
  event?.preventDefault?.();
  const pw = $('login-password').value;
  if (!pw) { loginError('请先输入密码'); shakeCard(); return; }

  await busy($('login-submit'), async () => {
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      loginError('');
      $('login-password').value = '';
      AUTH.required = true;
      await showApp();
    } catch (error) {
      if (error.retryAfterSec) {
        loginError(`登录失败次数过多，请 ${fmtLeft(error.retryAfterSec * 1000)}后再试`);
      } else {
        loginError(error.message || '登录失败');
      }
      $('login-password').select?.();
      shakeCard();
    }
  });
}

async function doLogout() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch { /* 会话本来就已经失效，也该退回登录页 */ }
  showLogin('已登出');
}

// ══════════════════════════════════════════════════════════ 页面注册表

/**
 * 加页面只动这里 + index.html 两处。
 * `onEnter` 在每次切到该页时调用（可以用来懒加载）。
 */
const PAGES = {
  status: { title: '状态', onEnter: () => loadState() },
  role: { title: '人格', onEnter: () => loadRoles() },
  sessions: { title: '会话', onEnter: () => loadSessions() },
  config: { title: '配置', onEnter: () => loadState({ form: true }) },
  logs: { title: '日志', onEnter: () => loadLogs() },
};

let page = 'status';

async function selectPage(name) {
  const spec = PAGES[name] ? name : 'status';
  page = spec;

  for (const btn of document.querySelectorAll('#nav .nav-item')) {
    const on = btn.dataset.page === spec;
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('[data-page-view]')) {
    // 重新挂一次动画类，让同一页来回切换也有"进场"感（不做的话只在首帧播）。
    view.hidden = view.dataset.pageView !== spec;
    if (!view.hidden) {
      view.style.animation = 'none';
      void view.offsetWidth;
      view.style.animation = '';
    }
  }

  $('page-title').textContent = PAGES[spec].title;
  document.title = `qq-dsh-bridge · ${PAGES[spec].title}`;
  clearMessages();
  closeDrawer();
  await PAGES[spec].onEnter?.();
}

// ══════════════════════════════════════════════════════════ 窄屏抽屉

function openDrawer() {
  $('app').classList.add('drawer-open');
  $('scrim').hidden = false;
}

function closeDrawer() {
  $('app').classList.remove('drawer-open');
  $('scrim').hidden = true;
}

// ══════════════════════════════════════════════════════════ 状态页

let pollBusy = false;

/**
 * 拉一次状态。
 *
 * @param options.form 是否用服务端的 config.json 重填配置表单。
 *   ⚠️ 只有**用户没有未保存修改**时才重填 —— 否则 5 秒一次的轮询会把
 *   正在编辑的内容冲掉（旧版就有这个坑：切到别的页再回来，编辑没了）。
 */
async function loadState({ form = false } = {}) {
  try {
    const state = await api('/api/state');
    setBadge('已连接', 'ok');
    renderConversations(state.runtime);
    renderEffective(state.effective);
    renderSideFoot(state.runtime);
    if (form) fillConfigForm(state.file);
    return state;
  } catch (error) {
    setBadge('连接失败', 'err');
    // 401 已经由 api() 切到登录页了，这里不再重复弹一条错。
    if (error.status !== 401) message('err', `读取状态失败：${error.message}`);
    return null;
  }
}

function setBadge(text, kind) {
  const b = $('status-badge');
  b.textContent = text;
  b.className = `badge${kind ? ` ${kind}` : ''}`;
}

function renderConversations(runtime) {
  const convs = runtime?.conversations ?? [];
  const tbody = $('conv-rows');
  $('conv-hint').textContent = convs.length ? `${convs.length} 个会话 · 每 5 秒自动刷新` : '';

  if (!convs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">（还没有会话 —— 等群里有人说话）</td></tr>';
    return;
  }

  tbody.innerHTML = convs.map((c) => {
    const s = c.stats ?? {};
    let badge;
    if (c.waiting) badge = '<span class="pill waiting">等待中</span>';
    else if (c.awake) badge = `<span class="pill awake">醒着 ${esc(fmtLeft(c.awakeForMs))}</span>`;
    else badge = '<span class="pill sleeping">睡眠</span>';
    if (c.agentRunning) badge += ' <span class="pill turn">agent 运行中</span>';

    return `<tr>
      <td class="mono">${esc(c.key)}</td>
      <td>${badge}</td>
      <td>${Number(s.delivered ?? 0)} <span class="muted small">（${esc(fmtTime(c.lastDeliverAt))}）</span></td>
      <td>${Number(s.woke ?? 0)}</td>
      <td>${Number(s.skippedNotTrigger ?? 0)} / ${Number(s.skippedGate ?? 0)}</td>
      <td>${Number(s.idleSleeps ?? 0)}</td>
    </tr>`;
  }).join('');
}

function renderEffective(cfg = {}) {
  const consoleCfg = cfg.console ?? {};
  const rows = [
    ['DSH 地址', cfg.dsh?.baseUrl],
    ['DSH home', cfg.dsh?.home],
    ['SnowLuma WS', cfg.snowluma?.wsUrl],
    ['主人 QQ', cfg.owner?.qq || '（未设置）'],
    ['allow 私聊 / 群', `${cfg.allow?.private?.length ?? 0} / ${cfg.allow?.groups?.length ?? 0}`],
    ['聊天记录根', cfg.chatlog?.root],
    ['日志级别', cfg.log?.level],
    ['日志文件', cfg.log?.file || '（只输出控制台）'],
    /**
     * 控制台自己：只显示监听地址和"有没有密码"。
     *
     * ⚠️ 密码本身在服务端已被打码成 `<已设置>`（见 api/console.js 的 redactEffective），
     * 这里也不显示它 —— 想看明文去配置页的 JSON（那是文件原文，本来就要能编辑）。
     */
    ['控制台', `${consoleCfg.host ?? '—'}:${consoleCfg.port ?? '—'}`
      + (consoleCfg.passwordSet ? ' · 密码登录' : ' · 未设密码（不鉴权）')],
  ];
  $('eff-rows').innerHTML = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`)
    .join('');
}

/** 侧栏底部：进程与运行时摘要（这些字段原先前端根本没用）。 */
function renderSideFoot(runtime) {
  if (!runtime) return;
  const lock = runtime.lock ? `PID ${esc(runtime.lock.pid)}` : '未持锁';
  $('side-foot').innerHTML = [
    `<span>配置版本 <b>${esc(runtime.revision ?? '—')}</b></span>`,
    `<span>当前人格 <b>${esc(runtime.role || '（未启用）')}</b></span>`,
    `<span>单实例锁 <b>${lock}</b></span>`,
  ].join('');
}

// ══════════════════════════════════════════════════════════ 人格页

let editingRole = '';

async function loadRoles() {
  const tbody = $('role-rows');
  try {
    const data = await api('/api/roles');
    $('role-current').textContent = data.current || '（未启用）';
    renderRoles(data);
  } catch (error) {
    if (error.status === 401) return;
    tbody.innerHTML = `<tr><td colspan="4" class="empty">读取角色卡失败：${esc(error.message)}</td></tr>`;
  }
}

function renderRoles(data) {
  const roles = data.roles ?? [];
  const tbody = $('role-rows');
  if (!roles.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">（还没有角色卡 —— 在下面新建一个）</td></tr>';
    return;
  }

  tbody.replaceChildren(...roles.map((role) => {
    const tr = document.createElement('tr');
    const isCurrent = role.name === data.current;

    const tdName = document.createElement('td');
    tdName.appendChild(document.createTextNode(role.name));
    if (isCurrent) {
      const pill = document.createElement('span');
      pill.className = 'pill on';
      pill.textContent = '启用中';
      tdName.append(' ', pill);
    }
    tr.appendChild(tdName);

    const tdChars = document.createElement('td');
    if (role.error) {
      const span = document.createElement('span');
      span.style.color = 'var(--destructive)';
      span.textContent = role.error;
      tdChars.appendChild(span);
    } else {
      tdChars.append(`${role.chars} / ${data.maxChars}`);
      if (role.over) {
        const over = document.createElement('span');
        over.className = 'pill over';
        over.textContent = '超上限，会截断';
        tdChars.append(' ', over);
      }
    }
    tr.appendChild(tdChars);

    const tdState = document.createElement('td');
    tdState.textContent = role.truncated ? '已截断' : '完整';
    tr.appendChild(tdState);

    const tdAct = document.createElement('td');
    tdAct.className = 'right';
    const btnUse = document.createElement('button');
    btnUse.type = 'button';
    btnUse.className = isCurrent ? 'btn tiny' : 'btn tiny primary';
    btnUse.textContent = isCurrent ? '重新启用' : '启用';
    btnUse.addEventListener('click', () => busy(btnUse, () => selectRole(role.name)));
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn tiny';
    btnEdit.textContent = '编辑';
    btnEdit.style.marginLeft = '6px';
    btnEdit.addEventListener('click', () => busy(btnEdit, () => editRole(role.name)));
    tdAct.append(btnUse, btnEdit);
    tr.appendChild(tdAct);

    return tr;
  }));
}

async function selectRole(name) {
  clearMessages();
  try {
    await api('/api/roles/select', { method: 'POST', body: JSON.stringify({ name }) });
    message('ok', `已启用角色：${name}（下一条消息即生效，不用重启）`);
    await loadRoles();
  } catch (error) {
    if (error.status !== 401) message('err', `启用失败：${error.message}`);
  }
}

async function editRole(name) {
  try {
    const raw = await api(`/api/role?name=${encodeURIComponent(name)}`);
    editingRole = name;
    $('role-editing').textContent = name;
    $('role-text').value = raw.content ?? '';
    $('role-preview-box').hidden = true;
    await previewRole({ silent: true });
  } catch (error) {
    if (error.status !== 401) message('err', `载入失败：${error.message}`);
  }
}

async function createRole() {
  clearMessages();
  const input = $('new-role-name');
  const name = input.value.trim();
  if (!name) { message('warn', '先填角色名'); return; }
  try {
    await api('/api/roles/create', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    message('ok', `已新建角色卡「${name}」（含模板，点「编辑」开始写）`);
    await loadRoles();
  } catch (error) {
    if (error.status !== 401) message('err', `新建失败：${error.message}`, error.errors);
  }
}

async function saveRole() {
  clearMessages();
  if (!editingRole) { message('warn', '先从列表点「编辑」选一个角色'); return; }
  try {
    const r = await api('/api/roles/save', {
      method: 'POST',
      body: JSON.stringify({ name: editingRole, content: $('role-text').value }),
    });
    showStat(r);
    message('ok', `已保存「${editingRole}」（${r.bytes} 字节，注入 ${r.chars} 字符）`);
    await loadRoles();
  } catch (error) {
    if (error.status !== 401) message('err', `保存失败：${error.message}`, error.errors);
  }
}


async function previewRole({ silent = false } = {}) {
  if (!silent) clearMessages();
  try {
    const r = await api('/api/roles/preview', {
      method: 'POST',
      body: JSON.stringify({ content: $('role-text').value, name: editingRole }),
    });
    showStat(r);
    const box = $('role-preview-box');
    const pre = $('role-preview');
    pre.textContent = r.text || '（这段内容里没有被注入的部分）';
    box.hidden = false;
    if (!silent) {
      box.open = true;
      if (r.truncated) message('warn', '内容超出上限，实际注入时会被截断');
      else message('ok', `预览完成：注入 ${r.chars} / ${r.maxChars} 字符`);
    }
    return r;
  } catch (error) {
    if (!silent && error.status !== 401) message('err', `预览失败：${error.message}`);
    return null;
  }
}

/** 统计行。maxChars 缺失时退化成不显示分母，绝不显示 undefined。 */
function showStat(sel) {
  if (!sel) return;
  const parts = [sel.maxChars != null
    ? `实际注入 ${sel.chars} / ${sel.maxChars} 字符`
    : `实际注入 ${sel.chars} 字符`];
  if (sel.truncated) parts.push('会被截断');
  $('role-stat').textContent = parts.join(' · ');
}

async function clearRole() {
  if (!window.confirm('清除当前人格？人设将不再注入（角色卡文件不会被删）。')) return;
  clearMessages();
  try {
    await api('/api/roles/clear', { method: 'POST', body: '{}' });
    message('ok', '已清除人格，下一条消息起只按仿真提示词行动');
    await loadRoles();
  } catch (error) {
    if (error.status !== 401) message('err', `清除失败：${error.message}`);
  }
}

// ══════════════════════════════════════════════════════════ 会话配置页
//
// 一页管两件事：
//   · 上面是"哪些会话配了覆盖"的索引（含 `*` 全站兜底）
//   · 下面是按白名单**动态生成**的表单
//
// ⚠️ 字段清单来自服务端（`/api/sessions` 的 `overridable`），前端不硬编码一份。
//    硬编码的后果是"加一个可覆盖字段要改两处"，而漏改的症状是
//    **页面上根本没有这个字段** —— 用户只会以为"这个键不支持按会话配"。

/** 枚举型字段的合法值（与服务端 schema 的 SESSION_ENUMS 对应）。 */
const SESSION_ENUMS = {
  'chatlog.triggerWho': ['owner', 'everyone'],
  'chatlog.windowWho': ['owner', 'everyone'],
  'decide.mode': ['off', 'shadow', 'enforce'],
};

/** 下拉里的"不覆盖这一项"。空串不能用 —— 空串是**合法值**（如 role.current = 不启用人设）。 */
const INHERIT = '__inherit__';
/** 角色下拉里"显式清空人设"。 */
const ROLE_NONE = '__none__';

let sessionSnapshot = null;
let roleNames = [];
let editingKey = '';

async function loadSessions() {
  const tbody = $('sess-rows');
  try {
    const [data, roles] = await Promise.all([
      api('/api/sessions'),
      api('/api/roles').catch(() => ({ roles: [] })),
    ]);
    sessionSnapshot = data;
    roleNames = (roles.roles ?? []).map((r) => r.name);
    $('sess-file').textContent = data.found ? data.file : `${data.file}（尚未创建）`;
    renderSessions();
    if (data.errors?.length) {
      message('err', '会话覆盖层有校验错误（正在沿用上一份可用配置）', data.errors);
    }
  } catch (error) {
    if (error.status === 401) return;
    tbody.innerHTML = `<tr><td colspan="4" class="empty">读取会话覆盖失败：${esc(error.message)}</td></tr>`;
  }
}

function renderSessions() {
  const data = sessionSnapshot;
  const tbody = $('sess-rows');
  const globalRole = data?.global?.role || '';
  const rows = [];

  const addRow = (key, badge, role, fields) => {
    const tr = document.createElement('tr');

    const tdKey = document.createElement('td');
    tdKey.className = 'mono';
    tdKey.textContent = key;
    if (badge) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = badge;
      tdKey.append(' ', pill);
    }
    tr.appendChild(tdKey);

    const tdRole = document.createElement('td');
    tdRole.textContent = role || `（继承全局：${globalRole || '未启用'}）`;
    tr.appendChild(tdRole);

    const tdFields = document.createElement('td');
    tdFields.className = 'muted small';
    tdFields.textContent = fields.length ? fields.join('、') : '（空）';
    tr.appendChild(tdFields);

    const tdOps = document.createElement('td');
    tdOps.className = 'right';
    const edit = document.createElement('button');
    edit.className = 'btn ghost';
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => {
      $('sess-key').value = key;
      openSessionEditor(key);
    });
    const del = document.createElement('button');
    del.className = 'btn danger ghost';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', (e) => busy(e.currentTarget, () => clearSession(key)));
    tdOps.append(edit, ' ', del);
    tr.appendChild(tdOps);

    rows.push(tr);
  };

  if (data?.wildcard) addRow('*', '兜底', '', data.wildcard.fields ?? []);
  for (const item of data?.keys ?? []) {
    // 不在 allow 白名单里的覆盖照样列出来（可能是手写的，或后来被移出白名单），
    // 但标一下 —— 否则用户会疑惑"这个会话我明明没加白名单，怎么在这儿"。
    addRow(item.key, item.inAllow === false ? '不在白名单' : '', item.role, item.fields ?? []);
  }

  renderSessionPicker(data);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">（还没有会话配了覆盖 —— 从下面下拉选一个开始）</td></tr>';
    return;
  }
  tbody.replaceChildren(...rows);
}

// 「自定义」选项：下拉里没有这个会话时，回到手打。
const CUSTOM_KEY = '__custom__';

/**
 * 填充会话下拉。选项来自服务端的 `conversations`（= config.json 的
 * `allow.groups` / `allow.private`），所以**不用手打 `group:<群号>`**。
 *
 * 另外两类也放进去，否则它们没法再被选中编辑：
 *   · `*`（全站兜底）
 *   · 已有覆盖、但不在白名单里的键
 */
function renderSessionPicker(data) {
  const pick = $('sess-pick');
  if (!pick) return;
  const current = pick.value || $('sess-key').value.trim();

  const options = [new Option('选一个会话…', '')];
  if (data?.wildcard) options.push(new Option('* （全站兜底）', '*'));
  for (const one of data?.conversations ?? []) {
    options.push(new Option(`${one.label}${one.hasOverride ? ' ✓ 已覆盖' : ''}`, one.key));
  }
  const known = new Set((data?.conversations ?? []).map((one) => one.key));
  for (const item of data?.keys ?? []) {
    if (item.key === '*' || known.has(item.key)) continue;
    options.push(new Option(`${item.key}（不在白名单）`, item.key));
  }
  options.push(new Option('自定义…', CUSTOM_KEY));

  pick.replaceChildren(...options);
  pick.value = options.some((one) => one.value === current) ? current : '';
  syncSessionPick();
}

/** 下拉 ↔ 输入框同步：选中具体会话时把它写进 `#sess-key`，选「自定义」才露出输入框。 */
function syncSessionPick() {
  const pick = $('sess-pick');
  const row = $('sess-custom-row');
  const custom = !pick?.value || pick.value === CUSTOM_KEY;
  if (row) row.hidden = !custom;
  if (!custom) $('sess-key').value = pick.value;
  return custom;
}

function patchOf(key) {
  const data = sessionSnapshot;
  if (!data) return {};
  if (key === '*') return data.wildcard?.patch ?? {};
  return data.keys.find((k) => k.key === key)?.patch ?? {};
}

function openSessionEditor(key) {
  if (!sessionSnapshot) return;
  editingKey = key;
  $('sess-editing').textContent = key || '';
  const patch = patchOf(key);
  const form = $('sess-form');
  form.replaceChildren();

  for (const [group, leaves] of Object.entries(sessionSnapshot.overridable ?? {})) {
    const card = document.createElement('div');
    card.className = 'sess-group';
    const head = document.createElement('div');
    head.className = 'sess-group-head mono';
    head.textContent = group;
    card.appendChild(head);
    for (const leaf of leaves) {
      card.appendChild(sessionField(
        group,
        leaf,
        patch?.[group]?.[leaf],
        sessionSnapshot.global?.[group]?.[leaf],
      ));
    }
    form.appendChild(card);
  }
  $('sess-stat').textContent = '';
}

/** 一个字段 = 名字 + 控件。空/继承 = 不写入覆盖层。 */
function sessionField(group, leaf, value, globalValue) {
  const fieldPath = `${group}.${leaf}`;
  const wrap = document.createElement('label');
  wrap.className = 'sess-field';

  const name = document.createElement('span');
  name.className = 'sess-field-name mono';
  name.textContent = fieldPath;
  wrap.appendChild(name);

  let control;
  const enums = SESSION_ENUMS[fieldPath];

  if (group === 'role' && leaf === 'current') {
    control = document.createElement('select');
    const inherit = new Option(`继承（全局：${globalValue || '未启用'}）`, INHERIT);
    control.appendChild(inherit);
    for (const role of roleNames) control.appendChild(new Option(role, role));
    control.appendChild(new Option('（不启用人设）', ROLE_NONE));
    control.value = value === undefined ? INHERIT : (value === '' ? ROLE_NONE : String(value));
    control.dataset.kind = 'string';
  } else if (enums) {
    control = document.createElement('select');
    control.appendChild(new Option(`继承（${globalValue ?? '未设置'}）`, INHERIT));
    for (const v of enums) control.appendChild(new Option(v, v));
    control.value = value === undefined ? INHERIT : String(value);
    control.dataset.kind = 'string';
  } else if (typeof globalValue === 'boolean') {
    control = document.createElement('select');
    control.appendChild(new Option(`继承（${globalValue}）`, INHERIT));
    control.appendChild(new Option('是', 'true'));
    control.appendChild(new Option('否', 'false'));
    control.value = value === undefined ? INHERIT : String(value);
    control.dataset.kind = 'boolean';
  } else if (Array.isArray(globalValue) || leaf === 'cardSections') {
    control = document.createElement('input');
    control.type = 'text';
    control.placeholder = Array.isArray(globalValue) && globalValue.length
      ? `继承（${globalValue.join(', ')}）`
      : '继承（空）';
    control.value = Array.isArray(value) ? value.join(', ') : '';
    control.dataset.kind = 'list';
  } else if (typeof globalValue === 'number') {
    control = document.createElement('input');
    control.type = 'number';
    control.min = '1';
    control.placeholder = `继承（${globalValue}）`;
    control.value = value === undefined || value === null ? '' : String(value);
    control.dataset.kind = 'number';
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.placeholder = globalValue ? `继承（${globalValue}）` : '继承（空）';
    control.value = value === undefined || value === null ? '' : String(value);
    control.dataset.kind = 'string';
  }

  control.className = 'input';
  control.dataset.path = fieldPath;
  wrap.appendChild(control);
  return wrap;
}

/** 表单 → 补丁。只收"非继承"的项。 */
function collectSessionPatch() {
  const patch = {};
  for (const el of $('sess-form').querySelectorAll('[data-path]')) {
    const fieldPath = el.dataset.path;
    const raw = el.value;
    if (raw === INHERIT || raw === '') continue;

    const [group, leaf] = fieldPath.split('.');
    let value;
    if (el.dataset.kind === 'number') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${fieldPath} 必须是正整数`);
      value = n;
    } else if (el.dataset.kind === 'boolean') {
      value = raw === 'true';
    } else if (el.dataset.kind === 'list') {
      value = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (raw === ROLE_NONE) {
      value = '';
    } else {
      value = raw;
    }

    patch[group] ??= {};
    patch[group][leaf] = value;
  }
  return patch;
}

async function saveSession() {
  const key = $('sess-key').value.trim();
  if (!key) {
    message('err', '先填会话键（group:<群号> / private:<QQ号> / *）');
    return;
  }
  let patch;
  try {
    patch = collectSessionPatch();
  } catch (error) {
    message('err', error.message);
    return;
  }
  try {
    const r = await api('/api/sessions/save', {
      method: 'POST',
      body: JSON.stringify({ key, patch }),
    });
    message('ok', `已保存 ${key}（${(r.fields ?? []).length} 个字段），下一条消息生效`);
    await loadSessions();
    openSessionEditor(key);
  } catch (error) {
    if (error.status === 401) return;
    message('err', `保存失败：${error.message}`, error.errors ?? []);
  }
}

async function clearSession(key) {
  const target = key || $('sess-key').value.trim();
  if (!target) {
    message('err', '先填会话键');
    return;
  }
  try {
    await api('/api/sessions/clear', { method: 'POST', body: JSON.stringify({ key: target }) });
    message('ok', `${target} 已恢复默认（覆盖全部删除）`);
    if (editingKey === target) {
      editingKey = '';
      $('sess-editing').textContent = '（从上面点「编辑」，或用下面加载一个键）';
      $('sess-form').replaceChildren();
    }
    await loadSessions();
  } catch (error) {
    if (error.status === 401) return;
    message('err', `删除失败：${error.message}`, error.errors ?? []);
  }
}

// ══════════════════════════════════════════════════════════ 配置页

let fileConfig = null;
/** 有未保存修改 —— 轮询看到它就不敢重填表单。 */
let cfgDirty = false;

const COMMON = [
  ['cfg-triggerWho', 'chatlog', 'triggerWho', 'string'],
  ['cfg-windowWho', 'chatlog', 'windowWho', 'string'],
  ['cfg-wakeLimit', 'chatlog', 'wakeLimit', 'number'],
  ['cfg-replyLimit', 'chatlog', 'replyLimit', 'number'],
  ['cfg-maxChars', 'chatlog', 'maxChars', 'number'],
  ['cfg-maxDays', 'chatlog', 'maxDays', 'number'],
  ['cfg-idleMs', 'chatlog', 'idleMs', 'number'],
  ['cfg-logLevel', 'log', 'level', 'string'],
];

const DEFAULTS = {
  triggerWho: 'owner', windowWho: 'owner', wakeLimit: 60, replyLimit: 20, maxChars: 4000,
  maxDays: 7, idleMs: 300000, logLevel: 'info',
};

function fillConfigForm(file) {
  if (cfgDirty) return;   // 不覆盖用户正在编辑的内容
  fileConfig = file?.value ?? {};
  setCommon({
    triggerWho: fileConfig.chatlog?.triggerWho ?? DEFAULTS.triggerWho,
    windowWho: fileConfig.chatlog?.windowWho ?? DEFAULTS.windowWho,
    wakeLimit: fileConfig.chatlog?.wakeLimit ?? DEFAULTS.wakeLimit,
    replyLimit: fileConfig.chatlog?.replyLimit ?? DEFAULTS.replyLimit,
    maxChars: fileConfig.chatlog?.maxChars ?? DEFAULTS.maxChars,
    maxDays: fileConfig.chatlog?.maxDays ?? DEFAULTS.maxDays,
    idleMs: fileConfig.chatlog?.idleMs ?? DEFAULTS.idleMs,
    logLevel: fileConfig.log?.level ?? DEFAULTS.logLevel,
  });
  $('cfg-json').value = JSON.stringify(fileConfig, null, 2);
  setDirty(false);
}

function setCommon(v) {
  $('cfg-triggerWho').value = v.triggerWho;
  $('cfg-windowWho').value = v.windowWho;
  $('cfg-wakeLimit').value = v.wakeLimit;
  $('cfg-replyLimit').value = v.replyLimit;
  $('cfg-maxChars').value = v.maxChars;
  $('cfg-maxDays').value = v.maxDays;
  $('cfg-idleMs').value = v.idleMs;
  $('cfg-logLevel').value = v.logLevel;
}

function setDirty(on) {
  cfgDirty = on;
  $('cfg-dirty').hidden = !on;
}

/** 把 10 个常用项写进 JSON 文本域（提交的唯一来源始终是文本域）。 */
function syncCommonToJson() {
  let doc;
  try {
    doc = JSON.parse($('cfg-json').value);
  } catch {
    message('warn', 'JSON 文本域当前不是合法 JSON，常用项没有同步进去');
    return false;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    message('warn', 'JSON 顶层必须是对象，常用项没有同步进去');
    return false;
  }
  for (const [id, group, key, type] of COMMON) {
    const el = $(id);
    let v = el.value;
    if (type === 'number') {
      v = Number(v);
      // 空输入会得到 NaN —— 直接拒绝，别往 JSON 里塞 null
      if (!Number.isFinite(v)) { message('warn', `「${key}」不是有效数字，没有同步进去`); return false; }
    } else if (type === 'boolean') {
      v = v === 'true';
    }
    if (!doc[group] || typeof doc[group] !== 'object') doc[group] = {};
    doc[group][key] = v;
  }
  $('cfg-json').value = JSON.stringify(doc, null, 2);
  setDirty(true);
  return true;
}

/** 解析文本域，返回候选配置；不合法返回 null 并已提示。 */
function currentCandidate() {
  let obj;
  try {
    obj = JSON.parse($('cfg-json').value);
  } catch (error) {
    message('err', `JSON 语法错误：${error.message}`);
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    message('err', '顶层必须是 JSON 对象');
    return null;
  }
  return obj;
}

async function doCheck() {
  clearMessages();
  const candidate = currentCandidate();
  if (!candidate) return;
  try {
    const r = await api('/api/config/check', { method: 'POST', body: JSON.stringify(candidate) });
    if (r.ok === false) {
      message('err', '校验未通过：', r.errors);
    } else {
      message('ok', `校验通过${r.warnings?.length ? '（有提醒）' : ''}`);
      for (const w of r.warnings ?? []) message('warn', String(w));
    }
  } catch (error) {
    if (error.status !== 401) message('err', `校验请求失败：${error.message}`, error.errors);
  }
}

async function doSave() {
  clearMessages();
  const candidate = currentCandidate();
  if (!candidate) return;
  try {
    const r = await api('/api/config/save', { method: 'POST', body: JSON.stringify(candidate) });
    setDirty(false);
    message('ok', `已保存并生效。${r.note ?? ''}`);
    for (const w of r.warnings ?? []) message('warn', String(w));
    await loadState({ form: true });
  } catch (error) {
    if (error.status !== 401) message('err', `保存失败：${error.message}`, error.errors);
  }
}

/**
 * 从磁盘重新载入。
 *
 * ⚠️ 旧版这里无条件弹"已从磁盘重新载入"，而 loadState 自己吞掉错误 ——
 * 于是失败也报成功。现在拿真实结果说话。
 */
async function doReset() {
  if (cfgDirty && !window.confirm('有未保存的修改，重新载入会丢掉它们。继续？')) return;
  clearMessages();
  setDirty(false);
  const state = await loadState({ form: true });
  if (state) message('ok', '已从磁盘重新载入');
}

// ══════════════════════════════════════════════════════════ 日志页

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/** 从一行日志里取级别（形如 `2026-10-15 13:11:43.401+08:00 INFO  正文`）。 */
function levelOf(line) {
  const m = /^\S+\s+\S+\s+([A-Z]+)\b/.exec(line);
  return m ? m[1].toLowerCase() : null;
}

async function loadLogs() {
  const pre = $('log-view');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  try {
    const r = await api('/api/logs');
    const lines = r.lines ?? [];
    renderLogs(lines);
    $('log-hint').textContent = `尾部 ${lines.length} 行`;
    if ($('log-autoscroll').checked && atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (error) {
    if (error.status === 401) return;
    pre.replaceChildren();
    const span = document.createElement('span');
    span.className = 'placeholder';
    span.textContent = `读取日志失败：${error.message}`;
    pre.appendChild(span);
  }
}

/**
 * 渲染日志：每行一个 span（**用 textContent**，日志内容永远不能注入 HTML）。
 *
 * 级别过滤按"严重度及以上"；认不出级别的行（堆栈续行）跟着上一行一起显示。
 */
function renderLogs(lines) {
  const pre = $('log-view');
  const min = LEVELS[$('log-level').value] ?? 0;
  if (!lines.length) {
    pre.replaceChildren();
    const span = document.createElement('span');
    span.className = 'placeholder';
    span.textContent = '（日志为空）';
    pre.appendChild(span);
    return;
  }

  const out = [];
  let keepPrev = true;
  for (const line of lines) {
    const lv = levelOf(line);
    if (lv) keepPrev = (LEVELS[lv] ?? 0) >= min;
    if (!keepPrev && lv) continue;
    if (!lv && !keepPrev) continue;
    const span = document.createElement('span');
    span.className = `ln${lv ? ` ${lv}` : ''}`;
    span.textContent = line;
    out.push(span);
  }
  pre.replaceChildren(...out);
  if (!out.length) {
    const span = document.createElement('span');
    span.className = 'placeholder';
    span.textContent = '（当前过滤条件下没有日志）';
    pre.appendChild(span);
  }
}

// ══════════════════════════════════════════════════════════ 主题

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '自动', light: '亮色', dark: '暗色' };
const THEME_KEY = 'qqbridge-theme';

function applyTheme(mode) {
  const dark = mode === 'dark'
    || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // 登录页和主界面各有一个切换按钮，两处都要跟着走。
  $('btn-theme').textContent = THEME_LABEL[mode];
  $('login-theme').textContent = THEME_LABEL[mode];
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* 隐私模式下写不了 */ }
}

function cycleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'auto';
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}

// ══════════════════════════════════════════════════════════ 登录页动态背景

const FX_KEY = 'qqbridge-login-fx';

/**
 * 默认开，除非系统要求减弱动效（那是无障碍默认值，仍可用按钮覆盖）。
 * 选择按设备记：这是"我这台机器有点卡"的偏好，不该跟着账号走。
 */
function readFx() {
  try {
    const v = localStorage.getItem(FX_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* ignore */ }
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

function applyFx(on) {
  $('waves').classList.toggle('off', !on);
  $('login-fx').setAttribute('aria-pressed', on ? 'true' : 'false');
  try { localStorage.setItem(FX_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════ 启动

function wireEvents() {
  // ── 登录页
  $('login-form').addEventListener('submit', doLogin);
  $('login-theme').addEventListener('click', cycleTheme);
  $('login-fx').addEventListener('click', () => {
    applyFx($('login-fx').getAttribute('aria-pressed') !== 'true');
  });
  $('login-reveal').addEventListener('click', () => {
    const input = $('login-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('login-reveal').setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  });

  // ── 导航（窄屏点完就关抽屉）
  for (const btn of document.querySelectorAll('#nav .nav-item')) {
    btn.addEventListener('click', () => { location.hash = `#${btn.dataset.page}`; });
  }
  $('btn-menu').addEventListener('click', openDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // ── 顶栏
  $('btn-refresh').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    clearMessages();
    if (page === 'logs') await loadLogs();
    else if (page === 'role') await loadRoles();
    else await loadState({ form: true });
  }));

  $('btn-theme').addEventListener('click', cycleTheme);

  $('btn-logout').addEventListener('click', (e) => busy(e.currentTarget, doLogout));

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((document.documentElement.getAttribute('data-theme') || 'auto') === 'auto') applyTheme('auto');
  });

  // ── 人格页
  $('btn-role-clear').addEventListener('click', (e) => busy(e.currentTarget, clearRole));
  $('btn-role-create').addEventListener('click', (e) => busy(e.currentTarget, createRole));
  $('btn-role-save').addEventListener('click', (e) => busy(e.currentTarget, saveRole));
  $('btn-role-preview').addEventListener('click', (e) => busy(e.currentTarget, () => previewRole()));

  $('btn-sess-load').addEventListener('click', () => {
    const key = $('sess-key').value.trim();
    if (!key) {
      message('err', '先从下拉选一个会话（或选「自定义」手填 group:<群号> / private:<QQ号> / *）');
      return;
    }
    openSessionEditor(key);
  });
  // 下拉一选就载入 —— 少一次点击，这也正是"懒得一个一个填"的场景。
  $('sess-pick').addEventListener('change', () => {
    const custom = syncSessionPick();
    if (custom) {
      $('sess-key').focus();
      return;
    }
    if ($('sess-pick').value) $('btn-sess-load').click();
  });
  $('sess-key').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('btn-sess-load').click();
  });
  $('btn-sess-save').addEventListener('click', (e) => busy(e.currentTarget, saveSession));
  $('btn-sess-clear').addEventListener('click', (e) => busy(e.currentTarget, () => clearSession()));
  $('new-role-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') busy($('btn-role-create'), createRole);
  });

  // ── 配置页：常用项写回 JSON；文本域任何编辑都标记为脏
  for (const [id] of COMMON) $(id).addEventListener('change', syncCommonToJson);
  $('cfg-json').addEventListener('input', () => setDirty(true));
  $('btn-check').addEventListener('click', (e) => busy(e.currentTarget, doCheck));
  $('btn-save').addEventListener('click', (e) => busy(e.currentTarget, doSave));
  $('btn-reset').addEventListener('click', (e) => busy(e.currentTarget, doReset));

  // ── 日志页
  $('btn-log-refresh').addEventListener('click', (e) => busy(e.currentTarget, loadLogs));
  $('log-level').addEventListener('change', loadLogs);
  // 勾上就立刻滚 —— 旧版只在下次刷新时读它，勾了像没反应
  $('log-autoscroll').addEventListener('change', (e) => {
    if (e.currentTarget.checked) {
      const pre = $('log-view');
      pre.scrollTop = pre.scrollHeight;
    }
  });

  // 离开页面前提醒（有未保存的配置）
  window.addEventListener('beforeunload', (e) => {
    if (!cfgDirty) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  window.addEventListener('hashchange', () => {
    if (!$('app').hidden) selectPage(location.hash.slice(1));
  });
}

async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
  applyFx(readFx());
  wireEvents();

  let session;
  try {
    session = await api('/api/session');
  } catch (error) {
    $('boot').replaceChildren();
    const span = document.createElement('span');
    span.textContent = `连不上控制台：${error.message}（它可能没起来，或端口被占用）`;
    $('boot').appendChild(span);
    return;
  }

  AUTH.required = Boolean(session?.required);

  if (AUTH.required && !session.authed) {
    showLogin();
    return;
  }

  await showApp();

  // 只在状态页轮询 —— 且上一轮没回来就跳过，避免请求堆叠。
  // 没登录（回到登录页）时也停手，避免每 5 秒刷一串 401。
  setInterval(async () => {
    if (page !== 'status' || pollBusy || !AUTH.authed || $('app').hidden) return;
    pollBusy = true;
    try { await loadState(); } finally { pollBusy = false; }
  }, 5000);
}

boot();
