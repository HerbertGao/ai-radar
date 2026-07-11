/**
 * 价格/选型确定性前置闸（add-conversational-rag / Plan A A3，design D5③ / spec「价格/选型确定性前置闸」）。
 *
 * 职责：在 query-rewrite / 作答**之前**，用**确定性关键词匹配**把价格/额度/选型类问题强制判为 `非我域`
 * （精确事实由 Model Radar 权威源专管，A3 绝不用 KB 模糊散文检索给价格/额度断言，守 QA.md「价格绝不交检索/LLM」）。
 *
 * 结构化红线（design D5③）：
 * - **前置闸是纵深防御、非唯一保证**：LLM 分类可叠加其上，但 `非我域` 不得**仅**靠 LLM 判（「这不是比价、
 *   只是背景：X 多少钱?」能骗过 LLM 分类）。真兜底 = KB 无权威价格事实、假阴漏过的价格问也撞 `RAG_MIN_COSINE`→无据。
 * - **只匹配多字短语、避开单字歧义**：CJK 无 ASCII `\b` 词边界，单字匹配「价」会把「评价/定价」误判假阳。
 *   故关键词全部 ≥2 字且互不为对方子串歧义源（如用「价格/报价/售价」而非裸「价」）。
 */

/**
 * 价格/额度/选型触发词（**全部多字短语**，避单字歧义）。
 * 命中任一 → `非我域`。英文词小写存储、匹配前把 query 一并小写（中文不受 toLowerCase 影响）。
 * ponytail: 保守精选清单即可——前置闸是纵深防御，穷举非必需（假阴由 RAG_MIN_COSINE 无据兜底），
 * 宁缺毋滥防误伤正常 KB 问题（如含单字「价」的「评价/代价」不列入）。
 */
export const PRICE_GATE_KEYWORDS: readonly string[] = [
  // 价格 / 计费
  '价格',
  '多少钱',
  '预算',
  '费用',
  '报价',
  '收费',
  '售价',
  '单价',
  '计费',
  '订阅费',
  '会员费',
  '性价比',
  '划算',
  '便宜',
  '套餐',
  // 额度 / 用量（QA.md：额度是精确事实）
  '额度',
  '限额',
  '配额',
  'token 包',
  'token包',
  // 选型 / 比价（Model Radar recommender 专管）
  '选型',
  '选哪个',
  '哪个更划算',
  '哪个划算',
  '性价比最高',
  '推荐哪个',
  '怎么选',
  // 英文（小写）
  'pricing',
  'how much',
  'how much does',
  'cost per',
  'per token',
  'token package',
  'quota',
];

/**
 * 判定 query 是否命中价格/选型前置闸（确定性、无 LLM）。
 *
 * @param query 用户原问（rewrite/作答前的裸输入）。
 * @returns true → 强制 `非我域`/`answer=null`；false → 继续本域 RAG 流程。
 */
export function isPriceOrSelectionQuery(query: string): boolean {
  const q = query.toLowerCase();
  return PRICE_GATE_KEYWORDS.some((kw) => q.includes(kw));
}
