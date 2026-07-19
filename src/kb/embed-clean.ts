/**
 * env-clean `embedTexts` 变体（add-conversational-rag 组 A / design D7 / task 4.2）。
 *
 * 与 `dedup/embedding.ts` 的 `embedTexts` 同「批量文本 → 等长同序向量 + 重试 + 错误日志」逻辑，但：
 * - **收注入凭据**（`apiKey`/`baseURL`/`model`），**不 top-level import `config/env`**（那会 eager parseEnv、崩纯查询进程）。
 * - 不值 import `db/index`（`dedup/embedding.ts` 顶层值 import 它，故不能从那里复用 `embedTexts`——会连坐 parseEnv）。
 *
 * 运行期由 `src/mcp/tools/search-kb.ts` 用 MCP 宽 env 凭据构造调用；测试注入 `embedManyFn` 桩不触网。
 * 本变体运行期在 search_kb 守护测试里被注入桩替换、**不经实跑**，其「无 top-level eager-env import」的清洁性
 * **只能靠静态 grep 证**（见 `query-chain-env.test.ts` 名单）——故相对 import 路径若变，须同步 grep specifier。
 */
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
// 复用 EmbedManyFn 契约类型（`import type` 运行期擦除，不连坐 dedup/embedding 的 db/index/config/env 值 import）。
import type { EmbedManyFn } from '../dedup/embedding.js';

export type { EmbedManyFn };

/** 注入的 embedding 凭据（由 MCP 宽 env 的可选 LLM 凭据构造）。 */
export interface EmbedCleanCredentials {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** env-clean embed 的可注入选项（重试 / 日志 / 注入桩）。 */
export interface EmbedCleanOptions {
  /** 注入的 embedMany 实现，默认真实 SDK。 */
  embedManyFn?: EmbedManyFn;
  /** 最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error。 */
  logError?: (message: string, detail: unknown) => void;
  /**
   * opt-in 取消信号（见 D2）。传入则透传给 `embedMany` 的 `abortSignal`；abort 后不重试。
   * 缺省不传 ⇒ 不出现 `abortSignal` ⇒ 逐字节等价现状。`AbortSignal` 是全局，不破 env-clean。
   */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 默认（真实）embedMany 调用；仅在未注入 embedManyFn 时兜底使用。
 * **测试守卫**（与 dedup/embedding.ts 的 defaultEmbedMany 同口径）：`process.env.VITEST` 下 throw——
 * 把「测试漏注入桩走真实路径」从静默真打生产 embedding API 变成失败。生产恒不设此变量。
 */
const defaultEmbedMany: EmbedManyFn = async (args) => {
  if (process.env.VITEST) {
    throw new Error(
      'embed-clean: 测试环境（VITEST）禁止真实 embedding 调用——未注入 embedManyFn 桩而走到默认真实路径。' +
        '请在测试中注入 embedManyFn，不要让默认路径触达生产 embedding API。',
    );
  }
  const result = await embedMany(args);
  return { embeddings: result.embeddings as number[][] };
};

/**
 * env-clean 低层 embed 原语：对一批文本批量生成向量，带重试 + 错误日志（凭据由入参注入、非 env）。
 *
 * **绝不**在此做空文本过滤——调用方须保证 `texts` 全部非空。
 *
 * @param texts       待嵌入的非空文本数组。空数组直接返回 `[]`（不发起调用）。
 * @param credentials 注入的 embedding 凭据（apiKey/baseURL/model）。
 * @param options     重试 / 日志 / 注入桩。
 */
export async function embedTextsClean(
  texts: readonly string[],
  credentials: EmbedCleanCredentials,
  options: EmbedCleanOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const run = options.embedManyFn ?? defaultEmbedMany;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[embed-clean] ${message}`, detail));
  const signal = options.signal;

  // 仅内存构造 provider + model（不触网）；凭据由入参注入、非读 config/env。
  const provider = createOpenAI({
    baseURL: credentials.baseURL,
    apiKey: credentials.apiKey,
    headers: { 'X-Title': 'ai-radar' },
  });
  const model = provider.embedding(credentials.model);
  const values = [...texts];

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { embeddings } = await run({ model, values, ...(signal ? { abortSignal: signal } : {}) });
      if (!Array.isArray(embeddings) || embeddings.length !== values.length) {
        // 长度不齐则无法可靠按序回映——视为失败重试，绝不错位。
        lastError = new Error(
          `embedMany 返回 ${embeddings?.length ?? 'undefined'} 个向量，与请求的 ${values.length} 条文本不等长`,
        );
        logError(`第 ${attempt}/${maxAttempts} 次：embedMany 返回向量数与文本数不一致`, lastError);
        continue;
      }
      return embeddings;
    } catch (error) {
      // abort 是主动取消、非瞬态错——仅当调用方传入 signal（本层才引入取消语义）时不进下一 attempt、直接抛（见 D2）；
      // 无 signal 消费者不触此分支 ⇒ 与现状逐字节等价（保 D5「缺省逐字节不变」，不吞 SDK 内部 abort 的既有重试）。
      if (signal && (signal.aborted || (error as { name?: string } | null)?.name === 'AbortError')) throw error;
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：embedMany 调用失败`, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`embedTextsClean 在 ${maxAttempts} 次尝试后仍失败`);
}
