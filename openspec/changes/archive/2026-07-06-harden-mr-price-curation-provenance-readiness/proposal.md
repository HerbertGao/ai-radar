## 为什么

`add-model-radar-price-curation-approval`（PR #63，已归档）ship 后的对抗 review 暴露 2 条 spec 级不变量缺口——都属 money-path 硬化，须在启用一键批准（prod）前补齐并让主规范可见：

1. **provenance 造假 miswrite**：一个 plan 经 `mr_plan_sources` 可关联多个源（含非官方聚合源）。即便唯一定位到单 plan，若重抓源不是该 plan 注册的 canonical 源，抽取候选仍会**继承 plan 行的官方 `source_confidence`**，把官方置信度写进 `mr_price_history`——违反「provenance 可溯源、源信任派生」红线。现主规范只挡「多 plan 源」与「置信度取自页面」，不挡「单 plan 关联的非 canonical 源」。
2. **发卡而无人能批（第二触发）**：worker 用 `api.sendMessage(chatId)` 发卡，接受 string/`@username`（可达）；但 web 接收侧 `Number(TELEGRAM_CHAT_ID)→NaN` 时静默不 `bot.start()`（频道绑定要求数值 chat id）。现主规范把「发卡而无人能批」的 fail-closed 就绪只列了 `TELEGRAM_APPROVER_IDS`，漏了「chatId 须数值化」这一同因触发。

## 变更内容

- 主规范 `model-radar-price-curation` 补 2 条不变量（见下 Capabilities）。代码已在工作区实现并过对抗 review 两轮（终判 APPROVE-DEGRADED：弱协调 + 一条 log-only wiring 未测，非缺陷）+ tests(232)/tsc/eslint 全绿。
- 同 PR 随行 3 项**纯 conformance/hygiene 修复**（无 spec delta，见 Non-Goals）：approve.ts 移除 `as string` 显式 null guard；worker-main.ts 发卡重试 `logError` 只落 `err.message`（送出侧 token 脱敏）；extract.ts / fingerprint.ts blocked-page 标记去重为共享 zero-dep 常量。

## 功能 (Capabilities)

### 新增功能

（无——不引入新能力，仅硬化既有 curation 能力。）

### 修改功能

- `model-radar-price-curation`: ① curation proposer 在重抓前**必须**校验重抓源 `mr_source.source_url` 等于目标 plan 的 canonical `mr_plans.source_url`，不等则 escalate（不重抓/不抽取/不开卡/不写 `price_history`）且落可诊断日志（区别于 no-candidate/gate-escalate）——防非 canonical 源候选继承 plan 官方置信度。② 一键批准「就绪」判定除 `MR_PRICE_CURATION_ENABLED` + `TELEGRAM_APPROVER_IDS` 非空外，**还须 `Number.isFinite(Number(TELEGRAM_CHAT_ID))`**；proposer 与接收侧复用此判定（跨镜像一致 fail-closed）。

## 非目标 (Non-Goals)

- **不**引入 URL 规范化/canonicalization 做 canonical 源比对：本期用逐字节 `!==`（现有 11 个 http 源已逐字节对齐；规范化会掩盖真实差异且属过度设计）。将来两列若出现规范化漂移再另议。
- **不**把随行的 3 项纯修复升格为 spec 需求（它们是既有 intent 的 conformance/hygiene）：approve.ts null guard 行为等价于既有 writer-Zod→`apply_failed`；worker-side `logError` 是既有「callback_data/token 必须从日志脱敏」§57 的送出侧 conformance（grammY `GrammyError.payload` 携带 token）；blocked-page 标记集是实现细节。
- **不**改批准鉴权 / CAS / TTL / 基线漂移 / outcome 判定等既有 money-path 语义。
- 本期仍**只**覆盖单价源；多 plan 源 escalate 不变。
- **不**含部署前的 prod DB 集成测试 / BOT_TOKEN 轮换（既有 follow-up，独立跟踪）。

## 影响

- 规范：`openspec/specs/model-radar-price-curation/spec.md`（归档时同步 2 条修改需求）。
- 代码（已实现）：`src/mr/curation/propose.ts`（canonical 源哨兵 + 诊断日志）、`src/config/env.ts`（`isMrPriceCurationApprovalReady` 补 chatId 数值化）；随行 `src/mr/curation/approve.ts`、`src/pipeline/worker-main.ts`、`src/mr/curation/extract.ts`、`src/mr/scrape/fingerprint.ts`、新增 `src/mr/scrape/blocked-markers.ts`，及对应测试。
- 行为：均 fail-closed，无破坏性变更；门控默认关，启用前生效。
