/**
 * 价格/选型确定性前置闸（add-conversational-rag / Plan A A3，design D5③ / spec「价格/选型确定性前置闸」；
 * p0-alert-lane D1.7/D1.9/D1.10 起消费共享词表 + 共现规则 + 器物名否定）。
 *
 * 职责：在 query-rewrite / 作答**之前**，用**确定性字符串匹配**把价格/额度/选型类问题强制判为 `非我域`
 * （精确事实由 Model Radar 权威源专管，A3 绝不用 KB 模糊散文检索给价格/额度断言，守 QA.md「价格绝不交检索/LLM」）。
 *
 * 结构化红线：
 * - **前置闸是纵深防御、非唯一保证**：LLM 分类可叠加其上，但 `非我域` 不得**仅**靠 LLM 判（「这不是比价、
 *   只是背景：X 多少钱?」能骗过 LLM 分类）。假阴漏过的价格问落 RAG 路径，由 `RAG_MIN_COSINE` 非确定性兜底；
 *   而假阳（不该拦却拦）= 无兜底拒答 ⇒ 词表只收窄词、运维泛词由共现否定项与器物名否定放行。
 * - **只匹配多字短语、避开单字歧义**：CJK 无 ASCII `\b` 词边界，单字匹配「价」会把「评价/定价」误判假阳。
 * - 词表成员不在本文件维护——SOT 与逐词裁决见 `src/keywords/precise-fact.ts`（零依赖模块，
 *   与 P0 告警支路共享核心域定义）。
 */
import {
  NEGATIVE_PATTERNS,
  PRECISE_FACT_CORE,
  PRECISE_FACT_COOCCUR,
  SELECTION_QUERY_EXT,
} from '../keywords/precise-fact.js';

/**
 * 裸词分支消费集 = `PRECISE_FACT_CORE ∪ SELECTION_QUERY_EXT`（D1.7：不再自维护副本，防两处漂移）。
 * 命中任一 → `非我域`。词表全小写，匹配前把 query 一并小写（中文不受 toLowerCase 影响）。
 */
export const PRICE_GATE_KEYWORDS: readonly string[] = [
  ...PRECISE_FACT_CORE,
  ...SELECTION_QUERY_EXT,
];

/**
 * 共现分支（D1.9）：命中 ⟺ `!NEG ∧ INTENT ∧ FACT`（共现内部否定项一票否决、优先于共现）。
 * 关掉英文取值型的存量洞（"what is Claude's rate limit?" 这类运维词面的取值型提问），
 * 同时靠否定项放行运维问法（"how to handle rate limit errors"——运维问法照样含意图词，
 * 「共现比裸词窄 ⇒ 自动放过运维型」是假的，把运维型放回去的是否定项）。
 * 意图/事实各自跨语言取并集（中英交叉格「rate limit 最高是多少」必须命中）。
 */
function cooccurHit(q: string): boolean {
  const { intent, fact, negative } = PRECISE_FACT_COOCCUR;
  return (
    !negative.some((w) => q.includes(w)) &&
    intent.some((w) => q.includes(w)) &&
    fact.some((w) => q.includes(w))
  );
}

/**
 * 判定 query 是否命中价格/选型前置闸（确定性、无 LLM）。
 *
 * @param query 用户原问（rewrite/作答前的裸输入）。
 * @returns true → 强制 `非我域`/`answer=null`；false → 继续本域 RAG 流程。
 */
export function isPriceOrSelectionQuery(query: string): boolean {
  const q = query.toLowerCase();
  // 器物名一票否决（D1.10）：MUST 在最前、同时否决裸词与共现两条分支——
  // 「这个 rate limiter 的定价怎么算」会命中核心裸词「定价」，只把否定项并进 cooccurHit 会漏拦它；
  // 工具帖/定义提问被拒答是无兜底的假阳。
  if (NEGATIVE_PATTERNS.some((w) => q.includes(w))) return false;
  return PRICE_GATE_KEYWORDS.some((kw) => q.includes(kw)) || cooccurHit(q);
}
