## Why

Plan A(见 `docs/hangar-migration-plan-a.md` Phase A1)的第一步:让「大事发生时先从即时推送知道,而非等每日 08:xx 日报」成立,作为重心从「每日精选日报」迁向「持续 KB + 对话 RAG」路上新的日常价值抓手(≅ inbox 的 P1 即时 notify)。

关键发现:这套「P0 即时推」机制**已经存在**——`realtime-alerts` 能力 + `alert-scan` 高频 lane 已完整实现(确定性 `importance_score >= 85` 门、LLM 禁判、专用 `target_type='alert'` 幂等、per-event 锁、`published_at` 时效窗、与日报原子 claim 共评分),但**默认关**(`ALERT_SCAN_ENABLED='false'`,代码注明「功能打磨期关闭」)。故 A1 = **产品化并启用现有机制**,补齐挡它上线的两处打磨 + 调频 + 可观测,**不新建 P0 机制、不加新评分字段**。

## What Changes

- **原文链接(canonicalUrl)**:告警候选现把 `canonicalUrl` 保守置 `null`(`alert-scan.ts:239`),告警消息渲染不出原文链接。改为经 `representative_raw_item_id` **LEFT JOIN** 回指 `raw_items.canonical_url` 补齐(URL 已在采集期经 `normalizeUrl` 去 utm/ref 等),使告警消息带可点的规范化原文链接;**回指绝不 INNER JOIN 丢候选**——回指为 NULL / 行已删时事件仍告警(只是无链接),不漏告警。
- **中文摘要打磨**:告警在高频链评分后**可能尚无 `headline_zh`/`summary_zh`**(告警链不跑日报的中文摘要阶段),现只走 headline 回退链推原始标题(多为英文)。改为:推送前对**入选告警候选**(≤ `ALERT_MAX_PER_SCAN`,极少)中缺中文摘要者跑一次 `summarizeEvent`(复用日报摘要 Agent)生成中文标题/摘要**并持久化**(供该事件后进日报被「已摘要守卫」复用、不重复摘要),使人读到中文标题;headline 回退链降为**摘要生成失败时的兜底**(不因失败漏告警)。「轻量」指只对 ≤ `ALERT_MAX_PER_SCAN` 条入选候选跑,非更轻的调用。
- **调频 + 启用**:把高频 lane 频率默认收紧(`ALERT_SCAN_CRON` `*/20` → `*/15`,落在 base spec「15–30 分钟」窗口内、无需改该需求;仍 env 可配),并把 `ALERT_SCAN_ENABLED` 推上生产(部署开)。
- **首次启用防旧消息刷屏**:用**发布时间基线水位**——启用时记 `baseline`(env `ALERT_MIN_PUBLISHED_AT`=启用时刻,Zod 校验 ISO 或显式空串 opt-out),告警候选加谓词 `published_at >= baseline`,**只告警启用后发布的新闻**、静默排除启用前存量(与评分状态/通道无关);**不写假 `success` 记录**。**代码强制而非靠文档**:`ALERT_SCAN_ENABLED='true'` 但基线未设 → 启动 fail-fast 拒绝注册(env `superRefine` 跨字段不变量),防启用却忘设基线致刷屏(守 `policy-push-timeliness`)。
- **P0 质量可观测**:每次扫描 emit/log P0 告警计数 + 命中事件的 `importance_score` 分布,供「精确/召回、噪音率」人工抽检——迁移成不成的验证信号(见 hangar-migration-plan-a §A1 出口闸)。
- **复用现有确定性门**:P0 判定仍是 value-judge 输出的 `importance_score >= ALERT_IMPORTANCE_THRESHOLD`(默认 85、env 可调),**不新增字段**;**不改用 `long_term_value`**(该列确实存在,但由提炼/经验 Agent 产出、作知识库准入闸 `>=70`,既非 value-judge 输出亦非 P0 语义);绝不交 LLM 拍板是否推。

## Capabilities

### 修改能力(Modified)
- `realtime-alerts`:告警消息渲染契约——补「必须渲染原文链接 canonicalUrl」+「推送前对缺中文摘要的候选跑轻量摘要、回退链降为兜底」;并加一条「P0 告警质量可观测」需求。

### 新增能力(New)
<!-- 无。A1 是对现有 realtime-alerts 的产品化，不新建能力。 -->

## 非目标(Non-Goals)

- **不新建 P0 层/字段**:复用现有 `importance_score >= 阈值` 门;不给 value-judge 加 `severity`/`p0` 等新输出字段/新列,也不改用已存在的 `long_term_value`(那是 KB 准入闸、非 value-judge 输出)作 P0 门。
- **不改 P0 判定归属**:是否告警永远由程序阈值 + 确定性规则决定,**绝不交 LLM**(守本仓不变量)。
- **不动幂等结构**:`push_records UNIQUE(target_type,target_id,channel,push_date)`、`target_type='alert'`、per-event 锁、跨天 per-channel 可靠补发口径全部不变。
- **不降级日报**(那是 A4)、**不做 SAG 式 KB 结构化**(A2)、**不做对话 RAG**(读侧独立服务)。
- **不动采集源子集**:高频链仍只采 `{rss, hacker_news, github}`(排除 arXiv/PH),不改 source-collectors。
- **不引入 hangar 依赖**:A1 仍跑当前栈,BullMQ 只当 cron + 整 job 重试;告警是本质无害自动推、直排、**不走审批**(不接 hangar Approval)。
- **不把 judge 拆成独立 pilot**。

## Impact

- **改动代码**:`src/pipeline/alert-scan.ts`(canonicalUrl 补齐、入选候选轻量摘要、P0 可观测 emit)、`src/config/env.ts`(`ALERT_SCAN_CRON` 默认收紧、`ALERT_SCAN_ENABLED` 上线)、可能 `src/push/message.ts`(链接渲染,若回退链未含)、复用 `src/agents/digest`(轻量摘要)。
- **不改**:value-judge schema/评分/列;`push_records` 结构与幂等键;告警选题/时效/原子 claim 口径;daily/weekly lane;MR/MCP/web。
- **依赖**:无新增运行时依赖(复用现有 chinese-digest-agent + dispatcher)。
- **成本**:每高频扫描对 ≤ `ALERT_MAX_PER_SCAN` 条入选候选各一次 `summarizeEvent` LLM 调用(候选极少、P0 稀有,成本可控);judge 评分沿用现有原子 claim(CAS)、不重复评分;调频把 {rss,hn,github} 采集频率提约 1.3×(`*/20`→`*/15`,GitHub/HN 速率上限实现期核)。
- **测试**:告警消息含 canonicalUrl 链接 + 中文摘要(摘要失败走回退链不漏告警);真集成 Postgres 幂等——同一 P0 事件绝不双推(`UNIQUE(alert,event_id,channel,push_date)` + 跨天 per-channel);守 `VITEST` 不真发飞书/Telegram。
- **部署**:次序=合并代码(默认关)→ 置基线 env `ALERT_MIN_PUBLISHED_AT`=启用时刻 → 置 `ALERT_SCAN_ENABLED='true'`(worker-main 才注册 alert-scan 队列/worker);容器化部署照旧(见 memory deployment-containerized)。
