/**
 * 周报默认 cron 的零依赖叶子常量（p0-alert-lane A1.3）。
 *
 * 从 weekly-queue.ts（driver，top-level import bullmq/env）提出：「飞书 cron 避整点」守卫
 * （src/config/__tests__/env.test.ts）必须直接 import 本常量做展开断言——抄一份字面量副本会
 * 与真值静默漂移，而纯函数守卫测试不宜拖入 driver 的依赖图。weekly-queue.ts re-export 本常量，
 * 既有导入路径（'./weekly-queue.js'）不变。
 */

/**
 * 周报默认 cron（BullMQ repeat.pattern）：每周一 09:07（Asia/Shanghai）。
 * **分钟字段避整点/半点（展开集 {7} ∩ {0,30} = ∅）**降低飞书限流（同日报 DAILY_DIGEST_CRON
 * 默认意图）；周一触发使汇总窗口恰为「刚结束的完整一周」（上周一→本周一）。
 *
 * 注：周报 cron 配置未引入新 env；用本常量作默认，可经 scheduleWeeklyReport 的 cron/tz 参数
 * 覆盖（wiring 层注入）。cron 时区常量（DEFAULT_WEEKLY_CRON_TZ）仍在 weekly-queue.ts——避整点
 * 判据只关心分钟字段，时区不参与展开。
 */
export const DEFAULT_WEEKLY_CRON = '7 9 * * 1';
