// 纯值工具：对象判定、深合并、深比较、稳定序列化。
//
// ── 为什么单独一个文件
//
// 这四件事原先各有一到两份**独立实现**：
//   · `deepMerge`         config/load.js 与 config/schema.js 各一份（行为等价，但两份会漂）
//   · `isPlainObject`     schema.js / onebot/parse.js / onebot/normalize.js 各一份
//   · `deepEqual`         config/write.js 内部
//   · `stableStringify`   config/store.js 与 config/sessions.js 各一份
//
// 漂移的后果不是"报错"，而是**判定标准悄悄变了两套**：比如 load 那份认为
// "数组不算对象"，schema 那份却按原样覆盖 —— 一旦哪天不一样，热重载就会
// 时灵时不灵，而两边各自看都像是对的。
//
// 所以：**判定语义只有这一份**。import 它，不要就地再写一遍。

/** 是"普通对象"（`{}`），排除 null / 数组 / 类实例 / Buffer。 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// 深合并：后者覆盖前者，对象递归，**数组整体替换**（不拼接）。
//
// 数组不合并是刻意的：`allow.groups` 这种列表若做拼接，用户删掉一个群号后
// 它还会从下层配置里"复活"，且看不出来。
//
// `patch === undefined` 原样返回 base（**同一个引用**）—— 调用方靠这一点判断
// "这次有没有覆盖"，所以不要把 undefined 也走一遍复制。
export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) return patch;
  if (!isPlainObject(base)) return { ...patch };
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

// 结构化比较（数组按顺序，对象按键）。用于"这份配置到底改没改"。
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// 键排序后序列化。
//
// 用途只有一个：消除**对象键顺序**造成的假差异 —— 否则"同样的配置"会因为
// 保存时键序变了而被判成"改过了"，触发无谓的热重载。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
