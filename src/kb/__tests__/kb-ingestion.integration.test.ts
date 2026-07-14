/**
 * 知识库入库幂等不变量集成测试（组 E 任务 5.4，**需本地 Postgres + pgvector**）。
 *
 * 覆盖 spec「知识库入库幂等」/「知识库准入闸只入精选」不变量（design D7）：
 * ① 同一 (target_type,target_id,kb_provider) 已 success 后重复触发被认领 `WHERE status<>'success'`
 *    跳过、不产生重复 kb_documents / kb_ingestion_records；
 * ② long_term_value=62 被准入闸拦下不入库；
 * ③ 入库写入阶段失败 → status=failed 保留 error_message，**再次触发能真正重试**（认领重新抢到该
 *    failed 行、重试成功后 status=success 且仅一条 kb_documents——验证 failed 不会永久挡死重试）；
 * ④ **两表原子性**：写入失败时事务回滚后无孤儿 kb_documents（断言 documents 行数 = success records 数）；
 * ⑤ **tombstone 排除**：被合并掉的 event 不进 KB 候选、不产生 kb_documents。
 *
 * LLM/embedding 不触网：知识摘要 Agent 与 embedTexts 经注入桩；写入失败用错维度 embedding 触发
 * vector(1536) 列拒绝（真实 DB 失败、走真实事务回滚），retry 用合法 embedding 成功。
 * 缺 DATABASE_URL 时自动跳过。每个用例用唯一 target_id / dedup_key 前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 经 import 链触发 env 校验（缺关键变量即 throw）；为推送/LLM 相关变量注入占位（本套件不触网）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { storeKbDocument, KB_PROVIDER_CUSTOM } = await import('../store.js');
const { runKbIngestion } = await import('../index.js');
import type { GenerateObjectFn } from '../ingestion-agent.js';
import type { EmbedManyFn } from '../../dedup/embedding.js';
import type { KbIngestionMetadata } from '../schema.js';

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = 'kb-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 合法 1536 维 embedding（满足 vector(1536) 列）。 */
const validVec = (): number[] => new Array(1536).fill(0.001);
/** 错维度 embedding（vector(1536) 列拒绝 → INSERT 抛错 → 事务回滚），用于制造写入失败。 */
const badVec = (): number[] => [1, 2, 3];

/** 知识摘要 Agent 桩：返回固定的合法元数据（long_term_value 可调）。 */
function metadataStub(longTermValue: number): GenerateObjectFn {
  return async () => ({
    object: {
      kb_title: 'KB 标题',
      summary_zh: 'KB 中文摘要',
      tags: ['AI'],
      entities: ['OpenAI'],
      source_urls: ['https://example.com/a'],
      event_date: '2026-06-15',
      long_term_value: longTermValue,
    } satisfies KbIngestionMetadata,
  });
}

/** embedTexts 桩：每条文本返回合法 1536 维向量。 */
const embedStub: EmbedManyFn = async ({ values }) => ({
  embeddings: values.map(() => validVec()),
});

/**
 * 直接 INSERT 一条 ai_news_events，返回 event_id。
 * summaryZh：未传 → 默认 'seed 摘要'（保留原有用例行为）；显式传 null → NULL（供回写测试）。
 */
async function seedEvent(args: {
  dedupKey: string;
  title: string;
  mergedInto?: string | null;
  publishedAt?: Date | null;
  summaryZh?: string | null;
}): Promise<string> {
  const summaryZh = 'summaryZh' in args ? args.summaryZh : 'seed 摘要';
  const { rows } = await pool!.query<{ event_id: string }>(
    // published_at 与 published_at_authority 同写（CHECK）；非空日期记 2（程序近似值）。
    `INSERT INTO ai_news_events
       (dedup_key, representative_title, summary_zh, first_seen_at, last_seen_at, published_at,
        published_at_authority, merged_into)
     VALUES ($1, $2, $3, now(), now(), $4, CASE WHEN $4::timestamptz IS NULL THEN 0 ELSE 2 END, $5)
     RETURNING event_id`,
    [args.dedupKey, args.title, summaryZh, args.publishedAt ?? null, args.mergedInto ?? null],
  );
  return rows[0]!.event_id;
}

