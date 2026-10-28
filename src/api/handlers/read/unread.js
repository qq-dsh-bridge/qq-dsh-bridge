// 未读概览。
//
// AI 每次被唤醒时先看它（"还有多少没读"），再决定要不要用 `readChat` 细查。
// 只读操作 —— 既不需要白名单（它不写任何东西），也不记发送类日志。
import { unreadOverview } from '../../../chatlog/query.js';

export const op = 'unread';

export function run({ poolFor }, convKey) {
  return unreadOverview(poolFor(convKey));
}
