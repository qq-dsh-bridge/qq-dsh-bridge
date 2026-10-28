// 人格卡（角色扮演）。
//
// ── 最重要的一条：人格卡只写「人设」，不写「怎么干活」
//
// 提示词分两层（抄自旧方案 roles/README.md 的设计约束）：
//
//   | 层 | 放在哪 | 管什么 |
//   | 人格提示词 | roles/<角色名>.md | **你是谁**：身份、性格、说话风格、梗、关系 |
//   | 仿真提示词 | prompt.js 的【发言方式】等小节 | **怎么干活**：工具怎么调、怎么收尾 |
//
// 为什么不混：工具协议会变（空格分条 → 一切皆工具），
// 写进人格卡必然有一版是错的；而且桥接**每条消息**都已经在讲怎么分条与收尾，
// 重复写只会占预算、还会互相打架。
//

import fs from 'node:fs';
import path from 'node:path';

// 默认注入上限（字符）。人格卡**唤醒时**注入一次（不是每条），这是成本护栏。
export const DEFAULT_MAX_INJECT_CHARS = 12000;

// 管理者称呼的唯一来源是角色卡里的 `<!-- owner-title: X -->`（见下）。

// 人格卡里声明「管理者称呼」的写法：
//
//     <!-- owner-title: 主人 -->
//
// ── 为什么用 HTML 注释而不是单独小节
//
// 它会被**解析后从注入文本里去掉**，所以：既不占提示词预算，
// 也不会让模型看到"设置项"这种东西（那会显得很出戏）。
// 而且它和现有角色卡格式（纯 Markdown）完全兼容，老卡不用改。
//
// ── 为什么必须有这个声明
//
// 把"主人"写死在提示词里，换任何一张人格卡它都叫主人。而且它和"群管理员"
// 是两件事：群管理员是 OneBot 给的群内身份（`groupRole: 'admin'`），
// 与你（owner.qq）毫无关系。
const OWNER_TITLE_RE = /^[ \t]*<!--\s*owner-title\s*[:：]\s*(.+?)\s*-->[ \t]*$/gim;

// 从人格卡里取出「管理者称呼」声明，并把声明行**从文本里去掉**。
//
// @returns `{ title, text }` —— title 为空串表示没声明（调用方应退回默认值）
export function extractOwnerTitle(content) {
  const text = String(content ?? '');
  let title = '';
  const stripped = text.replace(OWNER_TITLE_RE, (_, captured) => {
    // 只认第一个；后续重复声明忽略（但仍从文本里去掉，避免泄露给模型）。
    if (!title) title = String(captured).trim();
    return '';
  });
  return { title, text: stripped };
}

export class RoleError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'RoleError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

// 角色名合法性（防止路径穿越与 Windows 保留名）。
const RESERVED = new Set(['CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9']);

export function validateRoleName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new RoleError('角色名不能为空');
  if (name.length > 40) throw new RoleError('角色名过长（最多 40 字符）');
  if (/[\\/:*?"<>|]/.test(name)) throw new RoleError('角色名不能包含 \\ / : * ? " < > | 这些字符');
  if (name === '.' || name === '..') throw new RoleError('非法的角色名');
  if (/^readme$/i.test(name)) throw new RoleError('角色名不能叫 README');
  if (RESERVED.has(name.toUpperCase())) throw new RoleError(`"${name}" 是 Windows 保留名，换一个`);
  return name;
}

// 列出可用角色（不含 README）。
export function listRoles({ dir } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => !/^readme\.md$/i.test(f))
      .map((f) => f.replace(/\.md$/i, ''))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch {
    return [];
  }
}

// 读一个角色的原始内容。
export function readRoleContent({ dir, name } = {}) {
  const safe = validateRoleName(name);
  const file = path.join(dir, `${safe}.md`);
  if (!fs.existsSync(file)) {
    throw new RoleError(`找不到角色卡 "${safe}"`, {
      hint: `可用角色：${listRoles({ dir }).join('、') || '（无）'}`,
    });
  }
  return fs.readFileSync(file, 'utf8');
}

