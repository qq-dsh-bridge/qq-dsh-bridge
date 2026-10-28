// 配置的读写 —— 给控制台用。
//
// ── 写回 config.json 时的两道防护
//
// 1. **先校验，不过不写。** 用与启动时**同一个** validateConfig，
//    保证"控制台能存下的"就是"启动能接受的"。两份校验器会漂移，
//    漂移的结果是"控制台存好了但重启起不来"。
//
// 2. **原子写。** 写临时文件再 rename。直接覆写时若进程在中途被杀，
//    留下的就是半截 JSON —— 而 json 解析失败会让桥接起不来。
//
// **不要加回"写前备份"**：备份里是明文密码与 token，躺在配置目录里既没人看，
// 还会被压缩包/手动拷贝带走。要留历史就用版本库或系统的文件历史。
//
// ── 为什么不做"部分字段更新"
//
// 控制台提交的是**完整配置对象**，不是补丁。部分更新需要一套合并语义
// （数组合并？null 是删除还是置空？），而 deepMerge 的语义已经够微妙了。
// 让前端拿到完整配置、改完提交完整配置，只有一条路径。
//
// ── 未知键与危险改动
//
// 校验器拒绝未知键；另外这里额外检查几处"合法但危险"的改动
// （比如把 allowAllWhenEmpty 打开），返回警告而不是拒绝 ——
// 拒绝会让用户没法做有意的改动，但静默接受也不行。

import fs from 'node:fs';
import path from 'node:path';
import { validateConfig, ConfigError, deepMerge, isPlainObject } from './schema.js';
import { deepEqual } from '../util/value.js';
import { readConfigFile } from './load.js';

export class ConfigWriteError extends Error {
  constructor(message, { hint = '', errors = [] } = {}) {
    super(message);
    this.name = 'ConfigWriteError';
    this.hint = hint;
    this.errors = errors;
  }
  toString() {
    const hint = this.hint ? `\n  ${this.hint}` : '';
    const list = this.errors.length ? `\n  ${this.errors.map(String).join('\n  ')}` : '';
    return `${this.name}: ${this.message}${hint}${list}`;
  }
}

// 合法但需要提醒的改动。
export function auditChanges(before, after) {
  const warnings = [];

  const a = after.allow ?? {};
  const emptyLists = (a.private?.length ?? 0) === 0 && (a.groups?.length ?? 0) === 0;
  if (a.allowAllWhenEmpty === true && emptyLists) {
    warnings.push('allowAllWhenEmpty 为 true 且 allow 列表为空 —— 会对所有人开放');
  }

  // 闸门放宽
  if (before.chatlog?.triggerWho !== 'everyone' && after.chatlog?.triggerWho === 'everyone') {
    warnings.push('triggerWho 改为 everyone —— 群里任何人都能叫醒它');
  }
  if (before.chatlog?.windowWho !== 'everyone' && after.chatlog?.windowWho === 'everyone') {
    warnings.push('windowWho 改为 everyone —— 回应期内任何人都能让它接着说');
  }

  // 大幅放宽上下文（烧 token）
  if ((after.chatlog?.wakeLimit ?? 0) > (before.chatlog?.wakeLimit ?? 0) * 3) {
    warnings.push(`wakeLimit ${before.chatlog?.wakeLimit} → ${after.chatlog?.wakeLimit}，每次唤醒的 token 开销会显著上升`);
  }

  // 日志级别调低会让排查变难
  if (before.log?.level === 'debug' && after.log?.level !== 'debug') {
    warnings.push(`日志级别 ${before.log?.level} → ${after.log?.level}，将看不到投递的提示词全文`);
  }

  return warnings;
}

// 校验一份待写入的配置。
//
// @returns `{ ok, errors, warnings }`
export function checkConfig(candidate, { current } = {}) {
  const { ok, errors } = validateConfig(candidate, { strict: true });
  return {
    ok,
    errors: errors.map(String),
    warnings: ok && current ? auditChanges(current, candidate) : [],
  };
}

