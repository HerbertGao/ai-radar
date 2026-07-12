/**
 * KB-RAG handler（add-conversational-rag / Plan A A3，**本变更核心**；design D2/D5/D6/D8/D9 / spec conversational-rag）。
 *
 * 统一 **handler 契约**（未来编排引擎 seam，D2）：
 *   `handle(query, ctx) → { domain, answer, citations, trace, evidence }`
 * A3 单路只实现 KB-RAG：价格前置闸 →（多轮）query-rewrite →（env-clean 事件域）检索 → 证据阈值判 →
 * grounded 作答（generateObject，LLM 只出散文 + kb_id 选择器）→ 程序构造引用 → 写回会话。
 *
 * 诚实红线**全部靠代码结构强制、非 prompt 口头**（灵魂）：
 * - **① 证据阈值判无据（D5①）**：handler（非 searchKb）在作答**前**判——top-k 命中最高 `cosineSim < RAG_MIN_COSINE`、
 *   或 KB 无命中、或空查询 → `answer=null`/`evidence='无据'`，**不发起作答**、不杜撰。
 * - **② citations 程序构造（D5②）**：作答 LLM 只回 `{answer, cited_kb_ids[]}`；`citations` 由 `buildCitations`
 *   从**本轮命中行 ∩ ≥阈值**映射，命中集外/低分 id 丢弃、`source_url` 取命中行经 safeHref、`snippet:=summaryZh`
 *   （见 citations.ts）。**阈值过滤后引用集为空 → 降级 `无据`/`answer=null`**（不出「有据零引用」的伪装答）。
 * - **③ 价格前置闸确定性（D5③）**：`isPriceOrSelectionQuery` 在 rewrite/作答**前**强制 `非我域`/`answer=null`
 *   （见 price-gate.ts）；LLM 分类叠加其上、但不得仅靠 LLM。
 * - **④ 历史结构上不进证据链（D6）**：作答的 generateObject 载荷**只含 `rewrittenQuery` + 本轮 citations 上下文**，
 *   绝不含任何历史轮/旧 answer 文本。历史**只**喂给 query-rewrite 那一次 LLM 调用（见 query-rewrite.ts）。
 *
 * 边界（D3）：对 DOMAIN（kb_documents/…）**只 SELECT**（经 searchKb）；仅读写自有 `rag_conversations`（经 store，带 `WHERE user_id`）。
 * 作答（外部 API）**带重试 + 错误日志**（`defaultGenerateObject` 只超时无重试，本模块自加，D8）；重试耗尽 → 降级无据（不 500）。
 * 可测性：`generateObjectFn` / `searchFn` / `readHistoryFn` / `writeTurnFn` / `dbh` / `minCosine` 全可注入（默认真实实现）。
 */
import { z } from 'zod';
import { env } from '../config/env.js';
import { db as defaultDb } from '../db/index.js';
import { searchKb } from '../kb/retrieval.js';
import type { KbSearchResult } from '../kb/retrieval-core.js';
import { buildModel, defaultGenerateObject } from '../agents/llm-client.js';
import {
  readHistory,
  writeTurn,
  type ConversationTurn,
  type WriteTurnInput,
} from './conversation-store.js';
import { rewriteQuery } from './query-rewrite.js';
import { isPriceOrSelectionQuery } from './price-gate.js';
import { buildCitations, type Citation } from './citations.js';

export type { Citation };

/** db 句柄类型（drizzle 实例或事务），供依赖注入 / 集成测。 */
type DbLike = typeof defaultDb;

/** `generateObject` 注入契约（复用 llm-client 默认实现签名；测试传桩不触网）。 */
export type GenerateObjectFn = typeof defaultGenerateObject;

/** 检索注入契约（默认 `searchKb`；测试传桩返回固定命中集，不触网/不触 DB）。 */
export type SearchFn = (query: string) => Promise<KbSearchResult[]>;

