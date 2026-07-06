## 1. Provenance canonical 源哨兵（Delta 1，代码已实现）

- [x] 1.1 `propose.ts`：plan 快照加载 `mr_plans.source_url`，重抓前 `source.sourceUrl !== plan.sourceUrl` → escalate（在 `fetchFn` 之前）
- [x] 1.2 `propose.ts`：该 escalate 落可诊断日志（`source=`/`sourceUrl=`/`planUrl=`，无 token），区别于 no-candidate/gate-escalate
- [x] 1.3 测试：非 canonical 源 → escalated、`fetchFn` 未调、`notify.telegram` 未调、诊断日志命中（`propose.test.ts`）

## 2. 跨镜像 fail-closed 就绪补 chatId 数值化（Delta 2，代码已实现）

- [x] 2.1 `env.ts::isMrPriceCurationApprovalReady`：追加 `Number.isFinite(Number(TELEGRAM_CHAT_ID))`
- [x] 2.2 复用点确认：`index.ts`（web `bot.start`）与 `worker-main.ts`（lane 注册）共用同一判定（fan-out grep 已核）

## 3. 随行纯 conformance/hygiene 修复（无 spec delta，代码已实现）

- [x] 3.1 `approve.ts`：移除 `as string`，显式 `candidateValue/currency==null` guard → `ApplyFailedError`（等价既有 writer-Zod→apply_failed）+ 直接测试
- [x] 3.2 `worker-main.ts`：发卡重试 `withRetry` 注入 `logError`，只落 `err.message`（送出侧 token 脱敏，防 `GrammyError.payload.callback_data` 泄漏）
- [x] 3.3 blocked-page 标记去重：新增 zero-dep `src/mr/scrape/blocked-markers.ts`，`fingerprint.ts` 与 `curation/extract.ts` 复用（消除漂移）

## 4. 验收（已通过）

- [x] 4.1 `npx vitest run`（curation/config/scrape）全绿（232）
- [x] 4.2 `npx tsc --noEmit` 无错
- [x] 4.3 `npx eslint` 改动面无错
- [x] 4.4 对抗 review 循环两轮通过（终判 APPROVE-DEGRADED：弱协调 + 一条 log-only wiring 未测，非缺陷）

## 5. 收尾

- [ ] 5.1 归档：`/opsx:archive` 把 2 条修改需求同步进 `openspec/specs/model-radar-price-curation/spec.md`
- [ ] 5.2 （既有 follow-up，不属本变更）prod 启用前补 DB 集成测试 / `BOT_TOKEN` 轮换
