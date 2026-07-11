/**
 * Integration 测试（任务 2.1 / 部分 5.6，add-conversational-rag / design D4）：断言 forward-only 迁移
 * 0012_rag_conversations 已落 `rag_conversations` 表，且 A3 会话状态的 DB 约束就位：
 *  - id bigserial PRIMARY KEY
 *  - user_id varchar(128) NOT NULL DEFAULT 'local'（多用户 seam）
 *  - conversation_id varchar(128) NOT NULL、turn integer NOT NULL（服务端生成/派生）
 *  - hit_kb_ids jsonb（指针式）
 *  - UNIQUE(user_id, conversation_id, turn)（幂等/唯一由 DB 约束，非应用层）
 *  - INDEX(user_id, conversation_id)（历史读回）
 *  - 写入断言：重复 (user_id, conversation_id, turn) 被 UNIQUE 拒绝（5.6 DB 级兜底）
 *
 * 与 ai-experiences / ai-products 迁移测试同范式：需一个已 `drizzle-kit migrate` 的本地 Postgres，
 * 经 DATABASE_URL 注入；不触外网、不依赖 LLM；缺 DATABASE_URL 自动跳过。写入断言用唯一 conversation_id
 * + afterAll 清理，可重复运行不互相污染。
 */
// 自持加载 .env（本文件不 import 任何触发 config/env 的模块，单跑时 process.env.DATABASE_URL
// 尚未被填充 → skipIf 会误跳）。dotenv 不覆盖已注入变量，CI 注入 DATABASE_URL 时为 no-op。
import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

// 本套件写入断言用的唯一 conversation_id（afterAll 据此清理）。
const TEST_CID = `rag-conv-migration-it-${randomUUID()}`;

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM rag_conversations WHERE conversation_id = $1`, [
      TEST_CID,
    ]);
  }
  await pool?.end();
});

describe.skipIf(!databaseUrl)('rag_conversations 迁移落表与约束', () => {
  it('表存在且含本期必建列', async () => {
    const { rows } = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'rag_conversations'`,
    );
    const names = new Set(rows.map((r) => r.column_name));
    for (const col of [
      'id',
      'user_id',
      'conversation_id',
      'turn',
      'raw_query',
      'rewritten_query',
      'hit_kb_ids',
      'answer',
      'evidence',
      'model',
      'created_at',
    ]) {
      expect(names.has(col), `rag_conversations 缺列 ${col}`).toBe(true);
    }
  });

  it('id 为 bigint PRIMARY KEY（bigserial）', async () => {
    const { rows } = await pool!.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'rag_conversations' AND column_name = 'id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('bigint');
    expect(rows[0]!.is_nullable).toBe('NO');

    const { rows: pk } = await pool!.query<{ constraint_type: string }>(
      `SELECT tc.constraint_type
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = 'rag_conversations'
         AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = 'id'`,
    );
    expect(pk).toHaveLength(1);
  });

  it('user_id varchar(128) NOT NULL DEFAULT \'local\'（多用户 seam）', async () => {
    const { rows } = await pool!.query<{
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'rag_conversations' AND column_name = 'user_id'`,
    );
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.data_type).toBe('character varying');
    expect(c.character_maximum_length).toBe(128);
    expect(c.is_nullable).toBe('NO');
    expect(c.column_default ?? '').toContain("'local'");
  });

  it('conversation_id varchar(128) NOT NULL、turn integer NOT NULL', async () => {
    const { rows } = await pool!.query<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'rag_conversations' AND column_name IN ('conversation_id', 'turn')`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    const cid = byName.get('conversation_id')!;
    expect(cid.data_type).toBe('character varying');
    expect(cid.character_maximum_length).toBe(128);
    expect(cid.is_nullable).toBe('NO');
    const turn = byName.get('turn')!;
    expect(turn.data_type).toBe('integer');
    expect(turn.is_nullable).toBe('NO');
  });

  it('hit_kb_ids 为 jsonb（指针式）', async () => {
    const { rows } = await pool!.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'rag_conversations' AND column_name = 'hit_kb_ids'`,
    );
    expect(rows[0]!.data_type).toBe('jsonb');
  });

  it('UNIQUE(user_id, conversation_id, turn) 约束就位', async () => {
    const { rows } = await pool!.query<{ columns: string }>(
      `SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.column_name) AS columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = 'rag_conversations' AND tc.constraint_type = 'UNIQUE'
       GROUP BY tc.constraint_name`,
    );
    const uniqueColumnSets = rows.map((r) => r.columns);
    // kcu 按 column_name 字母序聚合：conversation_id, turn, user_id。
    expect(
      uniqueColumnSets,
      `未找到 UNIQUE(user_id,conversation_id,turn)；实际：${JSON.stringify(rows)}`,
    ).toContain('conversation_id,turn,user_id');
  });

  it('INDEX(user_id, conversation_id) 就位（历史读回）', async () => {
    const { rows } = await pool!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'rag_conversations'`,
    );
    const indexNames = rows.map((r) => r.indexname);
    expect(indexNames).toContain('rag_conversations_user_id_conversation_id_idx');
  });

  it('重复 (user_id, conversation_id, turn) 被 UNIQUE 拒绝（5.6 DB 级兜底）', async () => {
    await pool!.query(
      `INSERT INTO rag_conversations (user_id, conversation_id, turn, raw_query)
       VALUES ('local', $1, 1, 'first')`,
      [TEST_CID],
    );
    // 同 (user_id, conversation_id, turn) 再插 → UNIQUE 冲突抛错，不产生重复行。
    await expect(
      pool!.query(
        `INSERT INTO rag_conversations (user_id, conversation_id, turn, raw_query)
         VALUES ('local', $1, 1, 'dup')`,
        [TEST_CID],
      ),
    ).rejects.toThrow();
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rag_conversations WHERE conversation_id = $1`,
      [TEST_CID],
    );
    expect(rows[0]!.n).toBe('1');
  });
});