/** handler 上下文（多用户 seam：`userId` 本期恒 'local'，未来绑已验证 CF Access JWT claim）。 */
export interface HandlerContext {
  /** 隔离谓词值（本期恒 'local'；store 读写带 `WHERE user_id = $ctx`）。 */
  userId: string;
  /** 服务端生成的会话 id（贯穿一次多轮会话；见 conversation-store.newConversationId）。 */
  conversationId: string;
}

/** 检索轨迹（向用户披露：本轮实际检索句 = rewrittenQuery；D6/spec「trace 披露 rewrittenQuery」）。 */
export interface HandlerTrace {
  /** 用户原问（裸输入）。 */
  rawQuery: string;
  /** 本轮**实际检索句**（rewrite 后；空历史/降级时 = rawQuery）——向用户披露「实际检索了什么」。 */
  rewrittenQuery: string;
  /** 本轮 `searchKb` 全部命中的 kb_id（指针；价格前置闸/空查询时为 []）。 */
  hitKbIds: string[];
  /** 本轮命中最高 cosine（无命中 → null）——供观测阈值判定。 */
  topCosine: number | null;
  /** 价格/选型前置闸是否命中（true → `非我域`，未检索/未作答）。 */
  priceGate: boolean;
}

/** handler 契约返回（D2；`domain`/`evidence` 两轴分开，真值表见 design Open Questions）。 */
export interface HandlerResult {
  /** `本域`（KB-RAG 处理）| `非我域`（价格/选型，留待未来引擎 handoff）。 */
  domain: '本域' | '非我域';
  /** 散文答案（`本域 + 有据` 时非空）| null（`非我域` / `本域 + 无据`）。 */
  answer: string | null;
  /** 程序构造的引用（只含本轮命中集 ∩ ≥阈值；见 citations.ts）。 */
  citations: Citation[];
  /** 检索轨迹（披露 rewrittenQuery）。 */
  trace: HandlerTrace;
  /** `有据`（带引用作答）| `无据`（阈值不足/无命中/空查询/引用集空——诚实降级，不杜撰）。 */
  evidence: '有据' | '无据';
}

export interface HandlerDeps {
  /** 注入的作答 generateObject（默认真实 SDK；rewrite 也复用同一注入）。 */
  generateObjectFn?: GenerateObjectFn;
  /** 注入的检索实现（默认 searchKb，带 dbh）。 */
  searchFn?: SearchFn;
  /** 注入的历史读回（默认 readHistory，带 dbh + WHERE user_id）。 */
  readHistoryFn?: (userId: string, conversationId: string) => Promise<ConversationTurn[]>;
  /** 注入的会话写回（默认 writeTurn，带 dbh + WHERE user_id；服务端派生 turn）。 */
  writeTurnFn?: (input: WriteTurnInput) => Promise<number>;
  /** 可注入 db 或事务句柄（默认全局 db；仅默认 searchFn/readHistoryFn/writeTurnFn 用）。 */
  dbh?: DbLike;
  /** 证据阈值（默认 env.RAG_MIN_COSINE）。 */
  minCosine?: number;
  /** 检索 top-k（默认 searchKb 内的 env.KB_SEARCH_TOP_K）。 */
  topK?: number;
  /** 作答最大尝试次数（含首次），默认 3（首次 + 2 次重试，D8）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error。 */
  logError?: (message: string, detail: unknown) => void;
}

/** 作答输出 schema：LLM **只出散文 answer + kb_id 选择器**，绝不出 URL/citations 对象（citations 由 handler 构造）。 */
const answerOutputSchema = z.object({
  /** 散文答案；无法据证据回答 → null（诚实降级）。 */
  answer: z.string().nullable(),
  /** 引用的 kb_id（来自证据块；handler 再按命中集∩阈值过滤，伪造 id 被丢）。coerce 兜 LLM 回数字/序号。 */
  cited_kb_ids: z.array(z.coerce.string()).default([]),
});
type AnswerOutput = z.infer<typeof answerOutputSchema>;

