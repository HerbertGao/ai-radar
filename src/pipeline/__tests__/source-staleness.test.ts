/**
 * 按源陈旧度检测单元测试（add-per-source-staleness-alert，任务 4.1 阈值选取 + 4.2 判定逻辑）。
 *
 * 纯函数测试，不触 DB、不触 LLM：
 * - `resolveThreshold`：源在 overrides 里用覆盖值、否则用全局默认；
 * - `judgeStaleSources`（注入 mock 查询结果）：超阈值 / 阈值内 / 结果集缺席(NULL→陈旧) 三态 +
 *   边界（恰好 = now−阈值天数不判陈旧）+ 按源覆盖参与判定 + 多源去重。
 *
 * 检测模块 import 期会评估 env 单例（缺关键变量即 throw），故先注入占位再动态 import
 * （比照 store.integration.test.ts；本套件全程传显式参数、不依赖 env 默认值）。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { judgeStaleSources, resolveThreshold, detectStaleSources, defaultMonitoredSources } =
  await import('../source-staleness.js');
const { env } = await import('../../config/env.js');
const { buildRegistry } = await import('../../collectors/index.js');

const DAY_MS = 86_400_000;

describe('resolveThreshold —— 阈值选取（有覆盖用覆盖、无覆盖用默认）', () => {
  it('源在 overrides 里 → 用其覆盖值', () => {
    expect(resolveThreshold('product_hunt', new Map([['product_hunt', 2]]), 3)).toBe(2);
  });

  it('源不在 overrides → 用全局默认', () => {
    expect(resolveThreshold('arxiv', new Map([['product_hunt', 2]]), 3)).toBe(3);
  });
});

describe('judgeStaleSources —— 判定逻辑（注入 mock 查询结果）', () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS);

  it('超阈值零新增 → 陈旧（带 lastFetched + staleDays）', () => {
    const rows = [{ source: 'a', lastFetched: daysAgo(5) }];
    const stale = judgeStaleSources(rows, ['a'], now, new Map(), 3);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ source: 'a', staleDays: 5 });
    expect(stale[0]!.lastFetched).toEqual(daysAgo(5));
  });

  it('阈值内有新增 → 新鲜（不返回）', () => {
    const rows = [{ source: 'b', lastFetched: daysAgo(1) }];
    expect(judgeStaleSources(rows, ['b'], now, new Map(), 3)).toEqual([]);
  });

  it('结果集缺席（从未产出，NULL）→ 陈旧（staleDays=null）', () => {
    const stale = judgeStaleSources([], ['c'], now, new Map(), 3);
    expect(stale).toEqual([{ source: 'c', lastFetched: null, staleDays: null }]);
  });

  it('边界：恰好 = now − 阈值天数 → 不判陈旧（须严格早于才陈旧）', () => {
    const rows = [{ source: 'a', lastFetched: daysAgo(3) }];
    expect(judgeStaleSources(rows, ['a'], now, new Map(), 3)).toEqual([]);
  });

  it('按源覆盖阈值参与判定：覆盖收紧 → 陈旧；覆盖放宽 → 新鲜', () => {
    const rows = [
      { source: 'ph', lastFetched: daysAgo(3) }, // 覆盖 2 天 → 3>2 陈旧
      { source: 'blog', lastFetched: daysAgo(5) }, // 覆盖 10 天 → 5<10 新鲜
    ];
    const overrides = new Map([
      ['ph', 2],
      ['blog', 10],
    ]);
    const stale = judgeStaleSources(rows, ['ph', 'blog'], now, overrides, 3);
    expect(stale.map((s) => s.source)).toEqual(['ph']);
  });

  it('多源混合 + 重复源去重：只返回陈旧源、无重复', () => {
    const rows = [
      { source: 'fresh', lastFetched: daysAgo(1) },
      { source: 'stale', lastFetched: daysAgo(9) },
    ];
    const stale = judgeStaleSources(
      rows,
      ['fresh', 'stale', 'never', 'stale'],
      now,
      new Map(),
      3,
    );
    expect(stale.map((s) => s.source).sort()).toEqual(['never', 'stale']);
    const staleRow = stale.find((s) => s.source === 'stale')!;
    expect(staleRow.staleDays).toBe(9);
  });
});

/**
 * 任务 4.6：默认待监控源集合取自 collector registry，排除结构性停用源、自动纳入新源。
 *
 * 纯函数 + 桩 dbh（无真实 DB）：
 * - `defaultMonitoredSources` 读 `buildRegistry().map(e=>e.source)`，`RSS_FEEDS`/`BLOGGER_FEEDS`
 *   为空时排除 rss/blogger，非空时纳入（区分「有意停用」与「配了却坏了」）。
 * - `detectStaleSources` **不传 sources** 时走默认源集合，桩 dbh 返回空行集 → 每个已注册无产出源
 *   被自动纳入并判陈旧（不改检测代码即验证自动纳入）。
 */
