/**
 * 推荐器解释层 v2：LLM 证据叙述渲染器 + 机械守卫（add-model-radar-recommender-rag-explanation 组 C）。
 *
 * 结构（spec「解释输出的结构」）：`explanation = 模板段 + 可选证据叙述段 + 参考清单`。权威结论只出程序侧
 * （模板段），叙述段是非权威背景补充；数字来源封闭（叙述段数字 MUST ⊆ 守卫①白名单）。降级链恒可回落
 * `renderTemplate` 原值 ⇒ 最终 explanation 逐字节 = v1。
 *
 * env-clean（design D4 / 组 D 静态 grep 钉子）：**MUST NOT 值 import** `config/env`、`agents/llm-client`、
 * `db/index`——LLM provider 以**注入凭据**在模块内构造（仿 `src/kb/embed-clean.ts`），`dbh`/`embed`/`log` 全经注入。
 */
import { generateObject, APICallError } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { sanitizeText } from '../../collectors/sanitize.js';
import { renderTemplate } from './explain.js';
import {
  assembleEvidence,
  safeLog,
  PRICE_CHANGE_WINDOW_DAYS,
  type AssembleEvidenceDeps,
  type EvidenceLog,
} from './evidence.js';
import type { ExplanationInput, RecommendEvidence } from './schema.js';

/** OpenAI 兼容 language model 句柄类型（注入凭据构造）。 */
type LlmModel = ReturnType<ReturnType<typeof createOpenAI>>;

/** 每段素材 canonical 后的长度封顶（spec prompt 注入面 / design D5）。 */
const EVIDENCE_TEXT_MAX_LEN = 200;
/** LLM 调用总预算（模块常量、两进程同一 SOT；重试不扩大，design D4）。 */
const EXPLAIN_LLM_TIMEOUT_MS = 8000;
/** 重试前的剩余预算下限：低于此不重试（design D4）。 */
const EXPLAIN_RETRY_MIN_REMAINING_MS = 2000;

/** 渲染层三值标记（spec「可观测」）。 */
type RenderedBy = 'template' | 'llm' | 'llm-fallback-template';

/** 守卫②结论词表（封闭常量、匹配无正则参与，spec 守卫②）。 */
const CONCLUSION_ZH = ['首选', '备选', '不推荐', '推荐', '建议选'];
const CONCLUSION_LATIN = new Set(['primary', 'recommend', 'recommended', 'best']);

/** 注入的 LLM 凭据（由调用方以主 env / MCP 宽 env 构造）。 */
export interface ExplainerCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** `generateObject` 注入契约（默认真实 SDK；测试注入桩、断言 `maxRetries:0`）。 */
export interface GenerateObjectArgs {
  model: LlmModel;
  schema: unknown;
  prompt: string;
  maxRetries: number;
  abortSignal?: AbortSignal;
}
export type GenerateObjectFn = (args: GenerateObjectArgs) => Promise<{ object: unknown }>;

/** buildExplainer 入参（凭据 + 装配 deps + 可选 generateObject 注入缝）。 */
export interface BuildExplainerOptions {
  credentials: ExplainerCredentials;
  dbh: AssembleEvidenceDeps['dbh'];
  embed: AssembleEvidenceDeps['embed'];
  log: EvidenceLog;
  generateObjectFn?: GenerateObjectFn;
}

const narrativeSchema = z.object({ narrative: z.string() });

/**
 * 默认（真实）generateObject 调用。**测试守卫**（仿 embed-clean / llm-client）：`process.env.VITEST` 下 throw——
 * 把「测试漏注入桩走真实路径」从静默真打生产 LLM 变成失败。生产恒不设此变量。
 */
const defaultGenerateObject: GenerateObjectFn = async (args) => {
  if (process.env.VITEST) {
    throw new Error(
      'explain-llm: 测试环境（VITEST）禁止真实 LLM 调用——未注入 generateObjectFn 桩而走到默认真实路径。' +
        '请在测试中注入 generateObjectFn，不要让默认路径触达生产 LLM。',
    );
  }
  const result = await generateObject(args as unknown as Parameters<typeof generateObject>[0]);
  return { object: (result as { object: unknown }).object };
};

