/**
 * 精确事实域词表（p0-alert-lane D1；成员唯一 SOT =
 * `openspec/changes/p0-alert-lane/specs/conversational-rag/spec.md` 的穷举表——改词先改 SOT）。
 *
 * 两个出口共享同一个域定义、执行不同判定（问题意图 vs 事件类型，方向相反）：
 * - `/advisor` 前置闸（src/rag/price-gate.ts）：消费 `PRECISE_FACT_CORE ∪ SELECTION_QUERY_EXT`
 *   裸词 ∪ `PRECISE_FACT_COOCCUR` 共现——命中即拒答（精确事实绝不交检索/LLM，QA.md 红线③）。
 * - P0 告警支路 B（src/keywords/fact-change-gate.ts）：消费 `PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`
 *   （纯裸词 SQL `LIKE ANY`，不消费共现）——命中即立刻推（精确事实变了，人必须马上知道）。
 * - `NEGATIVE_PATTERNS`（器物名否定）两个出口共同消费：advisor 一票否决裸词与共现两条分支；
 *   P0 侧渲染为 SQL 否定合取项。
 *
 * ⚠️ 本模块 MUST 保持零依赖（不 import drizzle / schema）：`src/rag/price-gate.ts` 只需要词表，
 * 若这里 import drizzle/schema，price-gate 会为一份纯字符串数组**传递依赖上整个 `src/db/schema`**。
 * SQL 谓词出口放同目录 fact-change-gate.ts（那边才允许依赖 drizzle）。
 *
 * 选词口径（作用域 = 四组裸词常量）：全小写、多字短语、不含单字、不含 LIKE 元字符（`%` `_` `\`，
 * 加载即断言，见文件末尾）。共现三表：全小写、不含元字符；**否定词允许单字**（如「撞」——共现
 * 否定是一票否决，误杀方向 = 落 RAG 路径有 `RAG_MIN_COSINE` 兜底，与裸词假阳无兜底方向相反）。
 *
 * 三条选词规则（每条防一类已知的静默失效）：
 * 1. 死词自检（作用域 = 该 gate 的消费集）：W 是死词 ⟺ 消费集中存在更短 S 使 `W.includes(S)` 恒真
 *    （`some(kw => q.includes(kw))` 下 S 先满足）。「额度上限」⊂「额度」→ 不加；存量死词已清：
 *    `性价比最高` ⊂ `性价比`、`哪个划算`/`哪个更划算` ⊂ `划算`、`how much does` ⊂ `how much`
 *    （删除不改变命中集）。
 * 2. CJK 子串陷阱：`'使用量'.includes('用量')` 恒真 → 裸「用量」不入任何一组（「ChatGPT 周使用量
 *    破 8 亿」会直接触发 P0）；招牌用例「周用量上限提升 50%」由核心「用量上限」命中，零召回损失。
 * 3. 中英一致：`rate limit` 在英文里正是那个运维词（"how to handle rate limit errors" / "429"），
 *    与中文裸「限流」、其标准中译「速率限制」、`usage limit` 完全同类 → 四者不作裸词进核心
 *    （advisor 侧假阳 = 无兜底拒答），只进 `FACT_CHANGE_EXT`（仅 P0，新闻标题里几乎必是变更公告）；
 *    advisor 侧的英文取值型问法由 `PRECISE_FACT_COOCCUR` 共现规则确定性覆盖。
 */

/**
 * 精确事实域核心词（取值型/限额型短语）——advisor 前置闸 + P0 告警支路 B 两侧共享。
 * 只收窄词：本表的假阳同时打在两个出口，且 advisor 侧是无兜底拒答（更贵的那一侧）。
 */
