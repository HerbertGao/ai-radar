/**
 * 支路 B 双出口一致性测试（p0-alert-lane D2.5，需本地 Postgres）。
 *
 * 同一批标题（大小写混合 / null / 中英混排 / 半角与全角空格变体）喂给两个出口，断言
 * `factChangeTitlePredicate()` 的 SQL 命中集 == `matchFactChangeKeywords()` 的 TS 命中集。
 *
 * 🔴 MUST 含 Title Case 用例：否定项漏 `lower()` 的唯一证伪用例——全小写样例下「复用同一个
 * lower()」与「否定侧裸列」两种写法结果相同、恒绿；只有 Title Case 的器物名标题（HN 真实形态
 * `Show HN: A Rate Limiter for LLM APIs`）能把「正向命中、否定失效 ⇒ NOT(false)=true ⇒ 手机照震」
 * 这条静默失效变红。
 *
 * 不变量收窄为「ASCII + CJK 等价」：`İ`(U+0130) 下 PG lower() 与 JS toLowerCase() 已知分叉，
 * 后果止于归因字段，MUST NOT 断言全 Unicode 等价（本批标题不含该类码位）。
 *
 * 缺 DATABASE_URL 时 DB 侧套件 skip；TS 出口的纯函数断言不依赖 DB、恒跑。
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, inArray } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import {
  factChangeTitlePredicate,
  matchFactChangeKeywords,
} from '../fact-change-gate.js';

const databaseUrl = process.env.DATABASE_URL;
const PREFIX = 'factgate-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/**
 * 同一批标题（D2.5）：前 7 条是原文表格的逐字用例（expected 钉死期望）；其余覆盖大小写混合、
 * 中英混排、`token 包` 的半角空格与全角空格（U+3000）两种变体与不命中的对照组；null 单独喂。
 */
