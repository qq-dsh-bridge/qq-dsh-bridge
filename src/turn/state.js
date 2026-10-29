// 会话状态机



import { detectTrigger, gateAllows, normalizeWho, triggerLabel } from './gate.js';
import { deliver } from './deliver.js';
import { TurnPool, MARKS, CURSORS } from './pool.js';
import { attachPoolFeed } from './pool-feed.js';
import { takeMessages } from './take.js';
import { createDecider } from '../prompt/decide.js';
import { Waits } from './wait.js';
import { mentionsId } from '../chatlog/segments.js';
import { dateOf, seqOf } from '../chatlog/store.js';
import { markReadByRefs, PHASES } from '../chatlog/read.js';

// `agentRunning` 多久没动静就判定"权威端已收摊"（毫秒）。
//
// 曾经读的是 `this.config.agentStaleMs` —— 一个**不存在**的配置项（既不在
// `stateConfig()` 里，也不在 schema 的 `chatlog` 段里），所以那个三元分支
// 永远走 else。现在改成显式常量：读一个不存在的键不会报错，只会静默固定，
// 而"以为自己在调一个旋钮"比"没有这个旋钮"更糟。
const AGENT_STALE_MS = 600_000;




export class ConversationState {

  // #region 构造与字段

  // 身份与配置都是**每次现取**（取值函数由 `config/facade.js` 提供）。
  // 直接传 `ownerQq` / `config` 的老写法仍然有效，当作常量 —— 测试与单机脚本用得上。
  //
  // ⚠️ 不要再引入"持有配置对象 + 就地改"的写法：门面给的是 deepFreeze 过的快照，
  //    改它会在严格模式下当场抛错（见 `config/facade.js` 文件头）。
  #getOwnerQq = null;
  #getConfig = null;
  #staticOwnerQq = '';
  #staticConfig = {};

  get ownerQq() {
    return this.#getOwnerQq ? this.#getOwnerQq() : this.#staticOwnerQq;
  }

  get config() {
    return this.#getConfig ? this.#getConfig() : this.#staticConfig;
  }

  constructor({ key, ownerQq = '', getOwnerQq, config = {}, getConfig, store, onDeliver, logger, judge, decideLog } = {}) {
    this.key = key;
    this.#staticOwnerQq = String(ownerQq ?? '');
    this.#staticConfig = config ?? {};
    this.#getOwnerQq = typeof getOwnerQq === 'function' ? getOwnerQq : null;
    this.#getConfig = typeof getConfig === 'function' ? getConfig : null;
    this.store = store;
    this.onDeliver = onDeliver;
    this.logger = logger;
    this.judge = judge ?? null;
    this.decideLog = decideLog ?? null;
    // 决策层：输入快照 + 两个入口 + 日志，全在 decide.js（这里只持有实例）。
    this.decider = createDecider({ judge: this.judge, decideLog: this.decideLog, logger });
    this.lastDeliverAt = 0;   
    this.gatedAt = 0;         
    // 等待生命周期（activeWait / 本轮额度都在里面）。
    this.waits = new Waits(this);
    this.awakeUntil = 0;
    this.agentRunning = false;
    // 权威端最后一次有声音的时刻（见 `sweep`）：state 创建时算一次。
    this.lastAliveAt = Date.now();
    this.turnPool = new TurnPool({
      identity: (m) => {
        const date = m?.date ?? dateOf(m?.tsMs);
        const seq = seqOf(m, date);
        return seq === undefined ? '' : `${date}#${seq}`;
      },
      onMarkRead: (refs) => markReadByRefs(this.store, refs, PHASES.PUSH),
      store: this.store,
    });
    this.stats = { woke: 0, delivered: 0, skippedNotTrigger: 0, skippedGate: 0, idleSleeps: 0, heldByDecide: 0 };
    this.idleTimer = null;
  }

  // 睡着 = 醒着窗口已过期（`awakeUntil` 是唯一真值）。
  get sleeping() {
    return Date.now() >= this.awakeUntil;
  }

