/**
 * Show HN 采集器单元测试（source-collectors / design D1–D7，**纯 mock 不触网、不依赖 DB**）。
 *
 * 覆盖不变量：
 * - mapShowHnHit：objectID→sourceItemId、url→url、source='show_hn'、rawType='product'、metadata 透传。
 * - publishedAt 单位 + `>0` 守卫：created_at_i 正数→Date(秒*1000)；0/负/缺失/非数→null（非 1970）。
 * - title 剥 `Show HN` 前缀变体（`:`/`-`/`–`/`—`/大小写）；剥后空回退原 title。
 * - 三归一键全空跳过（经 product-keys 的 extractProductMergeKeys）：url 空/非 http、github.com/owner org 页。
 * - numericFilters 含 created_at_i 下界 + points 阈值两条件且 AND（运算符已编码；逗号字面或 %2C 均可）。
 * - 单源失败（fetchJson 抛错）withRetry 重试后抛出。
 * - 用固化真实 Algolia 响应 fixture 验字段名（objectID/created_at_i/points/url/title）可复现。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let mod: typeof import('../show-hn.js');

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  mod = await import('../show-hn.js');
});

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 用单条 hit 构造 Algolia body 桩。 */
function bodyWith(hits: unknown[]): unknown {
  return { hits };
}

describe('mapShowHnHit 映射统一结构', () => {
  it('完整 hit：source/rawType/sourceItemId/url/publishedAt/metadata 就位', () => {
    const item = mod.mapShowHnHit({
      objectID: '48520360',
      title: 'Show HN: Galdor – a Go LLM agent framework',
      url: 'https://github.com/YasserCR/galdor',
      created_at_i: 1781377449,
      points: 42,
      num_comments: 7,
      author: 'yassros16',
    });
    expect(item.source).toBe('show_hn');
    expect(item.rawType).toBe('product');
    expect(item.sourceItemId).toBe('48520360');
    expect(item.url).toBe('https://github.com/YasserCR/galdor');
    // title 已剥 `Show HN:` 前缀。
    expect(item.title).toBe('Galdor – a Go LLM agent framework');
    // created_at_i 秒 → Date（毫秒）。
    expect(item.publishedAt).toBeInstanceOf(Date);
    expect(item.publishedAt!.getTime()).toBe(1781377449 * 1000);
    // metadata 透传。
    expect(item.metadata?.points).toBe(42);
    expect(item.metadata?.num_comments).toBe(7);
    expect(item.metadata?.author).toBe('yassros16');
    expect(item.metadata?.hn_object_id).toBe('48520360');
  });

  it('objectID 为数字 → sourceItemId 字符串化', () => {
    const item = mod.mapShowHnHit({ objectID: 123, title: 'X', url: 'https://x.com' });
    expect(item.sourceItemId).toBe('123');
  });

  describe('publishedAt 单位 + >0 守卫（防 1970）', () => {
    it('created_at_i 为 0 → null（非 1970）', () => {
      const item = mod.mapShowHnHit({ objectID: '1', title: 'T', url: 'https://a.com', created_at_i: 0 });
      expect(item.publishedAt).toBeNull();
    });
    it('created_at_i 为负 → null', () => {
      const item = mod.mapShowHnHit({ objectID: '1', title: 'T', url: 'https://a.com', created_at_i: -5 });
      expect(item.publishedAt).toBeNull();
    });
    it('created_at_i 缺失 → null', () => {
      const item = mod.mapShowHnHit({ objectID: '1', title: 'T', url: 'https://a.com' });
      expect(item.publishedAt).toBeNull();
    });
    it('created_at_i 非数（NaN/字符串） → null', () => {
      const item = mod.mapShowHnHit({
        objectID: '1',
        title: 'T',
        url: 'https://a.com',
        created_at_i: NaN,
      });
      expect(item.publishedAt).toBeNull();
      const item2 = mod.mapShowHnHit({
        objectID: '1',
        title: 'T',
        url: 'https://a.com',
        created_at_i: '123' as unknown as number,
      });
      expect(item2.publishedAt).toBeNull();
    });
  });

  describe('title 剥 `Show HN` 前缀变体（大小写不敏感）', () => {
    it.each([
      ['Show HN: Cool Tool', 'Cool Tool'],
      ['Show HN - Cool Tool', 'Cool Tool'],
      ['Show HN – Cool Tool', 'Cool Tool'],
      ['Show HN — Cool Tool', 'Cool Tool'],
      ['show hn: lower case', 'lower case'],
      ['SHOW HN: UPPER', 'UPPER'],
      ['Show HN:NoSpace', 'NoSpace'],
    ])('「%s」→「%s」', (raw, expected) => {
      expect(mod.stripShowHnPrefix(raw)).toBe(expected);
    });

    it('剥后为空串 → 回退原 title（NOT NULL 绝不留空）', () => {
      expect(mod.stripShowHnPrefix('Show HN:')).toBe('Show HN:');
      expect(mod.stripShowHnPrefix('Show HN: ')).toBe('Show HN: ');
    });

    it('无前缀 → 原样', () => {
      expect(mod.stripShowHnPrefix('Plain Product')).toBe('Plain Product');
      // 「Show HN」嵌在中间不剥（仅剥前缀）。
      expect(mod.stripShowHnPrefix('A Show HN clone')).toBe('A Show HN clone');
    });
  });
});

