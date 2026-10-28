// 决策日志 —— 每次判定落一行 jsonl。
//
// shadow 期全靠它回答两个问题：它想拦哪些？拦错了多少？
// 之后要拟合本地小模型（MaiBot 那套 8 维权重）时，这份日志就是训练数据。
//
// ⚠️ 写失败只记 debug —— 日志是为了调参，不能因为它把消息流带崩。
import fs from 'node:fs';
import path from 'node:path';

// @param options.file 目标文件（`<chatlog.root>/decide.jsonl`）
// @param options.logger
export function createDecideLog({ file, logger } = {}) {
  if (!file) return { write() {} };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    logger?.debug('决策日志目录建不出来', { file, error: String(error) });
    return { write() {} };
  }

  return {
    write(row) {
      try {
        fs.appendFile(file, `${JSON.stringify(row)}\n`, (error) => {
          if (error) logger?.debug('决策日志写入失败', { error: String(error) });
        });
      } catch (error) {
        logger?.debug('决策日志写入失败', { error: String(error) });
      }
    },
  };
}
