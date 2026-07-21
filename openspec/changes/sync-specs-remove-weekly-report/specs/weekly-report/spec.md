## REMOVED Requirements

### 需求:周报定时汇总与推送

**Reason**: 周报车道已于 PR #95（`e292753`）整条删除——`src/pipeline/weekly-report.ts` / `weekly-queue.ts` / `weekly-cron.ts`、`message.ts` 的周报渲染器、`renderDigest` 的 weekly 分支、`isWeeklyReportEnabled` 与 `WEEKLY_REPORT_ENABLED` env key 均已不存在。该车道长期 `WEEKLY_REPORT_ENABLED=false`（从未在生产启用），且其汇总窗口仍键于 `first_seen_at`（未根治的时效 bug），属休眠车道，删除即收敛门控。本需求已无对应实现。

**Migration**: 无生产迁移动作。周报从未在生产启用，`push_records` 中不存在 `target_type='weekly'` 的行；`TARGET_TYPE.weekly` 枚举成员**保留**（删它需连带 DB CHECK 迁移，见 platform-foundation 该成员的保留说明），但无生产写入方。若未来要恢复周报能力，走新的提案重新立规范，并在其中根治 `first_seen_at` 窗口口径。

### 需求:周报推送幂等按周粒度

**Reason**: 同上——幂等四元组 `target_type='weekly'` / `target_id=iso_week` / `push_date=该 ISO 周周一` 的唯一写入方（周报车道）已随 PR #95 删除，无实现可约束。

**Migration**: 无。`push_records` 的 `UNIQUE(target_type, target_id, channel, push_date)` 约束不变（见 platform-foundation），仅少一个使用它的 `target_type`；历史行不存在，无需清理。
