// 配置 → 状态机形状。
//
// 为什么单独一个文件（而不是留在 `main.js` 里）：它是**配置与状态机之间的
// 适配层** —— 字段名一改必须两边同时改，放在 `config/` 下更容易在改动时被看到：
//
//   · `config/schema.js`   这些字段的**来源**（以及默认值）
//   · `turn/state.js`   这些字段的**含义**（`ConversationState` 怎么用它们）

// 从配置抽出状态机需要的形状。
export function stateConfig(chatlog) {
  return {
    trigger: { who: chatlog.triggerWho },
    window: { who: chatlog.windowWho },
    wakeLimit: chatlog.wakeLimit,
    replyLimit: chatlog.replyLimit,
    maxDays: chatlog.maxDays,
    maxChars: chatlog.maxChars,
    waitDefaultMs: chatlog.waitDefaultMs,
    // 等待的总上限（滑动窗口封顶，防"活跃的群永不超时"）。
    waitMaxMs: chatlog.waitMaxMs,
    // 醒着窗口长度（静默多久回睡眠）。
    idleMs: chatlog.idleMs,
  };
}
