/**
 * 中文 mojibake（乱码）检测（快修：digest / value-judge 共用）。
 *
 * 背景：经 OpenRouter 路由到的某些后端会间歇性返回「双重编码」字节——UTF-8 编码的
 * 中文被当 Latin-1 解码，到客户端时已是 mojibake（如 `æ¬ææ é¢ä¸ºNotes...`）。
 * raw_items 输入是干净的，坏在 per-response 间歇的 LLM 响应，故只有部分条目坏。
 *
 * 判定依据：干净中文摘要里中文是 CJK 区、英文术语是 ASCII（U+0000–U+007F），
 * Latin-1 补充区 U+0080–U+00FF 近乎不出现；而 mojibake 里这些字符（æ ¬ Ã Â â 等）
 * 成片出现。给正常文本里偶发的 ©®° 等留容差，超过小阈值才判为 mojibake。
 *
 * 不做还原：latin1→utf8 还原是有损的（会留 �），命中后一律走重试求干净响应、
 * 不行则降级，绝不输出乱码。
 */

/** Latin-1 补充区字符计数超过此阈值即判为 mojibake（给偶发 ©®° 留容差）。 */
const MOJIBAKE_THRESHOLD = 4;

/**
 * 判定字符串是否为「UTF-8 被当 Latin-1 解码」的中文 mojibake。
 *
 * 纯函数：统计落在 U+0080–U+00FF 的字符数，超过 MOJIBAKE_THRESHOLD 即判为 mojibake。
 */
export function looksLikeMojibake(s: string): boolean {
  let count = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x80 && code <= 0xff) {
      count++;
      if (count > MOJIBAKE_THRESHOLD) return true;
    }
  }
  return false;
}
