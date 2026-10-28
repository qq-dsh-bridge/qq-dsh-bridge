// 从字节猜 mime —— 只用于"服务器没说清类型"的兜底。
//
// 场景：qq_send 把外部 URL 抓进媒体库时，有些 CDN 回 `application/octet-stream`
// 或干脆不给 Content-Type。媒体仓库按 kind 校验 mime，猜不出来就拒绝，
// 比把一张图存成 octet-stream 更可控。
//
// 只认白名单里的类型（与 `KINDS[kind].mimes` 对齐）；猜不出返回 ''。

export function sniffMime(buffer) {
  const b = buffer;
  if (!b || b.length < 12) return '';

  // 图片
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';

  // 语音
  if (b.toString('ascii', 0, 5) === '#!AMR') return 'audio/amr';
  if (b.toString('ascii', 0, 6) === '#!SILK') return 'audio/silk';
  if (b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';

  // 视频
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';

  return '';
}
