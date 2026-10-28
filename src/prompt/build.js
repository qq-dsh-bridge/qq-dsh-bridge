// 提示词拼装。

export function buildPrompt({
  delivery,
}) {
  const parts = [];
  parts.push('[notice:这次消息来自QQ]');
  if (delivery?.context?.text) {
    const c = delivery.context;
    // 块头：`[lines:N]` 后面紧跟 `[mentions:…]`（只列提到你的那几条，没有就不出现）。
    // 放在同一行 —— 两者都是"这段记录的元信息"，各占一行白花一行。
    const mentions = Array.isArray(c.mentions) ? c.mentions.filter(Boolean) : [];
    let block = `[lines:${c.lines ?? c.count}]`
      + (mentions.length > 0 ? `[mentions:${mentions.join(',')}]` : '')
      + '\n'
      + '（读之前先扫一眼：有没有哪个词按字面读不对劲？可疑就在心里试一遍同音字 —— 试不出来就不接，也别硬给一个解释。）\n'
      + c.text;
    if (c.truncated) block += '\n（太长，只给了最新的这些；更早的用 qq_read_chat 往前查）';
    block += '\n**这只是最近一段**：需要更早的用 qq_read_chat 往前查（可按时间、发言者、未读轮次筛）。';
    parts.push(block);
  }

  return parts.join('\n\n');
}