/**
 * canonical 化（守卫与发射的唯一消费对象，spec canonical 段）：
 * sanitizeText（剔 C0、保 `\t\n\r`）→ NFKC 归一 → 负号/dash 映射（负号族 + `\p{Dash_Punctuation}` → `-`）→
 * 剔 C1 控制符（U+0080–009F，Cc，NFKC 不折、非 Cf/非 Default_Ignorable）→ 剔默认可忽略码点
 * （`\p{Default_Ignorable_Code_Point}` 覆盖 Cf 零宽/bidi + 变体选择符 U+FE0F 等 + 其他默认可忽略）。
 * C1 与变体选择符若存活可拆开结论词/URL/数字而目标端不可见，故必剔。
 */
function canonical(text: string): string {
  return sanitizeText(text)
    .normalize('NFKC')
    // `[\u2212\u207b\u208b\u2043]`=Sm/Po \u8d1f\u53f7\u65cf\uff08U+2212/U+207B/U+208B/U+2043\uff09\uff0c\p{Dash_Punctuation}(Pd) \u8986\u76d6\u4e0d\u5230\u3001\u987b\u5e76\u5165 dash \u6620\u5c04\u3002
    .replace(/[\u2212\u207b\u208b\u2043]|\p{Dash_Punctuation}/gu, '-')
    .replace(/[\u0080-\u009f]|\p{Default_Ignorable_Code_Point}/gu, '');
}

/** canonical 后每段封顶（spec：素材侧 canonical 三步在长度封顶之前）。 */
function canonicalCapped(text: string): string {
  return canonical(text).slice(0, EVIDENCE_TEXT_MAX_LEN);
}

/**
 * 统一提取管线核心（构造侧与比对侧共用，spec「统一提取管线」）：输入 = canonical 文本。
 * ①消费 `YYYY-MM-DD` 日期（带数字边界防 `12025-07-17` 拆出内层日期后残 `1`；年/月/日入集、连字符不残留）
 * → ②剔千分位（仅 `\d{1,3}(,\d{3})+` 内逗号）→ ③按 `[-+]?(\d+(\.\d+)?|\.\d+)` 提取，`-`/`+` 仅在段首或前一
 * 字符为非 `[A-Za-z0-9]` 时视为符号。
 *
 * `unverifiable`：某 token `parseFloat` 后**非有限**（如 400 位数 → Infinity）或 `|val|>MAX_SAFE_INTEGER`
 * （浮点折叠，`…992`≡`…993`）——此类叙述侧数字无法与白名单可靠比对，比对侧须 fail-closed。`nums` 仍只收有限值，
 * 保持构造侧（白名单）行为逐字节不变（素材数字都是真实小数值、不触发 unverifiable）。
 */
function extractNumbersDetailed(text: string): { nums: Set<number>; unverifiable: boolean } {
  const nums = new Set<number>();
  let unverifiable = false;

  // ① 日期先消费（数字边界防拆内层；连字符随整段一并移除，不残留为负号）。
  const work0 = text.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, (m) => {
    for (const part of m.split('-')) {
      const v = parseFloat(part);
      if (Number.isFinite(v)) nums.add(v);
    }
    return ' ';
  });

  // ② 千分位分隔仅在 \d{1,3}(,\d{3})+ 模式内剔除（「20, 25」不并成 2025）。
  const work = work0.replace(/\d{1,3}(,\d{3})+/g, (m) => m.replace(/,/g, ''));

  // ②' 科学计数法 fail-closed（比对侧）：`4.6e1` 会被 ③ 拆成 {4.6,1}，二者若均在白名单（如候选名 GLM-4.6 + 框架值 1）
  // 则放行显示为 `46` 的新数字。prompt 已明令叙述段只用平记法，含科学计数法记号即视为不可验证、整段弃用（同 T4 口径）。
  if (/\d[eE][-+]?\d/.test(work)) unverifiable = true;

  // ③ 提取 + 符号上下文。
  const re = /[-+]?(?:\d+(?:\.\d+)?|\.\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) !== null) {
    let token = m[0];
    const sign = token[0] === '-' || token[0] === '+';
    if (sign) {
      const prev = m.index > 0 ? work[m.index - 1]! : '';
      const prevIsAlnum = prev !== '' && /[A-Za-z0-9]/.test(prev);
      if (prevIsAlnum) token = token.slice(1); // 连字符（前接字母/数字）：不消费符号，取正数。
    }
    const val = parseFloat(token);
    if (!Number.isFinite(val) || Math.abs(val) > Number.MAX_SAFE_INTEGER) unverifiable = true;
    if (Number.isFinite(val)) nums.add(val); // nums 收敛口径与原实现一致（仅有限值），构造侧行为不变。
  }
  return { nums, unverifiable };
}

