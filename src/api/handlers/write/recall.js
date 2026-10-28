// 撤回消息 —— 支持一次撤多条。

export const op = 'recall';
export const needsAllow = true;
export const logsAsSend = true;

import { seqOf } from '../../../chatlog/store.js';

// 把入参拍平成队列（只认 seq）；一个都没给就报错。
function targetsOf(args) {
  const out = [];
  const push = (v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) { for (const one of v) push(one); return; }
    out.push({ kind: 'seq', value: v });
  };
  push(args?.seq);

  if (!out.length) {
    // 模型很可能还在照着旧描述填 messageId —— 明说该填什么，别只报"缺参数"。
    const hint = args?.messageId !== undefined
      ? '（`messageId` 已不再接受 —— 它从来不给你，定位符只有 `seq`。）'
      : '';
    throw new Error(`要撤哪条？传 \`seq\`（消息行首 [seq] 里那个）；要撤多条就传数组，如 \`seq: [1234, 1235]\`。${hint}`);
  }
  return out;
}

export async function run({ registry, http, logger }, convKey, args) {
  const conv = registry.get(convKey);
  // ⚠️ **只通过池定位，不直读存储**（存储的读入口只有池这一层）。
  //
  // `pool.find()` 本身是"内存优先、回源兜底"，所以即使那条已经被窗口挤掉也找得到；
  // 但 recall 实际永远命中内存 —— QQ 只允许 2 分钟内撤回，2 分钟的内容必定还在窗口里。
  const pool = conv.turnPool;
  // `selfQq` 是账号身份（配置级），不是历史数据 —— 池把它透出来，工具层不必摸 store。
  const selfQq = pool.selfQq;

  const targets = targetsOf(args);
  const results = [];

  // 一条的处理，**不抛错**：任何失败都落进这条自己的结果里。
  //
  // 为什么改成这样：多条撤回时，抛错会让整次调用失败，模型拿不到"哪几条成功了"，
  // 只能整批重来 —— 而重来那几条已经撤掉了，QQ 会再报一次错。
  const recallOne = async ({ value }) => {
    const label = `seq=${value}`;

    // ① 定位（拿 messageId + 校验是不是自己发的）
    let found = null;
    try {
      found = pool.find(value);
    } catch (error) {
      return { seq: value, error: `按 ${label} 查消息出错：${error?.message ?? error}` };
    }
    if (!found) {
      return {
        seq: value,
        notRecalled: true,
        error: `按 ${label} 找不到这条消息 —— 不在近期窗口里（多半已经超过撤回时限）。`,
      };
    }

    const target = { ...found.message, date: found.date };
    const key = seqOf(target, target.date);

    if (target.state?.recalled) {
      return { seq: key, recalled: 0, note: '这条**已经被撤回过**了，不用再撤。' };
    }
    if (!target.messageId) {
      return { seq: key, notRecalled: true, error: '没有 message_id（可能是老数据），撤不了。' };
    }

    // ② 只许撤自己发的。
    //
    // ⚠️ `selfQq` 为空时**不能放行** —— 那说明 store 没拿到本号，
    //    此时任何判定都不可靠（fail-closed）。
    const who = String(target.sender?.qq ?? '');
    if (selfQq === '') {
      return { seq: key, notRecalled: true, error: '不知道本号（selfQq 为空），无法确认这条是不是你发的，拒绝撤回。' };
    }
    if (who !== selfQq) {
      return {
        seq: key,
        notRecalled: true,
        error: `是${target.sender?.name || who}发的，**不是你发的** —— 只能撤回自己的消息。`
          + '（撤回别人的属于群管理行为，本桥接不提供。）',
      };
    }

    // ③ 真的撤
    try {
      await http.deleteMessage(target.messageId);
    } catch (error) {
      // OneBot 的 retcode 往往只有数字 —— 加一句人话，免得模型反复重试同一个不可能的请求。
      const raw = String(error?.message ?? error);
      const tooLate = /retcode/.test(raw) || /time|超时|过期|expire/i.test(raw);
      return {
        seq: key,
        notRecalled: true,
        error: raw + (tooLate ? '（多半是超过 2 分钟撤回时限了 —— 别再重试这条。）' : ''),
      };
    }

    logger.info('已撤回自己的消息', { conv: convKey, seq: key, msgId: target.messageId });
    return { seq: key, recalled: 1 };
  };

  for (const t of targets) results.push(await recallOne(t));

  // ④ **不在这里写存储** —— 等 SnowLuma 回推 `group_recall` / `friend_recall`。
  //
  // 存储只有两个更新端：SnowLuma（新事实）和 pool（标记回写）。"我撤了"的权威版本在
  // 回推里（`dispatch.js` → `store.recall`，幂等）；这里再写一份就多出第三个写入端。

  const count = (k) => results.filter((r) => r[k] === 1).length;
  const recalled = count('recalled');
  const failed = results.filter((r) => r.error).length;
  const notRecalled = results.filter((r) => r.notRecalled).length;

  // 单条时保留旧字段（`recalled` 是数字、`seq`、`note`）—— 只撤一条的场景最多，别让它退化成数组形状。
  if (results.length === 1) {
    const one = results[0];
    const base = { recalled: one.recalled ?? 0, seq: one.seq, messages: results };
    if (one.error) return { ...base, failed: 1, notRecalled: 1 };
    if (one.note) return { ...base, note: one.note };
    return {
      ...base,
      failed: 0,
      notRecalled: 0,
      note: '撤掉了。注意 QQ 只允许撤回约 2 分钟内发出的消息 —— 这条赶上了。',
    };
  }

  return {
    recalled,
    failed,
    notRecalled,
    messages: results,
    note: recalled === results.length
      ? `全部撤掉了（${recalled} 条）。`
      : `撤掉 ${recalled} 条，没撤 ${results.length - recalled} 条 —— 原因写在各自的 error / note 里；`
        + '只补那些失败的，别整批重来（成功的再撤一次会报"已撤回"）。',
  };
}