  get awake() {
    return !this.sleeping;
  }

  // 等待对象 / 本轮已等时长：都在 wait.js，这里只转发（调用方不必知道拆过）。
  get activeWait() {
    return this.waits.activeWait;
  }

  get waitedTotalMs() {
    return this.waits.waitedTotalMs;
  }

  // #endregion


  // #region 醒着窗口（静默即回睡眠）

  #touchAwake() {
    this.awakeUntil = Date.now() + this.idleMs;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeWait) return;
      if (this.agentRunning) return;
      this.logger?.debug('醒着窗口到期，回睡眠', { key: this.key, idleMs: this.idleMs });
      this.stats.idleSleeps += 1;
      this.sleep();
    }, this.idleMs);
  }

  #clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.awakeUntil = 0;
  }

  // 对外的一口"它还醒着"：wait.js 开等待时用（`#touchAwake` 是私有的）。
  notifyActivity() {
    this.#touchAwake();
  }

  // 静默多久回睡眠（毫秒）。
  get idleMs() {
    return Number(this.config.idleMs) > 0 ? Number(this.config.idleMs) : 300_000;
  }

  // #endregion


  // #region 收消息：触发 → 闸门 → 投递 / 交给 wait

  // 处理一条**已经落库**的消息。
  //
  // 落库不在这一层 —— 见 `intake.js` 的 `persistMessage()`：只要桥接在跑，到达即落库。
  // 这里只做**反应**：本号判定 → 触发 → 闸门 → 投递 / 交给 wait。
  //
  // @param stored  落库后的记录（`store.append()` 的返回，带 `no`/`date`）
  // @param message 归一后的原始消息（`event` / `atSelf` 这些只用来判触发）
  // @param options.selfSent 是不是本号自己发出去的回推（由 intake 判好）
  // @returns `{ action, reason, delivery? }`
  //   action: 'buffered' | 'woke' | 'handed-to-wait' | 'notified-wait'
  async accept(stored, message, { selfSent = false } = {}) {

    // ⚠️ **进池不在这里做** —— 见 `pool-feed.js`：只要桥接在跑，落库的每一条都无条件进池
    //    （订阅 `store.appended`），与本函数的任何分支（睡眠/醒着、本号/别人）无关。

    // ① **本进程刚发出去的回推**：到此为止。
    //
    // 已经落库了（`intake.js`），而且**算已读**（自己说的话不是"欠读"的）。
    // 必须停在这里：不能触发（否则它会回应自己刚说的话，形成环）。
    //
    // ⚠️ 判定在 intake 里按 `stored.sender.qq` 做，**不用** `message.selfSent` —— 后者
    //    早就没有写入点（永远 undefined），这个分支曾一直静默失效：本号回推的
    //    `message_sent` 会被当成"欠读的新消息"，参与触发判定。
    if (selfSent) {
      return { action: 'buffered', reason: 'self-sent', seq: seqOf(stored, stored.date), date: dateOf(stored.tsMs) };
    }

    // 会话类型 —— **必须从 convKey 取，不能从 message 上取**。
    //
    // ⚠️ 旧实现写 `message.kind === 'private' ? …`，而 `message.kind` 是**消息类型**
    //    （text/image/…，现已改名 msgType），永远不等于 'private' ⇒ 这里**恒为 'group'**，
    //    `detectTrigger` 的私聊分支成了死代码 —— 私聊只能靠 @ 触发，而私聊里没人 @ 它。
    const kind = String(this.key).startsWith('private:') ? 'private' : 'group';
    const isOwner = String(message.sender?.qq ?? '') === String(this.ownerQq);

    // ② 触发判定（**只认 @**；私聊直接算）—— 只决定"睡眠时能不能叫醒它"。
    //
    // ⚠️ 引用**不算**触发：`REASONS.QUOTE` 已整条删除。群里互相引用是常态，
    //    一旦算触发就等于对满群消息都有反应，闸门形同虚设。
    // ⚠️ `atSelf` 不落盘，改为"segments 里的 at 有没有本号"，
    //    本号来自日文件顶层的 selfQq（store 实例持有它）。
    const reason = detectTrigger(
      message.event ?? {},
      kind,
      { atSelf: message.atSelf ?? mentionsId(stored, this.store.selfQq) },
    );

    const hasWait = Boolean(this.activeWait);

    // ① **wait 优先**：`qq_wait` 是**阻塞的工具调用**，它挂着的时候，
    //    一条消息该不该让它返回，判据是「`windowWho` 放行 ∪ `qq` 免 @ 名单」
    //    —— 全在 `Waits#allows` / `gate.js::waitHit` 里。
    //
    // ⚠️ **不能拿 `agentRunning` 当这个判据**（老实现是 `hasWait && agentRunning`）：
    //    agent 在等工具结果时，dsh 那边会报 `running=false`；桥接重启后更糟 ——
    //    会话映射要等下一次投递才建立，`agentRunning` 会一直是初始值 false。
    //    此时主人连发几条（没 @ 它）全被当成"未触发"塞进池子，wait 干等到超时。
    //    实测症状就是："qq_wait 挂着，你说话了，它没反应"。
    //
    //    "结果没人接"的风险不在这里兜 —— `Waits#settle` 里另有护栏：
    //    回合确实结束了就**不标已读**（消息留在池里，下次真投递照样带上）。
    const waiting = hasWait;

    if (waiting) {
      this.#touchAwake();       // 说上话了，窗口往后推
      this.waits.refresh();     // 有人说话就续命（不续命的话"正聊着"会被硬断）
      this.waits.notify(stored);
      return { action: 'handed-to-wait', reason, seq: seqOf(stored, stored.date), date: stored.date };
    }

    // ② **不在回合里**（睡着 / 刚收摊）→ 走 `triggerWho`。
    //
    // 这是"开一轮新投递（带 `[lines:N]` 那次）"的闸：**`triggerWho` 放行 且 这条 @ 了它**。
    // 两个都要 —— 放行是权限，`@` 是"在叫我"。
    if (!this.agentRunning) {
      const gateWho = normalizeWho(this.config.trigger?.who);
      const allowed = gateAllows(gateWho, message.sender?.qq, this.ownerQq) && Boolean(reason);
      if (!allowed) {
        // 未过闸：不更新水位、**也不续命**。
        if (!reason) this.stats.skippedNotTrigger += 1;
        else this.stats.skippedGate += 1;
        const why = reason ? 'gate' : 'not-triggered';
        return { action: 'buffered', reason: why, seq: seqOf(stored, stored.date), date: stored.date };
      }
      this.gatedAt = message.tsMs ?? Date.now();

      // 决策层（见 `prompt/judge.js`）。
      //
      //   shadow  → **不等它**，投递照旧，判完只记日志（判错的代价为零）
      //   enforce → 等它判完：`ignore` 就**不投递**，这条只留在池里
      //
      // 为什么 ignore 也不丢：消息已经入池，下次被叫醒时它照样出现在 `[lines:N]` 块里。
      // 所以"沉默"是零成本的，"判错"最多是"晚点再说"。
      const verdict = await this.decider.wake({
        conv: this.key,
        pool: this.turnPool,
        selfQq: this.store.selfQq,
        message: stored,
        isOwner,
      });
      if (verdict?.act === 'ignore') {
        this.stats.heldByDecide += 1;
        return {
          action: 'held',
          reason: 'decide',
          verdict: verdict.reason,
          seq: seqOf(stored, stored.date),
          date: stored.date,
        };
      }
      return this.#deliver({ reason, isOwner, message: stored });
    }

    // ③ **回合内、没在等** → 已经在池里了，什么都不做（模型马上会开 wait）
    this.logger?.debug('回合内、没在等 → 入池（等模型开 wait 时再按规则筛）', {
      conv: this.key, seq: seqOf(stored, stored.date), reason,
    });
    return { action: 'buffered', reason: 'pooled', seq: seqOf(stored, stored.date), date: stored.date };
  }

  // #endregion


  // #region 投递

  async #deliver({ reason, isOwner, message }) {
    // ⚠️ 必须在 `#touchAwake()` **之前**取：它就是"这一轮算不算新开的"。
    const woke = this.sleeping;
    if (woke) this.stats.woke += 1;

    // 投递 = 它要开口了 → 醒着窗口从现在起算。
    this.#touchAwake();

    const deliverLimit = this.config.wakeLimit ?? 60;
    // *投递的上下文也从池里取**（与 `qq_wait` 同一条取样路径）。
    //
    // 两种情况下都用唤醒的窗口（`wakeLimit`，默认 60）：早先醒着时改用 `replyLimit`（20）
    // 想省 token，但那会让它看不到"你 @ 它之前那几句没读到的"。
    //
    // 取样规则与 wait 完全一致：从最新往回、**跳过本号**、遇已读即停、池不够回库补。
    const { messages: contextItems } = takeMessages({ store: this.store, pool: this.turnPool, limit: deliverLimit });

    const delivery = deliver(this.store, {
      items: contextItems,
      triggerSeq: seqOf(message, message.date),
      triggerDate: message.date,
      maxChars: this.config.maxChars,
      // 取未读时最多回溯几天。⚠️ 这一项以前**没传** —— `deliver()` 于是落到
      // `DEFAULTS.maxDays = 7`，而 `stateConfig()` 带进来的 `chatlog.maxDays` 因此
      // *没有任何人读**：schema 里验着、控制台里摆着、改了毫无反应（典型"假旋钮"）。
      // 兜底仍在 `deliver()` 自己身上；`this.config` 是**现取的快照**（配置门面按 revision 记忆），天然跟着热重载走。
      maxDays: this.config.maxDays,
      // ⚠️ `selfQq` **必须传**：渲染层靠它把本号显示成〔本号〕、并在行尾标 `← @ 了你`。
      //    不传的话本号显示成普通昵称、"这条 @ 了你"的标记也不出现 —— 实测后果是
      //    模型看不出哪条在叫它，于是该回不回。来源是 store 实例（它持有日文件顶层的 selfQq）。
      selfQq: this.store.selfQq,
      // 管理者（你）—— 投喂时现算，**不落盘**：换人格卡 / 改配置下一轮立刻生效，
      // 历史记录里的标签不会跟着变（那会让旧数据说谎）。来源是配置 `owner.qq`。
      ownerQq: this.ownerQq,
    });

    this.lastDeliverAt = Date.now();
    this.stats.delivered += 1;

    const meta = {
      key: this.key,
      reason,
      label: triggerLabel(reason, isOwner),
      isOwner,
      woke,
      // 触发者身份 —— 提示词要给出来，免得 AI 自己去消息里找是谁叫的它。
      triggerBy: {
        qq: String(message.sender?.qq ?? ''),
        name: message.sender?.name ?? '',
        isOwner,
      },
    };


    if (this.onDeliver) {
      // ⚠️ **投递成功之后才标已读**：`readCount > 0` = "它看过了"，而 `deliver()` 只是
      //    拼提示词 —— 拼好了不代表送到了（会话不存在、流断了、onDeliver 抛错）。早先在
      //    `deliver()` 里标，后果是**投递失败那批被永久吞掉**（下次取未读直接跳过），
      //    而日志里一行错都没有。这里抛错时**不标**，保持未读、下次重投。
      try {
        await this.onDeliver(delivery, meta);
      } catch (error) {
        this.logger?.warn('投递失败 —— 不标已读，下次重投', {
          conv: this.key, count: delivery.items?.length ?? 0, error: String(error),
        });
        throw error;
      }
      // 只标**实际进了上下文的那批**（`delivery.items`）。
      if (delivery.items?.length) {
        // 只标**真正渲染出去的那些**：超 `maxChars` 会提前停止（truncated），被丢的行
        // 根本没进提示词，而旧写法标 `delivery.items` 全部 ⇒ 它们也成了"已读"、
        // 再也不会被投递（与"投递成功才标已读"是同一条规矩，这里漏了）。
        // 渲染是从**最新**往回攒的 ⇒ 取 items 的**尾部**。⚠️ `slice(-0)` 等价于
        // `slice(0)`（整段），所以 0 必须单独处理。
        const rendered = delivery.context?.count ?? 0;
        const shown = rendered > 0 ? delivery.items.slice(-rendered) : [];
        // ⚠️ **只调池**：存储里的 `readCount` 由 `onMarkRead` 回写 —— 池是标记的**唯一作者**
        //    （存储的两个更新端：SnowLuma 与 pool）。
        // 本号那批在取样时就被跳过了，所以这里天然不会给它们打标记。
        this.turnPool.markRead(shown);
        // *打交付记号** —— 与"标已读"是**两件独立的事**，所以故意放在 `try` **外面**：
        // 已读标失败（本地索引坏了）不会让"它真的看过了"变成没发生 —— 上面那句日志
        // 原话就是"消息已送达，不影响本轮"。放进同一个 `try` 的话，`markRead` 一抛
        // 就把记号一起吞了，下次 `qq_wait` 会因为这几条"未交付"立刻返回（假唤醒）。
        this.turnPool.mark(shown, MARKS.DELIVERED);
        // *推进 wait 判定水位线** —— 新投递成功同样意味着"这批已经交给它了"，
        // 下次开 `qq_wait` 不该再因为这些消息立刻返回（那是假唤醒）。
        //
        // 三个动作各管一层，缺哪件都出具体的怪事：
        //   · `pool.markRead`        → 池：这批"已读"（**顺带回写存储的 `readCount`**）
        //   · `mark(...DELIVERED)`   → 池：这批"真进过上下文"（逐条，与 `maxChars` 截断对齐）
        //   · `advancePast(WAIT)`    → 池：判定位置前移（一个数，见 `#poolWake`）
        this.turnPool.advancePast(CURSORS.WAIT, this.turnPool.all());
      }
    }

    // ⚠️ **这里不清池**：池是滑动窗口，条目要留给别的消费者（事件呈现、排障）。
    //
    // ⚠️ 推进 wait 判定水位线**放在上面 `if (this.onDeliver)` 里面**（紧挨着 `mark`）：
    //    没有真的投递出去，就不该前移判定位置 —— 否则那批消息会被 `qq_wait` 当成
    //    "已经处理过"，永远等不到它。

    return { action: woke ? 'woke' : 'delivered', reason, delivery, meta };
  }

  // #endregion


  // #region 等待（转发到 wait.js）

  // 开一次等待。生命周期（定时器 / 续命 / 叫醒 / 结算 / 标记）全在 `wait.js::Waits`，
  // 这里只留一个入口 —— 调用方（`api/handlers/read/wait.js`）不必知道它拆过。
  waitForMessages(options) {
    return this.waits.wait(options);
  }

  // #endregion


  // #region 睡眠与权威状态

  // 主动结束等待（外部中断，如进程退出）。窗口一起清掉 = 回睡眠态。
  cancelWait() {
    this.waits.cancel('cancelled');
    this.#clearIdle();
  }

  // 回到睡眠。AI 回合结束时调用（不再等，也不再投递）。
  sleep() {
    if (this.waits.activeWait) this.waits.cancel('sleep');

    this.#clearIdle();
    // ⚠️ **不要直接写 `agentRunning`**：`setAgentRunning` 才是唯一作者。
    //    直接赋值会让随后的权威状态事件因为"值没变"整段 return ——
    //    其中就包括 `waitedTotalMs` 清零，于是等待额度跨回合累积，最后
    //    `nextWaitMs()` 归零、`qq_wait` 永久秒返回。实测见 .tmp/state-baseline.mjs。
    this.setAgentRunning(false, 'sleep');
  }


  // 写"agent 是不是正在跑这个会话"（**权威**，来自 DSH 的 `api-session/status`）。
  // 它在忙时要把醒着窗口续上 —— 否则 AI 还在写回复、状态机已经睡了，它下一句会被丢掉。
  //
  // ⚠️ 判据不再是 turn 事件，所以**漏一个事件不再有后果**：原先那条"孤儿 `turn/end`
  //    不许改状态"的规则随之删除 —— 它之所以存在，是因为"配对"本身就是错的判据。
  //
  // @param running 权威状态（true = agent 正在跑）
  // @param source  来源（status / cache / …），只用于日志排查
  setAgentRunning(running, source = 'unknown') {
    const next = Boolean(running);
    // 时间戳先更新：哪怕状态没变，"权威端还活着"这个事实本身也要算数（见 `sweep`）。
    this.lastAliveAt = Date.now();
    if (this.agentRunning === next) return;
    this.agentRunning = next;
    this.logger?.debug('agent 运行状态', {
      conv: this.key, agentRunning: next, source, activeWait: Boolean(this.activeWait),
    });
    if (next) {
      // 它开始忙 → 醒着窗口从现在起算（忙期间不许回睡眠）。
      this.#touchAwake();
      return;
    }
    // *它收摊了 = 本轮会话结束** —— 正是"已退出本轮、Web 端需要重新投递提示词"的边界：
    //   · `qq_wait` 累计时长清零（下一轮重新有完整额度）
    //   · **缓存池不在这里清** —— 清池**只有两处**：等待结算（`wait.js`）和
    //     `#deliver`（新投递成功后）。在这里清 = 模型还没拿到这批、消息先被判死。
    //
    // ⚠️ **不能放在 `sleep()` 里清** —— 收尾时若有等待挂着，`main.js` 会**保持唤醒不 sleep**
    //    （"回合结束，但它正在等待新消息"），那种情况下这条"收摊"通知才是真正的边界。
    this.waits.resetBudget();
    if (!this.activeWait && this.awake) this.#touchAwake(); // 收尾时重新起算静默
  }

  // 权威端有一次活动（收到任何一帧）—— 只续命，不改状态。
  //
  // `sweep()` 的判据是"`agentRunning` 为真、但权威端长时间没声音"。
  // 由 wire-stream 在每帧（session.event / lifecycle / agent.status）里调。
  touchAlive() {
    this.lastAliveAt = Date.now();
  }

  // *权威状态看门狗**（registry 每分钟调一次）。
  //
  // 为什么需要：`agentRunning` 只由 dsh 的状态事件驱动。SSE 断过、漏一条，
  // 状态就**冻住** —— 冻在 true 就再也不投递（所有消息都走"回合内、没在等 → 只入池"），
  // 冻在 false 则会把回合中的消息当成新唤醒、重复投递。
  //
  // ⚠️ **有等待时不动**：`qq_wait` 一挂就是几十分钟（总上限 30 分钟），
  //    那期间本来就没有状态事件 —— 按"没声音"判死会把正常等待误伤成收摊。
  //    等待本身有超时兜底，不需要看门狗。
  //
  // ⚠️ 这个阈值**曾经是一个"读取不存在配置项"的死分支**：这里读过
  //    `this.config.agentStaleMs`，而 `stateConfig()` 从来没有这一项、
  //    `chatlog` 段里也没有这个键 —— 于是三元表达式的前半段永远为假，
  //    实际生效的总是 `600_000`。读一个不存在的键不会报错，只会静默固定。
  //    想让它可配：在 `schema.js` 的 `chatlog` 加 `agentStaleMs`，
  //    并同步 `config/state-view.js`（然后它自动就能按会话覆盖了）。
  //
  // @returns 是否发生了自愈（true = 从 true 拉回 false）
  sweep(now = Date.now()) {
    if (!this.agentRunning || this.activeWait) return false;
    if (now - (this.lastAliveAt || 0) < AGENT_STALE_MS) return false;
    this.logger?.warn('权威状态超时没声音：按已收摊处理', {
      conv: this.key, staleMs: AGENT_STALE_MS, lastAliveAt: this.lastAliveAt,
    });
    this.setAgentRunning(false, 'stale');
    return true;
  }

  // #endregion

  
  // #region 等待额度与快照

  // *这次 `qq_wait` 实际能等多久**（毫秒）：
  //   单次默认 `waitDefaultMs`（5 分钟），但**本轮所有 wait 累计**不超过 `waitMaxMs`（30 分钟），
  //   所以单次 = `min(默认值, 总上限 - 已累计)`。
  //
  // ⚠️ **AI 不能指定时长** —— `qq_wait` 的 schema 里已去掉 `timeoutMs` / `maxMs`：上限若由
  //    被限制的一方自己给，等于没有上限（传个 999999999 就绕过去了）。**它只能决定要不要 wait。**
  // ⚠️ **剩余极少时照样给它**（不做最小下限）：累计 29 分 59 秒、只剩 1 秒就等 1 秒 ——
  //    加下限分支只会多一条路径，而"白跑一趟"的代价只是它立刻收到 timeout、然后收摊。
  //
  // @returns 单次等待时长（毫秒）；**≤ 0 表示本轮额度已用完**
  nextWaitMs() {
    return this.waits.budgetMs();
  }

  snapshot() {
    return {
      key: this.key,
      // 派生值，只为控制台/原始 JSON 看得懂 —— 真值是 `awakeUntil`。
      state: this.sleeping ? 'sleeping' : 'waiting',
      waiting: Boolean(this.activeWait),
      awake: this.awake,
      awakeForMs: this.awake ? Math.max(0, this.awakeUntil - Date.now()) : 0,
      agentRunning: this.agentRunning,
      lastDeliverAt: this.lastDeliverAt,
      gatedAt: this.gatedAt,
      // 回合内缓存池里的条数（排障用：能看出"这批消息进没进池"）。
      pooled: this.turnPool.size,
      stats: { ...this.stats },
    };
  }

  // #endregion
}


