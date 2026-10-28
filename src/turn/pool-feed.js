// *落库 → 池** 的喂料：只要桥接在跑，每条落库的消息都无条件进池。
//
// ── 为什么单独一个文件，而不是写在 `receive()` 里
//
// 这是一条**事实订阅**，不是"处理一条消息"的其中一步。它不关心：
// 谁在处理、回合跑没跑、睡眠还是醒着、是不是本号发的 —— 只关心"库里有了它"。
//
// 写在 `receive()` 里就会把"池里有什么"绑在"这条消息走完了哪条分支"上。已经踩过两次：
//   · 早先套着 `if (this.agentRunning)` ⇒ 睡眠期到达的消息根本不进池；
//   · 本号回推在 `readCount = 1` 那个分支就 `return` 了 ⇒ 自己的消息永远进不了池。
//
// ── 为什么订阅 `appended` 事件，而不是让每个调用方自己 add
//
//   · 落库入口不止一个（`dispatch.js` 的收消息、`send.js` 记自己发出去的消息）；
//     挨个去调必然漏 —— 漏的那条会让 `#takeMessages` 的池路径缺一段、退化成每次扫库。
//   · `append()` 自带去重：同一 `msgSeq`（私聊是 `messageId`）重复 append 会直接返回
//     旧记录、**不重复发事件**，所以订阅方不必再判重。
//
// ── 用这个模块的唯一要求
//
// 在**创建会话**的地方调一次 `attachPoolFeed(store, conv.turnPool)`（见
// `ConversationRegistry.get`）。池是每个会话一个、store 也是，所以这个绑定是 1:1 的。

// 把 store 的 `appended` 事件接到池上。
//
// @param store ChatStore（必须已 `init()`，`append()` 会发事件）
// @param pool  TurnPool（这个会话的那个）
// @returns 解绑函数 —— 测试/热重载时用；正常进程不用管
//
// ⚠️ 池是**滑动窗口**（默认 500 条）：喂得太早或太晚都不影响正确性，只有**漏喂**才有害。
// ⚠️ 这里**不做任何过滤**（不看发送者、不看回合状态）：过滤是**取样**时的事
//    （`#takeMessages` 跳过本号、按已读边界停），不是入池时的事。
export function attachPoolFeed(store, pool) {
  if (!store || typeof store.on !== 'function') {
    throw new TypeError('attachPoolFeed: 第一个参数要是 ChatStore（得能 on/off）');
  }
  if (!pool || typeof pool.addMessage !== 'function') {
    throw new TypeError('attachPoolFeed: 第二个参数要是 TurnPool');
  }

  const onAppended = ({ message } = {}) => {
    if (message) pool.addMessage(message);
  };

  store.on('appended', onAppended);
  return () => store.off('appended', onAppended);
}