export const PRECISE_FACT_CORE: readonly string[] = [
  // 价格 / 计费（真·公告措辞；语义过宽的「报价/单价/售价」归 SELECTION_QUERY_EXT）
  '价格',
  '定价',
  '计费',
  '订阅费',
  '会员费',
  'pricing',
  // 额度 / 限额（QA.md：额度是精确事实）
  '额度',
  '限额',
  '配额',
  // token 包三变体缺一不可：半角空格 / 全角空格 U+3000 / 无空格——中文标题用全角空格
  // 分隔中英文是常态，漏全角变体 = 对一类常见标题恒不命中，且这类漏词恒不可见（D1.6）
  'token 包',
  'token　包',
  'token包',
  'token package',
  'quota',
  // 取值型限额短语（缺失则「周用量上限提到多少了」落 KB 散文路径）。
  // 「用量上限」恒留核心：P0 支路不消费共现 ⇒ 移出核心 = P0 招牌用例「周用量上限提升 50%」
  // 静默失联；其 advisor 侧中文运维假阳（「用量上限撞了多久恢复」被拒答）是已登记的有意代价（D1.9）
  'weekly limit',
  '用量上限',
];

/**
 * 提问词 / 主观词扩展——仅 advisor 前置闸消费，MUST NOT 进 P0（它们是用户问法而非新闻标题措辞；
 * `per token` 几乎是 LLM 论文标题的通用后缀，`便宜`/`套餐`/`费用` 同样泛化）。
 * 「报价/单价/售价」语义过宽（「H100 售价上调」「OpenAI 报价 X 亿收购」是市场/并购新闻），
 * 故不入核心、只归本组（advisor 侧它们本就是问法）（D1.5）。
 */
export const SELECTION_QUERY_EXT: readonly string[] = [
  '多少钱',
  '预算',
  '费用',
  '收费',
  '性价比',
  '划算',
  '便宜',
  '套餐',
  '报价',
  '单价',
  '售价',
  '选型',
  '选哪个',
  '推荐哪个',
  '怎么选',
  'how much',
  'cost per',
  'per token',
];

/**
 * 变更词 + 运维泛词扩展——仅 P0 告警支路消费，MUST NOT 进 advisor 前置闸：
 * 「GPT-4 被弃用了吗」是可由 KB 如实回答的新闻事实；`rate limit`/`usage limit`/`速率限制`/
 * 裸`限流` 是运维词（advisor 侧假阳 = 无兜底拒答），而新闻标题里出现它们几乎必是变更公告（D1.5）。
 */
export const FACT_CHANGE_EXT: readonly string[] = [
  'deprecat', // 词干，有意覆盖 deprecated / deprecation（过宽面已登记进核验清单）
  'sunset',
  '弃用',
  '停止支持',
  '限流',
  'rate limit',
  'usage limit',
  '速率限制',
];

/**
 * 器物名否定模式——两个出口共同消费（advisor 一票否决两条分支；P0 SQL 否定合取项）。
 * 正向词 `rate limit`/`限流`/`速率限制` 都是器物名的子串（无词边界）⇒ 不挡则
 * 「Show HN: A Rate Limiter for LLM APIs」推手机、「what is a rate limiter?」被无兜底拒答。
 *
 * 🔴 MUST NOT 含 `rate limiting`：它是公告常用动名词（"Improved rate limiting"），挡它 =
 * 漏掉真的限流变更公告——正是支路 B 存在要防的失效（漏一条真变更 > 误震一次博文，D1.10）。
 */
export const NEGATIVE_PATTERNS: readonly string[] = ['rate limiter', '限流器', '速率限制器'];

