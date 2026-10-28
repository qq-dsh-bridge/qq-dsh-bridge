// 身份校验
export class SelfQqMismatchError extends Error {
  constructor(expected, actual) {
    super(`当前登录的 QQ 是 ${actual}，与配置的 snowluma.selfQq=${expected} 不一致`);
    this.name = 'SelfQqMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// 核对
export async function verifySelfQq(http, expectedQq) {
  const expected = String(expectedQq ?? '').trim();
  if (!expected) throw new Error('配置里没有 snowluma.selfQq —— 拒绝在不知道"用哪个号"的情况下启动');

  let login;
  try {
    login = await http.getLoginInfo();
  } catch {
    return { checked: false };
  }

  const actual = String(login?.user_id ?? '').trim();
  if (!actual) return { checked: false };
  if (actual !== expected) throw new SelfQqMismatchError(expected, actual);
  return { checked: true, actual };
}
