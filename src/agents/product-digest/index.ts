/**
 * 产品中文化 Agent（capability: product-chinese-digest，design D2）。
 *
 * **Agent 内核**与 events digest（src/agents/digest/index.ts）同规格：
 * - 经 Vercel AI SDK `generateObject` 调用 LLM（provider/model 从 env 注入）。
 * - 以 ./schema.ts 的 Zod schema 约束并校验输出（含 `name_zh` / `tagline_zh`）。
 * - 校验失败处理（关键不变量）：记 error 日志 + 有限重试，仍失败则降级抛出
 *   ProductDigestFailureError，绝不静默吞掉、绝不返回未校验或半截输出。
 *
 * 依赖注入：`generateObject` 经参数注入（默认用真实 SDK），
 * 使 vitest 可在不依赖真实 key 的前提下覆盖成功/失败路径。
 *
 * 边界：本模块只产出经校验的中文化对象；落库（UPDATE name_zh/tagline_zh）由
 * ./persistence.ts 实现；编排（候选并集 / 永不向上抛 / 失败告警）由 pipeline 层实现
 * （**编排契约不同规格**：编排零件对称 collapseProductsOnce 永不向上抛，详见 design D7）。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { buildModel, defaultGenerateObject } from '../llm-client.js';
import {
  productDigestOutputSchema,
  NAME_ZH_MAX,
  PRODUCT_TAGLINE_MAX,
  type ProductDigestOutput,
} from './schema.js';

export { productDigestOutputSchema };
export type { ProductDigestOutput };

/**
 * 有限重试后仍无法得到经校验中文化输出时抛出的降级信号。
 * 编排层据此降级（保持 name_zh NULL、渲染回退英文 name），而非把失败当成功。
 */
export class ProductDigestFailureError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'ProductDigestFailureError';
    this.attempts = attempts;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `generateObject` 的最小依赖契约（仅取本 Agent 用到的形参/返回）。
 * 注入此类型使测试可 mock，不依赖真实 LLM。
 */
export type GenerateObjectFn = (args: {
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  schema: typeof productDigestOutputSchema;
  prompt: string;
}) => Promise<{ object: unknown }>;

export interface SummarizeProductInput {
  /** 产品名（英文，必填，构成 prompt 主体）。 */
  name: string;
  /** 原始英文描述（可选；经 representative_raw_item_id → raw_items.content；缺则仅凭 name）。 */
  content?: string | null;
}

export interface SummarizeProductOptions {
  /** 注入的 generateObject 实现，默认真实 SDK。 */
  generateObjectFn?: GenerateObjectFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function buildPrompt(input: SummarizeProductInput): string {
  // 当前日期无条件注入：使模型以「现在」为准、不以训练截止时点判定新旧（design D5，与新闻对称）。
  const today = new Date().toISOString().slice(0, 10);
  // 产品为名判：content 仅为采集器已存正文（若有），无 enrichment 补抓；纯空白视同无描述。
  const hasContent = Boolean(input.content?.trim());
  const parts = [
    '你是 AI 工具/产品分析师。请用简体中文为下面这个产品生成结构化输出。',
    `当前日期：${today}（以此为「现在」，勿以你的训练知识截止时点为准）。`,
    '要求：只陈述事实与对开发者的价值，不夸张、不堆砌营销词；只返回结构化 JSON。',
    `产品名：${input.name}`,
  ];
  if (hasContent) {
    parts.push(`产品描述：${input.content}`);
  } else {
    // content 缺失（如 Show HN 恒 null）：仅凭产品名产中文，不编造未知功能。
    parts.push('（无产品描述，仅凭产品名翻译/概括。）');
  }
  // 防幻觉护栏（design D5，与新闻摘要 buildPrompt 对称）：产品按名判定，一律禁止据训练知识补事实。
  parts.push(
    '注意：禁止编造产品名（及描述，若有）中未出现的具体事实（版本号、参数指标、发布时间、价格、功能清单等）；' +
      '禁止基于你的训练知识断言该产品是否存在或是否已发布；' +
      'is_ai_related 只依据产品名（及描述，若有）所述客观判定，训练知识存在时效滞后，不据其否认或质疑。',
  );
  parts.push(
    `字段：name_zh（中文译名，≤${NAME_ZH_MAX} 字；若已是中文或为专有名词可保留原名）；` +
      `tagline_zh（一句话中文简介，含产品定位+对开发者的价值，≤${PRODUCT_TAGLINE_MAX} 字）；` +
      `is_ai_related（布尔：该产品是否与 AI/机器学习直接相关——如 AI 编程工具、LLM 应用、` +
      `ML 框架/模型为 true；扫雷游戏、通用日志库等与 AI 无关的产品为 false）。`,
  );
  return parts.join('\n');
}

/**
 * 对一个入选产品产出经 Zod 校验的中文译名 + 简介。
 *
 * 成功：返回经 productDigestOutputSchema 校验通过的对象（含非空 name_zh / tagline_zh）。
 * 失败：所有尝试都因调用抛错或 Zod 校验不过而失败 → 记日志 + 抛 ProductDigestFailureError
 *       （降级信号），绝不返回未校验或半截输出。
 */
export async function summarizeProduct(
  input: SummarizeProductInput,
  options: SummarizeProductOptions = {},
): Promise<ProductDigestOutput> {
  const run = options.generateObjectFn ?? defaultGenerateObject;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[product-digest] ${message}`, detail));

  const model = buildModel();
  const prompt = buildPrompt(input);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run({
        model,
        schema: productDigestOutputSchema,
        prompt,
      });
      // 即便 SDK 已按 schema 解析，这里再独立校验一次，确保未校验/半截输出绝不外泄。
      const parsed = productDigestOutputSchema.safeParse(result.object);
      if (!parsed.success) {
        lastError = parsed.error;
        logError(
          `第 ${attempt}/${maxAttempts} 次：中文化输出未通过 Zod 校验`,
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

  // 有限重试耗尽 → 降级（抛出），由编排层决定保持 NULL（渲染回退英文 name）。绝不静默吞掉。
  throw new ProductDigestFailureError(
    `产品中文化 Agent 在 ${maxAttempts} 次尝试后仍无法产出经校验的输出，已降级（不写库）。`,
    maxAttempts,
    lastError,
  );
}
