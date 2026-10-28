// 媒体门面：所有 kind（图片 / 语音 / 视频 / 文件 / 表情）的发布走这里。
//
// 为什么需要这层（而不是让调用点各自 import `src/media/store.js`）：
//   · `publish` 要**对外前缀**（`http://127.0.0.1:3110`）—— 那是"服务在哪"，
//     不是仓库的知识；仓库只知道自己落盘在哪
//   · `ALLOWED` / `MediaError` 也在这里统一
//
// 内容寻址、配额、清理都在 `src/media/store.js`；这一层不复制那些逻辑。

import { KINDS } from '../media/kinds.js';
import { MediaError } from '../media/store.js';
import { mediaUrlOf } from '../media/url.js';

export { MediaError };

// 图片允许的 mime → 扩展名（白名单；刻意不含 svg —— 它能内嵌脚本）。
export const ALLOWED = KINDS.image.mimes;

let media = null;
let apiBaseUrl = '';
let agentRoot = '';

// @param options.agentRoot agent 看到的媒体根（WSL 里是 `/ws/media`）；留空 = 不给路径
export function configureMediaStore({ store, baseUrl = '', agentRoot: agent = '' } = {}) {
  if (!store) throw new MediaError('configureMediaStore 需要 store', { code: 'no-store' });
  media = store;
  apiBaseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
  agentRoot = String(agent ?? '').replace(/\/+$/, '');
}

export function mediaStore() {
  return media;
}

// 对外前缀（`http://127.0.0.1:3110`）—— 工具结果里只出现这个和 agent 路径，
// **不出现任何宿主路径**。
export function mediaBaseUrl() {
  return apiBaseUrl;
}

// agent 看到的媒体根（配了 `media.agentRoot` 或能从 `chatlog.agentRoot` 推导出来时才有）。
// 它不含盘符、不含仓库位置，是 agent 自己的命名空间，给出去不会暴露宿主目录结构。
export function mediaAgentRoot() {
  return agentRoot;
}

// 存一份媒体，返回可访问的短地址（`/m/<id>`）。
//
// @param data              Buffer
// @param options.kind      KINDS 里的一类（image / audio / video / file / emoji）
// @param options.mimeType  不给则按 kind 兜底（图片 png，其余 octet-stream）
export function publish(data, { kind = 'image', mimeType = '', name = '', origin = '', baseUrl } = {}) {
  if (!media) throw new MediaError('媒体仓库还没初始化', { status: 500, code: 'no-store' });
  const mime = mimeType || (kind === 'image' ? 'image/png' : 'application/octet-stream');
  const meta = media.put({ data, kind, mime, name, origin });
  return mediaUrlOf(baseUrl ?? apiBaseUrl, meta.id);
}

// 一个消息段该用哪个**去重键**（`origin`）。
//
// ── 为什么必须只有一份实现
//
// **去重键是"同一张图只存一次"的唯一判据** —— 两份一旦分叉（比如一边
// lowercase 了文件名、另一边没有），同一张图会被存两遍，而症状只是配额
// 悄悄涨，没有任何报错。
//
// @param target   OneBot 的消息段 data（带 `file` / `url`）
// @param options.convKey 会话键（没有文件名时的兜底键）
// @param options.ref     消息引用（seq 或 messageId）
// @param options.index   同一消息里第几个
// @param options.kind    `'voice'` 时会加后缀 —— 语音与图片的 `file` 可能同名
//                        （QQ 有时用同一个资源 id），不加就不该判成同一条
// @returns 形如 `qqfile:<文件名>` 或 `group:1|1234|0` / `…:voice`
export function originOfMedia(target, {
  convKey = '', ref = '', index = 0, kind = '',
} = {}) {
  const fileKey = String(target?.file ?? '').trim().split('/').pop().toLowerCase();
  const base = fileKey ? `qqfile:${fileKey}` : `${convKey}|${ref}|${index}`;
  return kind ? `${base}:${kind}` : base;
}
