/**
 * Telegram 日报消息拼装（telegram-push 9.3，design D2/D3/D4/D6）。
 *
 * 把待发集合（今日 Top N 中待推送者）拼成**一条** Telegram 消息。每条事件渲染为
 * 「序号 + 代表标题（粗体）+ 一句话要点（headline_zh）+ 原文可点击链接」——
 * 不再堆叠完整长摘要（summary_zh 仅落库不进消息，design D2）。
 *
 * 单条消息原子送达——N 条 push_record 状态同生共死（成功整批 success / 失败整批 failed），
 * 故必须拼成一条，不可拆多条。
 */
import type { SelectedEvent } from '../selection/top-n.js';

/** Telegram 单条消息长度上限（保守取 4000，留余量给 Markdown 转义）。 */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * 代表标题渲染期截断上限（单一常量，含省略号，按 Unicode code point 计）。
 *
 * `representative_title` 是无长度上限的源标题原文；不截断则一条超长标题即可撑爆单条消息。
 * 截断**必须在 MarkdownV2 转义之前、按 code point**（见 truncateByCodePoint）。
 * 120 与 headline 的 HEADLINE_MAX(80) 共同把每条有界，使 Top N 典型一条装下、截断退化为兜底。
 */
const TITLE_MAX = 120;

/** headline 缺失时回退用 summary_zh 的截断字数（按 code point）。 */
const SUMMARY_FALLBACK_MAX = 80;

/** 截断后省略号。 */
const ELLIPSIS = '…';

/** 转义 Telegram MarkdownV2 保留字符（文本用），避免标题/要点里的特殊符号破坏渲染或发送失败。 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/**
 * **链接 URL 专用**转义函数（design D3）：Telegram MarkdownV2 内联链接 `[文本](url)` 的 URL
 * 部分只需转义 `)` 与 `\`。**禁止**复用 18 字符文本转义器 escapeMarkdownV2——后者会把 URL
 * 里常见的 `.`/`-`/`_`/`=` 也加反斜杠，破坏链接（点击跳错或发送失败）。
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/[)\\]/g, (ch) => `\\${ch}`);
}

/**
 * 按 Unicode code point 截断（用 [...str] 展开，非 .slice 的 UTF-16 code unit，防中文/emoji 截半）。
 * 超过 max（含省略号）才截，截后保留 (max-1) 个 code point + 省略号。
 */
function truncateByCodePoint(text: string, max: number): string {
  const cps = [...text];
  if (cps.length <= max) return text;
  return cps.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

/**
 * 选出每条事件的「一句话要点」文本（转义前的原文）。回退链（固定顺序）：
 *   headline_zh（非空）→ summary_zh 截断前 ~80 字 → 无要点（返回 null，仅标题）。
 * representative_title 不在此回退（它已作为标题独立渲染；headline 缺失退到标题即等价仅标题无要点）。
 */
function resolveHeadlineText(e: SelectedEvent): string | null {
  const headline = e.headlineZh?.trim();
  if (headline) return headline;
  const summary = e.summaryZh?.trim();
  if (summary) return truncateByCodePoint(summary, SUMMARY_FALLBACK_MAX);
  return null;
}

/**
 * 拼一条日报消息。MarkdownV2 格式，每条 = 「序号 + 标题(粗体) + 要点 + 链接」。
 * 超长时按整条事件为单位截断（不切半条），并在末尾标注剩余条数，保证不超 Telegram 上限。
 *
 * @returns 消息文本、建议的 parse_mode，以及实际拼进消息（未被截断丢弃）的事件 id 列表
 *   （保持入参顺序）。调用方据 includedIds 仅对实际发出的事件改状态，避免被截断者被误标
 *   success 而永久漏推。
 */
export function buildDigestMessage(events: readonly SelectedEvent[]): {
  text: string;
  parseMode: 'MarkdownV2';
  includedIds: string[];
} {
  const header = `*AI Radar 每日情报* \\(${escapeMarkdownV2(
    String(events.length),
  )}\\)`;

  const blocks: string[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;

    // 标题：渲染期截断（转义之前、按 code point），再转义。
    const rawTitle = e.representativeTitle?.trim() || '(无标题)';
    const title = escapeMarkdownV2(truncateByCodePoint(rawTitle, TITLE_MAX));

    // 要点：headline → summary 截断 → 无（回退链）。
    const headlineText = resolveHeadlineText(e);
    const headlineLine = headlineText
      ? `\n${escapeMarkdownV2(headlineText)}`
      : '';

    // 链接：canonical_url 用专用 URL 转义器；缺失则不渲染链接（仅标题+要点）。
    const url = e.canonicalUrl?.trim();
    const linkLine = url
      ? `\n[原文](${escapeMarkdownV2Url(url)})`
      : '';

    blocks.push(
      `${escapeMarkdownV2(`${i + 1}.`)} *${title}*${headlineLine}${linkLine}`,
    );
  }

  // 按事件块逐个累加，超出上限即停止并标注剩余条数（不切半条，保证可发送）。
  let text = header;
  let included = 0;
  const includedIds: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const next = `${text}\n\n${blocks[i]!}`;
    if (next.length > MAX_MESSAGE_LENGTH) break;
    text = next;
    included += 1;
    includedIds.push(events[i]!.eventId);
  }
  if (included < blocks.length) {
    text += `\n\n${escapeMarkdownV2(`…另有 ${blocks.length - included} 条未展示`)}`;
  }

  return { text, parseMode: 'MarkdownV2', includedIds };
}
