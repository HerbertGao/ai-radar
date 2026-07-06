/**
 * Integration 测试（任务 1.3）：断言 harden-daily-push-relevance-and-grounding 的 forward-only
 * 迁移 `0011_harden_daily_push_is_ai_related` 已在 `ai_news_events` 与 `ai_products` 两表各落
 * `is_ai_related` 列，且**可空布尔**（design D6：可空布尔、不回填，NULL 即 fail-closed 排除）。
 *
 * 对齐 spec：
 *  - value-judge-agent「is_ai_related 落库 + 要闻段 fail-closed 闸门」
 *  - product-discovery「产品段 is_ai_related 闸门」
 * 两者都以「列存在 + boolean + nullable」为前提；缺列时代码先于迁移部署会 fail-fast（assertProductZhColumns）。
 *
 * 迁移幂等（journal 级，drizzle-kit migrate 连跑两次第二次经 journal 跳过、无新 SQL）沿用既有
 * *-migration.integration.test.ts 范式——**不在 test 内重跑**，由本地 `npm run migrate` 二跑 +
 * CI migrate step 覆盖（见变更 tasks 8.1）。本套件只读断言迁移后的结构。
 *
 * 依赖：需要一个已执行 `drizzle-kit migrate` 的本地 Postgres（compose 起的库即可），
 * 通过 DATABASE_URL 注入；不依赖真实外网、不依赖 LLM。
 * 缺 DATABASE_URL 时本套件自动跳过（CI 在有 pg service 的 job 里才会跑到）。
 *
 * 可重复运行：纯只读查询 information_schema，不写任何数据。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!databaseUrl)('is_ai_related 迁移落两表可空布尔列', () => {
  it.each(['ai_news_events', 'ai_products'])(
    '%s.is_ai_related 存在且为 boolean + nullable',
    async (tableName) => {
      const { rows } = await pool!.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'is_ai_related'
        `,
        [tableName],
      );

      expect(rows, `${tableName}.is_ai_related 列缺失`).toHaveLength(1);
      const col = rows[0]!;
      expect(col.data_type).toBe('boolean');
      // 可空：fail-closed 排除依赖 NULL 参与谓词，绝不能是 NOT NULL。
      expect(col.is_nullable).toBe('YES');
      // 不带 default（design D6：不回填，旧行保持 NULL）。
      expect(col.column_default).toBeNull();
    },
  );
});
