/**
 * 只读边界对抗集成测试（组 E / task 5.1，design D3 / spec「读 DOMAIN 只读、仅读写自有会话状态」）——
 * **需本地 Postgres**（经 DATABASE_URL 注入；缺则整套件 skip、绝不硬编造）。
 *
 * 证明：跑一轮**真 `handle`**（真 dbh，走真实 `readHistory` / `writeTurn`；注入 `searchFn` / `generateObjectFn`
 * 桩避免触网/触真 embedding）后——
 *  - DOMAIN 各表（`kb_documents` / `ai_news_events` / `ai_products` / `mr_*`）**行数零变化**，
 *    且 `kb_documents` **整行内容哈希零变化**（任一列被误 UPDATE 亦可检出）；
 *  - **仅** `rag_conversations` 增行（本会话 0 → 1）。
 *
 * 即证「handler 的写路径结构上只落自有会话表、绝不写域库」。与 retrieval.integration / conversation-store
 * 集成测同范式：唯一前缀/唯一 conversation_id + afterAll 清理，可重复运行、fileParallelism=false 串行隔离。
 */
// 自持加载 .env（单跑时 process.env.DATABASE_URL 尚未填充 → skipIf 会误跳）。dotenv 不覆盖已注入变量。
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import type { KbSearchResult } from '../../kb/retrieval-core.js';

// 经 import 链触发 env 校验；注入占位（DATABASE_URL 用真值，其余不触网——全依赖注入桩）。
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { handle } = await import('../handler.js');

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const PREFIX = `rag-ro-itest-${randomUUID()}`;
const CID = `rag-ro-cid-${randomUUID()}`;

/** DOMAIN 表名清单（information_schema 派生、可信非用户输入）：显式三表 + 全部 `mr_*`。 */
const DOMAIN_TABLES_SQL = `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name IN ('kb_documents', 'ai_news_events', 'ai_products') OR table_name LIKE 'mr\\_%')
  ORDER BY table_name`;

/** 逐 DOMAIN 表行数快照。表名来自 information_schema（可信），拼接安全。 */
async function domainCounts(): Promise<Record<string, string>> {
  const { rows } = await pool!.query<{ table_name: string }>(DOMAIN_TABLES_SQL);
  const out: Record<string, string> = {};
  for (const { table_name } of rows) {
    // ponytail: 表名源自 information_schema 白名单查询、非外部输入，直接内插安全。
    const c = await pool!.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table_name}`);
    out[table_name] = c.rows[0]!.n;
  }
  return out;
}

/** kb_documents 行数 + 整行内容哈希（任一列被 UPDATE 亦可检出，非仅行数）。 */
async function kbDocsSnapshot(): Promise<{ n: string; h: string | null }> {
  const { rows } = await pool!.query<{ n: string; h: string | null }>(
    `SELECT count(*)::text AS n,
            md5(coalesce(string_agg(k::text, ',' ORDER BY k.id), '')) AS h
       FROM kb_documents k`,
  );
  return rows[0]!;
}

async function ragConvCount(cid: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM rag_conversations WHERE conversation_id = $1`,
    [cid],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!pool) return;
  // 非空 DOMAIN 基线：seed 一条 kb_documents（内容哈希对比才有意义、兼防误 DELETE）。
  await pool.query(
    `INSERT INTO kb_documents (target_type, target_id, kb_title, summary_zh)
     VALUES ('event', $1, 'ro baseline doc', 'baseline summary')`,
    [`${PREFIX}-doc`],
  );
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM rag_conversations WHERE conversation_id = $1`, [CID]);
    await pool.query(`DELETE FROM kb_documents WHERE target_id = $1`, [`${PREFIX}-doc`]);
  }
  await pool?.end();
});

describe.skipIf(!databaseUrl)('5.1 只读断言：一轮对话只写 rag_conversations、DOMAIN 零变化', () => {
  it('真 dbh 跑一轮 handle（注入 searchFn/generateObjectFn 桩）→ DOMAIN 行数+内容零变化，rag_conversations 恰 +1', async () => {
    // 桩命中（不触 DB/网）：阈上命中 + 散文引用 → 走**最全写路径**（有据、hitKbIds、model 落库）。
    const hits: KbSearchResult[] = [
      {
        id: 'kb-ro-1',
        kbTitle: '只读用标题',
        summaryZh: '只读用摘要',
        entities: null,
        sourceUrls: ['https://example.com/ro'],
        eventDate: null,
        longTermValue: 80,
        cosineSim: 0.9,
      },
    ];
    const searchFn = async () => hits;
    const generateObjectFn = async () => ({
      object: { answer: '基于证据的答案。', cited_kb_ids: ['kb-ro-1'] },
    });

    const beforeDomain = await domainCounts();
    const beforeKb = await kbDocsSnapshot();
    const cidBefore = await ragConvCount(CID);

    const r = await handle(
      '只读断言用查询',
      { userId: 'local', conversationId: CID },
      { dbh: db!, searchFn, generateObjectFn, minCosine: 0.3, logError: () => {} },
    );

    const afterDomain = await domainCounts();
    const afterKb = await kbDocsSnapshot();
    const cidAfter = await ragConvCount(CID);

    // handler 真的走了完整作答+写路径（才使只读断言有意义）。
    expect(r.evidence).toBe('有据');
    expect(r.answer).not.toBeNull();

    // DOMAIN 各表行数零变化 + kb_documents 内容哈希零变化（无 INSERT/UPDATE/DELETE）。
    expect(afterDomain).toEqual(beforeDomain);
    expect(afterKb).toEqual(beforeKb);

    // 仅 rag_conversations 增一行（本会话 0 → 1）。
    expect(cidBefore).toBe(0);
    expect(cidAfter).toBe(1);
  });
});