describe('collectShowHn 跳过判据（三归一键全空）', () => {
  /** 跑采集，固定 now/桩，断言哪些 objectID 被发射。 */
  async function collectIds(hits: unknown[]): Promise<string[]> {
    const items = await mod.collectShowHn({
      fetchJson: async () => bodyWith(hits),
      logError: () => {},
      now: new Date('2026-06-14T00:00:00Z'),
    });
    return items.map((i) => i.sourceItemId);
  }

  it('url 为 null / 空串 / 缺字段 → 跳过不发射', async () => {
    const ids = await collectIds([
      { objectID: 'null-url', title: 'Show HN: A', url: null },
      { objectID: 'empty-url', title: 'Show HN: B', url: '' },
      { objectID: 'missing-url', title: 'Show HN: C' },
    ]);
    expect(ids).toEqual([]);
  });

  it('非 http URL（mailto / 相对路径）→ 跳过', async () => {
    const ids = await collectIds([
      { objectID: 'mailto', title: 'Show HN: M', url: 'mailto:x@y.com' },
      { objectID: 'relative', title: 'Show HN: R', url: '/relative/path' },
    ]);
    expect(ids).toEqual([]);
  });

  it('github.com/owner org 页（无具体 repo）→ 三键全空跳过', async () => {
    const ids = await collectIds([
      { objectID: 'org-page', title: 'Show HN: Org', url: 'https://github.com/owner' },
    ]);
    expect(ids).toEqual([]);
  });

  it('有 github repo（≥2 段路径）→ 发射（github_repo 非空，github.com 域被 F1 抑制不影响）', async () => {
    const ids = await collectIds([
      { objectID: 'repo', title: 'Show HN: R', url: 'https://github.com/owner/repo' },
    ]);
    expect(ids).toEqual(['repo']);
  });

  it('有普通产品域 → 发射（canonical_domain 非空）', async () => {
    const ids = await collectIds([
      { objectID: 'domain', title: 'Show HN: D', url: 'https://cool.ai/launch' },
    ]);
    expect(ids).toEqual(['domain']);
  });
});

describe('collectShowHn numericFilters 两条件 AND', () => {
  it('查询串含 created_at_i 下界 + points 阈值两条件且 AND 生效（运算符已编码）', async () => {
    let captured = '';
    await mod.collectShowHn({
      fetchJson: async (url) => {
        captured = url;
        return bodyWith([]);
      },
      logError: () => {},
      minPoints: 15,
      windowDays: 3,
      maxPerRun: 25,
      now: new Date('2026-06-14T00:00:00Z'),
    });

    // 裸 `>` 不得出现在 URL（必须编码，否则 Algolia 400）。
    expect(captured).not.toContain('created_at_i>');
    // 解析 numericFilters 参数（URLSearchParams 已解码 %3E→`>`、%2C→`,`）。
    const parsed = new URL(captured);
    expect(parsed.searchParams.get('tags')).toBe('show_hn');
    expect(parsed.searchParams.get('hitsPerPage')).toBe('25');
    const nf = parsed.searchParams.get('numericFilters')!;
    // points 阈值在串内（服务端过滤，非客户端）。
    expect(nf).toContain('points>=15');
    // 时间窗下界：now=2026-06-14T00:00:00Z = 1781308800s，减 3*86400 = 1781049600。
    const lowerBound = Math.floor(new Date('2026-06-14T00:00:00Z').getTime() / 1000) - 3 * 86400;
    expect(nf).toContain(`created_at_i>${lowerBound}`);
    // 两条件以逗号 AND 连接。
    expect(nf.split(',')).toHaveLength(2);
  });
});

describe('collectShowHn 单源失败隔离', () => {
  it('fetchJson 抛错 → withRetry 重试后抛出（整源失败由编排层隔离）', async () => {
    let calls = 0;
    await expect(
      mod.collectShowHn({
        maxAttempts: 3,
        baseDelayMs: 0,
        sleep: async () => {},
        logError: () => {},
        now: new Date('2026-06-14T00:00:00Z'),
        fetchJson: async () => {
          calls += 1;
          throw new Error('Algolia 503');
        },
      }),
    ).rejects.toThrow('Algolia 503');
    expect(calls).toBe(3); // 用满 maxAttempts。
  });
});

describe('固化真实 Algolia 响应 fixture 验字段名', () => {
  it('fixture 经映射：字段名 objectID/created_at_i/points/url/title 可复现', async () => {
    const fixturePath = join(__dirname, 'fixtures', 'show-hn-algolia.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(Array.isArray(fixture.hits)).toBe(true);
    expect(fixture.hits.length).toBeGreaterThan(0);

    // 经真实采集路径（注入 fixture body），不施加 points/时间窗闸（fixture 是无过滤抓的）。
    const items = await mod.collectShowHn({
      fetchJson: async () => fixture,
      logError: () => {},
      now: new Date('2026-06-14T00:00:00Z'),
    });
    // fixture 首条是真实 github repo（YasserCR/galdor）→ 发射，字段名对得上。
    const first = items.find((i) => i.sourceItemId === '48520360');
    expect(first).toBeDefined();
    expect(first!.source).toBe('show_hn');
    expect(first!.rawType).toBe('product');
    expect(first!.url).toBe('https://github.com/YasserCR/galdor');
    expect(first!.publishedAt).toBeInstanceOf(Date);
    // title 剥 `Show HN:` 前缀。
    expect(first!.title.startsWith('Show HN')).toBe(false);
    expect(first!.metadata?.hn_object_id).toBe('48520360');
  });
});