describe('defaultMonitoredSources / detectStaleSources —— 默认源集合（任务 4.6）', () => {
  const registrySources = [...new Set(buildRegistry().map((e) => e.source))];
  const feed = { url: 'https://example.com/feed', vendor: null };

  /** 桩 dbh：drizzle 链式 select/from/where/groupBy → 解析为给定行集（不触真实库）。 */
  function stubDb(
    rows: { source: string; lastFetched: Date | null }[],
  ): Parameters<typeof detectStaleSources>[1] {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      groupBy: () => Promise.resolve(rows),
    };
    return chain as unknown as Parameters<typeof detectStaleSources>[1];
  }

  it('feeds 为空 → 排除 rss/blogger，其余已注册源保留（= registry 源集减 rss/blogger）', () => {
    const monitored = defaultMonitoredSources({
      ...env,
      RSS_FEEDS: [],
      BLOGGER_FEEDS: [],
    });
    expect(monitored).not.toContain('rss');
    expect(monitored).not.toContain('blogger');
    expect(monitored.sort()).toEqual(
      registrySources.filter((s) => s !== 'rss' && s !== 'blogger').sort(),
    );
    // 无 feeds 开关的源恒纳入（自动纳入锚点，新增 collector 无需改告警代码）。
    expect(monitored).toContain('hacker_news');
  });

  it('feeds 非空 → rss/blogger 纳入监控集（配置非空的已注册源不被误排除）', () => {
    const monitored = defaultMonitoredSources({
      ...env,
      RSS_FEEDS: [feed],
      BLOGGER_FEEDS: [feed],
    });
    expect(monitored).toContain('rss');
    expect(monitored).toContain('blogger');
    expect(monitored.sort()).toEqual(registrySources.sort());
  });

  it('SITEMAP_SOURCES 为空 → 排除 sitemap（与 rss/blogger 对称，防 sitemap 结构性停用后永久误报）', () => {
    // 回归：sitemap 也是 list 驱动源，SITEMAP_SOURCES='' 是受支持的停用动作，collectSitemaps 恒返回 []
    // → max(fetched_at) 恒 NULL → 曾每日永久误报（漏在 rss/blogger 之外）。
    const monitored = defaultMonitoredSources({ ...env, SITEMAP_SOURCES: [] });
    expect(monitored).not.toContain('sitemap');
    expect(monitored).toContain('hacker_news'); // 无空配置开关的源恒纳入。
  });

  it('三个 list 驱动源配置全空 → rss/blogger/sitemap 全排除，其余已注册源保留', () => {
    const monitored = defaultMonitoredSources({
      ...env,
      RSS_FEEDS: [],
      BLOGGER_FEEDS: [],
      SITEMAP_SOURCES: [],
    });
    expect(monitored.sort()).toEqual(
      registrySources
        .filter((s) => !['rss', 'blogger', 'sitemap'].includes(s))
        .sort(),
    );
  });

  it('不传 sources → 走默认源集合；桩返回空行集 → 每个已注册无产出源被纳入并判陈旧', async () => {
    const now = new Date();
    // 空行集 = 所有默认监控源在 raw_items 中零行 → 每个都从未产出 → 陈旧（staleDays=null）。
    const stale = await detectStaleSources({ now }, stubDb([]));
    // 返回的陈旧源集合恰为默认监控源集合（证明「不传 sources」走 defaultMonitoredSources）。
    expect(stale.map((s) => s.source).sort()).toEqual(defaultMonitoredSources().sort());
    // 已注册无产出源被自动纳入并判陈旧（从未产出 → lastFetched/staleDays 均为 null）。
    const hn = stale.find((s) => s.source === 'hacker_news');
    expect(hn).toEqual({ source: 'hacker_news', lastFetched: null, staleDays: null });
  });
});
