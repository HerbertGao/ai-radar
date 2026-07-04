/**
 * 待批卡片渲染单测（task 6.3）——纯渲染，无 DB / 不触网 / 不发送。
 *
 * money-path 红线覆盖：
 * - Telegram 卡 `callback_data = "mrpr:<token>:approve"`（≤64B），token 只进 callback_data；
 * - 飞书卡**通知-only**：不含 token、无写按钮/action/callback、引导去 Telegram（design D7）。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { buildPriceReviewTelegramCard, buildPriceReviewFeishuCard } = await import(
  '../card.js'
);

const base = {
  planName: 'Coding Plan Pro',
  oldValue: 40,
  newValue: 44,
  currency: 'CNY' as const,
  sourceUrl: 'https://example.com/pricing',
  pctDelta: 0.1,
};

const TOKEN = 'deadbeef'.repeat(4); // 32 hex chars（仿 randomBytes(16).toString('hex')）

describe('buildPriceReviewTelegramCard', () => {
  it('callback_data=mrpr:<token>:approve 且 ≤64B，diff 数值出现在文本', () => {
    const card = buildPriceReviewTelegramCard({ ...base, token: TOKEN });
    const cd = (card.replyMarkup.inline_keyboard[0]![0] as { callback_data: string })
      .callback_data;
    expect(cd).toBe(`mrpr:${TOKEN}:approve`);
    expect(Buffer.byteLength(cd, 'utf8')).toBeLessThanOrEqual(64);
    expect(card.parseMode).toBe('MarkdownV2');
    expect(card.text).toContain('44');
    expect(card.text).toContain('40');
  });
});

describe('buildPriceReviewFeishuCard（通知-only）', () => {
  it('不含 token、无写按钮/action/callback，引导去 Telegram', () => {
    const card = buildPriceReviewFeishuCard(base);
    const json = JSON.stringify(card);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('mrpr:');
    expect(json.toLowerCase()).not.toContain('callback');
    // 元素只有 div（无 action/button 交互块）。
    expect(json).not.toContain('"action"');
    expect(json).not.toContain('"button"');
    expect(card.header.template).toBe('orange');
    expect(json).toContain('Telegram');
  });
});