// 写入角色卡（控制台编辑用）。
export function writeRoleContent({ dir, name, content } = {}) {
  const safe = validateRoleName(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe}.md`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(content ?? ''), 'utf8');
  fs.renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

// 取真正要注入的文本：剥掉 `owner-title` 声明，再按上限截断。
//
// 这里**不再**做"按模式筛小节"（那套标记已删，见文件头）。它现在的用途只有
// 控制台的字符统计，所以字符数必须和实际注入的一致 —— 别再往里加过滤。
//
// @param options.content  原始 markdown
// @param options.maxChars 注入上限（超出截断）
// @returns `{ text, chars, truncated, ownerTitle }`
export function selectRoleText({ content, maxChars = DEFAULT_MAX_INJECT_CHARS } = {}) {
  // 先抽声明 —— 它必须在**截断之前**取出来，而且不参与字符预算
  // （配置项占预算没有道理）。
  const { title: ownerTitle, text: body } = extractOwnerTitle(content);

  const text = body;
  if (!text.trim()) return { text: '', chars: 0, truncated: false, ownerTitle };

  let out = text.replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;

  if (maxChars > 0 && out.length > maxChars) {
    // 在**段落边界**截断，而不是硬切字符 —— 切一半的句子会让人设看起来很怪。
    const cut = out.slice(0, maxChars);
    const at = cut.lastIndexOf('\n\n');
    out = (at > maxChars * 0.5 ? cut.slice(0, at) : cut).trimEnd() + '\n\n（人格卡因长度上限截断）';
    truncated = true;
  }

  return { text: out, chars: out.length, truncated, ownerTitle };
}

// 角色仓库：记住"当前启用哪个角色"，并给出每次注入的文本。
//
// 状态落盘到配置：`config.json` 的 `role.current`。理由见下面 constructor 的注释。
//
// ── 为什么每次唤醒都注入（而不是只发一次）
//
// 人设是"你是谁"，不是"这一轮要做什么"。DSH 会压缩历史上下文，
// 而人设一旦被压掉，AI 就会退回默认的 coding-agent 口吻
// （实测表现：突然开始说英文、像在自言自语地写代码注释）。
// 所以每次唤醒都带一份 —— 这是刻意的成本。
export class RoleStore {
  // ── 为什么当前角色不再单独落盘
  //
  // 配置层已经有「三层叠加 + 热重载 + 校验 + 原子写 + 备份」这一整套；
  // 角色再用一个 `state/current-role.json` 维护，就是**两处真源**——
  // 两边不一致时的症状（控制台显示 A、提示词里是 B）极难排查。
  // 搬进配置后：切角色 = 改配置 = 走同一条写入路径，插件也少读一个文件。
  //
  // ⚠️ 本类**不自己写文件**：切换角色调 `persistRole(name)`，由调用方改配置
  //    （见 main.js 的 `saveRoleSelection`）。这样"写配置"只有一条路径。
  //
  // @param options.dir         角色卡目录
  // @param options.getConfig   取当前生效配置（`() => config`）—— **每次现读**，
  //                            热重载/控制台切换立刻生效
  // @param options.persistRole 把当前角色写进配置（`(name) => void`），可空
  // @param options.getEffective 取**某个会话**的生效配置（`(convKey) => config`）。
  //                            会话覆盖层的注入点：不传时所有会话都用 `getConfig()`，
  //                            行为与引入覆盖层之前完全一致。
  // @param options.maxChars    注入上限
  // @param options.logger
  constructor({ dir, getConfig, getEffective, persistRole, maxChars = DEFAULT_MAX_INJECT_CHARS, logger } = {}) {
    this.dir = dir;
    this.maxChars = maxChars;
    this.logger = logger;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.getEffective = typeof getEffective === 'function' ? getEffective : null;
    this.persistRole = typeof persistRole === 'function' ? persistRole : null;
  }

  // 当前角色名 —— **每次从配置读**，不缓存。
  //
// 不缓存：否则控制台切完角色，提示词里还是旧人设，要等重启才换 ——
// 而"切了没反应"最容易被误判成"角色卡的问题"。
  get name() {
    return String(this.getConfig()?.role?.current ?? '');
  }

  // **某个会话**该用哪张卡 —— 覆盖层优先，没有覆盖就退回全局 `role.current`。
  //
  // 空串 = 这个会话不启用人设（与全局口径一致：空串合法，等于只按仿真提示词走）。
  nameFor(convKey) {
    if (!this.getEffective) return this.name;
    const conf = this.getEffective(convKey) ?? {};
    return String(conf?.role?.current ?? '');
  }

  // 落盘。没有写入回调时只告警，不阻断（角色照样在本进程生效）。
  #persist(name) {
    if (!this.persistRole) {
      this.logger?.warn('没有配置写入回调，角色变更不会落盘（重启后回到配置里的值）', { role: name });
      return;
    }
    this.persistRole(name);
  }

  list() { return listRoles({ dir: this.dir }); }

  // 启用一个角色。
  set(name) {
    const safe = validateRoleName(name);
    readRoleContent({ dir: this.dir, name: safe }); // 不存在就抛
    this.#persist(safe);
    this.logger?.info('已切换角色', { role: safe });
    return safe;
  }

  // 清除角色（AI 只按仿真提示词行动）。
  clear() {
    this.#persist('');
    this.logger?.info('已清除角色');
  }

  // 注意：这里**没有** `forPrompt()`（已删）。
  //
  // 人设不再由桥接拼进 user 消息 —— 它由 system prompt 层的 qq-prompt-sections
  // 插件按 `roles/<当前角色>.md` 现读。RoleStore 现在只负责：当前角色是谁、
  // 有哪些卡、给控制台读写。要"取注入文本"就去插件那边（它用的是同一个目录）。
}
