// 单实例锁

import fs from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  constructor(message, { hint = '', pid = 0 } = {}) {
    super(message);
    this.name = 'LockError';
    this.hint = hint;
    this.pid = pid;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}


// 抢一个独占锁

export function acquireLock({ file, isAlive = defaultIsAlive, now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (existing && existing.pid > 0 && isAlive(existing.pid)) {
    throw new LockError(
      `已有实例在运行（PID ${existing.pid}，启动于 ${new Date(existing.startedAt).toLocaleString()}）`,
      {
        pid: existing.pid,
        hint: '关掉那个窗口再启动，或者确认它不是僵尸进程。'
          + '同时跑两个会让同一条 QQ 消息被回两遍，聊天记录的 seq 也会互相覆盖。',
      },
    );
  }

  // 走到这里说明：文件不存在，或者里面是陈旧/损坏的内容。
  //
  // *损坏的文件也要清掉** —— `readLock` 对坏文件返回 null，
  // 如果只在"读到了有效内容"时才删，坏文件会永远留着，
  // 后面的 `wx` 写入就一直 EEXIST，桥接再也起不来（实测踩过）。
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 已经被别人清了也无所谓
    }
  }

  const payload = { pid: process.pid, startedAt: now(), cwd: process.cwd() };
  // wx：文件已存在就失败，避免两个进程同时抢到（TOCTOU）。
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new LockError('另一个实例刚刚抢先启动了', { hint: '稍等一秒再试。' });
    }
    throw error;
  }

  let released = false;
  return {
    pid: process.pid,
    file,
    release() {
      if (released) return;
      released = true;
      try {
        // 只删自己的锁：如果文件里的 PID 已经不是我们（被覆盖过），就别动。
        const cur = readLock(file);
        if (cur && cur.pid !== process.pid) return;
        fs.unlinkSync(file);
      } catch {
        // 文件已经没了
      }
    },
  };
}

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.pid !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

// 默认实现：进程是否存在。signal 0 不发信号，只做权限与存在性检查。
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限发信号（Windows 上常见）⇒ 仍然算活着。
    return error.code === 'EPERM';
  }
}
