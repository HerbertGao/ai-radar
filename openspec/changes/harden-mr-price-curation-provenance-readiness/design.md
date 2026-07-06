## 上下文

`add-model-radar-price-curation-approval`（PR #63）已 ship 并归档，门控默认关。启用前对该 money-path 做对抗 review（Codex + Code Reviewer + Reality Checker + Security Engineer，两轮）暴露 2 条 spec 级不变量缺口。代码已在工作区实现并过 tests(232)/tsc/eslint。本设计事后记录这 2 条不变量的技术决策；随行的 3 项纯 conformance/hygiene 修复不在此展开（见 proposal Non-Goals）。

约束：不改既有 D5 money-path 语义（CAS/TTL/基线漂移/outcome 判定）；均须 fail-closed；provenance 是 CLAUDE.md 硬红线（可溯源、源信任派生、绝不交 LLM）。

## 目标 / 非目标

**目标：**
- 关闭「非 canonical 源候选继承 plan 官方置信度」的 provenance 造假 miswrite。
- 补齐「发卡而无人能批」fail-closed 就绪的第二触发（chatId 非数值）。
- 让主规范 SOT 对这两条红线可见。

**非目标：**
- 不引入 URL 规范化做 canonical 源比对。
- 不把随行 3 项纯修复升格为 spec 需求。
- 不改批准鉴权/CAS/TTL/漂移/outcome 既有语义；不扩到多价源。

## 决策

**D-A：canonical 源 provenance 哨兵 = proposer 重抓前逐字节 `source.sourceUrl === plan.sourceUrl`，不等即 escalate。**
- 根因：一个 plan 经 `mr_plan_sources` 可关联多源（seed 按 vendor 全连接 plan×source）。既有 `planRows.length !== 1` 只挡多 plan 源；单 plan 但源为非官方聚合源时，重抓候选走 gate 时用的是 **plan 行**的 `source_confidence='official_pricing'`，于是非官方源的数值带官方置信度写进 `mr_price_history`。
- 位置：放在 plan 快照加载后、`fetchFn` 重抓之前——非 canonical 源**连页面都不抓/不抽**，最小化对不可信源的处理面。
- **备选：URL 规范化后比较**（去 trailing slash / http↔https / utm）。**否决**——现有 11 个 http 源两列已逐字节对齐；规范化会**掩盖真实差异**（本应发现的错配被抹平），且属过度设计。fail-closed 方向下逐字节 `!==` 的唯一代价是「规范化漂移 → 合法 canonical 源被误 escalate（人手兜底）」，非误写。
- **可诊断性：** 该 escalate 落一条明确日志（含 `source=`/`sourceUrl=`/`planUrl=`，均为公开 URL、无 token），使「永久暗源」区别于 no-candidate/gate-escalate 可查——否则计数器上无法区分。

**D-B：chatId 数值化并入既有共享就绪判定 `isMrPriceCurationApprovalReady`。**
- 根因：worker 发卡 `api.sendMessage(chatId)` 接受 string/`@username`（可达），但接收侧 `Number(TELEGRAM_CHAT_ID)→NaN` 时频道绑定失败、静默不 `bot.start()` → 发卡无人能批。
- 决策：就绪判定 `= enabled ∧ APPROVER_IDS 非空 ∧ Number.isFinite(Number(TELEGRAM_CHAT_ID))`，**proposer（worker lane 注册）与 web（bot.start）复用同一函数** → 两镜像同进同退。`isFinite ⟹ !NaN`，故凡就绪必令接收侧能绑定数值 chatId（关闭 `@username` 误配）。
- **备选：更严格 `/^-?\d+$/`**（拒 `"0"`/空白/`"1e3"`）。**暂不做**——`z.string().min(1)` 已拒空串；残留的空白/`"0"` 属无意义配置且两侧同样 fail-closed（worker `sendMessage("0")` 直接 400），非本次红线，记为 nit。

## 风险 / 权衡

- **D-A 逐字节比较 → 规范化漂移误 escalate** → 缓解：现有源已对齐 + 诊断日志可定位；真出现漂移再另议规范化（proposal Non-Goals 已声明）。fail-closed，非误写。
- **D-A 依赖 seed 侧两列 `source_url` 手工对齐**（`mrSource.sourceUrl` 取自 `s.sourceUrl`、`mrPlans.sourceUrl` 取自 `p.sourceUrl`，无 upsert 规范化）→ 缓解：诊断日志 + 逐字节要求写入规范；录入约定须保持 canonical 源两列一致。
- **D-B 残留退化配置**（空白/`"0"`/`"Infinity"`）→ 两侧均落「无批准」，非误开；可选收紧为整数正则。

## Migration Plan

- 无迁移/无 DDL/无破坏性变更；门控默认关，回滚 = 关 `MR_PRICE_CURATION_ENABLED`。
- 代码已实现；归档时把本变更的 2 条修改需求同步进 `openspec/specs/model-radar-price-curation/spec.md`。

## Open Questions

- 若未来 `mr_source.source_url` 与 `mr_plans.source_url` 出现规范化漂移（新增源录入不一致），是否引入统一 URL 规范化——待真实出现再定。
