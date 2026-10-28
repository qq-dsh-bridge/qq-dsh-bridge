// 图片暂存 —— **把 base64 换成短 URL**。
//
// ── 为什么要它（实测数据）
//
// 为什么快照：一张 720px 的 Markdown 图 base64 约 6.3k 字符 ≈ 1500 token，
// 而且模型得把同一串**逐字复述**进 `qq_send`（抄错一个字符整张图就废）。
// 换成 `/m/<32hex>`（约 40 字符）**差约 150 倍**。
//
// ── 为什么由桥接存（而不是各渲染器自己起服务）
//
// 现在收归桥接一处：一个仓库、一份配额、**端口恒定**。
//
// @param args.base64  图片数据（不含 `data:` 前缀——带了也能处理）
// @param args.mimeType 默认 image/png
export const op = 'imagePublish';
export const authFree = true;

// ⚠️ `media.js` 导出的名字是 `publish`；`publishImage` 是历史别名。
import { publish as publishImage, MediaError } from '../media.js';
import { BridgeApiError } from '../errors.js';

export async function run({ logger, imageBaseUrl }, convKey, args) {
  const raw = String(args?.base64 ?? '').trim();
  // ⚠️ 参数类错误用 **400**（BridgeApiError），不是裸 Error ——
  //    裸 Error 会被 server.js 一律映射成 500，于是模型分不清
  //    "我参数写错了"和"服务故障了"，而这两者的下一步动作完全不同。
  if (!raw) throw new BridgeApiError('缺少 `base64` 参数（图片数据）。', { status: 400, code: 'missing-base64' });

  // 容忍 `data:image/png;base64,` 前缀。
  //
  // 模型从别处复制 base64 时常把 data URL 整串带过来 —— 直接
  // `Buffer.from(x, 'base64')` 会**静默得到一个坏图**（那串前缀会被
  // 当成 base64 解码成垃圾字节）。所以先剥掉，并且**从 data URL 里
  // 提取真实 mimeType**（比让它猜准）。
  let b64 = raw;
  let mimeType = String(args?.mimeType ?? '').trim();
  const dm = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
  if (dm) {
    if (!mimeType) mimeType = dm[1];
    b64 = dm[2];
  }
  if (!mimeType) mimeType = 'image/png';

  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) {
    throw new BridgeApiError(
      'base64 解出来是空的 —— 数据可能不是合法的 base64。',
      { status: 400, code: 'bad-base64' },
    );
  }

  const url = (() => {
    try {
      return publishImage(buf, { mimeType, baseUrl: imageBaseUrl });
    } catch (error) {
      // `MediaError` 自带状态码 → 转成 BridgeApiError，让 HTTP 层给出正确的
      // 400 而不是 500（"类型不支持"是改参数就能好的，不是服务故障）。
      if (error instanceof MediaError) {
        throw new BridgeApiError(error.message, { status: error.status, code: error.code });
      }
      throw error;
    }
  })();
  logger.debug('图片已暂存', {
    conv: convKey, bytes: buf.length, mimeType, url: url.slice(0, 60),
  });
  return {
    url,
    bytes: buf.length,
    mimeType,
    note: `地址按媒体配额保留（默认 500 MB，超了删最旧）。发的时候用 \`{ "image": "${url}" }\` —— 别再抄 base64。`,
  };
}
