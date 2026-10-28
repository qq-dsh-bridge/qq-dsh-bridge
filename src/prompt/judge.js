// 决策层 —— 判断"这一轮她要不要开口"。
//
// ── 为什么要有它
//
// 提示词里写「@ 你 ≠ 必须回」没有用：实测 88–96% 的 @ 仍在 60 秒内被回。
// 原因不是模型判断力差 —— 离线测过，同一个模型在"没叫她"的场景里 96% 判"不该开口"。
// 差别在于**判断被夹在生成里**：一旦这一轮的任务是"写点什么"，它就不判了。
//
// 所以把判断拆出来单独问一次：给短上下文、要 JSON、不给工具。
//
// ── 为什么把人设卡放进 system
//
// 判断"该不该说"需要知道她是谁，光靠一段摘要不够贴。实测 2593 字的卡节选进 system 后
// *1664 / 1841 token 命中前缀缓存**，credit 从 0.03 掉到 0.01，延迟 1.6s。
//
// ⚠️ **这里不写死任何一个角色**：名字来自当前启用的角色（`roles/*.md`），"她能干什么"
//    来自配置，卡取哪几节也来自配置。换角色只需要换角色文件 + 配置，不改代码。
import crypto from 'node:crypto';
import fs from 'node:fs';

// 按标题切角色卡。
//
// @param markdown 角色卡全文
// @param keys     命中哪些标题（`startsWith` 或包含）。**空 = 整张卡**
export function pickSections(markdown, keys = []) {
  const text = String(markdown ?? '');
  if (!keys.length) return text.trim();

  const lines = text.split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) heads.push(i);
  }
  const out = [];
  for (let k = 0; k < heads.length; k += 1) {
    const title = lines[heads[k]];
    if (!keys.some((p) => title.includes(p))) continue;
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    out.push(lines.slice(heads[k], end).join('\n').trim());
  }
  return out.join('\n\n');
}

// 唤醒点的任务说明 —— 名字与"她能干什么"由调用方给。
function taskWake({ name, capabilities }) {
  return `────────────────────────
你是「${name}」的决策层，不是写手 —— **你不写回复，只判断这一轮她要不要开口**。

判断标准照上面那份人设来：
- 该开口：有人真的在跟她说话（问她事、找她办事、接她的话），而且她按人设**愿意**接。
- 不该开口：别人之间的对话（哪怕提到她）；玩梗带她、只是叫一声名字；命令句（"说""快点""发我"）；
  她已经拒绝过的事被追问；她刚连着说了好几条；纯图片/表情/无文字。
- **服从明确的叫停**：有人说"别回""闭嘴""别理我""这条不要放"→ 那就是明确要她**不开口**。
${capabilities ? `- **她能给的**：${capabilities} —— 落到这些话题上，多半该开口。\n` : ''}- 管理者 @ 她通常是例外（人设里怎么写的就怎么办）。

拿不准时倾向 **ignore** —— 她不说话没有任何代价，群里看不到痕迹。

只输出 JSON，不要别的内容：
{"act":"reply","reason":"十五字以内"} 或 {"act":"ignore","reason":"十五字以内"}`;
}

// wait 返回那条路用的任务说明 —— **暂未接线**，措辞与唤醒点同源。
function taskWait({ name }) {
  return `────────────────────────
你是「${name}」的决策层。她正在等，你只判断这一批新消息**值不值得打断等待**。

- 该返回：有人明确在跟她说话（@ 她、引用她、叫她名字并提问）；管理者说话；她等的那个人说了与她相关的内容。
- 继续等：只是群友之间在聊；玩梗、刷屏、表情；她等的人只是随便说了句不相干的。

注意：继续等**不等于漏消息** —— 这些会留在池子里，下次返回时一起给她。所以拿不准时选"继续等"。

只输出 JSON：{"act":"return","reason":"十五字以内"} 或 {"act":"keep","reason":"十五字以内"}`;
}

// 把一批消息拍成"给人看的几行"。
function renderLines(list, selfName) {
  return list.map((m) => {
    const who = m.self ? selfName : (m.who || '某人');
    const ago = m.secsAgo === undefined ? '' : `${m.secsAgo}秒前`;
    return `[${ago}][${who}] ${m.text}`;
  }).join('\n');
}