/** 统一提取管线（构造侧：白名单）。仅取有限数值集合，行为与历史实现逐字节一致。 */
export function extractNumbers(text: string): Set<number> {
  return extractNumbersDetailed(text).nums;
}

/** 剥离合法 `[n]` 引用标记（守卫③通过后再跑，用空串替换——防「推[1]荐」类视觉合成结论词）。 */
function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, '');
}

/**
 * 守卫① 数字白名单（比对侧，fail-closed）：叙述段（剥离 `[n]` 后）任一 token 不可验证（非有限/超安全整数）⇒ 弃用；
 * 任一数字 ∉ 白名单 ⇒ 弃用。返回原因或 null（通过）。
 */
export function numberWhitelistGuard(narrative: string, whitelist: Set<number>): string | null {
  const { nums, unverifiable } = extractNumbersDetailed(narrative);
  if (unverifiable) return 'guard1-unverifiable-number';
  for (const n of nums) {
    if (!whitelist.has(n)) return `guard1-number-not-in-whitelist:${n}`;
  }
  return null;
}

/** 拉丁 token 切分（非字母数字分词、小写；无正则匹配词表，spec 守卫②）。 */
function latinTokens(text: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  for (const ch of text) {
    const isAlnum =
      (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (isAlnum) {
      cur += ch;
    } else if (cur) {
      tokens.push(cur.toLowerCase());
      cur = '';
    }
  }
  if (cur) tokens.push(cur.toLowerCase());
  return tokens;
}

/** 守卫② 结论词禁令：消费剥离 `[n]` 后的 canonical 文本，命中封闭词表 ⇒ 弃用。 */
export function conclusionWordGuard(narrative: string): string | null {
  for (const w of CONCLUSION_ZH) {
    if (narrative.includes(w)) return `guard2-conclusion-word:${w}`;
  }
  for (const t of latinTokens(narrative)) {
    if (CONCLUSION_LATIN.has(t)) return `guard2-conclusion-word:${t}`;
  }
  return null;
}

/**
 * 守卫③ 引用形态：消费 canonical 文本（含 `[n]`）。URL 形态 / `[n]` 邻接数字 / 越界引用 ⇒ 弃用。
 * 编号域 = kbHits 条数；全角 `［１］` 已由 canonical NFKC 归一为 `[n]`。
 */
export function citationGuard(narrative: string, kbHitsCount: number): string | null {
  // URL 形态（http / :// 大小写不敏感）——URL MUST NOT 入 prompt。
  if (/http/i.test(narrative) || narrative.includes('://')) return 'guard3-url-form';
  // `[n]` 紧邻数字（\d[ 或 ]\d）——防「[2]5」视觉合成白名单外数字。
  if (/\d\[/.test(narrative) || /\]\d/.test(narrative)) return 'guard3-citation-adjacent-digit';
  // 越界引用（悬空）。
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(narrative)) !== null) {
    const n = parseInt(m[1]!, 10);
    if (n < 1 || n > kbHitsCount) return `guard3-citation-out-of-range:${n}`;
  }
  return null;
}

