/**
 * statement_timeout 单连事务真取消机制的**真 PG** 集成测试（add-model-radar-assembly-deadline-cancel，需本地 Postgres）。
 *
 * 单测（retrieval-core.test.ts / evidence.test.ts）只能用 mock 证 SQL 形态 + remainingMs 回调内算 + 错误冒泡；
 * 「真 PG 令超时查询 57014 中止 / 事务自动 ROLLBACK / `is_local` 使 statement_timeout 不泄漏到归还池的连接」
 * 这三条净新机制的**引擎级**行为，唯有真连库可证——本文件补这一缝。
 *
 * 只读：仅 `pg_sleep` + `set_config`，不碰任何业务表、不写库、不触网/LLM。缺 `DATABASE_URL` 自动跳过。
 * 用 `max: 1` 专用池 ⇒ 事务与其后续查询必落同一物理连接，`is_local` 是否泄漏可判定地验。
 */
// 自持加载 .env（单跑时 process.env.DATABASE_URL 尚未填充 → skipIf 会误跳）。dotenv 不覆盖已注入变量，CI 注入 DATABASE_URL 时为 no-op。
import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

// 真实 DB 存在性以（dotenv 加载后的）原值为准——本文件不 import 触 env 校验的应用模块，故只需 .env 的 DATABASE_URL。
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 1 }) : null;
const db = pool ? drizzle(pool) : null;
const describeIfDb = databaseUrl ? describe : describe.skip;

afterAll(async () => {
  if (pool) await pool.end();
});

describeIfDb('statement_timeout 单连事务真取消（真 PG：57014 + 自动 ROLLBACK + is_local 不泄漏）', () => {
  it('set_config(statement_timeout,is_local) 内的超时查询以 SQLSTATE 57014 被服务端中止', async () => {
    await expect(
      db!.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '50', true)`);
        await tx.execute(sql`select pg_sleep(0.5)`); // 0.5s ≫ 50ms ⇒ 服务端计时器中止
        return 'unreached';
      }),
    ).rejects.toMatchObject({ cause: { code: '57014' } }); // Drizzle 包外层 Error、真 SQLSTATE 在 .cause（异常冒泡前已内部 ROLLBACK + release）
  });

  it('超时+ROLLBACK 后同一（max:1）物理连接无残留 statement_timeout：0.2s 查询不再被中止', async () => {
    // 复用上条被 57014 中止后归还的同一连接；is_local=true ⇒ 事务外 statement_timeout 复位为默认（0=无限）。
    // 若泄漏（连接仍带 50ms 上限），此 0.2s pg_sleep 会再抛 57014；断言 resolves 即证不泄漏、连接干净可复用。
    await expect(db!.execute(sql`select pg_sleep(0.2)`)).resolves.toBeDefined();
  });
});