const DEFAULT_MAX_ATTEMPTS = 3;

/** 作答证据块 prompt：**只含 rewrittenQuery + 本轮 eligible 命中**（绝不含历史，D6 红线④）。 */
function buildAnswerPrompt(rewrittenQuery: string, eligibleHits: readonly KbSearchResult[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const evidenceBlock = eligibleHits
    .map(
      (h, i) =>
        `[${i + 1}] kb_id=${h.id}\n标题：${h.kbTitle ?? '(无标题)'}\n摘要：${h.summaryZh ?? '(无摘要)'}`,
    )
    .join('\n\n');
  return [
    '你是 AI 行业情报问答助手。**只依据下面的知识库证据**用简体中文回答用户问题。',
    `当前日期：${today}（以此为「现在」，勿以训练知识截止时点为准）。`,
    '严格要求：',
    '- 只依据证据作答；证据未覆盖的绝不编造。若无法据证据回答，answer 返回 null。',
    '- 绝不给出价格/额度/选型的精确断言（这些由专门系统负责，本系统不作价格判断）。',
    '- cited_kb_ids 只填你实际引用的证据的 kb_id（来自下方证据块），绝不虚构不存在的 kb_id。',
    '',
    `用户问题：${rewrittenQuery}`,
    '',
    '知识库证据：',
    evidenceBlock,
    '',
    '返回字段：answer（散文答案或 null）、cited_kb_ids（引用的 kb_id 字符串数组）。',
  ].join('\n');
}

/**
 * 作答（generateObject）**带重试 + 错误日志**（D8：defaultGenerateObject 只超时无重试，此处自加）。
 * 有限重试全部失败（调用抛错 / Zod 校验不过）→ 返回 null（handler 据此降级无据，不 500）。
 */
async function generateAnswerWithRetry(
  run: GenerateObjectFn,
  prompt: string,
  maxAttempts: number,
  logError: (message: string, detail: unknown) => void,
): Promise<AnswerOutput | null> {
  const model = buildModel();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({ model, schema: answerOutputSchema, prompt });
      const parsed = answerOutputSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(`第 ${attempt}/${maxAttempts} 次：作答输出未通过 Zod 校验`, parsed.error.issues);
        continue;
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：作答 generateObject 调用失败`, error);
    }
  }
  logError(`作答重试 ${maxAttempts} 次耗尽，降级为无据（不作答）`, lastError);
  return null;
}

/**
 * KB-RAG handler 主入口（handler 契约 seam）。
 *
 * @param query 用户原问（裸输入）。
 * @param ctx   { userId（隔离谓词值）, conversationId（服务端生成） }。
 * @param deps  依赖注入（生产用默认真实实现；测试注入桩，见模块头「可测性」）。
 */
export async function handle(
  query: string,
  ctx: HandlerContext,
  deps: HandlerDeps = {},
): Promise<HandlerResult> {
  const dbh = deps.dbh ?? defaultDb;
  const generateObjectFn = deps.generateObjectFn ?? defaultGenerateObject;
  const searchFn =
    deps.searchFn ??
    ((q: string) => searchKb(q, deps.topK != null ? { topK: deps.topK } : {}, dbh));
  const readHistoryFn =
    deps.readHistoryFn ?? ((u: string, c: string) => readHistory(u, c, dbh));
  const writeTurnFn = deps.writeTurnFn ?? ((input: WriteTurnInput) => writeTurn(input, dbh));
  const minCosine = deps.minCosine ?? env.RAG_MIN_COSINE;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    deps.logError ?? ((message, detail) => console.error(`[rag-handler] ${message}`, detail));

  /** 统一写回一轮会话（指针式、只写自有表、带 WHERE user_id）并返回结果（每路径恰写一次，task 2.3）。 */
  const finish = async (result: HandlerResult): Promise<HandlerResult> => {
    await writeTurnFn({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      rawQuery: query,
      rewrittenQuery: result.trace.rewrittenQuery,
      hitKbIds: result.trace.hitKbIds.length > 0 ? result.trace.hitKbIds : null,
      answer: result.answer,
      evidence: result.evidence,
      // 只有真正发起并成功作答时记录 model；非我域/无据无作答 → null。
      model: result.answer !== null ? env.LLM_MODEL : null,
    });
    return result;
  };

  // ── 红线③：价格/选型确定性前置闸（rewrite/作答之前，强制非我域）──────────────
  if (isPriceOrSelectionQuery(query)) {
    return finish({
      domain: '非我域',
      answer: null,
      citations: [],
      evidence: '无据',
      trace: { rawQuery: query, rewrittenQuery: query, hitKbIds: [], topCosine: null, priceGate: true },
    });
  }

  // ── 空查询短路：无可检索 → 无据（不 embed、不作答，红线①之一）──────────────
  if (query.trim().length === 0) {
    return finish({
      domain: '本域',
      answer: null,
      citations: [],
      evidence: '无据',
      trace: { rawQuery: query, rewrittenQuery: query, hitKbIds: [], topCosine: null, priceGate: false },
    });
  }

  // ── 多轮：读回历史 → query-rewrite（历史**只**在此被用；失败降级用原问，D6）──────
  const history = await readHistoryFn(ctx.userId, ctx.conversationId);
  const rewrittenQuery = await rewriteQuery(query, history, { generateObjectFn, logError });

  // ── 检索（env-clean 事件域、只读、确定性）──────────────────────────────────
  const hits = await searchFn(rewrittenQuery);
  const hitKbIds = hits.map((h) => h.id);
  const topCosine = hits.length > 0 ? Math.max(...hits.map((h) => h.cosineSim)) : null;
  const baseTrace: HandlerTrace = {
    rawQuery: query,
    rewrittenQuery,
    hitKbIds,
    topCosine,
    priceGate: false,
  };

  // ── 红线①：证据阈值判无据（handler 层，非 searchKb）──────────────────────────
  // top-k 命中最高 cosine < 阈值、或无命中 → 无据/answer=null，**不发起作答**、不杜撰。
  if (topCosine === null || topCosine < minCosine) {
    return finish({ domain: '本域', answer: null, citations: [], evidence: '无据', trace: baseTrace });
  }

  // eligible 命中（≥阈值）——**只**把这些喂给作答 LLM（LLM 只能引命中集∩阈值，D5②）。
  const eligibleHits = hits.filter((h) => h.cosineSim >= minCosine);

  // ── grounded 作答（generateObject，带重试；载荷只含 rewrittenQuery + eligible 命中，无历史，红线④）──
  const prompt = buildAnswerPrompt(rewrittenQuery, eligibleHits);
  const output = await generateAnswerWithRetry(generateObjectFn, prompt, maxAttempts, logError);

  // 作答重试耗尽（output=null）或 LLM 自判无法作答（answer 空）→ 降级无据（不 500）。
  if (output === null || output.answer === null || output.answer.trim().length === 0) {
    return finish({ domain: '本域', answer: null, citations: [], evidence: '无据', trace: baseTrace });
  }

  // ── 红线②：citations 程序构造（命中集∩阈值过滤，伪造/低分 id 丢弃，source_url 取命中行）──
  const citations = buildCitations(output.cited_kb_ids, hits, minCosine);

  // 阈值过滤后引用集为空（有阈上命中但 LLM 只选了阈下/集外 id）→ 降级无据，不出「有据零引用」伪装答（D5②）。
  if (citations.length === 0) {
    return finish({ domain: '本域', answer: null, citations: [], evidence: '无据', trace: baseTrace });
  }

  return finish({
    domain: '本域',
    answer: output.answer,
    citations,
    evidence: '有据',
    trace: baseTrace,
  });
}
