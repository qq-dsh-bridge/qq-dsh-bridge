import path from 'node:path';

// agent 路径 ↔ 宿主路径
//
// 为什么需要：agent 可能在 WSL 里（看到 `/ws/...`），也可能就是原生 Windows /
// Linux 进程（看到的就是宿主路径）。而 SnowLuma 是**宿主进程** —— 它不认识
// agent 的命名空间：把 `/ws/日/歌.flac` 直接丢给它的 `record` 段，它会当成
// "当前盘根目录下的 ws"，于是报 `ENOENT: stat 'C:\path\to\歌.flac'`。
//
// 所以这里只做一件事：**若干对前缀的互相翻译**。
//   agentRoot  `/ws`                    ← 配置 `chatlog.agentRoot`
//   hostRoot   `C:\path\to\workspaces`   ← 配置 `chatlog.root`
//   agentRoot  `/ws/media`              ← 配置 `media.agentRoot`（可选，媒体可在外）
//   hostRoot   `D:\media`               ← 配置 `media.root`
//
// 三种部署：
//   · WSL                → agentRoot=/ws，hostRoot=宿主目录
//   · 同机原生（同路径）  → agentRoot 留空即可（不翻译，原样透传）
//   · 不共享文件系统      → agentRoot 留空（只接受 URL / `/m/`）
//
// ⚠️ 模型经常**把前导斜杠写丢**（`ws/日/歌.flac`），那会被 SnowLuma 当成相对它
//    自己 cwd 的路径（实测落到 SnowLuma 安装目录下的 `ws\...`）。所以"丢了斜杠"也认。
//
// ⚠️ 一旦配了 agentRoot，**本机路径一律不让进**（见 `toHostPathStrict`）：
//    模型猜中一个宿主路径（`C:\Windows\...`）就能把重要文件发出去。

let maps = [];

// Windows 的路径大小写不敏感；agent 前缀也不一定和配置的大小写一致。
const lower = (s) => String(s ?? '').toLowerCase();

function normalizePair({ agent = '', host = '' } = {}) {
  // agent 前缀统一成 `/` 分隔：agent 可能是 WSL、Linux，也可能是原生 Windows
  // （原生 Windows 的 agent 会把 `D:\…` 当自己的路径，恒等映射也要能对上）。
  const a = String(agent).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const h = String(host).trim().replace(/[\\/]+$/, '');
  return a && h ? { agent: a, host: h } : null;
}

