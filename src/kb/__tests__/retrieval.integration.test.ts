/**
 * searchKb 知识库读侧语义检索原语集成测试（add-kb-retrieval-baseline，组 B 任务 4.1 / 5.1–5.5，
 * **需本地 Postgres + pgvector**）。
 *
 * 覆盖 spec「知识库语义检索原语（只读、确定性、事件域）」+ design D2/D8/D9 不变量：
 * - 5.1 排序正确性：seed 已知 embedding（idx0/idx1 放 (cos,sin) → 与查询 base 向量余弦=cos，可控）→
 *   断言按 cosineSim 降序、topK 截断、cosine 并列时 id 稳定次序；embedding IS NULL 行被排除。
 * - 5.2 tombstone 事件排除：kb_documents 事件行其 ai_news_events.merged_into 非空 → 不返回；
 *   sibling（merged_into NULL）照常返回（守 D8 / 「tombstone 对下游不可见」）。
 * - 5.3 事件域限定：target_type='experience' 行不返回（守 D9）。
 * - 5.4 诚实降级 & 序列化：空 KB → []；纯空白查询 → [] 且**不调 embedManyFn**（trim 短路先于 embed）；
 *   低相似度仍带分返回不编造、不抛；每条 id 为 string 且 JSON.stringify 不抛（bigint 崩回归）。
 * - 5.5 topK 上限：>50 被原语钳制到 50；0/负被归一化到 >=1（Math.min/Math.max，不抛、无 LIMIT 0/负）。
 * - 4.1 只读守卫：跑查询后 kb_documents / kb_ingestion_records 行数与内容零变化（无 INSERT/UPDATE/DELETE）。
 *
 * 纪律（memory test-no-prod-sends / VITEST 不触网）：查询向量经注入 embedManyFn 桩确定化——**绝不**真调
 * embedding API（embedTexts 的 defaultEmbedMany 有 VITEST 守卫会抛）；本变更无 senders，无飞书/Telegram 面。
 * searchKb 读**全局**事件域 kb_documents（无 source 过滤），故每用例 TRUNCATE kb_documents /
 * kb_ingestion_records（RESTART IDENTITY 使 id 从 1 递增、tiebreaker 可判）+ 按前缀清本套件 ai_news_events。
 * vitest fileParallelism=false（串行）→ TRUNCATE 隔离安全。缺 DATABASE_URL 时整套件 skip。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

// 经 import 链触发 env 校验（缺关键变量即 throw）；注入占位（本套件不触网、注入 embed 桩）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { searchKb } = await import('../retrieval.js');
import type { EmbedManyFn } from '../../dedup/embedding.js';

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = 'kb-retr-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

let seq = 0;

/** 1536 维 pgvector 字面量：idx0/idx1 放 (cos,sin)，其余 0 → 与 base [1,0,...] 的余弦 = cos。 */
function vecLiteral(cos: number): string {
  const arr = new Array(1536).fill(0);
  arr[0] = cos;
  arr[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return `[${arr.join(',')}]`;
}

/** 查询基准向量 [1,0,0,...]（number[]，与 vecLiteral(cos) 余弦恰为 cos）。 */
function baseVec(): number[] {
  const arr = new Array(1536).fill(0);
  arr[0] = 1;
  return arr;
}

/**
 * 构造注入选项：embedManyFn 返回给定查询向量（默认 base），logError 静默（避免观测日志噪声）；
 * 附计数器断言「纯空白查询短路时 embedManyFn 未被调用」。topK 透传。
 */
function inject(opts: { topK?: number; queryVec?: number[] } = {}) {
  const state = { embedCalls: 0 };
  const embedManyFn: EmbedManyFn = async () => {
    state.embedCalls += 1;
    return { embeddings: [opts.queryVec ?? baseVec()] };
  };
  return {
    options: { embedManyFn, logError: () => {}, ...(opts.topK !== undefined ? { topK: opts.topK } : {}) },
    state,
  };
}

/** 直接 INSERT 一条 kb_documents（embedding 经 $::vector 字面量绑定），返回 {id, targetId}。 */
async function seedKbDoc(args: {
  kbTitle: string;
  embeddingLiteral: string | null;
  targetType?: string;
  targetId?: string;
  entities?: unknown;
  sourceUrls?: unknown;
  eventDate?: string | null;
  longTermValue?: number;
}): Promise<{ id: string; targetId: string }> {
  const targetId = args.targetId ?? `${PREFIX}-${++seq}`;
  const { rows } = await pool!.query<{ id: string; target_id: string }>(
    `INSERT INTO kb_documents
       (target_type, target_id, kb_title, summary_zh, entities, source_urls, event_date, long_term_value, embedding)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::vector)
     RETURNING id, target_id`,
    [
      args.targetType ?? 'event',
      targetId,
      args.kbTitle,
      `摘要:${args.kbTitle}`,
      args.entities !== undefined ? JSON.stringify(args.entities) : null,
      args.sourceUrls !== undefined ? JSON.stringify(args.sourceUrls) : null,
      args.eventDate ?? null,
      args.longTermValue ?? 80,
      args.embeddingLiteral,
    ],
  );
  return { id: String(rows[0]!.id), targetId: rows[0]!.target_id };
}

/** 批量 seed n 条事件域 kb_documents（单条 SQL，共用同一 embedding；供 topK 钳制用例，避免逐条慢）。 */
async function bulkSeedEventDocs(n: number, cos: number): Promise<void> {
  await pool!.query(
    `INSERT INTO kb_documents (target_type, target_id, kb_title, long_term_value, embedding)
     SELECT 'event', $1 || g::text, 'bulk-' || g::text, 80, $2::vector
       FROM generate_series(1, $3) g`,
    [`${PREFIX}-bulk-`, vecLiteral(cos), n],
  );
}

/** 直接 INSERT 一条 ai_news_events（显式 event_id，供 tombstone 反连接命中/缺行）。 */
async function seedEventRow(eventId: string, mergedInto: string | null): Promise<void> {
  await pool!.query(
    `INSERT INTO ai_news_events
       (event_id, dedup_key, representative_title, first_seen_at, last_seen_at, merged_into, source_count)
     VALUES ($1,$2,$3, now(), now(), $4, 1)`,
    [eventId, `${PREFIX}-${eventId}`, 'seed event', mergedInto],
  );
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  // searchKb 读全局事件域 kb_documents → 全表清（RESTART IDENTITY 使 id 从 1 递增，tiebreaker 可判）。
  await pool.query(`TRUNCATE TABLE kb_documents, kb_ingestion_records RESTART IDENTITY`);
  await pool.query(`DELETE FROM ai_news_events WHERE event_id LIKE $1`, [`${PREFIX}-%`]);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('searchKb 排序正确性（5.1）', () => {
  it('按 cosineSim 降序返回，embedding IS NULL 行被排除', async () => {
    await seedKbDoc({ kbTitle: 'A', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'B', embeddingLiteral: vecLiteral(0.5) });
    await seedKbDoc({ kbTitle: 'C', embeddingLiteral: vecLiteral(0.1) });
    await seedKbDoc({ kbTitle: 'NULL doc', embeddingLiteral: null }); // 不可检索 → 排除。

    const { options } = inject();
    const results = await searchKb('查询', options, db!);

    expect(results.map((r) => r.kbTitle)).toEqual(['A', 'B', 'C']); // 降序 0.9>0.5>0.1，NULL 不在内。
    expect(results.map((r) => r.cosineSim)).toEqual([...results.map((r) => r.cosineSim)].sort((a, b) => b - a));
    expect(results[0]!.cosineSim).toBeCloseTo(0.9, 5);
    expect(results[1]!.cosineSim).toBeCloseTo(0.5, 5);
    expect(results[2]!.cosineSim).toBeCloseTo(0.1, 5);
  });

  it('topK 截断到前 K 条（按分降序）', async () => {
    await seedKbDoc({ kbTitle: 'A', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'B', embeddingLiteral: vecLiteral(0.5) });
    await seedKbDoc({ kbTitle: 'C', embeddingLiteral: vecLiteral(0.1) });

    const { options } = inject({ topK: 2 });
    const results = await searchKb('查询', options, db!);

    expect(results.map((r) => r.kbTitle)).toEqual(['A', 'B']); // 截断到 top-2。
  });

  it('cosine 并列时 id 次序稳定（较早插入=较小 id 在前）', async () => {
    const first = await seedKbDoc({ kbTitle: 'tie-1', embeddingLiteral: vecLiteral(0.7) });
    const second = await seedKbDoc({ kbTitle: 'tie-2', embeddingLiteral: vecLiteral(0.7) }); // 同向量 → 并列。
    expect(BigInt(first.id)).toBeLessThan(BigInt(second.id));

    const { options } = inject();
    const results = await searchKb('查询', options, db!);

    // 并列 distance → ORDER BY 次序键 id 升序：较小 id（先插入）在前，结果可复现。
    expect(results.map((r) => r.kbTitle)).toEqual(['tie-1', 'tie-2']);
    expect(results.map((r) => r.id)).toEqual([first.id, second.id]);
  });
});

describe.skipIf(!databaseUrl)('searchKb tombstone 事件排除（5.2 / D8）', () => {
  it('merged_into 非空的事件其 kb 文档不返回；sibling（merged_into NULL）照常返回', async () => {
    const ts = Date.now();
    const survivorId = `${PREFIX}-surv-${ts}`;
    const tombId = `${PREFIX}-tomb-${ts}`;
    const siblingId = `${PREFIX}-sib-${ts}`;
    await seedEventRow(survivorId, null);
    await seedEventRow(tombId, survivorId); // 入库后被塌缩：merged_into=survivor。
    await seedEventRow(siblingId, null); // 正常存活事件。

    // tomb 文档给更高 cosine（0.95），证明它是被反连接排除、而非被分数挤掉。
    await seedKbDoc({ kbTitle: 'tomb doc', targetId: tombId, embeddingLiteral: vecLiteral(0.95) });
    await seedKbDoc({ kbTitle: 'sibling doc', targetId: siblingId, embeddingLiteral: vecLiteral(0.6) });

    const { options } = inject();
    const results = await searchKb('查询', options, db!);

    const titles = results.map((r) => r.kbTitle);
    expect(titles).toContain('sibling doc'); // merged_into NULL → 可检索。
    expect(titles).not.toContain('tomb doc'); // tombstone 反连接排除、不泄露。
  });

  it('kb 事件行无对应 ai_news_events 行（缺行）→ 仍返回（include-on-missing 安全缺省，D8）', async () => {
    // 不 seed ai_news_events 行 → NOT EXISTS 为真 → 非 tombstone、仍可检索（缺行绝不误删）。
    await seedKbDoc({ kbTitle: 'orphan doc', targetId: `${PREFIX}-orphan`, embeddingLiteral: vecLiteral(0.8) });
    const { options } = inject();
    const results = await searchKb('查询', options, db!);
    expect(results.map((r) => r.kbTitle)).toContain('orphan doc');
  });
});

describe.skipIf(!databaseUrl)('searchKb 事件域限定（5.3 / D9）', () => {
  it('target_type=experience 行不返回（只检索 event）', async () => {
    await seedKbDoc({ kbTitle: 'exp card', targetType: 'experience', embeddingLiteral: vecLiteral(0.95) });
    await seedKbDoc({ kbTitle: 'event doc', targetType: 'event', embeddingLiteral: vecLiteral(0.5) });

    const { options } = inject();
    const results = await searchKb('查询', options, db!);

    expect(results.map((r) => r.kbTitle)).toEqual(['event doc']); // 经验卡不在事件域检索范围。
  });
});

describe.skipIf(!databaseUrl)('searchKb 诚实降级 & 序列化（5.4）', () => {
  it('空 KB → 空数组（不抛）', async () => {
    const { options, state } = inject();
    const results = await searchKb('查询', options, db!);
    expect(results).toEqual([]);
    expect(state.embedCalls).toBe(1); // 查询非空 → 照常 embed，只是无候选行。
  });

  it('纯空白查询 → 空数组且不调 embedManyFn（trim 短路先于 embed）', async () => {
    await seedKbDoc({ kbTitle: 'has doc', embeddingLiteral: vecLiteral(0.9) }); // 有可检索行也不返回。
    const { options, state } = inject();
    const results = await searchKb('   ', options, db!);
    expect(results).toEqual([]);
    expect(state.embedCalls).toBe(0); // 短路：绝不对纯空白发起向量化（防退化向量）。
  });

  it('低相似度仍带分返回、不编造、不抛', async () => {
    await seedKbDoc({ kbTitle: 'faint', embeddingLiteral: vecLiteral(0.03) });
    const { options } = inject();
    const results = await searchKb('查询', options, db!);
    expect(results).toHaveLength(1);
    expect(results[0]!.kbTitle).toBe('faint');
    expect(typeof results[0]!.cosineSim).toBe('number');
    expect(results[0]!.cosineSim).toBeCloseTo(0.03, 5); // 真实低分，非兜底/编造。
  });

  it('每条 id 为 string 且结果可 JSON.stringify 不抛（bigint 崩回归）', async () => {
    await seedKbDoc({
      kbTitle: 'serializable',
      embeddingLiteral: vecLiteral(0.8),
      entities: { orgs: ['OpenAI'], models: ['GPT'] },
      sourceUrls: ['https://example.com/a'],
      eventDate: '2026-06-01',
    });
    const { options } = inject();
    const results = await searchKb('查询', options, db!);
    expect(results).toHaveLength(1);
    for (const r of results) expect(typeof r.id).toBe('string'); // bigint → String(id)。
    expect(() => JSON.stringify(results)).not.toThrow(); // 含 jsonb entities/sourceUrls，序列化不崩。
  });
});

describe.skipIf(!databaseUrl)('searchKb topK 原语内归一化（5.5）', () => {
  it('topK > 50 被钳制到 50（>50 行时返回恰 50、不抛）', async () => {
    await bulkSeedEventDocs(55, 0.5); // >50 可检索行（单条 SQL 批量，避免逐条慢）。
    const { options } = inject({ topK: 999 });
    const results = await searchKb('查询', options, db!);
    expect(results).toHaveLength(50); // Math.min(999, 50)=50，原语层钳制、非 CLI 参数校验。
  });

  it('topK=0 归一化到 >=1（无 LIMIT 0 静默空）', async () => {
    await seedKbDoc({ kbTitle: 'A', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'B', embeddingLiteral: vecLiteral(0.5) });
    const { options } = inject({ topK: 0 });
    const results = await searchKb('查询', options, db!);
    expect(results).toHaveLength(1); // Math.max(1, ...)=1，绝不 LIMIT 0 返回空。
  });

  it('topK 为负归一化到 >=1（无 LIMIT 负值报错）', async () => {
    await seedKbDoc({ kbTitle: 'A', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'B', embeddingLiteral: vecLiteral(0.5) });
    const { options } = inject({ topK: -5 });
    const results = await searchKb('查询', options, db!);
    expect(results).toHaveLength(1); // 负值归一到 1，不触发 Postgres LIMIT 负值报错。
  });

  it('topK=NaN 回落默认、绝非无界全表（回归钉：修复前 drizzle 省略 LIMIT 返回全部）', async () => {
    await bulkSeedEventDocs(55, 0.5); // >50 可检索行。
    const { options } = inject({ topK: NaN }); // 如 CLI `Number("abc")=NaN`。
    const results = await searchKb('查询', options, db!);
    // NaN 经 Number.isFinite 兜底回落 env 默认 → 有界；绝非返回全部 55
    // （修复前 Math.trunc(NaN)=NaN 穿过 clamp，drizzle 见 `NaN>=0` 假直接省略 LIMIT → 静默无界输出）。
    expect(results.length).toBeLessThanOrEqual(50);
    expect(results.length).toBeLessThan(55);
  });

  it('topK 小数经 trunc 取整（2.7 → 2）', async () => {
    await seedKbDoc({ kbTitle: 'A', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'B', embeddingLiteral: vecLiteral(0.6) });
    await seedKbDoc({ kbTitle: 'C', embeddingLiteral: vecLiteral(0.3) });
    const { options } = inject({ topK: 2.7 });
    const results = await searchKb('查询', options, db!);
    expect(results.map((r) => r.kbTitle)).toEqual(['A', 'B']); // Math.trunc(2.7)=2。
  });
});

describe.skipIf(!databaseUrl)('searchKb 只读守卫（4.1 / D6）', () => {
  it('跑查询后 kb_documents / kb_ingestion_records 行数与内容零变化', async () => {
    await seedKbDoc({ kbTitle: 'ro-1', embeddingLiteral: vecLiteral(0.9) });
    await seedKbDoc({ kbTitle: 'ro-2', embeddingLiteral: vecLiteral(0.4) });
    // 造一条入库账本行，使只读断言覆盖两表（非空基线，兼防误 DELETE）。
    await pool!.query(
      `INSERT INTO kb_ingestion_records (target_type, target_id, kb_provider, status)
       VALUES ('event', $1, 'custom', 'success')`,
      [`${PREFIX}-ro-rec`],
    );

    const snapshot = async () => {
      // 哈希整行（k::text 含全部列）→ 任一列被 UPDATE 亦可检出（守「内容零变化」literal，非仅 id+title/status）。
      const docs = await pool!.query<{ n: string; h: string | null }>(
        `SELECT count(*)::text AS n,
                md5(coalesce(string_agg(k::text, ',' ORDER BY k.id), '')) AS h
           FROM kb_documents k`,
      );
      const recs = await pool!.query<{ n: string; h: string | null }>(
        `SELECT count(*)::text AS n,
                md5(coalesce(string_agg(r::text, ',' ORDER BY r.id), '')) AS h
           FROM kb_ingestion_records r`,
      );
      return { docs: docs.rows[0], recs: recs.rows[0] };
    };

    const before = await snapshot();
    const { options } = inject();
    await searchKb('查询', options, db!); // 仅 SELECT。
    const after = await snapshot();

    expect(after).toEqual(before); // 行数 + 内容哈希零变化 → 无 INSERT/UPDATE/DELETE。
    expect(before.docs!.n).toBe('2');
    expect(before.recs!.n).toBe('1');
  });
});
