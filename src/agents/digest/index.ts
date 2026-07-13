/**
 * 中文摘要 Agent（任务 7.1，capability: chinese-digest-agent）。
 *
 * 与 value-judge 同规格（design D9）：
 * - 经 Vercel AI SDK `generateObject` 调用 LLM（provider/model 从 env 注入）。
 * - 以 ./schema.ts 的 Zod schema 约束并校验输出（含 `summary_zh`）。
 * - 校验失败处理（关键不变量）：记 error 日志 + 有限重试，仍失败则降级抛出
 *   DigestFailureError，绝不静默吞掉、绝不返回未校验或半截输出。
 *
 * 依赖注入：`generateObject` 经参数注入（默认用真实 SDK），
 * 使 vitest 可在不依赖真实 key 的前提下覆盖成功/失败路径。
 *
 * 边界：本模块只产出经校验的摘要对象；落库（UPDATE summary_zh）与降级回退
 * （representative_title / 剔除）由 ./persistence.ts 实现。
 */
import type { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { buildModel, defaultGenerateObject } from '../llm-client.js';
import {
  digestOutputSchema,
  headlineOnlyOutputSchema,
  HEADLINE_MAX,
  type DigestOutput,
  type HeadlineOnlyOutput,
} from './schema.js';

export { digestOutputSchema, headlineOnlyOutputSchema };
export type { DigestOutput, HeadlineOnlyOutput };

/**
 * 有限重试后仍无法得到经校验摘要时抛出的降级信号。
 * 调用方据此降级（回退 representative_title 或剔除该 event），而非把失败当成功。
 */
export class DigestFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'DigestFailureError';
    this.attempts = attempts;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `generateObject` 的最小依赖契约（仅取本 Agent 用到的形参/返回）。
 * 注入此类型使测试可 mock，不依赖真实 LLM。
 *
 * `schema` 为 `z.ZodTypeAny`（宽松）：完整路径传 digestOutputSchema、轻量路径传
 * headlineOnlyOutputSchema，同一注入桩可服务两条路径。
 */
export type GenerateObjectFn = (args: {
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  schema: z.ZodTypeAny;
  prompt: string;
}) => Promise<{ object: unknown }>;

export interface SummarizeEventInput {
  /** 事件代表标题（必填，构成 prompt 主体）。 */
  title: string;
  /** 事件正文/原文摘要（可选，供 prompt 上下文）。 */
  content?: string | null;
  /** 来源标识（可选，供 prompt 上下文）。 */
  source?: string | null;
}

export interface SummarizeOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 构造摘要 prompt。`mode='full'` 产 summary_zh + headline_zh；`mode='headline'` 只产 headline_zh。
 *
 * 两模式共用同一防幻觉护栏（当前日期注入 + 无正文只据标题不编造），只有「长度要求 + 字段声明」
 * 两句因产出集不同而分叉——轻量路径同样 grounding 于正文、无正文不编造（spec「两路径都 grounding」）。
 */
function buildPrompt(
  input: SummarizeEventInput,
  mode: 'full' | 'headline' = 'full',
): string {
  // 当前日期无条件注入：使模型以「现在」为准、不以训练截止时点判定新旧（design D4）。
  const today = new Date().toISOString().slice(0, 10);
  // 纯空白正文视同无正文（与 value-judge 的 content !~ '\S' 同口径），触发防幻觉护栏。
  const hasContent = Boolean(input.content?.trim());
  const parts = [
    '你是 AI 行业情报分析师。请用简体中文为下面这条事件生成结构化输出。',
    `当前日期：${today}（以此为「现在」，勿以你的训练知识截止时点为准）。`,
    mode === 'full'
      ? '要求：只陈述事实与对开发者的影响，不夸张、不堆砌营销词；摘要控制在约 1000 字以内；只返回结构化 JSON。'
      : '要求：只陈述事实与对开发者的影响，不夸张、不堆砌营销词；只返回结构化 JSON。',
    `标题：${input.title}`,
  ];
  if (hasContent) parts.push(`正文：${input.content}`);
  if (input.source) parts.push(`来源：${input.source}`);
  if (!hasContent) {
    // 无正文防幻觉护栏（design D4 / spec「无正文时不编造具体参数 / 不否认真实发布」）。
    parts.push(
      '注意：本条无正文，只有标题。请只依据标题客观概括，' +
        '禁止编造标题中未出现的具体事实（版本号、参数指标如上下文窗口大小/benchmark 分数、发布时间、价格、功能清单等）；' +
        '禁止基于你的训练知识断言该产品/模型是否存在或是否已发布，' +
        '也禁止否定或质疑标题所声称的发布事实——训练知识存在时效滞后，一律以标题所述为准客观转述。',
    );
  }
  parts.push(
    mode === 'full'
      ? '字段：summary_zh（中文摘要正文）；' +
          `headline_zh（一句话要点，含主体+动作+影响，≤${HEADLINE_MAX} 字）。`
      : `字段：headline_zh（一句话要点，含主体+动作+影响，≤${HEADLINE_MAX} 字）。`,
  );
  return parts.join('\n');
}

/**
 * 有限重试 + 独立 Zod 复校 + 降级抛错的共享内核（完整/轻量两路径共用，单一事实来源）。
 *
 * 成功：返回经 `schema` 校验通过的对象。
 * 失败：所有尝试都因调用抛错或 Zod 校验不过而失败 → 记日志 + 抛 DigestFailureError（降级信号），
 *       绝不返回未校验或半截输出。mojibake 由 schema 的 refine 承担、在此走 Zod 失败分支。
 */
async function generateValidated<S extends z.ZodTypeAny>(
  schema: S,
  prompt: string,
  options: SummarizeOptions,
): Promise<z.infer<S>> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[digest] ${message}`, detail));

  const model = buildModel();

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({ model, schema, prompt });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验/半截输出绝不外泄。
      const parsed = schema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：摘要输出未通过 Zod 校验`,
          parsed.error.issues,
        );
        continue;
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：generateObject 调用失败`, error);
    }
  }

  // 有限重试耗尽 → 降级（抛出），由调用方决定回退 representative_title 或剔除。绝不静默吞掉。
  throw new DigestFailureError(
    `中文摘要 Agent 在 ${maxAttempts} 次尝试后仍无法产出经校验的摘要，已降级（不写库）。`,
    maxAttempts,
    lastError,
  );
}

/**
 * 完整路径：对一条入选事件产出经 Zod 校验的中文摘要（summary_zh + headline_zh 同产）。
 *
 * 保留供仍需当场落库 summary_zh 的调用方（实时告警链等）；日报 digest 阶段改用轻量路径
 * `generateHeadline`（见下）。
 */
export async function summarizeEvent(
  input: SummarizeEventInput,
  options: SummarizeOptions = {},
): Promise<DigestOutput> {
  return generateValidated(digestOutputSchema, buildPrompt(input, 'full'), options);
}

/**
 * 轻量路径（日报 digest 阶段用）：只产经 Zod 校验的 `headline_zh`（一句话要点），**不产 summary_zh**。
 *
 * schema 仅 `{ headline_zh }` → generateObject 输出 token 大减。降级语义与完整路径一致
 * （校验失败/mojibake → 有限重试 → 耗尽抛 DigestFailureError，由持久化层回退 representative_title
 * 或剔除）；同样 grounding 于正文、无正文不编造（prompt 注入当前日期 + 无正文护栏）。
 */
export async function generateHeadline(
  input: SummarizeEventInput,
  options: SummarizeOptions = {},
): Promise<HeadlineOnlyOutput> {
  return generateValidated(
    headlineOnlyOutputSchema,
    buildPrompt(input, 'headline'),
    options,
  );
}