/** 读回一条 ai_news_events 的 summary_zh（供回写断言）。 */
async function fetchSummaryZh(eventId: string): Promise<string | null> {
  const { rows } = await pool!.query<{ summary_zh: string | null }>(
    `SELECT summary_zh FROM ai_news_events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0]?.summary_zh ?? null;
}

/** 直接 INSERT 一条 push_records（success）。 */
async function seedPushSuccess(eventId: string, pushDate: string): Promise<void> {
  await pool!.query(
    `INSERT INTO push_records (target_type, target_id, channel, push_date, status, pushed_at)
     VALUES ('event', $1, 'telegram', $2, 'success', now())`,
    [eventId, pushDate],
  );
}

async function countDocs(targetId: string): Promise<number> {
  const { rows } = await pool!.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM kb_documents WHERE target_id = $1`,
    [targetId],
  );
  return Number(rows[0]!.c);
}

async function countRecords(targetId: string): Promise<number> {
  const { rows } = await pool!.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM kb_ingestion_records WHERE target_id = $1`,
    [targetId],
  );
  return Number(rows[0]!.c);
}

async function fetchRecord(targetId: string) {
  const { rows } = await pool!.query<{
    status: string;
    error_message: string | null;
    kb_document_id: string | null;
  }>(
    `SELECT status, error_message, kb_document_id
     FROM kb_ingestion_records WHERE target_id = $1 AND kb_provider = $2`,
    [targetId, KB_PROVIDER_CUSTOM],
  );
  return rows[0];
}

function deletePrefix(): Promise<unknown> {
  return Promise.all([
    pool!.query(`DELETE FROM kb_documents WHERE target_id LIKE $1 OR target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $2)`, [`${PREFIX}-%`, `${PREFIX}-%`]),
    pool!.query(`DELETE FROM kb_ingestion_records WHERE target_id LIKE $1 OR target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $2)`, [`${PREFIX}-%`, `${PREFIX}-%`]),
  ])
    .then(() =>
      pool!.query(`DELETE FROM push_records WHERE target_id IN (SELECT event_id FROM ai_news_events WHERE dedup_key LIKE $1)`, [`${PREFIX}-%`]),
    )
    .then(() =>
      pool!.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${PREFIX}-%`]),
    );
}

beforeAll(async () => {
  if (!pool) return;
  await deletePrefix();
});

afterAll(async () => {
  if (pool) {
    await deletePrefix();
    await pool.end();
  }
});

