// 投递流水线：聊天记录 store、运行时快照、以及"投给 DSH 的那一下"。
//
// 它们的共同点是**属于业务而非装配**：
import fs from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../chatlog/store.js';
import { buildPrompt } from '../prompt/build.js';

// 会话键 → ChatStore（按需创建，缓存复用）。
//
// @param chatlogRoot 已解析成绝对路径的工作区根
// @param selfQq      SnowLuma 自动发现的本号（可能为空）
// @param getConfig   `() => 当前配置` —— getter 而不是快照，理由见 main.js 的说明
// @returns `{ storeFor, stores }` —— `stores` 还要给退出路径 flush 用
export function createStoreFor({ chatlogRoot, logger, selfQq, getConfig }) {
  // 会话键 → ChatStore（按需创建，缓存复用）。
  const stores = new Map();
  const storeFor = (convKey) => {
    let s = stores.get(convKey);
    if (!s) {
      // ⚠️ `selfQq` 必须传进去 —— 它写到日文件顶层，是新结构里
      // 判定"这条 @ 了我没有"的**唯一依据**（atSelf 字段已删）。
      //
      // 来源是 SnowLuma 自动发现的 selfQq（endpoints.selfQq），
      // 而不是配置里可能为空的 snowluma.selfQq。
      s = new ChatStore({
        root: chatlogRoot,
        convKey,
        logger,
        // 运行期读取 → 用 store.get()（改配置后新建的会话立刻用新值）
        selfQq: selfQq || getConfig().snowluma.selfQq || '',
      }).init();
      stores.set(convKey, s);
    }
    return s;
  };

  return { storeFor, stores };
}


// 造"真正投递"的回调（拼提示词 → 进 DSH 队列）。
//
// ⚠️ `getStream` / `getRegistry` 是**晚绑定**的 getter，不是笔误：
//    这个回调是在 `new ConversationRegistry({ onDeliver })` 的**参数里**造出来的，
//    而 `registry` 要等那次构造返回、`stream` 更是排在 registry 之后 ——
//    用 getter 才能在**调用时**（那时两者都已就绪）拿到它们。
//    直接传值会是 undefined；靠闭包引用 `const` 也能work，但 getter 把
//    "我现在还拿不到"这个意图写在了签名上，读代码的人不用去猜时序。
export function createDeliverHandler({ deliverer, logger, getConfig, getStream, getRegistry }) {
  // 真正投递：拼提示词 → 进 DSH 队列。
  return async function onDeliver(delivery, meta) {
    // 人设、边界、消息格式、工具用法都在 system prompt 层（qq-prompt-sections 插件），
    // 这里只把**这一轮的事实**拼成 user 消息 —— 见 prompt/build.js 的文件头。
    const prompt = buildPrompt({ delivery });

    // ⚠️ 状态机取值一起记 —— 这是**唯一**能判定"该不该投递"的证据。
    //
    // 投递只在 `agentRunning === false` **且** `activeWait === null` 时发生
    // （见 state.js 的分支）。`agentRunning` 现在**直接来自 DSH 的权威状态**
    // （插件的 `agent.status` 帧），不再由 `turn/start` / `turn/end`
    // 推断 —— 所以若日志出现 `agentRunning=false activeWait=false` 而 DSH 那边在排队，
    // 要查的是**状态通道本身**（断了？没重订阅？启动对账没跑？），而不是再去怀疑 turn 边界。
    const snap = getRegistry().get(meta.key);
    logger.info('投递', {
      conv: meta.key,
      trigger: meta.label,
      woke: meta.woke,
      lines: delivery.context.count,
      chars: prompt.length,
      unreadLeft: delivery.remainingUnread,
      agentRunning: snap?.agentRunning,
      activeWait: Boolean(snap?.activeWait),
      sleeping: snap?.sleeping,
      pooled: snap?.pooled,
    });
    logger.debug('提示词全文', { prompt });

    try {
      const r = await deliverer.deliver(meta.key, prompt);
      logger.debug('投递完成', { conv: meta.key, sessionId: r.sessionId });
      // 投递之后必须确认该会话已进事件流 —— 一条 SSE 连接承载的会话集合是固定的，
      // 新会话要重连才进得来（HostEventStream.follow 会自己重连）。
      getStream().follow(r.sessionId);
    } catch (error) {
      // 投递失败必须可见，且不能把状态机卡在 waiting。
      logger.error('投递失败', { conv: meta.key, error: String(error) });
      getRegistry().get(meta.key).sleep();
    }
  };
}
