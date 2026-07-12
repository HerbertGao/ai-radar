/**
 * 轻量路径（headline-only）单元测试（任务 4.1）——纯 mock LLM，不依赖真实 key、不需 DB。
 *
 * 覆盖本组关键不变量：
 * 1. headlineOnlyOutputSchema **只含 headline_zh**：接受 `{ headline_zh }`、剥离多余 summary_zh；
 *    空串/缺字段/超长/mojibake 被挡（复用 HEADLINE_MAX + mojibake 守卫）。
 * 2. generateHeadline 传给 generateObject 的 **schema 只有 headline_zh 字段**（不产 summary_zh），
 *    且轻量路径 prompt 同样 grounding（注入当前日期 + 无正文防幻觉护栏）。
 * 3. headlineOnlyEvent 成功：`UPDATE ... set` **仅含 headlineZh**（绝不写 summaryZh）；
 *    降级：绝不调用 UPDATE（不写未校验内容）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { headlineOnlyOutputSchema, HEADLINE_MAX } from '../schema.js';

// index.js / persistence.js 经 import 链间接 import env（启动期校验，缺关键变量即 throw）。
// 注入占位 env 后再动态 import，使本纯单元套件无需真实凭据、无需 DB。
let generateHeadline: typeof import('../index.js').generateHeadline;
let headlineOnlyEvent: typeof import('../persistence.js').headlineOnlyEvent;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  const idx = await import('../index.js');
  generateHeadline = idx.generateHeadline;
  const persistence = await import('../persistence.js');
  headlineOnlyEvent = persistence.headlineOnlyEvent;
});

const VALID_HEADLINE = '某开源编码 Agent 发布新版本，支持多文件编辑，便于开发者集成。';

describe('headlineOnlyOutputSchema（只含 headline_zh）', () => {
  it('接受含合法 headline_zh 的输出', () => {
    const parsed = headlineOnlyOutputSchema.safeParse({ headline_zh: VALID_HEADLINE });
    expect(parsed.success).toBe(true);
  });

  it('剥离多余 summary_zh：parsed.data 只含 headline_zh（不产 summary_zh）', () => {
    const parsed = headlineOnlyOutputSchema.parse({
      headline_zh: VALID_HEADLINE,
      summary_zh: '这段长摘要不应出现在轻量路径产出里',
    });
    expect(parsed).toEqual({ headline_zh: VALID_HEADLINE });
    expect('summary_zh' in parsed).toBe(false);
  });

  it('拒绝缺 headline_zh 字段', () => {
    expect(headlineOnlyOutputSchema.safeParse({}).success).toBe(false);
  });

  it('拒绝空串 / 仅空白 headline_zh', () => {
    expect(headlineOnlyOutputSchema.safeParse({ headline_zh: '' }).success).toBe(false);
    expect(headlineOnlyOutputSchema.safeParse({ headline_zh: '   ' }).success).toBe(false);
  });

  it(`拒绝超长 headline_zh（>${HEADLINE_MAX} 字）`, () => {
    expect(
      headlineOnlyOutputSchema.safeParse({ headline_zh: '字'.repeat(HEADLINE_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it('拒绝 mojibake headline_zh（上游双重编码乱码）', () => {
    expect(
      headlineOnlyOutputSchema.safeParse({ headline_zh: 'æ¬ææ é¢ä¸ºNotes on DeepSeek' })
        .success,
    ).toBe(false);
  });
});

describe('generateHeadline（mock generateObject）', () => {
  it('传给 generateObject 的 schema 只有 headline_zh 字段（不产 summary_zh）', async () => {
    let receivedSchema: unknown;
    const generateObjectFn = vi.fn(async ({ schema }: { schema: unknown }) => {
      receivedSchema = schema;
      return { object: { headline_zh: VALID_HEADLINE } };
    });
    const result = await generateHeadline(
      { title: '某事件标题' },
      { generateObjectFn, logError: () => {} },
    );
    expect(result).toEqual({ headline_zh: VALID_HEADLINE });
    // 注入桩拿到的 schema 就是轻量 schema——字段集恰为 { headline_zh }，无 summary_zh。
    expect(receivedSchema).toBe(headlineOnlyOutputSchema);
    expect(Object.keys(headlineOnlyOutputSchema.shape)).toEqual(['headline_zh']);
  });

  it('轻量路径 prompt 同样 grounding：注入当前日期 + 无正文防幻觉护栏', async () => {
    let captured = '';
    const generateObjectFn = vi.fn(async ({ prompt }: { prompt: string }) => {
      captured = prompt;
      return { object: { headline_zh: VALID_HEADLINE } };
    });
    await generateHeadline({ title: 'Claude Sonnet 5' }, { generateObjectFn, logError: () => {} });
    const today = new Date().toISOString().slice(0, 10);
    expect(captured).toContain(today);
    expect(captured).toContain('只依据标题');
    expect(captured).toContain('禁止编造');
    expect(captured).toContain('训练知识');
    // 字段声明只提 headline_zh、不提 summary_zh（LLM 不被要求产长摘要）。
    expect(captured).toContain('headline_zh');
    expect(captured).not.toContain('summary_zh');
  });

  it('有正文时 prompt 含正文（grounding 于正文）', async () => {
    let captured = '';
    const generateObjectFn = vi.fn(async ({ prompt }: { prompt: string }) => {
      captured = prompt;
      return { object: { headline_zh: VALID_HEADLINE } };
    });
    await generateHeadline(
      { title: 'Leanstral 1.5', content: '某公司发布 Leanstral 1.5，上下文窗口 128k。' },
      { generateObjectFn, logError: () => {} },
    );
    expect(captured).toContain('某公司发布 Leanstral 1.5，上下文窗口 128k。');
  });
});

describe('headlineOnlyEvent 只写 headline_zh（mock generateObject + mock db）', () => {
  /** 最小 db stub，记录 update().set().where() 的调用与 set 入参。 */
  function makeDbStub() {
    const setSpy = vi.fn();
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({
      set: (...setArgs: unknown[]) => {
        setSpy(...setArgs);
        return { where: whereSpy };
      },
    }));
    return { dbStub: { update } as never, setSpy, update };
  }

  it('成功：UPDATE set 仅含 headlineZh（绝不写 summaryZh），返回 status=headline', async () => {
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { headline_zh: VALID_HEADLINE } });
    const { dbStub, setSpy, update } = makeDbStub();
    const outcome = await headlineOnlyEvent(
      { eventId: 'evt-1', representativeTitle: '代表标题', canonicalUrl: null },
      { generateObjectFn, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({
      eventId: 'evt-1',
      status: 'headline',
      headlineZh: VALID_HEADLINE,
      degraded: false,
    });
    expect(update).toHaveBeenCalledTimes(1);
    // 关键：set 仅含 headlineZh——无 summaryZh、无 representative_title / *_score 等身份/评分列。
    expect(setSpy).toHaveBeenCalledWith({ headlineZh: VALID_HEADLINE });
    const setArg = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect('summaryZh' in setArg).toBe(false);
  });

  it('降级 + representative_title 可用：回退 fallback，绝不 UPDATE（不写未校验内容）', async () => {
    const generateObjectFn = vi.fn().mockResolvedValue({ object: { headline_zh: '' } });
    const { dbStub, update } = makeDbStub();
    const outcome = await headlineOnlyEvent(
      { eventId: 'evt-2', representativeTitle: '可回退的代表标题', canonicalUrl: 'https://e.com/a' },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({
      eventId: 'evt-2',
      status: 'fallback',
      fallbackText: '可回退的代表标题',
      degraded: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('降级 + 标题空 + 无 URL：剔除该 event（dropped），不写库', async () => {
    const generateObjectFn = vi.fn().mockRejectedValue(new Error('down'));
    const { dbStub, update } = makeDbStub();
    const outcome = await headlineOnlyEvent(
      { eventId: 'evt-3', representativeTitle: '', canonicalUrl: null },
      { generateObjectFn, maxAttempts: 2, logError: () => {} },
      dbStub,
    );
    expect(outcome).toEqual({ eventId: 'evt-3', status: 'dropped', degraded: true });
    expect(update).not.toHaveBeenCalled();
  });
});
