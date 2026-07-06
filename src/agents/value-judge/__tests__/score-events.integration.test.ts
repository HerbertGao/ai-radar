/**
 * Value Judge 接入流水线集成测试（任务 6.3）——需本地 Postgres（compose 起的库）。
 *
 * 验证 spec「评分按映射写入真实事件并可读回」+ design D8 的核心不变量：
 * - 用 collapseRawItem 造**真实事件行**（塌缩首建 event_id / representative_* / first_seen_at /
 *   published_at），再对其 scoreUnscoredEvents 写分，读回各 *_score 与 Agent 输出一致（往返）。
 * - 写分用 `UPDATE ... WHERE event_id = ?` 仅改 *_score + should_push：断言塌缩首建的
 *   event_id / representative_raw_item_id / representative_title / first_seen_at / published_at /
 *   source_count 在评分后**不变**（不被覆盖致 Top N 退化）。
 * - 单条 judge 校验失败 → 降级跳过 + degraded_count++ + **不落库未校验数据**（该事件 *_score 仍 NULL）。
 * - 已评分事件（*_score 非 NULL）跳过不重判（不重复 LLM 调用、不覆盖旧分）。
 *
 * generateObjectFn 全程注入 mock，不依赖真实 LLM key；DATABASE_URL 缺则整套件 skip。
 * 每个用例用唯一 source_item_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema.js';

// score-events.js / collapse.js 间接 import config/env（启动期校验全部必填变量）。
// 本套件 mock LLM、不发推送，为推送/LLM 相关变量注入占位（||= 兼容空串）；
// 真实 DATABASE_URL 仍由 .env / CI 注入（缺则整套件 skip）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const { collapseRawItem } = await import('../../../dedup/collapse.js');
const { scoreUnscoredEvents } = await import('../score-events.js');

const databaseUrl = process.env.DATABASE_URL;

const SOURCE = 'score-events-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const VALID_OUTPUT = {
  is_ai_related: true,
  type: 'ai_product',
  category: 'AI Coding',
  importance: 82,
  novelty: 75,
  developer_relevance: 90,
  hype_risk: 35,
  should_push: true,
  reason: 'A new open-source coding agent.',
};

async function seedRawItem(args: {
  sourceItemId: string;
  url: string | null;
  title: string;
  publishedAt: Date | null;
  content?: string | null;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title, published_at, content)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [SOURCE, args.sourceItemId, args.url, args.title, args.publishedAt, args.content ?? null],
  );
  return BigInt(rows[0]!.id);
}

async function fetchEventByDedupKey(dedupKey: string) {
  const { rows } = await pool!.query<{
    event_id: string;
    representative_raw_item_id: string | null;
    representative_title: string | null;
    first_seen_at: Date | null;
    published_at: Date | null;
    source_count: number;
    importance_score: string | null;
    novelty_score: string | null;
    developer_relevance_score: string | null;
    hype_risk_score: string | null;
    should_push: boolean | null;
    is_ai_related: boolean | null;
  }>(
    `SELECT event_id, representative_raw_item_id, representative_title,
            first_seen_at, published_at, source_count,
            importance_score, novelty_score, developer_relevance_score,
            hype_risk_score, should_push, is_ai_related
     FROM ai_news_events WHERE dedup_key = $1`,
    [dedupKey],
  );
  return rows;
}

/** 造一条真实事件并返回其 dedup_key（经塌缩首建）；可选 content 落到代表 raw_item 供 grounding。 */
async function seedEvent(
  prefix: string,
  title: string,
  content?: string | null,
): Promise<string> {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `https://example.com/${prefix}/${ts}`;
  const id = await seedRawItem({
    sourceItemId: `${prefix}-${ts}`,
    url,
    title,
    publishedAt: new Date('2026-06-01T00:00:00Z'),
    content: content ?? null,
  });
  const out = await collapseRawItem(
    { id, url, title, publishedAt: new Date('2026-06-01T00:00:00Z'), fetchedAt: new Date() },
    db!,
  );
  return out.dedupKey!;
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM ai_news_events WHERE representative_raw_item_id IN
       (SELECT id FROM raw_items WHERE source = $1)`,
    [SOURCE],
  );
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('Value Judge 接入流水线（评分往返 + 降级容错）', () => {
  it('真实事件评分按映射写入 *_score 列并可读回一致；身份/排序列不被覆盖', async () => {
    const dedupKey = await seedEvent('roundtrip', 'New open-source coding agent');
    const before = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 评分前各 *_score 为 NULL（塌缩不写分）。
    expect(before.importance_score).toBeNull();

    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    // 至少把本事件送判并写分（其他并发套件造的未评分事件也可能被纳入，故用 >=）。
    expect(result.scored).toBeGreaterThanOrEqual(1);
    expect(result.degradedCount).toBe(0);

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 往返：各 *_score 与 Agent 输出按映射一致（NUMERIC 落库为字符串，用 Number 比较）。
    expect(Number(after.importance_score)).toBe(VALID_OUTPUT.importance);
    expect(Number(after.novelty_score)).toBe(VALID_OUTPUT.novelty);
    expect(Number(after.developer_relevance_score)).toBe(
      VALID_OUTPUT.developer_relevance,
    );
    expect(Number(after.hype_risk_score)).toBe(VALID_OUTPUT.hype_risk);
    expect(after.should_push).toBe(VALID_OUTPUT.should_push);

    // 写分仅改 *_score + should_push：塌缩首建的身份/代表/排序列不变。
    expect(after.event_id).toBe(before.event_id);
    expect(after.representative_raw_item_id).toBe(before.representative_raw_item_id);
    expect(after.representative_title).toBe(before.representative_title);
    expect(after.first_seen_at?.toISOString()).toBe(
      before.first_seen_at?.toISOString(),
    );
    expect(after.published_at?.toISOString()).toBe(
      before.published_at?.toISOString(),
    );
    expect(Number(after.source_count)).toBe(Number(before.source_count));
  });

  it('单条 judge 校验失败：降级跳过 + degraded_count++ + 不落库未校验数据', async () => {
    const dedupKey = await seedEvent('degrade', 'Item that fails judging');

    // mock 始终返回不符 schema 的对象 → judgeRawItem 重试耗尽抛 ValueJudgeFailureError。
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { is_ai_related: 'not-a-bool' } });
    const logError = vi.fn();

    const result = await scoreUnscoredEvents(
      {
        judge: { generateObjectFn, maxAttempts: 2, logError: () => {} },
        logError,
      },
      db!,
    );

    // 本事件被降级计数，且记录了日志（非静默）。
    expect(result.degradedCount).toBeGreaterThanOrEqual(1);
    expect(logError).toHaveBeenCalled();

    // 关键不变量：降级事件未写库——各 *_score 仍为 NULL（未校验数据绝不落库）。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).toBeNull();
    expect(after.novelty_score).toBeNull();
    expect(after.developer_relevance_score).toBeNull();
    expect(after.hype_risk_score).toBeNull();
  });

  it('已评分事件跳过不重判：第二轮不再调用 LLM、不覆盖旧分', async () => {
    const dedupKey = await seedEvent('skip', 'Already scored event');

    const firstFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn: firstFn, logError: () => {} }, logError: () => {} },
      db!,
    );
    const firstCalls = firstFn.mock.calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // 第二轮：本事件 *_score 已非 NULL，应被 `importance_score IS NULL` 过滤掉，不再送判。
    // 若误把已评分事件再判，会用不同分覆盖——故第二轮 mock 返回不同分以放大该 bug。
    const DIFFERENT = { ...VALID_OUTPUT, importance: 11, novelty: 22 };
    const secondFn = vi.fn().mockResolvedValue({ object: DIFFERENT });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn: secondFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 旧分保持首轮值（82），未被第二轮的 11 覆盖 → 证明已评分被跳过。
    expect(Number(after.importance_score)).toBe(VALID_OUTPUT.importance);
    expect(Number(after.novelty_score)).toBe(VALID_OUTPUT.novelty);
  });

  it('is_ai_related 落库并可读回（false 值证明非硬编码 true、非被映射层丢弃）', async () => {
    const dedupKey = await seedEvent('ai-related', 'Some non-AI item');
    // 返回 is_ai_related=false：若映射/落库丢弃该字段，读回会是 NULL（或默认），非 false。
    const output = { ...VALID_OUTPUT, is_ai_related: false };
    const generateObjectFn = vi.fn().mockResolvedValue({ object: output });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 读回 false（既非 NULL 丢弃、也非硬编码 true）——证明 mapping.ts 映射 + UPDATE set 落库往返。
    expect(after.is_ai_related).toBe(false);
  });

  it('grounding：补全后 content 进入传给 generateObjectFn 的 prompt（非仅读回 mock 硬编码输出）', async () => {
    // 唯一标记落到代表 raw_item.content——判分候选 SELECT 经 representative_raw_item_id left join
    // raw_items 载入该 content，judgeRawItem 拼进 prompt。断言注入 generateObjectFn 收到的 prompt
    // 文本**含该 content**：若 score-events 只改签名不接 SELECT 载入，prompt 不含 content 则本用例红
    // （区别于「读回 mock 硬编码输出」的假绿——后者即使 content 未接入也绿）。
    const marker = `GROUNDING-MARKER-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const contentText = `Anthropic shipped a real release. ${marker}`;
    const dedupKey = await seedEvent('grounding', 'A grounded event', contentText);

    const prompts: string[] = [];
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { object: VALID_OUTPUT };
    });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    // 至少一次调用的 prompt 含补全后 content（本事件的判分 prompt）。
    expect(prompts.some((p) => p.includes(contentText))).toBe(true);
    // 事件确被判分落库（防「未送判」导致 grounding 断言空过）。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).not.toBeNull();
  });
});
