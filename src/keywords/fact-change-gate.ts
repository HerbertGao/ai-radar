/**
 * P0 支路 B：精确事实变更闸的单一构造器、双出口（p0-alert-lane D2.1/D2.1b，design D4/D5）。
 *
 * 同一份词表（`PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`，成员 SOT 在 precise-fact.ts）渲染成两个出口：
 * - `factChangeTitlePredicate()`：Drizzle SQL 谓词，嵌入告警闸（alert-gate.ts）——闸判定 MUST 在
 *   SQL 侧：告警候选查询带 `ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN`，LIMIT 先于任何
 *   应用层过滤执行——词表匹配放 TS 侧做二次过滤，SQL 只会选出支路 A 的候选，支路 B 的事件根本
 *   进不了结果集（「实现完了、测试也写了、就是永远不触发」）。否定项同理 MUST 在 SQL 侧：放应用层
 *   则被它挡掉的候选已经占用了 LIMIT 的名额。
 * - `matchFactChangeKeywords()`：TS 纯函数，仅供 p0.observed 归因复算（D2.3）——绝不参与闸判定。
 *
 * 两出口共同口径：小写折叠；`representative_title IS NULL` 视为不命中；否定项 `NEGATIVE_PATTERNS`
 * （器物名）一票否决。共现规则（PRECISE_FACT_COOCCUR）只进 advisor，本模块不消费（D1.9）。
 *
 * 词表模块（precise-fact.ts）保持零依赖；本模块才允许依赖 drizzle + schema（design D5 的分层——
 * price-gate.ts 只需要词表，不该为它传递依赖上整个 db/schema）。
 *
 * 一致性边界（design D5）：SQL `LIKE ANY`（逐词包 `%`）与 TS `includes()` 的等价性由「词表不含
 * LIKE 元字符 `%`/`_`/`\`」保证（precise-fact.ts 模块加载即断言），且收窄为 ASCII + CJK——
 * `İ`(U+0130) 下 PG `lower()` 与 JS `toLowerCase()` 已知分叉，后果止于归因字段，不断言全 Unicode。
 */
import { and, not, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { aiNewsEvents } from '../db/schema.js';
import {
  FACT_CHANGE_EXT,
  NEGATIVE_PATTERNS,
  PRECISE_FACT_CORE,
} from './precise-fact.js';

/** P0 支路 B 的词源 = 核心 ∪ 变更扩展（纯裸词，不消费共现——共现只进 advisor，D1.9）。 */
const FACT_CHANGE_KEYWORDS: readonly string[] = [
  ...PRECISE_FACT_CORE,
  ...FACT_CHANGE_EXT,
];

/**
 * 支路 B 的 SQL 谓词：`representative_title` 命中词表 ∧ NOT 命中器物名否定项。
 *
 * **签名恒返回 `SQL`、永不返回 `undefined`**：drizzle 的 `or()` 对空参数列表返回 `undefined`，
 * 而 `and(x, undefined)` 会静默丢掉那一项 → 告警闸的 OR 塌缩成只剩支路 A → 支路 B 恒空且无人
 * 察觉。本函数的 and() 恒有两个非 undefined 项（词表非空由 precise-fact.ts 的逐组 length 断言
 * 兜住），结构上不可能返回 undefined。
 *
 * 纯 `representative_title` 谓词：不引用 raw_items 任何列、不依赖 join——可原样嵌入告警闸的
 * LEFT JOIN 查询与回填域的 INNER JOIN 查询（D2.1b）。
 */
export function factChangeTitlePredicate(): SQL {
  // 逐词包 %：LIKE 不包 % 就是等值匹配 → 支路 B 恒空。词表常量本身不含 % / _ / \
  // （precise-fact.ts 模块加载即断言）⇒ 包 % 后语义与 TS includes() 等价（ASCII + CJK）。
  const patterns = FACT_CHANGE_KEYWORDS.map((kw) => `%${kw}%`);
  const negPatterns = NEGATIVE_PATTERNS.map((kw) => `%${kw}%`);
  // sql.param(数组)：整个数组作【单个】参数（渲染为 like any ($1)，$1 = PG 数组），词表增删
  // 不改变计划形状。绝不可把裸 JS 数组内插进 like any (${patterns})——drizzle 按 inArray 机制
  // 渲染成括号参数列表 like any (($1,$2,…)) → PG 42809，每轮抛错、整个告警扫描 job 失败（已实测）。
  //
  // 🔴 否定谓词 MUST 复用与正向【同一个】lower(...) 表达式：词表全小写而 PG 的 LIKE 区分大小写，
  // HN 的真实标题是 Title Case（`Show HN: A Rate Limiter for LLM APIs`）——否定侧漏 lower() 时，
  // 正向（有 lower()）命中 %rate limit%、否定（无 lower()）匹配不到 %rate limiter% ⇒
  // NOT(false) = true ⇒ 手机照震、否定项等于不存在；而全小写样例的测试恒绿（该失效是静默的，
  // Title Case 证伪用例见 fact-change-gate.integration.test.ts 的双出口一致性测试）。
  const positive = sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(patterns)})`;
  const negative = sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(negPatterns)})`;
  // NULL 口径：lower(NULL) IS NULL，LIKE ANY 对 NULL 返回 NULL（非 TRUE）⇒ and() 不满足 ⇒
  // representative_title IS NULL 视为不命中——与 TS 出口的 null → [] 同口径。
  return and(positive, not(negative)) as SQL;
}

/**
 * 支路 B 的 TS 出口（纯函数，仅供归因复算 D2.3）：返回标题命中的词表词；命中否定项
 * （器物名）任一 → 返回 `[]`（与 SQL 侧 `and(positive, not(negative))` 等价）。
 *
 * 签名接受 `null`（与 `AlertCandidate.representativeTitle: string | null` 兼容）：null → []。
 */
export function matchFactChangeKeywords(title: string | null): string[] {
  if (title === null) return [];
  // 小写折叠：与 SQL 侧 lower() 同口径（ASCII + CJK 等价；全 Unicode 不作声明）。
  const q = title.toLowerCase();
  // 否定项一票否决，优先于正向匹配：器物名帖（rate limiter / 限流器 / 速率限制器）不是事实变更。
  if (NEGATIVE_PATTERNS.some((w) => q.includes(w))) return [];
  return FACT_CHANGE_KEYWORDS.filter((kw) => q.includes(kw));
}