// 只把**真正改过的键**合并进磁盘上原有的配置。
//
// ── 为什么不能整份覆盖写
//
// 控制台保存的是"前端提交的完整对象"，而前端是从 **config.json 文件内容**
// 填的表单。问题是：有些值**只存在于运行时的生效配置里、不在文件里** ——
// 最典型的是 SnowLuma 的 `wsToken` / `httpToken`（桥接从 SnowLuma 的
// 配置文件里**发现**的，从没写进 config.json）。
//
// 整份覆盖写会把它们洗成 undefined，随后热重载发现
// `tokenChanged=true`、重连 URL 里没有 `?access_token=`，
// 于是**连不上 SnowLuma**（实测：日志刷 `close:1006`，而 SnowLuma
// 那边端口好、消息也在流）。
//
// ── 判据：跟"磁盘上的原值"比，不是跟生效值比
//
// 正确的判据是 **「提交值 ≠ 磁盘原值」**：
//   文件里有 windowWho=owner，前端提交 everyone ⇒ 改过了，写进去
//   文件里没有 snowluma.wsToken，前端提交也没有 ⇒ 都没变，不写
//     （于是运行时发现的那个值不会被凭空写成文件，也不会被洗掉）
//
// ── 不支持删除键
//
// 前端把某键删掉 = 恢复默认，而不是"删掉这个配置项"。
// 这是有意的取舍：能删键就意味着"发现值"也会被误删。
//
// @returns 合并后要写入磁盘的对象
export function mergeChangedOnly({ onDisk = {}, submitted = {} } = {}) {
  const out = structuredClone(onDisk ?? {});
  applyDiff(out, submitted ?? {}, onDisk ?? {});
  return out;
}

function applyDiff(target, submitted, original) {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return;

  for (const [k, v] of Object.entries(submitted)) {
    const orig = original?.[k];
    const isObj = v && typeof v === 'object' && !Array.isArray(v);

    if (isObj) {
      // 递归下钻：只有叶子层面的"改过"才算改过。
      const childTarget = target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])
        ? target[k]
        : {};
      target[k] = childTarget;
      applyDiff(childTarget, v, orig && typeof orig === 'object' ? orig : {});
      // 空的子对象不留（避免写出一堆 `{}`）。
      if (Object.keys(childTarget).length === 0) delete target[k];
      continue;
    }

    // 叶子：与**磁盘原值**不同 ⇒ 前端改过它，写进去。
    if (!deepEqual(v, orig)) target[k] = v;
  }
}

// 结构化比较（数组按顺序，对象按键）—— 实现已收敛到 `util/value.js`。
// 原来这里自带一份，且 `export` 出去却没人用（唯一的消费者是本文件的 applyDiff）。

// 原子写入配置（**不做备份**）。
//
// 为什么不备份：备份文件里是**明文密码与 token**，落在配置目录里既没人看，
// 又会被 .gitignore 之外的手段带走（压缩包、手动拷贝）。要留历史就用版本库
// 或系统的文件历史，别指望这个函数。
//
// @param options.file     目标文件
// @param options.config   要写入的配置对象（调用方通常先过 mergeChangedOnly）
// @returns `{ file }`
export function writeConfigFile({ file, config } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  // 原子写：临时文件 + rename。
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    // 结尾留换行：手工编辑的文件更友好，也让 diff 干净。
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 清理失败无所谓
    }
    throw new ConfigWriteError(`写入失败：${error.message}`);
  }

  return { file };
}

// 读回磁盘上的配置（给控制台展示"当前文件内容"）。
//
// 与运行中的生效配置可能不同 —— 环境变量与命令行层会覆盖它。
// 控制台要把这个差异显式展示出来，否则用户会以为"文件写了但没生效"。
export function readConfigForConsole({ file }) {
  const { found, value } = readConfigFile(file);
  return { found, file, value };
}

// *局部更新**配置里的几个键（不是整份表单提交）。
//
// ── 与 `mergeChangedOnly` 的分工
//
// 控制台配置页提交的是**完整对象**，所以那条路要按"与磁盘原值比较"挑出改动
// （见上面的长注释）。而"切角色""改一个开关"这类写入点只知道**自己的键**，
// 手上没有整份表单 —— 让它去拼完整对象，就等于把别的键（尤其是运行时发现的
// token）一起覆写一遍。
//
// 所以这里反过来：**读磁盘 → 深合并补丁 → 校验 → 原子写**。
// 只有补丁里出现的键会被改，其余原样保留，运行时发现的值也不会被写成文件。
//
// 校验用的是**与启动同一个** `validateConfig`（strict），所以不会写出
// "能存下但重启起不来"的配置。不合法时抛错且**不写文件**。
//
// @returns `{ file, config }` —— config 是写入后的完整对象
export function updateConfigFile({ file, patch } = {}) {
  const { found, value } = readConfigFile(file);
  const base = found && isPlainObject(value) ? value : {};
  const next = deepMerge(structuredClone(base), patch ?? {});

  const { ok, errors } = validateConfig(next, { strict: true });
  if (!ok) {
    throw new ConfigWriteError('局部更新后的配置校验未通过，未写入', {
      errors: errors.map(String),
    });
  }

  const written = writeConfigFile({ file, config: next });
  return { ...written, config: next };
}

export { ConfigError };