/**
 * 共现规则（仅 advisor 消费，MUST NOT 进 P0 词表支路——P0 是纯标题 `LIKE ANY` 谓词）。
 * 命中 ⟺ !negative.some(w => q.includes(w)) && intent.some(...) && fact.some(...)
 * （否定项一票否决、优先于共现；本 negative 只在共现判定内部，与 NEGATIVE_PATTERNS 是两张不同的表）。
 *
 * 意图与事实各自跨语言取并集后再做共现（中英交叉格「rate limit 最高是多少」必须能命中），
 * MUST NOT 实现成两条各自封闭的语言内规则。
 *
 * 成员裁决（D1.9，每条对应一个实测的静默失效）：
 * - intent MUST NOT 含裸 `max`（⊂ `max_tokens`/`maxed`；`maximum` 覆盖真取值问法、
 *   "what's the max usage limit" 由 `what's` 命中 ⇒ 零召回损失，且顺带解掉「maximum ⊂ max 是死词」）；
 *   MUST NOT 含 `how much`（已是 SELECTION_QUERY_EXT 裸词 ⇒ 共现分支恒不独立命中 = 死规则）；
 *   MUST NOT 含 `是多少`（⊂ `多少` ⇒ 死词）。
 * - fact MUST NOT 含 `用量上限`（已是核心裸词 ⇒ 死规则）。
 * - negative MUST NOT 含 `hit`（⊂ `white` ⇒ "rate limit for white-label apps" 这条取值型会被误放行）；
 *   `handling` MUST 与 `handle` 并存、不是死词——'handling'.includes('handle') 为 false
 *   （handle 的 e 在 -ing 前脱落），删它则「current rate limit handling」会被共现误拦（无兜底拒答）。
 *   曾有一轮按「死词」误删过，此处登记防重演。
 */
export const PRECISE_FACT_COOCCUR: {
  readonly intent: readonly string[];
  readonly fact: readonly string[];
  readonly negative: readonly string[];
} = {
  intent: ['what is', "what's", 'current', 'maximum', 'how many', '多少', '上限是', '最多', '最高'],
  fact: ['rate limit', 'usage limit', '速率限制'],
  negative: [
    'error',
    '429',
    'retry',
    'back off',
    'backoff',
    'handle',
    'handling',
    'maxed',
    'exceed',
    'avoid',
    'throttl',
    '怎么办',
    '怎么处理',
    '退避',
    '重试',
    '撞',
  ],
};

// ---------------------------------------------------------------------------
// 模块加载即断言（D1.2，比测试更难被绕过：新增词的人不跑测试也会立刻炸）。
// 同一份词表有两个出口：P0 侧渲染成 SQL `LIKE ANY`（逐词包 %），advisor 侧走 TS `includes()`。
// `_` 是 LIKE 的单字符通配符而 TS 侧当字面量 ⇒ 含 `_` 的词让两个出口静默分叉，
// 没有任何测试会自然发现它；`\` 是 LIKE 默认转义符，同禁。
// 遍历集 MUST 含 NEGATIVE_PATTERNS（它同样被渲染成 SQL + TS 两个出口）。
// ---------------------------------------------------------------------------
for (const k of [
  ...PRECISE_FACT_CORE,
  ...FACT_CHANGE_EXT,
  ...SELECTION_QUERY_EXT,
  ...NEGATIVE_PATTERNS, // ← 绝不可漏
  ...PRECISE_FACT_COOCCUR.intent,
  ...PRECISE_FACT_COOCCUR.fact,
  ...PRECISE_FACT_COOCCUR.negative,
]) {
  if (/[%_\\]/.test(k)) throw new Error(`词表含 LIKE 元字符: ${k}`);
}
// 非空 MUST 由显式的逐组 length 断言兜住——元字符循环对空数组恒过（vacuous），
// 这是 P0 侧谓词函数「恒返回 SQL、永不返回 undefined」的前提。
for (const [name, set] of Object.entries({
  PRECISE_FACT_CORE,
  FACT_CHANGE_EXT,
  SELECTION_QUERY_EXT,
  NEGATIVE_PATTERNS,
  COOCCUR_INTENT: PRECISE_FACT_COOCCUR.intent,
  COOCCUR_FACT: PRECISE_FACT_COOCCUR.fact,
  COOCCUR_NEG: PRECISE_FACT_COOCCUR.negative,
})) {
  if (set.length === 0) throw new Error(`词表为空: ${name}`);
}