/** 价格变更行渲染话术（from→to@日期；首录行标「新录得价」，spec 证据装配 / prompt 段）。 */
function renderPriceLine(pc: RecommendEvidence['priceChanges'][number]): string {
  const head = `${pc.vendorName} ${pc.planName}`;
  return pc.from !== null
    ? `${head}：${pc.from}→${pc.to} ${pc.currency}（${pc.changedAt}）`
    : `${head}：新录得价 ${pc.to} ${pc.currency}（${pc.changedAt}）`;
}

/**
 * 参考清单标题折叠：先 canonical（剔 C1/零宽/bidi/变体选择符——KB 标题不可信，否则 RLO/零宽/C1 漏进发射的
 * 参考清单），再 CR/LF/tab 与连续空白 → 单空格、按素材封顶截断（每 kbHit 恒一物理行，spec 守卫③）。
 */
function foldTitle(title: string): string {
  return canonical(title).replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_TEXT_MAX_LEN);
}

/** 参考清单：与编号同序、每 kbHit 一物理行；直接用已 gated 的 kbHits.url（装配层已闸，无需再过 URL 闸）。 */
function renderReferenceList(kbHits: RecommendEvidence['kbHits']): string {
  return kbHits
    .map((h, i) => {
      const t = foldTitle(h.title);
      return h.url ? `[${i + 1}] ${t} ${h.url}` : `[${i + 1}] ${t}`;
    })
    .join('\n');
}

/** 白名单构造：每段最终素材文本跑提取管线 ∪ 显式数值字段 ∪ 框架数值（spec 守卫①）。 */
function buildWhitelist(
  candidateMaterials: string[],
  kbMaterials: string[],
  priceMaterials: string[],
  pendingMaterials: string[],
  input: ExplanationInput,
  evidence: RecommendEvidence,
): Set<number> {
  const whitelist = new Set<number>();
  for (const mat of [...candidateMaterials, ...kbMaterials, ...priceMaterials, ...pendingMaterials]) {
    for (const n of extractNumbers(mat)) whitelist.add(n);
  }
  // 显式数值字段。
  for (const c of input.candidates) {
    if (c.monthlyCost !== null) whitelist.add(c.monthlyCost);
  }
  for (const pc of evidence.priceChanges) {
    const to = Number(pc.to);
    if (Number.isFinite(to)) whitelist.add(to);
    if (pc.from !== null) {
      const from = Number(pc.from);
      if (Number.isFinite(from)) whitelist.add(from);
    }
  }
  // 框架数值：窗口天数常量 + 本次各证据数组长度活值。
  whitelist.add(PRICE_CHANGE_WINDOW_DAYS);
  whitelist.add(evidence.kbHits.length);
  whitelist.add(evidence.priceChanges.length);
  whitelist.add(evidence.pendingReview.length);
  return whitelist;
}

const PROMPT_INSTRUCTIONS =
  '你是编程订阅选型助理。请仅用一段中文补充「最近发生了什么」的背景与变化，供用户参考。硬性要求：' +
  '只用平记法阿拉伯数字（不用汉字数字 / 科学计数法）；不复述现价、不下任何结论（现价与推荐结论以模板段为准）；' +
  '历史价格变更只按下方提供的「从 X 到 Y（日期）」字段叙述，不得引入新数字；引用参考资料时用 [编号]（可选）；不要输出任何网址。';

