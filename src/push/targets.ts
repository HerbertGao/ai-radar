/**
 * 推送幂等四元组的枚举收口（platform-foundation「数据库 Schema 可迁移」枚举收口需求）。
 *
 * `push_records` 的 `target_type` 与 `channel` 是裸 `VARCHAR`，DB 不挡拼写错——某处误拼
 * （如 `'alerts'`、`'Event'`）会使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推。
 * 故由本模块用 **Zod enum** 集中定义权威全集，所有推送路径（dispatcher / 候选窗口 / 各
 * target_type 推送入口）统一引用本处常量，**禁止散落字面量**。新增 target_type/channel
 * 必须先扩此处枚举再使用。
 *
 * 权威全集（spec platform-foundation 显式声明）：
 * - `target_type` = `{event, product, alert, weekly, experience}`
 *   —— `paper`/`repo` 不在范围（arXiv 论文仅采集沉淀、不推送）；`alert`/`weekly` 是 P2
 *      相对 QA §8.6 注释的有意新增（实时告警 / 周报各需独立幂等命名空间）；`experience`
 *      是 add-ai-blogger-experience-mining 新增（AI 博主经验的实践锦囊推送需独立幂等命名空间）。
 * - `channel` = `{telegram, feishu}`
 *   —— Telegram 必配、飞书可选。
 */
import { z } from 'zod';

/**
 * 推送目标类型枚举（权威全集）。
 *
 * `ops-alert` 与 `alert` 分属两个命名空间：`alert` 是**业务**推送（实时重大发布告警，target_id
 * 是 event_id）；`ops-alert` 是**运维**告警（源失效 / 熔断 / 租约失守，target_id 是 dedupKey）。
 * 任何按 push_records 判「今日是否已推送业务内容」的查询 MUST 显式过滤 target_type——否则一条
 * ops-alert 成功记录会被误读成「日报已发」。
 */
export const targetTypeEnum = z.enum([
  'event',
  'product',
  'alert',
  'weekly',
  'experience',
  'ops-alert',
]);
/** 推送通道枚举（本期权威全集）。 */
export const channelEnum = z.enum(['telegram', 'feishu']);

/** 推送目标类型（`push_records.target_type`）。 */
export type TargetType = z.infer<typeof targetTypeEnum>;
/** 推送通道（`push_records.channel`）。 */
export type Channel = z.infer<typeof channelEnum>;

/** 命名常量：各推送路径引用这些常量而非字面量，杜绝拼写错分裂命名空间。 */
export const TARGET_TYPE = {
  event: 'event',
  product: 'product',
  alert: 'alert',
  weekly: 'weekly',
  experience: 'experience',
  'ops-alert': 'ops-alert',
} as const satisfies Record<TargetType, TargetType>;

/**
 * **日报**（「AI Radar 每日情报」这一条消息）的 target_type 子集 = 要闻段 + 新品段。凡是回答
 * 「今日的日报发了吗、发了什么」的查询（get_today_ai_digest）都 MUST 用它收口。
 *
 * 排除项各有各的理由——`ops-alert` 只是其中之一，别把它读成唯一排除项：
 * - `alert`：**业务**推送，但走实时重大发布告警链（06:00 起每 15 分钟一轮），不是日报内容；
 * - `weekly`：周报，独立幂等命名空间、独立一条消息；
 * - `experience`：实践锦囊，独立一条消息；
 * - `ops-alert`：**运维**告警，与业务推送共用 push_records 的幂等地基，压根不是业务内容。
 *
 * 收窄到这两个是**根因修复**而非顺手收敛：get_today 从前没有 target_type 过滤，上面四种 target_type
 * 的 success 行**全都**在污染它——例如告警链 06:00 推了一条 `alert`、而 08:03 的日报还没跑时，它会回
 * 「channels=[telegram]、events=[]」，而不是照实说「今日尚未推送」。四种同形 bug 一把修掉。
 */
export const TODAY_DIGEST_TARGET_TYPES = [
  TARGET_TYPE.event,
  TARGET_TYPE.product,
] as const satisfies readonly TargetType[];

export const CHANNEL = {
  telegram: 'telegram',
  feishu: 'feishu',
} as const satisfies Record<Channel, Channel>;
