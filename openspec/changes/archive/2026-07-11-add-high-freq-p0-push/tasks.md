## 1. 原文链接(canonicalUrl)

- [x] 1.1 `alert-scan.ts`:告警候选 `canonicalUrl` 从 `null` 改为经 `representative_raw_item_id` **LEFT JOIN(或相关子查询)** 回指 `raw_items.canonical_url`(采集期已 `normalizeUrl` 去追踪参数);**绝不 INNER JOIN 丢候选**——回指为 NULL / raw_item 行已被塌缩删除时,达阈值事件仍留候选(消息无链接、不报错)
- [x] 1.2 确认告警消息渲染出该规范化原文链接(若 `src/push/message.ts` 渲染未含链接则补;不破坏现有回退链)

## 2. 中文摘要打磨

- [x] 2.1 推送前对**入选**告警候选(≤ `ALERT_MAX_PER_SCAN`)中 `headline_zh`/`summary_zh` 为 NULL 者,调 `summarizeEvent`(`agents/digest`,per-event 纯调用)生成 `{headline_zh, summary_zh}` **并经 `digestEvent` 持久化**(供该事件后进日报被「已摘要守卫」`run-daily-workflow.ts:704` 复用、不重复摘要);**生成失败**才降为 headline 回退链——摘要缺失/失败**绝不**报错或漏告警。逐条 try/catch 隔离。附:把 `importance_score` 一并选入候选(供 4.1)

## 3. 调频 + 启用 + 基线 env

- [x] 3.1 `env.ts`:`ALERT_SCAN_CRON` 默认 `*/20` → `*/15`(落 base spec「15–30 分钟」窗口内、无需改该需求;仍 env 可配、范围校验不变)
- [x] 3.2 `env.ts`:新增 `ALERT_MIN_PUBLISHED_AT`,**Zod 校验为合法 ISO 时刻或显式空串**(`z.string().datetime().or(z.literal('')).optional()`——**必须 `.optional()`、不给 `.default('')`**,使「未设 vs 显式空串 vs ISO」三态可分,仿 Feishu `.optional()`+superRefine 先例;否则默认关部署与现有 env 测试会因字段恒必填而起不来);非法值启动 fail-fast;解析成 Date 一次。启用口径:`ALERT_SCAN_ENABLED` 部署置 `'true'`;更新 `.env.example` / DEPLOY 说明启用前提与基线
- [x] 3.3 **fail-fast 跨字段不变量**(env `superRefine`,仿现有 Feishu 完整性校验):`ALERT_SCAN_ENABLED='true'` 但 `ALERT_MIN_PUBLISHED_AT` **未设置**(既非 ISO 亦非显式空串 opt-out)→ 启动即 fail-fast、拒绝注册告警链。把首次启用防刷屏守卫从「部署次序文档」升级为「代码强制」,防启用却忘设基线导致存量 P0 刷屏

## 4. P0 质量可观测

- [x] 4.1 `selectAlertCandidates` **把 `importance_score` 选入 `AlertCandidate`**(现未选,见 alert-scan.ts:200-206);每次高频扫描完成后经 `ctx.emit`/pino 结构化记录:本次告警计数 N、各命中 `importance_score`、`event_id`/`channel`。纯确定性旁路——不 LLM 判质量、不额外推送、不改判定/不阻塞

## 5. 首次启用防旧消息刷屏(发布时间基线水位,守 `policy-push-timeliness`)

- [x] 5.1 告警候选查询加谓词 **`published_at >= ALERT_MIN_PUBLISHED_AT`**(env 未设则不加)——**只告警启用后发布的新闻**,启用前发布的存量(**无论何时被评分、无论后加了哪个通道**)一律排除;谓词在 `published_at`、与评分状态/通道无关、无每扫描上限、**不写任何 `push_records` 假记录**
- [x] 5.2 部署次序落文档:合并代码(默认关)→ 置 `ALERT_MIN_PUBLISHED_AT`=启用时刻 → 置 `ALERT_SCAN_ENABLED='true'`;基线与启用分离,避免启用瞬间推近 N 天存量 P0

## 6. 测试 & 验证

- [x] 6.1 告警渲染测试:消息含 canonicalUrl 规范化链接 + 中文 `headline_zh`;`summarizeEvent` **失败时**走 headline 回退链、仍告警不漏(注入抛错桩);**回指为 NULL 的达阈值事件仍告警**(1.1 LEFT JOIN)
- [x] 6.2 基线水位回归(**真集成 Postgres**):`published_at < baseline` 的存量事件启用后**不告警**;`published_at >= baseline` 的新事件正常告警;同一 P0 事件绝不双推——断言 `UNIQUE(alert, event_id, channel, push_date)` 只落一行 + 跨天 per-channel 可靠补发口径不变
- [x] 6.3 全量测试绿,守 `VITEST` 不真发飞书/Telegram(钉 channels / 注入 sender mock,memory `test-no-prod-sends`)
- [x] 6.4 env fail-fast 单测(`config/__tests__/env.test.ts`):`ALERT_SCAN_ENABLED='true'` + `ALERT_MIN_PUBLISHED_AT` 未设 → 解析抛错;设为合法 ISO 或显式空串 → 通过;非法 ISO → 抛错

## 7. 顺手清理

- [x] 7.1 `alert-scan.ts:36` stale 注释:锁键写成 `alert:{channel}:{event_id}` 但实际+spec 为 per-event `alert:{event_id}`;A1 既编辑本文件,顺手修正注释
