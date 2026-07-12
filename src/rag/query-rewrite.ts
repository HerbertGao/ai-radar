/**
 * 多轮 query-rewrite（add-conversational-rag / Plan A A3，design D6 / spec「历史只作信号、结构化不进证据链」）。
 *
 * 职责：按 `(user_id, conversation_id)` 读回的历史轮 + 用户最新追问 → LLM condense 成**独立检索句**
 * （消歧代词/省略，只改「检索什么」、不回答问题）。**历史只**在此一次 LLM 调用被使用——作答调用
 * （handler 的 `answer(rewrittenQuery, 本轮 citations)`）结构上不含历史（D6 红线）。
 *
 * 关键不变量：
 * - **失败降级用原问、不阻塞**（rewrite 是可选优化，非硬依赖）：LLM 抛错 / 输出未过校验 / 输出空串 → 返回 `rawQuery`。
 * - **空历史短路**：首轮无历史可 condense → 直接返回 `rawQuery`（省一次 LLM 调用/成本，不改语义）。
 * - **可测性**：`generateObjectFn` 经参数注入（默认真实 SDK），测试注入桩即可断言消歧/降级而不触网。
 */
import { z } from 'zod';
import { buildModel, defaultGenerateObject } from '../agents/llm-client.js';
import type { ConversationTurn } from './conversation-store.js';

/** rewrite 输出 schema：LLM 只出独立检索句。 */
const rewriteOutputSchema = z.object({
  rewritten_query: z.string(),
});

/** rewrite 只取末 N 轮做指代消歧——防长会话把 rewrite prompt 撑爆 + 成本无界增长。 */
// ponytail: 12 轮足够消歧上下文；需要更长记忆再调（或换 per-user 成本栈，design 非目标）。
const REWRITE_HISTORY_TURNS = 12;

/** `generateObject` 注入契约（复用 llm-client 的默认实现签名；测试传桩不触网）。 */
export type GenerateObjectFn = typeof defaultGenerateObject;

export interface RewriteOptions {
  /** 注入的 generateObject 实现，默认真实 SDK（VITEST 下 defaultGenerateObject 会 throw 兜底防触网）。 */
  generateObjectFn?: GenerateObjectFn;
  /** 错误日志 sink，默认 console.error；便于测试断言降级被记录（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

function buildRewritePrompt(rawQuery: string, history: readonly ConversationTurn[]): string {
  // 历史 condense 上下文：既往轮的原问 + 答案（答案可为无据/空——如实标注，供指代消歧）。
  const historyBlock = history
    .map((t) => {
      const q = t.rawQuery ?? '';
      const a = t.answer ?? '（无答案 / 无据）';
      return `第 ${t.turn} 轮\nQ: ${q}\nA: ${a}`;
    })
    .join('\n\n');
  return [
    '你是检索查询改写器。根据下面的对话历史，把用户的「最新追问」改写成一句**无需上下文即可独立检索**的查询。',
    '要求：',
    '- 把指代（它/这个/上面说的/他们）替换为历史中的具体实体；补全省略的主体。',
    '- 只改「检索什么」，**不要回答问题**、不要加解释。',
    '- 若最新追问本身已独立、无需改写，则原样返回。',
    '',
    '对话历史：',
    historyBlock,
    '',
    `最新追问：${rawQuery}`,
    '',
    '返回字段：rewritten_query（改写后的独立检索句）。',
  ].join('\n');
}

/**
 * 把最新追问 + 历史 condense 成独立检索句。失败 / 空历史 → 降级返回 `rawQuery`（不阻塞）。
 *
 * @param rawQuery 用户最新追问（裸输入）。
 * @param history  按 `(user_id, conversation_id)` 读回的历史轮（升序）；**只**在此被使用。
 * @param options  注入 generateObjectFn / logError。
 * @returns 独立检索句（成功）或 `rawQuery`（空历史 / 失败降级）。
 */
export async function rewriteQuery(
  rawQuery: string,
  history: readonly ConversationTurn[],
  options: RewriteOptions = {},
): Promise<string> {
  // 空历史短路：无可 condense，直接用原问（省一次 LLM 调用）。
  if (history.length === 0) return rawQuery;

  const run = options.generateObjectFn ?? defaultGenerateObject;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[rag-rewrite] ${message}`, detail));

  try {
    const model = buildModel();
    const prompt = buildRewritePrompt(rawQuery, history.slice(-REWRITE_HISTORY_TURNS));
    const result = await run({ model, schema: rewriteOutputSchema, prompt });
    const parsed = rewriteOutputSchema.safeParse(result.object);
    if (!parsed.success) {
      logError('rewrite 输出未通过 Zod 校验，降级用原问', parsed.error.issues);
      return rawQuery;
    }
    const rewritten = parsed.data.rewritten_query.trim();
    if (rewritten.length === 0) {
      logError('rewrite 输出空串，降级用原问', null);
      return rawQuery;
    }
    return rewritten;
  } catch (error) {
    // rewrite 是可选优化：失败绝不阻塞对话，降级用原问检索。
    logError('rewrite 调用失败，降级用原问', error);
    return rawQuery;
  }
}