// #region 多会话注册表


// 管理多个会话的状态机。启动时全部 sleeping（内存态，不落盘）。
export class ConversationRegistry {
  // 与 `ConversationState` 同一套：常量兜底 + 取值函数优先（取值函数来自配置门面）。
  #getOwnerQq = null;
  #getConfig = null;
  #staticOwnerQq = '';
  #staticConfig = {};

  get ownerQq() {
    return this.#getOwnerQq ? this.#getOwnerQq() : this.#staticOwnerQq;
  }

  get config() {
    return this.#getConfig ? this.#getConfig() : this.#staticConfig;
  }

  // @param options.onConversationCreated 新会话第一次出现时回调（用于按需登记 workspace）
  // @param options.resolveConfig `(convKey) => 状态机配置`
  //
  //   **会话覆盖层的注入点**（`config.sessions.json` 的 `chatlog.*` 部分）。
  //   不传时所有会话共用 `options.config`，行为与引入覆盖层之前完全一致。
  //   传了就对每个会话单独解析 —— 于是"这个群只认主人、那个群认所有人"成立。
  constructor({
    ownerQq = '', config = {}, getOwnerQq, getConfig,
    resolveConfig, storeFor, onDeliver, onConversationCreated, logger, judge, decideLog,
  } = {}) {
    // 与 `ConversationState` 同一套：常量兜底 + 取值函数优先。
    this.#staticOwnerQq = String(ownerQq ?? '');
    this.#staticConfig = config ?? {};
    this.#getOwnerQq = typeof getOwnerQq === 'function' ? getOwnerQq : null;
    this.#getConfig = typeof getConfig === 'function' ? getConfig : null;
    this.resolveConfig = typeof resolveConfig === 'function' ? resolveConfig : null;
    this.storeFor = storeFor;
    this.onDeliver = onDeliver;
    this.onConversationCreated = onConversationCreated;
    this.logger = logger;
    // 决策层 —— 每个会话共用同一个（无状态，只持有 system 与 key 缓存）。
    this.judge = judge ?? null;
    this.decideLog = decideLog ?? null;
    this.conversations = new Map();
    // 看门狗：每分钟让每个会话检查一次"权威状态是不是冻住了"。
    // unref = 这个定时器不该拖着进程不让退出。
    this.watchdog = setInterval(() => {
      for (const c of this.conversations.values()) {
        try {
          c.sweep();
        } catch (error) {
          this.logger?.warn('状态看门狗异常', { key: c.key, error: String(error) });
        }
      }
    }, 60_000);
    this.watchdog.unref?.();
  }