describe.skipIf(!databaseUrl)('知识库入库幂等 + 准入闸 + tombstone 排除（不变量）', () => {
  const baseItem = (targetId: string) => ({
    targetType: 'event' as const,
    targetId,
    kbTitle: 'KB 标题',
    summaryZh: 'KB 中文摘要',
    tags: ['AI'],
    entities: ['OpenAI'],
    sourceUrls: ['https://example.com/a'],
    eventDate: '2026-06-15',
    longTermValue: 85,
    embedding: validVec(),
  });

  it('① 已 success 后重复触发被认领 WHERE status<>success 跳过、不产生重复 documents/records', async () => {
    const targetId = `${PREFIX}-dup-${Date.now()}`;

    const first = await storeKbDocument(baseItem(targetId), {}, db!);
    expect(first.outcome).toBe('ingested');
    expect(await countDocs(targetId)).toBe(1);
    expect(await countRecords(targetId)).toBe(1);
    expect((await fetchRecord(targetId))!.status).toBe('success');

    // 重复触发：认领 setWhere(status<>'success') 不满足 → RETURNING 空 → 跳过。
    const second = await storeKbDocument(baseItem(targetId), {}, db!);
    expect(second.outcome).toBe('skipped-claimed');
    // 不产生重复行。
    expect(await countDocs(targetId)).toBe(1);
    expect(await countRecords(targetId)).toBe(1);
  });

  it('③/④ 写入失败 → status=failed 保留 error_message、无孤儿 documents；再次触发真正重试成功且仅一条 document', async () => {
    const targetId = `${PREFIX}-retry-${Date.now()}`;

    // 第一次：错维度 embedding 触发 vector(1536) 列拒绝 → 事务回滚（无 kb_documents）→ 置 failed。
    const failed = await storeKbDocument(
      { ...baseItem(targetId), embedding: badVec() },
      { logError: () => {} },
      db!,
    );
    expect(failed.outcome).toBe('failed');
    const rec1 = await fetchRecord(targetId);
    expect(rec1!.status).toBe('failed');
    expect(rec1!.error_message).toBeTruthy();
    expect(rec1!.kb_document_id).toBeNull();
    // ④ 两表原子性：回滚后无孤儿 document（document 数 = success record 数 = 0）。
    expect(await countDocs(targetId)).toBe(0);

    // 第二次（重试）：认领据 status='failed'（<>'success'）重新抢到该行、合法 embedding → 成功。
    const ok = await storeKbDocument(baseItem(targetId), {}, db!);
    expect(ok.outcome).toBe('ingested');
    const rec2 = await fetchRecord(targetId);
    expect(rec2!.status).toBe('success');
    expect(rec2!.kb_document_id).toBeTruthy();
    // 验证 failed 不永久挡死重试：仅一条 document、一条 record（认领是 DO UPDATE 复用同一行）。
    expect(await countDocs(targetId)).toBe(1);
    expect(await countRecords(targetId)).toBe(1);
  });

  it('④ 两表原子性聚合断言：documents 行数 = success records 数（混合 success/failed 后）', async () => {
    const okId = `${PREFIX}-atom-ok-${Date.now()}`;
    const failId = `${PREFIX}-atom-fail-${Date.now()}`;

    await storeKbDocument(baseItem(okId), {}, db!); // success
    await storeKbDocument(
      { ...baseItem(failId), embedding: badVec() },
      { logError: () => {} },
      db!,
    ); // failed（回滚、无 document）

    const { rows: docRows } = await pool!.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_documents WHERE target_id IN ($1,$2)`,
      [okId, failId],
    );
    const { rows: sucRows } = await pool!.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_ingestion_records WHERE target_id IN ($1,$2) AND status='success'`,
      [okId, failId],
    );
    expect(Number(docRows[0]!.c)).toBe(Number(sucRows[0]!.c));
    expect(Number(docRows[0]!.c)).toBe(1);
  });

  it('② runKbIngestion：long_term_value=62 被准入闸拦下不入库', async () => {
    const pushDate = '2026-06-15';
    const eventId = await seedEvent({ dedupKey: `${PREFIX}-gate-${Date.now()}`, title: '低价值事件' });
    await seedPushSuccess(eventId, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-06-15T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(62) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.gatedOut).toBeGreaterThanOrEqual(1);
    // 该事件未入库：无 kb_documents、无 kb_ingestion_records。
    expect(await countDocs(eventId)).toBe(0);
    expect(await countRecords(eventId)).toBe(0);
  });

  it('② runKbIngestion：long_term_value=85 过闸入库（正路对照）', async () => {
    const pushDate = '2026-06-15';
    const eventId = await seedEvent({ dedupKey: `${PREFIX}-pass-${Date.now()}`, title: '高价值事件' });
    await seedPushSuccess(eventId, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-06-15T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(85) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    expect(result.ingested).toBeGreaterThanOrEqual(1);
    expect(await countDocs(eventId)).toBe(1);
    const rec = await fetchRecord(eventId);
    expect(rec!.status).toBe('success');
  });

  it('⑤ tombstone 排除：被合并掉的 event（merged_into 非空）不进 KB 候选、不产生 kb_documents', async () => {
    const pushDate = '2026-06-15';
    // 存活者（merged_into IS NULL）+ 被吞 tombstone（merged_into=存活）。
    const survivor = await seedEvent({ dedupKey: `${PREFIX}-tomb-surv-${Date.now()}`, title: '存活事件' });
    const tomb = await seedEvent({
      dedupKey: `${PREFIX}-tomb-dead-${Date.now()}`,
      title: '被吞事件',
      mergedInto: survivor,
    });
    // 两者都「曾 push success」（模拟 tombstone 也有历史 push 记录），但 tombstone 必须被候选排除。
    await seedPushSuccess(survivor, pushDate);
    await seedPushSuccess(tomb, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-06-15T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(90) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    expect(result.ingested).toBeGreaterThanOrEqual(1);
    // 存活者入库、tombstone 不入库。
    expect(await countDocs(survivor)).toBe(1);
    expect(await countDocs(tomb)).toBe(0);
    expect(await countRecords(tomb)).toBe(0);
  });
});

/**
 * downgrade-daily-digest（Plan A A4，组 B）：KB 入库回写 summary_zh 回归。
 *
 * 覆盖 spec「知识摘要 Agent 产出入库元数据」MODIFIED + 任务 4.3：
 * - 回写发生：push-success 事件（summary_zh 为 NULL）入库后 ai_news_events.summary_zh 被回写
 *   （该值即 weekly 零 LLM 复用的来源）；
 * - `< 70` 未入 KB 者亦回写（回写独立于 >= 70 准入 KB 写）；
 * - summary_zh 已存在时 Agent **仍照常跑**产 long_term_value（供准入闸），回写 `WHERE ... IS NULL`
 *   不覆盖现值——**断言 P0/已摘要事件不被误挡出 KB（KB-admission 无回归）**。
 *
 * 各用例用唯一 push_date + 唯一 dedup_key 前缀隔离；per-eventId 断言精确、result 计数用 >= 兜底。
 */
describe.skipIf(!databaseUrl)('KB 入库回写 summary_zh（组 B / A4 降级搬迁）', () => {
  it('回写：summary_zh 为 NULL 的 push-success 事件入库后被回写（>= 70 入 KB）', async () => {
    const pushDate = '2026-07-01';
    const eventId = await seedEvent({
      dedupKey: `${PREFIX}-wb-hi-${Date.now()}`,
      title: '高价值回写事件',
      summaryZh: null,
    });
    await seedPushSuccess(eventId, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-07-01T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(85) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    expect(result.ingested).toBeGreaterThanOrEqual(1);
    expect(await countDocs(eventId)).toBe(1);
    // Agent 产出的 summary_zh 被回写（NULL → 'KB 中文摘要'），weekly 后续零 LLM 复用此值。
    expect(await fetchSummaryZh(eventId)).toBe('KB 中文摘要');
  });

  it('回写：long_term_value < 70 未入 KB 的事件 summary_zh 仍被回写（回写独立于准入闸）', async () => {
    const pushDate = '2026-07-02';
    const eventId = await seedEvent({
      dedupKey: `${PREFIX}-wb-lo-${Date.now()}`,
      title: '低价值回写事件',
      summaryZh: null,
    });
    await seedPushSuccess(eventId, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-07-02T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(62) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    expect(result.gatedOut).toBeGreaterThanOrEqual(1);
    // 未入 KB（< 70 被准入闸拦下），但回写仍在准入闸之前发生。
    expect(await countDocs(eventId)).toBe(0);
    expect(await fetchSummaryZh(eventId)).toBe('KB 中文摘要');
  });

  it('summary_zh 已存在（如 P0/告警链已产）：Agent 仍跑产 long_term_value、回写 WHERE IS NULL 不覆盖、KB 准入无回归', async () => {
    const pushDate = '2026-07-03';
    const eventId = await seedEvent({
      dedupKey: `${PREFIX}-wb-exist-${Date.now()}`,
      title: 'P0 已摘要事件',
      summaryZh: '告警链已产摘要',
    });
    await seedPushSuccess(eventId, pushDate);

    const result = await runKbIngestion(
      {
        now: new Date('2026-07-03T03:00:00Z'),
        agent: { generateObjectFn: metadataStub(85) },
        embed: { embedManyFn: embedStub },
        store: { logError: () => {} },
        logError: () => {},
      },
      db!,
    );

    // Agent 照常跑（未因 summary_zh 已存在而跳过）→ 产 long_term_value=85 → 过闸入 KB。
    // kb_documents=1 即证 Agent 已运行并产出 long_term_value：若跳过 Agent 则无从判闸、无从入库。
    expect(result.agentOk).toBeGreaterThanOrEqual(1);
    expect(result.ingested).toBeGreaterThanOrEqual(1);
    // KB-admission 无回归：P0/已摘要高价值事件未被误挡出 KB。
    expect(await countDocs(eventId)).toBe(1);
    // 回写 `WHERE summary_zh IS NULL`：列非空 → 不覆盖现值（幂等无操作，非跳过 Agent）。
    expect(await fetchSummaryZh(eventId)).toBe('告警链已产摘要');
  });
});
