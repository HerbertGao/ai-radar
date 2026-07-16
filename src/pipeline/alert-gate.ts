/**
 * 告警闸共享谓词构造器（p0-alert-lane，design D2/D3 / realtime-alerts spec）。
 *
 * **一次抽出、两处同调**：告警候选（alert-scan.ts 的 selectAlertCandidates）与 published_at
 * 回填域（backfill.ts 的 scopePredicate alert 分支）MUST 由本构造器生成同一段共享谓词——
 * 回填带固定单次上限（PUBLISHED_AT_INFERENCE_MAX_PER_RUN，默认 20），**有固定 LIMIT 就有饥饿**：
 * - 回填域比闸【宽】：宽出去的高 importance 非 AI 事件占掉名额，把真正在闸内、published_at
 *   IS NULL 的事件挤出本轮回填 → 永为 NULL → 被时效闸的 NULL 排除挡住 → 永不告警、可观测无痕迹。
 * - 回填域比闸【窄】：闸内的 NULL 事件被静默丢弃（永不回填 → 永不告警）。
 * 两个方向都是缺陷，唯一正确形态是「相等」，且由同一个构造器生成而非两处各写一份（各写必漂移）。
 *
 * 「同构」仅指本共享谓词段：回填域另有 published_at IS NULL / first_seen 超窗剪枝 / 豁免源排除 /
 * INNER JOIN 代表 raw_item 等自有合取项（design D3），本构造器不含它们。
 */
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { aiNewsEvents } from '../db/schema.js';

/**
 * 告警闸（两项共用前提 + 支路 A）：
 *   importance_score IS NOT NULL AND is_ai_related = true AND importance_score >= threshold
 *
 * - ①「已评分」在最外层（评分失败 / claim 被抢 / LLM 降级的 NULL 事件绝不入闸）。
 * - ② AI 闸 **MUST 写成 `= true`，MUST NOT 写成 `IS NOT FALSE`**——false 与 NULL 一律排除
 *   （fail-closed），与日报要闻闸 `eq(is_ai_related, true)`（src/selection/top-n.ts）同极性。
 *   importance 衡量「有多重要」、不衡量「是不是 AI 新闻」（KVM 逃逸 CVE 也能拿 95），两轴正交。
 * - **MUST NOT 加 `should_push`**——那是 Judge 的「值不值得推」，P0 告警有意不受其约束。
 */
// drizzle 的 and / or 是【自由函数】——写成 isNotNull(...).and(...) 编译不过。
export function alertGatePredicate(threshold: number): SQL {
  return and(
    isNotNull(aiNewsEvents.importanceScore),              // ① 已评分
    eq(aiNewsEvents.isAiRelated, true),                   // ② AI 闸：fail-closed
    gte(aiNewsEvents.importanceScore, String(threshold)), // ③ 支路 A（numeric → string）
  ) as SQL;
}
