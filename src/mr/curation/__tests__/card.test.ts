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

const {
  buildPriceReviewTelegramCard,
  buildPriceReviewFeishuCard,
  buildUrlDriftTelegramCard,
} = await import('../card.js');

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

describe('buildUrlDriftTelegramCard', () => {
  const urlBase = {
    oldUrl: 'https://moonshot.cn/docs/pricing',
    candidateUrl: 'https://kimi.com/docs/pricing',
    confidence: 'high' as const,
    reason: '源域从 moonshot.cn 迁至 kimi.com，同 vendor 域内',
  };

  it('callback_data=mrud:<token>:approve 且 ≤64B，candidate_url 不进 callback_data', () => {
    const card = buildUrlDriftTelegramCard({ ...urlBase, token: TOKEN });
    const cd = (card.replyMarkup.inline_keyboard[0]![0] as { callback_data: string })
      .callback_data;
    expect(cd).toBe(`mrud:${TOKEN}:approve`);
    expect(Buffer.byteLength(cd, 'utf8')).toBeLessThanOrEqual(64);
    expect(cd).not.toContain('kimi.com'); // candidate_url 是 value、绝不进 callback_data
    expect(card.parseMode).toBe('MarkdownV2');
    // 卡面含 old/candidate/confidence/reason 关键信息。
    expect(card.text).toContain('moonshot');
    expect(card.text).toContain('kimi');
    expect(card.text).toContain('high');
  });

  it('B1 回归守卫：old→candidate 变更行是纯文本、host 的 `.`/`-` 经 escapeMarkdownV2 转义（防 Telegram 400 整卡失败）', () => {
    // oldUrl 只出现在**变更行纯文本**（不进内联链接目标、reason 也不含它）——故其转义形唯一可判：误用
    // escapeMarkdownV2Url（只转 `)`/`\`）会留裸 `.` → MarkdownV2「'.' is reserved」→ sendMessage 400 → 每张卡都发不出。
    const card = buildUrlDriftTelegramCard({
      token: TOKEN,
      oldUrl: 'https://old-host.example/p',
      candidateUrl: 'https://new-host.example/q',
      confidence: 'low',
      reason: 'r',
    });
    expect(card.text).toContain('old\\-host\\.example'); // 变更行经文本转义器
    expect(card.text).not.toContain('old-host.example'); // 无未转义裸 host（回归到 Url 转义器即出现）
    // 候选 host 也单独钉：变更行须文本转义（链接目标另有一份不转义的 new-host.example）——否则只回退 candidate 侧的
    // 变更行 escaper（保留 old 侧）不会被上面两条捕获。
    expect(card.text).toContain('new\\-host\\.example');
  });

  it('不可信 reason / candidate_url 含 MarkdownV2 破坏字符 → 安全转义、无未转义 breakout', () => {
    const card = buildUrlDriftTelegramCard({
      token: TOKEN,
      oldUrl: 'https://kimi.com/a',
      // 候选 URL 含 `)`——若不经 escapeMarkdownV2Url 会提前闭合 [..](..) 链接。
      candidateUrl: 'https://kimi.com/a(b)c',
      confidence: 'medium',
      // LLM 产出的伪链接注入尝试——须经 escapeMarkdownV2 中和。
      reason: '[click](tg://evil) *bold* _x_ ) breakout',
    });

    // reason 的所有 MarkdownV2 特殊字符被反斜杠转义 → 不残留裸伪链接。
    expect(card.text).toContain('\\[click\\]\\(tg://evil\\)');
    expect(card.text).not.toContain('[click](tg://evil)');
    // 候选 URL 的 `)` 被转义，不会提前闭合真正的 [查看候选页](...) 链接。
    expect(card.text).toContain('https://kimi.com/a(b\\)c');
    // 唯一合法的内联链接是我们自己的「查看候选页」；reason 里的伪链接不成链接。
    const linkTexts = [...card.text.matchAll(/(?<!\\)\[([^\]]*)\]\((?<!\\)/g)].map(
      (m) => m[1],
    );
    expect(linkTexts).toEqual(['查看候选页']);
  });
});
