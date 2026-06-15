/**
 * 知识库历史回填入口（一次性运维）—— `npm run kb:backfill` 执行本文件。
 *
 * 触发一次 `runKbBackfill()`：枚举历史「曾推送成功」的全部 push_date，逐日复用 `runKbIngestion`
 * 把既有历史事件灌入本地表知识库。**幂等**（已入库者跳过，可安全重复跑）、**不推送**（仅写
 * kb_documents/kb_ingestion_records）。
 *
 * 前置：
 *   1. postgres/redis 已起且迁移到 P3（kb 表 + vector 扩展存在）；
 *   2. .env 填好真实 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（KB Agent 与 embedding 复用 LLM provider）。
 *
 * 退出码：完成 → 0；抛错 → 1。日志走 stderr，结构化结果（artifact）走 stdout。
 */
import { runKbBackfill } from './backfill.js';

async function main(): Promise<void> {
  console.error(
    '[kb-backfill] 开始知识库历史回填（一次性、复用前向入库、幂等、不推送）…',
  );
  const res = await runKbBackfill();
  // 结构化结果打到 stdout 作可审计 artifact（日志 stderr / 数据 stdout）。
  console.log(JSON.stringify({ artifact: 'kb-backfill', result: res }, null, 2));
  console.error(
    `[kb-backfill] 完成：${res.pushDates} 日，累计入库 ${res.totals.ingested} 条` +
      `（候选 ${res.totals.candidates}、闸下 ${res.totals.gatedOut}、已存跳过 ${res.totals.skippedClaimed}、` +
      `Agent失败 ${res.totals.agentFailed}、写失败 ${res.totals.storeFailed}）。`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[kb-backfill] 失败：', err);
    process.exit(1);
  });
