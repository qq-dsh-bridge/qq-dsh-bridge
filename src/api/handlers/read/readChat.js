// 查聊天记录 —— 支持时间 / 发言者 / 已读轮次 / 未读 / 关键词等筛选。
//
// 只读操作。它是 AI "往前翻上下文"的唯一入口（提示词里只给最近一段，
// 更早的必须靠它查）。实现见 `chatlog/query.js`。
import { readChat } from '../../../chatlog/query.js';

export const op = 'readChat';

export function run({ poolFor }, convKey, args) {
  return readChat(poolFor(convKey), args);
}