// @param options.agent   agent 看到的前缀（WSL 里是 `/ws`）
// @param options.host    宿主的真实目录
// @param options.extra   额外的对（媒体根可以不在 chatlog 根里面）
export function configurePathMap({ agent = '', host = '', extra = [] } = {}) {
  const list = [];
  const main = normalizePair({ agent, host });
  if (main) list.push(main);
  for (const item of Array.isArray(extra) ? extra : []) {
    const pair = normalizePair(item ?? {});
    if (pair) list.push(pair);
  }

  const seen = new Set();
  maps = list
    .filter((pair) => {
      const key = `${lower(pair.agent)}|${lower(pair.host)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // 最长前缀优先：`/ws/media` 必须压过 `/ws`。
    .sort((a, b) => b.agent.length - a.agent.length);
}

// 这里曾导出 `hasAgentMap()` / `agentRoots()` —— **已删**：没有任何消费方。
// 它们服务的是早期"有映射就拒绝本机路径"的设计；现在这个判断在
// `toHostPathStrict()` 里就地做（见下面），单独暴露"有没有映射"只会让人以为
// 还有第三个开关。

const NON_PATH = /^(https?:|base64:|data:)/i;

// 在 maps 里找 agent 前缀；返回 { pair, rel } 或 null。
function matchAgent(raw) {
  const s = raw.replace(/\\/g, '/');
  const low = lower(s);
  for (const pair of maps) {
    const agent = lower(pair.agent);
    const base = agent.replace(/^\//, '');   // `/ws` → `ws`

    let rel = null;
    if (low === agent) rel = '';
    else if (low.startsWith(`${agent}/`)) rel = s.slice(pair.agent.length + 1);
    // 丢了前导斜杠的写法（`ws/…`）也认 —— 否则会变成 SnowLuma cwd 下的相对路径。
    else if (low === base) rel = '';
    else if (low.startsWith(`${base}/`)) rel = s.slice(base.length + 1);

    if (rel !== null) return { pair, rel };
  }
  return null;
}

function joinHost(pair, rel) {
  // 用宿主自己的分隔符（Linux 宿主是 `/`，Windows 是 `\`）。
  const parts = rel.replace(/^\/+/, '').split('/').filter((p) => p !== '');
  return parts.length ? path.join(pair.host, ...parts) : pair.host;
}

// 严格版：**配了 agentRoot 时，只接受 agent 命名空间**。
//
// · URL / `/m/<id>` 原样通过；
// · agent 路径（含丢了斜杠的 `ws/…`）翻成宿主路径；
// · 其它（`D:\…`、`/etc/…`、相对路径）一律拒绝 —— 模型不该知道宿主路径。
//
// @returns `{ ok: true, value }` 或 `{ ok: false, reason }`
export function toHostPathStrict(p) {
  const raw = String(p ?? '').trim();
  if (raw === '' || !maps.length || NON_PATH.test(raw)) return { ok: true, value: raw };
  if (/^\/m\//.test(raw)) return { ok: true, value: raw };

  const hit = matchAgent(raw);
  if (!hit) {
    return {
      ok: false,
      value: raw,
      reason: `只接受 ${maps.map((m) => m.agent).join(' / ')} 下的路径、/m/<id> 或 URL；本机路径不允许`,
    };
  }
  return { ok: true, value: joinHost(hit.pair, hit.rel) };
}

// 宿主路径 → agent 路径：**所有给模型看的路径都要走这个**。
//
// 给模型 `C:\path\to\workspaces\...` 它既不认识（原生 Windows 除外），也会被它
// 在群里复述出去。所以出口一律翻译；没有映射时原样返回（调用方自己判断要不要给）。
export function toAgentPath(p) {
  const raw = String(p ?? '').trim();
  if (!maps.length || raw === '') return raw;
  const s = raw.replace(/\\/g, '/');

  // 宿主前缀按长度降序，避免短前缀先命中。
  const byHost = [...maps].sort((a, b) => b.host.length - a.host.length);
  for (const pair of byHost) {
    const host = pair.host.replace(/\\/g, '/');
    if (lower(s) === lower(host)) return pair.agent;
    if (lower(s).startsWith(`${lower(host)}/`)) {
      return `${pair.agent}/${s.slice(host.length + 1)}`;
    }
  }
  return raw;
}

// 把一段文本里出现的宿主路径换成 agent 路径（用于透传外部错误）。
//
// 典型场景：SnowLuma 的报错 `ENOENT: stat 'D:\…\ws\日\歌.flac'` —— 直接转给模型
// 等于把宿主目录结构讲给它听，它还看不懂。
export function agentize(text) {
  let out = String(text ?? '');
  if (!maps.length || out === '') return out;

  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byHost = [...maps].sort((a, b) => b.host.length - a.host.length);
  for (const pair of byHost) {
    const host = pair.host;
    // 前缀 + 后面那截（到引号为止），后半截的分隔符一起换成 `/`：
    // `D:\a\b\c` → `/ws/b/c`，而不是 `/ws\b\c`。
    const re = new RegExp(`(?:${esc(host)}|${esc(host.replace(/\\/g, '/'))})([^'"]*)`, 'gi');
    out = out.replace(re, (_m, rest = '') => pair.agent + String(rest).replace(/\\/g, '/'));
  }
  return out;
}