/** 拼 prompt（编号素材=kbHits、URL 不入、不含 query，spec prompt 段）。 */
function buildPrompt(
  candidateMaterials: string[],
  kbMaterials: string[],
  priceMaterials: string[],
  pendingMaterials: string[],
): string {
  const sections: string[] = [];
  sections.push('候选方案：\n' + candidateMaterials.map((m) => `- ${m}`).join('\n'));
  if (kbMaterials.length > 0) {
    sections.push('参考资料（引用时用 [编号]）：\n' + kbMaterials.map((m, i) => `[${i + 1}] ${m}`).join('\n'));
  }
  if (priceMaterials.length > 0) {
    sections.push(`近 ${PRICE_CHANGE_WINDOW_DAYS} 天价格变更：\n` + priceMaterials.map((m) => `- ${m}`).join('\n'));
  }
  if (pendingMaterials.length > 0) {
    sections.push('待复核（价格待人工确认）：\n' + pendingMaterials.map((m) => `- ${m}`).join('\n'));
  }
  return PROMPT_INSTRUCTIONS + '\n\n' + sections.join('\n\n');
}

/** 是否 abort/timeout 错误（恒不重试，spec 层选择与降级链）。 */
function isAbortOrTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 瞬态错误（spec 口径：网络层错误 + HTTP 429/5xx 重试；4xx 业务错含 408/409 与 schema 校验失败不重试）：
 * `ai` SDK 的 `APICallError.isRetryable` 对 408/409 也置 true（api-call-error.ts），超出 spec，故 APICallError
 * 分支再按状态码收窄——仅 `statusCode == null`（无状态码的网络级）/ 429 / ≥500 才判瞬态，显式排除 408/409 等 4xx。
 * 非 HTTP 的 fetch 失败（不被包成 APICallError）按网络层 `TypeError`/`FetchError` 兜底。上限：outer try/catch 恒兜底回落。
 *（旧实现查 `name==='APICallError'` 是死码——SDK 的 `APICallError.name` 实为 `'AI_APICallError'`、永不命中。）
 */
function isTransient(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    const s = error.statusCode;
    return error.isRetryable === true && (s == null || s === 429 || s >= 500);
  }
  const name = (error as { name?: string } | null)?.name;
  return name === 'TypeError' || name === 'FetchError';
}