// 创建一个决策器。
//
// ── 按会话取值
//
// `decide.*` 里的 `mode` / `ownerAlways` / `maxRecentLines` / `capabilities` /
// `cardSections` / `cardMaxChars` 都可以按会话覆盖（见 config/sessions.js 的白名单）。
// 于是"这个群严、那个群松"成立 —— 但 system 也随之**每个会话各一份**，
// 所以下面的 state 是 `convKey → 快照` 的表，不是一个全局变量。
//
// 所有取值函数都**带 convKey**；不传 = 走全局配置（老调用点/脚本仍然可用）。
//
// @param options.getConfig    取全局配置（`() => config`）
// @param options.getConfigFor 取**某个会话**的生效配置（`(convKey) => config`）；
//                             不传则退化为 getConfig()
// @param options.getRoleName  全局角色名（`() => name`）
// @param options.getRoleFor   某个会话的角色名（`(convKey) => name`）；不传退化
// @param options.logger
// @param options.cardPath     角色卡路径。**收 convKey**（`(convKey) => path`），
//                             这样每个会话取自己那张卡；旧的无参函数也能用
export function createJudge({
  getConfig, getConfigFor, getRoleName, getRoleFor, logger, cardPath,
} = {}) {
  const configOf = (convKey) => {
    if (typeof getConfigFor === 'function') return getConfigFor(convKey) ?? {};
    return typeof getConfig === 'function' ? (getConfig() ?? {}) : {};
  };
  const cfg = (convKey) => (configOf(convKey)?.decide ?? {});
  const cardPathOf = (convKey) => {
    if (typeof cardPath !== 'function') return cardPath;
    // 老调用点的 `() => path` 会把 convKey 丢掉，不影响；新调用点用它按会话取卡。
    return cardPath(convKey);
  };
  const roleNameOf = (convKey) => {
    if (typeof getRoleFor === 'function') return String(getRoleFor(convKey) || '') || '角色';
    return String((typeof getRoleName === 'function' ? getRoleName() : '') || '角色');
  };

  // convKey → 快照。键 `''` 表示"全局"（不传 convKey 的调用）。
  const states = new Map();
  let keyCache = { value: '', at: 0 };
  // 正在判的会话集合（**按会话**，不是一个全局布尔）。
  //
  // 为什么要按会话：早先用 `inflight >= 1` 全局互斥，于是 A 群在判的时候
  // B 群的 @ 直接拿到 `busy` 并放行 —— 多群同时说话时判定层等于半瘫。
  // 按会话互斥仍然是"同一个群不排队、宁可少判一次"那个立场。
  const inflight = new Set();

  // 拼一个会话的 system（两套：唤醒点 wake / wait 返回点 wait）。
  //
  // 任何一项（卡路径 / 卡修改时间 / 角色名 / 节选 / 上限 / 能力）变了就重建，
  // 否则复用 —— 正常路径下这是一次字符串比较。
  function stateFor(convKey) {
    const c = cfg(convKey);
    const path = cardPathOf(convKey) || '';
    let mtime = 0;
    try {
      mtime = fs.statSync(path).mtimeMs;
    } catch {
      mtime = 0;
    }
    const roleName = roleNameOf(convKey);
    const max = Math.max(200, Number(c.cardMaxChars) || 3000);
    const sections = Array.isArray(c.cardSections) ? c.cardSections : [];
    const caps = String(c.capabilities ?? '');
    const stamp = `${path}|${mtime}|${roleName}|${max}|${sections.join(',')}|${caps}`;

    const hit = states.get(convKey);
    if (hit && hit.stamp === stamp) return hit;

    let raw = '';
    if (path) {
      try {
        raw = fs.readFileSync(path, 'utf8');
      } catch (error) {
        logger?.warn('决策层：角色卡读不到，判断将退化为"只看上下文"', { path, conv: convKey, error: String(error) });
      }
    }

    const card = pickSections(raw, sections).slice(0, max);
    const head = card ? `${card}\n\n` : '';
    const fallback = '按"是个有自己脾气的人"来';
    const wake = head + (card
      ? taskWake({ name: roleName, capabilities: caps })
      : taskWake({ name: roleName, capabilities: caps }).replace('照上面那份人设来', fallback));
    const wait = head + taskWait({ name: roleName });

    const built = {
      stamp,
      roleName,
      cardChars: card.length,
      wake,
      wait,
      hashes: {
        wake: crypto.createHash('sha1').update(wake).digest('hex').slice(0, 12),
        wait: crypto.createHash('sha1').update(wait).digest('hex').slice(0, 12),
      },
    };
    states.set(convKey, built);
    return built;
  }

  // 取 API key：内联 → 文件（按 ref 抠）→ 环境变量。缓存 60 秒，轮换 key 不用重启。
  function apiKey(c) {
    if (c.apiKey) return c.apiKey;
    if (Date.now() - keyCache.at < 60_000 && keyCache.value) return keyCache.value;
    let value = '';
    if (c.apiKeyFile) {
      try {
        const text = fs.readFileSync(c.apiKeyFile, 'utf8');
        const ref = String(c.apiKeyRef || 'WB2API_KEY').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        value = text.match(new RegExp(`${ref}:\\s*(\\S+)`))?.[1] ?? '';
      } catch {
        value = '';
      }
    }
    if (!value) value = String(process.env.QQ_DECIDE_API_KEY ?? '');
    keyCache = { value, at: Date.now() };
    return value;
  }

  // 判定层对某个会话是否启用。
  function enabledFor(convKey) {
    const mode = cfg(convKey).mode;
    return mode === 'shadow' || mode === 'enforce';
  }

  // 判一次。
  //
  // @param {object} input
  // @param {string} input.convKey 哪个会话（决定用哪套覆盖后的配置与人设卡）
  // @param {'wake'|'wait'} input.kind
  // @param {Array<{who:string,text:string,secsAgo?:number,self?:boolean}>} input.recent 最近若干条（旧→新）
  // @param {object} input.trigger 触发那条 `{ who, text, atMe, isOwner }`
  // @param {object} input.state 她的状态 `{ sinceSelfSec, todayCount }`
  async function decide({ kind = 'wake', recent = [], trigger = {}, state = {}, convKey = '' } = {}) {
    const c = cfg(convKey);
    if (!enabledFor(convKey)) return { act: 'off', reason: '', ms: 0 };
    const sys = stateFor(convKey);

    const key = apiKey(c);
    if (!key) return { act: 'error', reason: '没有 apiKey', ms: 0 };
    // 同一个会话同时只判一个：第二个进来直接跳过（宁可少判一次，也不排队拖时间）。
    if (inflight.has(convKey)) return { act: 'busy', reason: '', ms: 0 };
    inflight.add(convKey);

    const max = Math.max(1, Number(c.maxRecentLines) || 8);
    const lines = renderLines(recent.slice(-max), sys.roleName);
    const parts = [];
    if (lines) parts.push(`【最近 ${Math.min(recent.length, max)} 条】\n${lines}`);
    parts.push(
      `${kind === 'wait' ? '【这一批】' : '【这一条】'}\n`
      + `[${trigger.who || '某人'}${trigger.atMe ? '，@了她' : ''}${trigger.exempt ? '，是她等的人（免@名单）' : ''}] ${trigger.text || ''}`,
    );
    const since = Number(state.sinceSelfSec);
    parts.push(
      '【她的状态】'
      + (Number.isFinite(since) ? `距上次发言 ${since} 秒；` : '还没说过话；')
      + `今天在这个群已发 ${Number(state.todayCount) || 0} 条`,
    );

    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(500, Number(c.timeoutMs) || 3000));
    try {
      const res = await fetch(`${String(c.apiBase || 'http://127.0.0.1:7863/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: c.model || 'cn:deepseek-v4.1-flash',
          messages: [{ role: 'system', content: sys[kind === 'wait' ? 'wait' : 'wake'] }, { role: 'user', content: parts.join('\n\n') }],
          temperature: 0,
          // *关掉思考**（`thinking: {type:'disabled'}` 是网关唯一认的写法，其他几种都无效 —— 实测）。
          //
          // 判"要不要开口"不需要推演：开思考时每条花 80–130 token、多 0.15–0.5 秒，
          // 24 条对照里结论只差 6 条，且偏向更保守的那一侧。省下的 token 比省下的时间值钱。
          // 想要回思考就把 `decide.thinking` 设成 `"on"`。
          ...(String(c.thinking ?? 'off') === 'on' ? {} : { thinking: { type: 'disabled' } }),
          // ⚠️ 不能给太小：开思考时模型会先花 token 想（实测 reasoning 80–94），
          //    给 80 时返回空内容、finish_reason=length —— 看起来像"它没判断"。
          max_tokens: Math.max(200, Number(c.maxTokens) || 900),
        }),
      });
      if (!res.ok) return { act: 'error', reason: `HTTP ${res.status}`, ms: Date.now() - t0 };
      const json = await res.json();
      const text = String(json?.choices?.[0]?.message?.content ?? '');
      const hit = text.match(/\{[\s\S]*\}/);
      if (!hit) return { act: 'error', reason: '没有 JSON', ms: Date.now() - t0, raw: text.slice(0, 120) };
      let obj = {};
      try {
        obj = JSON.parse(hit[0]);
      } catch {
        return { act: 'error', reason: 'JSON 解析失败', ms: Date.now() - t0, raw: hit[0].slice(0, 120) };
      }
      const act = String(obj.act ?? '');
      if (act !== 'reply' && act !== 'ignore' && act !== 'return' && act !== 'keep') {
        return { act: 'error', reason: `未知 act=${act}`, ms: Date.now() - t0 };
      }
      return { act, reason: String(obj.reason ?? '').slice(0, 40), ms: Date.now() - t0, usage: json.usage };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { act: aborted ? 'timeout' : 'error', reason: aborted ? '' : String(error?.message ?? error), ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      inflight.delete(convKey);
    }
  }

  // 启动就把 system 拼好（日志里能立刻看到卡长度与指纹）。
  // 只预拼**全局**那一份：带覆盖的会话在第一次判定时才拼（那时才知道 convKey）。
  if (enabledFor('')) stateFor('');

  return {
    decide,
    // ── 按会话取（新调用点用这些） ─────────────────────────────────
    enabledFor,
    modeFor(convKey) {
      return String(cfg(convKey).mode ?? 'off');
    },
    // enforce 下管理者默认直放（省一次调用、也省判错风险）。
    ownerAlwaysFor(convKey) {
      return cfg(convKey).ownerAlways !== false;
    },
    roleNameFor(convKey) {
      return stateFor(convKey).roleName;
    },
    sysHashFor(convKey) {
      return stateFor(convKey).hashes.wake;
    },
    hashFor(kind, convKey) {
      return stateFor(convKey).hashes[kind === 'wait' ? 'wait' : 'wake'];
    },
    cardCharsFor(convKey) {
      return stateFor(convKey).cardChars;
    },

    // ── 全局（不传 convKey 的老调用点 / 脚本仍可用） ────────────────
    enabled() {
      return enabledFor('');
    },
    // `off` / `shadow` / `enforce` —— 调用方靠它决定要不要等判定结果。
    get mode() {
      return String(cfg('').mode ?? 'off');
    },
    get ownerAlways() {
      return cfg('').ownerAlways !== false;
    },
    // 当前角色名（日志用）。
    get roleName() {
      return roleNameOf('');
    },
    // system 的指纹 —— 变了说明角色卡或人设节选改过（缓存会失效，日志里能对上）。
    get sysHash() {
      return stateFor('').hashes.wake;
    },
    // 按 kind 取指纹（唤醒点与 wait 返回点是两套 system）。
    hashOf(kind) {
      return stateFor('').hashes[kind === 'wait' ? 'wait' : 'wake'];
    },
    // 判断层看到的人设卡长度，启动日志用。
    get cardChars() {
      return stateFor('').cardChars;
    },
  };
}
