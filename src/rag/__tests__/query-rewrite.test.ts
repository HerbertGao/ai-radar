/**
 * query-rewrite 单测（task 6.2 / 2.2，design D6）——纯 mock LLM，不触网 / 不需 DB。
 *
 * 覆盖：
 * 1. 多轮消歧：历史 + 追问 condense 成独立检索句（并断言历史**确实**喂给了 rewrite prompt）。
 * 2. 失败降级用原问（LLM 抛错 / 输出未过校验 / 输出空串 → 返回 rawQuery，不阻塞）。
 * 3. 空历史短路：不调 LLM，直接用原问。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../conversation-store.js';

// query-rewrite → llm-client / conversation-store 经 import 链间接 import env（启动期校验）。
// 注入占位 env 后再动态 import，使本纯单元套件无需真实凭据 / 无需 DB。
let rewriteQuery: typeof import('../query-rewrite.js').rewriteQuery;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ rewriteQuery } = await import('../query-rewrite.js'));
});

const turn = (over: Partial<ConversationTurn>): ConversationTurn => ({
  turn: 1,
  rawQuery: null,
  rewrittenQuery: null,
  hitKbIds: null,
  answer: null,
  evidence: null,
  model: null,
  createdAt: null,
  ...over,
});

describe('rewriteQuery', () => {
  it('多轮消歧：把指代追问 condense 成独立检索句，历史喂进 rewrite prompt', async () => {
    const history = [turn({ turn: 1, rawQuery: 'GPT-5 发布了吗', answer: 'GPT-5 已发布。' })];
    let capturedPrompt = '';
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return { object: { rewritten_query: 'GPT-5 的上下文窗口有多大' } };
    });

    const out = await rewriteQuery('它的上下文多大', history, { generateObjectFn });

    expect(out).toBe('GPT-5 的上下文窗口有多大');
    // 历史确实进了 rewrite 调用（D6：历史只在此被用）。
    expect(capturedPrompt).toContain('GPT-5 发布了吗');
    expect(capturedPrompt).toContain('它的上下文多大');
  });

  it('长会话截断：rewrite prompt 只含末 12 轮，撑爆前的旧轮不进 prompt', async () => {
    // 20 轮，每轮 rawQuery 带唯一标记 mark-<turn>；只有末 12 轮（turn 9..20）应进 prompt。
    const history = Array.from({ length: 20 }, (_, i) =>
      turn({ turn: i + 1, rawQuery: `mark-${i + 1}`, answer: 'a' }),
    );
    let capturedPrompt = '';
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return { object: { rewritten_query: 'ok' } };
    });

    await rewriteQuery('它是什么', history, { generateObjectFn });

    // 末 12 轮在（turn 20 最近、turn 9 是窗口首轮）。
    expect(capturedPrompt).toContain('mark-20');
    expect(capturedPrompt).toContain('mark-9');
    // 被撑爆窗口挡在外的旧轮不在（turn 8 及更早）。
    expect(capturedPrompt).not.toContain('mark-8');
    expect(capturedPrompt).not.toContain('mark-1\n');
  });

  it('空历史短路：不调 LLM，直接返回原问', async () => {
    const generateObjectFn = vi.fn();
    const out = await rewriteQuery('MCP 是什么', [], { generateObjectFn });
    expect(out).toBe('MCP 是什么');
    expect(generateObjectFn).not.toHaveBeenCalled();
  });

  it('LLM 抛错 → 降级用原问（不阻塞）', async () => {
    const history = [turn({ rawQuery: 'x', answer: 'y' })];
    const generateObjectFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const out = await rewriteQuery('它是什么', history, {
      generateObjectFn,
      logError: () => {},
    });
    expect(out).toBe('它是什么');
  });

  it('输出空串 → 降级用原问', async () => {
    const history = [turn({ rawQuery: 'x', answer: 'y' })];
    const generateObjectFn = vi.fn(async () => ({ object: { rewritten_query: '   ' } }));
    const out = await rewriteQuery('它是什么', history, {
      generateObjectFn,
      logError: () => {},
    });
    expect(out).toBe('它是什么');
  });

  it('输出未过 Zod 校验（缺字段）→ 降级用原问', async () => {
    const history = [turn({ rawQuery: 'x', answer: 'y' })];
    const generateObjectFn = vi.fn(async () => ({ object: {} }));
    const out = await rewriteQuery('它是什么', history, {
      generateObjectFn,
      logError: () => {},
    });
    expect(out).toBe('它是什么');
  });
});