export function buildExplainer(options: BuildExplainerOptions): (input: ExplanationInput) => Promise<string> {
  const { credentials, dbh, embed, log } = options;
  // 工厂对注入凭据做防御断言（构造期抛错由调用方 fail-open 兜住，spec 两进程装配）。
  if (!credentials || !credentials.apiKey || !credentials.baseUrl || !credentials.model) {
    throw new Error('buildExplainer: credentials.apiKey/baseUrl/model 均必填');
  }
  const run = options.generateObjectFn ?? defaultGenerateObject;

  // 内存构造 provider + model（不触网、凭据注入、非读 config/env，仿 embed-clean）。
  const provider = createOpenAI({
    baseURL: credentials.baseUrl,
    apiKey: credentials.apiKey,
    headers: { 'X-Title': 'ai-radar' },
  });
  const model = provider(credentials.model);

  /** LLM 调用：8s 总预算内，非超时瞬态错且剩余充足时重试 1 次；maxRetries:0 关 SDK 内建重试。 */
  async function callLlm(prompt: string): Promise<string> {
    const deadline = Date.now() + EXPLAIN_LLM_TIMEOUT_MS;
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('explain-llm: 预算耗尽');
      const signal = AbortSignal.timeout(remaining);
      try {
        const { object } = await run({ model, schema: narrativeSchema, prompt, maxRetries: 0, abortSignal: signal });
        const parsed = narrativeSchema.safeParse(object);
        if (!parsed.success) throw new Error('explain-llm: narrative schema 校验失败'); // 非瞬态、不重试。
        return parsed.data.narrative;
      } catch (error) {
        if (isAbortOrTimeout(error, signal)) throw error; // 超时/abort 恒不重试。
        if (attempt >= 2 || !isTransient(error)) throw error; // 只重试 1 次、非瞬态不重试。
        if (deadline - Date.now() < EXPLAIN_RETRY_MIN_REMAINING_MS) throw error; // 剩余预算不足。
        safeLog(log, 'explain-llm: 瞬态错误重试', { error: String(error) });
      }
    }
  }

  return async function explain(input: ExplanationInput): Promise<string> {
    const templateOut = await renderTemplate(input);
    let evidence: RecommendEvidence | undefined;
    try {
      evidence = input.evidence ?? (await assembleEvidence(input.candidates, { dbh, embed, log }));

      const topCosine = evidence.kbHits.length > 0 ? Math.max(...evidence.kbHits.map((h) => h.cosine)) : null;
      const logRender = (renderedBy: RenderedBy, discardReason?: string): void => {
        safeLog(log, 'mr.recommend.explain', {
          renderedBy,
          kbHits: evidence!.kbHits.length,
          topCosine,
          priceChanges: evidence!.priceChanges.length,
          pendingReview: evidence!.pendingReview.length,
          ...(discardReason ? { discardReason } : {}),
        });
      };

      // 三源全空 ⇒ 跳过 LLM（无料可写、省成本），标记 template。
      if (
        evidence.kbHits.length === 0 &&
        evidence.priceChanges.length === 0 &&
        evidence.pendingReview.length === 0
      ) {
        logRender('template');
        return templateOut;
      }

      // 素材 canonical + 封顶（prompt 与白名单从同一份最终素材构造）。
      const candidateMaterials = input.candidates.map((c) => canonicalCapped(`${c.vendorName} · ${c.name}`));
      const kbMaterials = evidence.kbHits.map((h) => canonicalCapped(h.title));
      const priceMaterials = evidence.priceChanges.map((pc) => canonicalCapped(renderPriceLine(pc)));
      const pendingMaterials = evidence.pendingReview.map((n) => canonicalCapped(n));

      const whitelist = buildWhitelist(
        candidateMaterials,
        kbMaterials,
        priceMaterials,
        pendingMaterials,
        input,
        evidence,
      );
      const prompt = buildPrompt(candidateMaterials, kbMaterials, priceMaterials, pendingMaterials);

      let narrative: string;
      try {
        narrative = await callLlm(prompt);
      } catch (error) {
        logRender('llm-fallback-template', 'llm-call-failed');
        safeLog(log, 'explain-llm: LLM 调用失败回落', { error: String(error) });
        return templateOut;
      }

      // 叙述段 canonical 化 + trim（空判定 / 三守卫 / 发射消费同一 trim 后 canonical 值）→ 空 ⇒ 回落
      // （不标 llm、不产空段、不发射首尾空白）。
      const canonNarr = canonical(narrative).trim();
      if (canonNarr === '') {
        logRender('llm-fallback-template', 'empty-narrative');
        return templateOut;
      }

      // 守卫 ③ → ① → ②（①②消费剥离合法 [n] 后的 canonical 文本）。
      const c3 = citationGuard(canonNarr, evidence.kbHits.length);
      if (c3) {
        logRender('llm-fallback-template', c3);
        return templateOut;
      }
      const stripped = stripCitations(canonNarr);
      const c1 = numberWhitelistGuard(stripped, whitelist);
      if (c1) {
        logRender('llm-fallback-template', c1);
        return templateOut;
      }
      const c2 = conclusionWordGuard(stripped);
      if (c2) {
        logRender('llm-fallback-template', c2);
        return templateOut;
      }

      // 通过：模板段 + 叙述段 + 参考清单（无 KB 命中整段省略）。
      let out = `${templateOut}\n\n${canonNarr}`;
      if (evidence.kbHits.length > 0) out += `\n\n${renderReferenceList(evidence.kbHits)}`;
      logRender('llm');
      return out;
    } catch (error) {
      // 渲染器主体整包 try/catch：守卫/拼装/净化自身抛错同样回落，绝不向 recommend() 传播。
      safeLog(log, 'mr.recommend.explain', {
        renderedBy: 'llm-fallback-template',
        kbHits: evidence?.kbHits.length ?? 0,
        topCosine: null,
        priceChanges: evidence?.priceChanges.length ?? 0,
        pendingReview: evidence?.pendingReview.length ?? 0,
        discardReason: 'render-error',
        error: String(error),
      });
      return templateOut;
    }
  };
}
