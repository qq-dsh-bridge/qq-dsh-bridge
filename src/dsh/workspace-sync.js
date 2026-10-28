// 自动注册 dsh workspace（走插件 /workspace）。
//
// 会话只有落在**注册表登记过**的项目下才会分组：`/ensure { workspaceId }`
// 才会把会话登记进项目的 sessionIds（所有权的真源），只给 cwd 不够。
// 插件那边按规范化路径幂等 —— 已存在的目录返回同一个 id，所以这里无条件调即可。
// #region 注册

export class WorkspaceSyncError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'WorkspaceSyncError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

// 确保一个目录已注册为 workspace，返回它的 **workspaceId**（失败返回空串）。
//
// 失败不阻断：会话照样建得起来（分组是观感，不是功能），只是会落在 Ungrouped。
export async function ensureWorkspace({ host, path: dir, title, logger } = {}) {
  if (!dir) return '';
  try {
    const r = await host.workspace({ path: dir, title });
    const id = String(r?.workspaceId ?? '');
    logger?.debug('workspace 已就绪', { path: dir, id, sessions: r?.sessionIds?.length ?? 0 });
    return id;
  } catch (error) {
    logger?.warn('注册 workspace 失败（会话仍会创建，只是不分组）', { path: dir, error: String(error) });
    return '';
  }
}

// 批量版（启动对账用）。
//
// 插件不区分"新建"还是"复用"（都是幂等 create），所以这里也不编造 created，
// 只报成功/失败 —— 想知道是否新建没有实际用途。
//
// @returns `{ registered: [path], failed: [{ path, error }] }`
export async function syncWorkspaces({ host, paths = [], logger } = {}) {
  const result = { registered: [], failed: [] };
  for (const { path: dir, title } of paths) {
    // eslint-disable-next-line no-await-in-loop
    const id = await ensureWorkspace({ host, path: dir, title, logger });
    if (id) result.registered.push(dir);
    else result.failed.push({ path: dir });
  }
  if (paths.length) {
    logger?.info('workspace 对账完成', { registered: result.registered.length, failed: result.failed.length });
  }
  return result;
}
// #endregion

// #region 工具

// 会话键 → 人类可读标题。
export function defaultTitle(convKey) {
  const [kind, id] = String(convKey).split(':');
  return kind === 'group' ? `QQ群 ${id}` : `QQ私聊 ${id}`;
}
// #endregion
