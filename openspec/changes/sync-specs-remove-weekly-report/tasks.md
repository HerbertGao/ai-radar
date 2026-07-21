## 0. 前置：确认地面真相仍成立

- [x] 0.1 确认 #95 的删除在当前 `main` 上仍成立（漂移修正的前提）：`git show e292753 --stat` 列出 `src/pipeline/weekly-report.ts` / `weekly-queue.ts` / `weekly-cron.ts` 为删除，且 `ls src/pipeline/weekly-*.ts` 无匹配、`grep -rn "SEMANTIC_DEDUP_ENABLED\|WEEKLY_REPORT_ENABLED" src/ .github/ *.yml *.md` 为空。**若任一不成立立即停手**——说明有人重新引入了周报，本变更的前提失效。
- [x] 0.2 确认 `TARGET_TYPE.weekly` **仍在**（本变更 MUST NOT 删它）：`grep -n "weekly" src/push/targets.ts` 命中 `:32`（枚举成员）与 `:49`（映射）。若已被删，`platform-foundation` 的改法要重写（该 delta 目前保留枚举陈述）。
- [x] 0.3 确认 `summary_zh` 回写仍有真实消费者：`grep -n "summaryZh" src/pipeline/alert-scan.ts` 命中渲染回退链（约 `:531-582`）。若无，`knowledge-base` 的 delta 理由要改（不得因此取消回写断言）。

## 1. 规范同步（本变更的主体，delta 已在 `specs/` 下写好）

- [x] 1.1 复核 8 份 MODIFIED delta 的**逐字节同源性**：对每份 `openspec/changes/sync-specs-remove-weekly-report/specs/<cap>/spec.md`，把其中的需求块与 `openspec/specs/<cap>/spec.md` 同名需求块做 diff，确认**差异只落在周报/`SEMANTIC_DEDUP_ENABLED` 相关句子上**，没有误删无关行（D2 的验收闸；`validate` 抓不到内容丢失）。
- [x] 1.2 复核 `specs/weekly-report/spec.md` 的 REMOVED 两条需求名与主规范 `openspec/specs/weekly-report/spec.md` 的 `### 需求:` 标题**逐字一致**（名不匹配会让 REMOVED 静默不生效）。
- [x] 1.3 `openspec-cn validate sync-specs-remove-weekly-report --strict` 通过。
- [x] 1.4 全量复核残留：`grep -rn "weekly\|周报" openspec/specs/` 的每条命中**逐条判定**——预期只剩三类：① `platform-foundation` 的保留成员说明；② `model-radar-recommender` 的 `weekly_messages`（额度 limitType，**与周报无关，MUST NOT 改**）；③ `blogger-experience-mining:74`「`target_type='experience'` 与既有 event/product/alert/weekly 互不挤占」——枚举成员保留使该句**仍为真**，是对枚举全集的陈述而非对车道的引用，**不改**。任何其它命中说明本变更漏了一处。

## 2. 代码注释清理（可选，独立 commit，纯注释零逻辑）

- [x] 2.1 `src/push/targets.ts:11-12,60` — 注释仍把 `weekly` 描述成在役推送路径（「周报，独立幂等命名空间、独立一条消息」）。改为「保留成员，无生产写入方，车道已删除」。**只改注释，枚举成员与映射一行不动。**
- [x] 2.2 `src/kb/index.ts:15` — 「供 weekly 零 LLM 复用」改为其真实消费者（告警链渲染回退链），与 `knowledge-base` delta 同口径。
- [x] 2.3 `src/mcp/tools/get-today.ts:80`、`src/push/dispatcher.ts:9`、`src/pipeline/run-daily-workflow.ts:1042` — 枚举式罗列 `alert / weekly / experience` 的注释，按 2.1 的口径统一（提到 weekly 时标明是保留成员）。
- [x] 2.4 `npm run typecheck && npm run lint && npm run test` 全绿（注释改动不应影响任何一项；若有变化说明误改了代码）。

## 3. 验收与归档

- [x] 3.1 `git diff` 逐份人工过一遍：确认**无运行时代码行为改动**（任务组 2 若做，diff 只含注释行）。
- [ ] 3.2 走 `/opsx:archive`：delta 并入主规范，`openspec/specs/weekly-report/` 目录随归档删除。
- [ ] 3.3 归档后 `openspec-cn validate --specs --strict` 全绿，且谱数为 **31**（原 32 减去 weekly-report 一谱）。数目对不上说明 REMOVED 没生效或误删了别的谱。
- [ ] 3.4 归档后再跑一次 1.4 的 grep 复核（归档合并可能引入新的残留）。