  // 某个会话该用的状态机配置。
  //
  // 没有覆盖层时返回全局那份；有覆盖层时返回该会话自己那份（都由配置门面记忆）。
  //
  // 这里**不缓存**：门面按 revision 记忆，热重载后自然就是新对象。
  resolveFor(key) {
    if (!this.resolveConfig) return this.config;
    try {
      return this.resolveConfig(key) ?? this.config;
    } catch (error) {
      // 解析失败绝不能静默回退到"空配置" —— 那会让闸门失去判据。
      this.logger?.warn('会话配置解析失败，退回全局配置', { key, error: String(error) });
      return this.config;
    }
  }

  // 取（或按需创建）一个会话状态机。
  //
  // 会话拿的是**取值函数**而不是配置对象：于是热重载不需要"推给每个会话"，
  // 也不会出现"对象被就地改/被替换"两套语义并存的情况。
  get(key) {
    let c = this.conversations.get(key);
    if (!c) {
      const store = this.storeFor(key);
      c = new ConversationState({
        key,
        getOwnerQq: () => this.ownerQq,
        getConfig: () => this.resolveFor(key),
        store,
        onDeliver: this.onDeliver,
        logger: this.logger,
        judge: this.judge,
        decideLog: this.decideLog,
      });
      // *落库 → 池**：桥接在跑就无条件喂（见 `pool-feed.js`）。
      // 放在"建会话"这一处是因为 store 与 pool 都是**每会话一个**，绑定是 1:1 的；
      // 它不属于消息处理流程（`receive`），也不该受回合状态影响。
      attachPoolFeed(store, c.turnPool);
      this.conversations.set(key, c);
      this.logger?.debug('已创建会话状态机', { key, sleeping: c.sleeping });
      // 新会话第一次出现 → 通知外层（用于按需把它登记成 DSH workspace）。
      // 放在这里而不是投递路径上：会话一出现就该有归属，不必等到被唤醒。
      try {
        this.onConversationCreated?.(key);
      } catch (error) {
        this.logger?.warn('新会话回调失败', { key, error: String(error) });
      }
    }
    return c;
  }

  // 路由一条消息到对应会话（**只取状态机**；落库由调用方先做，见 `intake.js`）。
  conversationFor(convKey) {
    return this.get(convKey);
  }

  // 所有会话快照（控制台用）。
  snapshot() {
    return [...this.conversations.values()].map((c) => c.snapshot());
  }

  // 热重载配置。
  //
  // 现在**只更新兜底值**：会话拿的是取值函数（`getConfig: () => resolveFor(key)`），
  // 它们下次取值时自然就是新配置 —— 不再需要"逐个会话重新赋值"。
  //
  // 保留这个方法是为了兼容"直接构造 registry 并传死人配置"的用法（测试、脚本）。
  applyConfig(config) {
    this.#staticConfig = config;
  }

  // 退出时清理。
  shutdown() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const c of this.conversations.values()) c.cancelWait();
  }
}

// #endregion
