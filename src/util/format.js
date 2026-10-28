// 纯格式化助手（无依赖、无副作用）。
//
// 这几个函数原先各有 1~2 份**逐字相同**的副本散在 handler 里：
//   · humanSize   api/handlers/read/getMessageContent.js
//   · charCount   setGroupCard.js / setNickname.js
// 副本的代价不是代码行数，而是口径悄悄分叉 —— 同一个字节数在两处显示成
// "1.5 MB" 与 "1.50 MB"，模型看到的就是两种事实。
//
// 这里曾有一个 `summarize(value)`（JSON 压成 200 字）—— **已删**：没有任何
// 消费方，而它的名字又太泛，容易被误当成"日志摘要"的通用入口。

// QQ 消息的 `time` 是**整秒**，这里只取时分（`15:07`）。
export function clockOf(seconds) {
  const d = new Date((Number(seconds) || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 字节数 → 人能读的量级。
//
// 只分到 MB：媒体单类上限最大 64 MB（见 `media/kinds.js`），再往上没有必要分档。
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 按**码点**数长度。
//
// ⚠️ 不能用 `text.length`：那是 UTF-16 码元数，emoji 与部分汉字是代理对
//    （`'😀'.length === 2`），会让"改群名片/昵称不能超过 N 字"的校验误判。
export function charCount(text) {
  return [...String(text ?? '')].length;
}