const CASES: ReadonlyArray<{ title: string; expected: boolean; why: string }> = [
  // ── 原文表格 6 行逐字用例（含 Title Case 证伪对）──────────────────────────────
  {
    title: 'Show HN: A Rate Limiter for LLM APIs',
    expected: false,
    why: 'Title Case 器物名——否定谓词漏 lower() 时这条会命中 ⇒ 红（唯一证伪用例）',
  },
  {
    title: 'show hn: a rate limiter for llm apis',
    expected: false,
    why: '全小写同一条——两种写法都能过 ⇒ 它证伪不了任何东西，故不可只写这条',
  },
  {
    title:
      'Improved Batch Inference API: Enhanced UI, Expanded Model Support, and 3000× Rate Limit Increase',
    expected: true,
    why: '生产实测的支路 B 真命中（Title Case）——它能被捕获只因为正向用了 lower()',
  },
  {
    title: 'Beyond rate limits: scaling access to Codex and Sora',
    expected: true,
    why: '生产实测真命中',
  },
  {
    title: 'Improved rate limiting',
    expected: true,
    why: '动名词不在否定项内——防有人把 rate limiting 加进否定项（挡它 = 漏真的限流变更公告）',
  },
  { title: 'Nginx 限流器最佳实践', expected: false, why: '中文器物名（限流器）被否定项挡住' },
  { title: '速率限制器压测', expected: false, why: '中文器物名（速率限制器）被否定项挡住' },
  // ── 大小写混合 / 中英混排 / 空格变体 ────────────────────────────────────────
  { title: 'OpenAI Updates PRICING for GPT-5', expected: true, why: '大小写混合正向命中（pricing）' },
  { title: 'Claude 新增 token 包 折扣', expected: true, why: '中英混排 + 半角空格变体（token 包）' },
  { title: 'Claude 新增 token　包 折扣', expected: true, why: '中英混排 + 全角空格 U+3000 变体（token　包）' },
  { title: 'GPT-5 周用量上限提升 50%', expected: true, why: '招牌用例：核心词「用量上限」命中' },
  // ── 不命中对照组 ─────────────────────────────────────────────────────────────
  { title: 'Random unrelated headline about robots', expected: false, why: '无词表词' },
  { title: '一条与词表无关的中文标题', expected: false, why: '无词表词' },
];

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM ai_news_events WHERE dedup_key LIKE $1`, [`${PREFIX}-%`]);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('双出口一致性：SQL 命中集 == TS 命中集（D2.5）', () => {
  it('同一批标题（含 null）两出口命中集逐条相等，且 6 条逐字用例符合钉死期望', async () => {
    const ts = Date.now();
    // 逐条 seed（representative_title 可空——null 标题也进 SQL 侧，验证「NULL 视为不命中」口径）。
    const idToIndex = new Map<string, number>();
    const allIds: string[] = [];
    const titles: Array<string | null> = [...CASES.map((c) => c.title), null];
    for (let i = 0; i < titles.length; i++) {
      const { rows } = await pool!.query<{ event_id: string }>(
        `INSERT INTO ai_news_events (dedup_key, representative_title)
         VALUES ($1, $2) RETURNING event_id`,
        [`${PREFIX}-${ts}-${i}`, titles[i]],
      );
      idToIndex.set(rows[0]!.event_id, i);
      allIds.push(rows[0]!.event_id);
    }

    // SQL 出口：谓词只作用于本用例 seed 的行（inArray 圈定），命中集按标题下标还原。
    const hitRows = await db!
      .select({ eventId: schema.aiNewsEvents.eventId })
      .from(schema.aiNewsEvents)
      .where(and(inArray(schema.aiNewsEvents.eventId, allIds), factChangeTitlePredicate()));
    const sqlHitIndices = new Set(hitRows.map((r) => idToIndex.get(r.eventId)!));

    // TS 出口：同一批标题按 matchFactChangeKeywords 复算命中集。
    const tsHitIndices = new Set(
      titles.map((t, i) => (matchFactChangeKeywords(t).length > 0 ? i : -1)).filter((i) => i >= 0),
    );

    // 两出口命中集必须逐条相等（含 null 那条：双侧都不命中）。
    for (let i = 0; i < titles.length; i++) {
      expect(
        sqlHitIndices.has(i),
        `双出口分叉于标题[${i}] ${JSON.stringify(titles[i])}: SQL=${sqlHitIndices.has(i)} TS=${tsHitIndices.has(i)}`,
      ).toBe(tsHitIndices.has(i));
    }

    // 逐字用例的钉死期望（Title Case 器物名不命中 / 生产真命中命中 / rate limiting 命中 / 中文器物名不命中）。
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i]!;
      expect(sqlHitIndices.has(i), `SQL 期望不符 [${c.title}]: ${c.why}`).toBe(c.expected);
      expect(tsHitIndices.has(i), `TS 期望不符 [${c.title}]: ${c.why}`).toBe(c.expected);
    }
    // null 标题：双出口都不命中（SQL：lower(NULL) 的 LIKE ANY 非 TRUE；TS：null → []）。
    expect(sqlHitIndices.has(titles.length - 1)).toBe(false);
  });
});

describe('matchFactChangeKeywords（TS 出口纯函数口径，无 DB）', () => {
  it('null → []（签名接受 null，与 AlertCandidate.representativeTitle 兼容）', () => {
    expect(matchFactChangeKeywords(null)).toEqual([]);
  });

  it('命中否定项（含 Title Case）→ []（一票否决，先于正向匹配）', () => {
    expect(matchFactChangeKeywords('Show HN: A Rate Limiter for LLM APIs')).toEqual([]);
    expect(matchFactChangeKeywords('Nginx 限流器最佳实践')).toEqual([]);
  });

  it('正向命中返回具体词条（小写折叠；供归因 matchedKeywords 复算）', () => {
    expect(matchFactChangeKeywords('Improved Rate Limiting')).toContain('rate limit');
    expect(matchFactChangeKeywords('GPT-5 周用量上限提升 50%')).toContain('用量上限');
  });
});
