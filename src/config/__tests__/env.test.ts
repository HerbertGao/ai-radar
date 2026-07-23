/**
 * env 校验单元测试（任务 1.3）。
 *
 * 守住不变量：关键变量缺失时 `parseEnv` 启动即抛错（快速失败），
 * 禁止静默用空值/默认值继续运行。同时验证 P1 新增的数值/比率配置：
 * - 默认值在未提供时生效；
 * - 非法值（NaN / 越界）被拒绝；
 * - RSS_FEEDS 逗号分隔解析为去空白的非空数组。
 *
 * 纯函数测试，不触发 import 期的 `env` 单例校验（直接调用导出的 parseEnv）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// 零依赖叶子模块（静态 import 不触发 env 单例校验）：展开器 = 避整点判据的共享文法。
import { expandCronMinutes } from '../cron-minutes.js';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// env.ts 在 import 期会以 process.env 评估 `env` 单例（缺关键变量即 throw）。
// 本套件只测纯函数 parseEnv，注入占位让 import 期单例校验通过后再动态取 parseEnv，
// 使套件在不完整 shell env 下也能干净运行（占位绝不影响 parseEnv 的入参——它收显式 source）。
let parseEnv: typeof import('../env.js').parseEnv;
let isFeishuEnabled: typeof import('../env.js').isFeishuEnabled;
let alertMinPublishedAt: typeof import('../env.js').alertMinPublishedAt;

beforeAll(async () => {
  // 本地试用该新特性的人若在 shell 里设了引导键，下面的占位块会整体失效、套件在 import 期崩。
  delete process.env.AI_RADAR_ENV_FILE;
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  // 纯净 CI 无 .env 时 import env.js 的单例校验会因缺 PRODUCT_HUNT_TOKEN throw、整套件 import 期崩溃假绿（FIX-C，比照 product-hunt.test.ts）。
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ parseEnv, isFeishuEnabled, alertMinPublishedAt } = await import('../env.js'));
});

/** 一份能通过校验的最小合法 env。各用例在其上做删除/改写。 */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://ai_radar:ai_radar@localhost:5432/ai_radar',
    REDIS_URL: 'redis://localhost:6379',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'openai/gpt-4o-mini',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '123456',
    PRODUCT_HUNT_TOKEN: 'ph-dev-token',
  } as NodeJS.ProcessEnv;
}

describe('parseEnv —— 关键变量缺失快速失败', () => {
  it('完整合法 env 通过校验并填充默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.PUSH_TIMEZONE).toBe('Asia/Shanghai');
    expect(env.TOP_N).toBe(8);
    expect(env.RANK_WEIGHT_IMPORTANCE).toBe(0.45);
    expect(env.RANK_WEIGHT_DEVELOPER_RELEVANCE).toBe(0.25);
    expect(env.RANK_WEIGHT_NOVELTY).toBe(0.2);
    expect(env.RANK_WEIGHT_HYPE_RISK).toBe(0.1);
    expect(env.IMPORTANCE_FLOOR).toBe(60);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.5);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(3);
    expect(env.RSS_FEEDS).toEqual([]);
    expect(env.GITHUB_TOKEN).toBe('');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'PRODUCT_HUNT_TOKEN',
  ])('[场景:缺关键变量时启动即报错] 缺失 %s 时抛错', (key) => {
    const source = validEnv();
    delete source[key];
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('LLM_BASE_URL 缺失时用默认 OpenRouter 端点', () => {
    const env = parseEnv(validEnv());
    expect(env.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('parseEnv —— P1 数值/比率配置校验', () => {
  it('非数字 TOP_N 被拒绝', () => {
    const source = { ...validEnv(), TOP_N: 'not-a-number' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('DEGRADE_ABORT_RATIO 越界（>1）被拒绝', () => {
    const source = { ...validEnv(), DEGRADE_ABORT_RATIO: '1.5' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('IMPORTANCE_FLOOR 越界（>100）被拒绝', () => {
    const source = { ...validEnv(), IMPORTANCE_FLOOR: '200' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('TOP_N 非正数（0）被拒绝', () => {
    const source = { ...validEnv(), TOP_N: '0' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('自定义数值生效', () => {
    const source = {
      ...validEnv(),
      TOP_N: '5',
      IMPORTANCE_FLOOR: '70',
      DEGRADE_ABORT_RATIO: '0.3',
      FIRST_SEEN_WINDOW_DAYS: '7',
      PUSH_TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.TOP_N).toBe(5);
    expect(env.IMPORTANCE_FLOOR).toBe(70);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.3);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(7);
    expect(env.PUSH_TIMEZONE).toBe('UTC');
  });
});

describe('parseEnv —— PUBLISHED_AT_INFERENCE_MAX_PER_RUN 经 envSchema 校验（任务 6.1 / design D4）', () => {
  // 固化「进 zod 校验、非法即启动失败」：证明该配置走 envSchema（coerce + int + positive），
  // 非裸读 process.env（裸读会绕过校验、让非法值静默生效，违反 env 全局不变量）。

  it('未提供时取默认 20', () => {
    const env = parseEnv(validEnv());
    expect(env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe(20);
  });

  it('合法值（"20"）coerce 为 number 20', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '20',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe(20);
    expect(typeof env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe('number');
  });

  it('负数（"-5"）启动即报错（positive 校验，非裸读）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '-5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('NaN（"abc"）启动即报错（number coerce 校验）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: 'abc',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('0 启动即报错（positive，0 不合法）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('小数（"3.5"）启动即报错（int 校验）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '3.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— 飞书可选通道（feishu-push 5.1）', () => {
  it('两者均缺 → 飞书 disabled，纯 Telegram 部署照常启动（向后兼容）', () => {
    const env = parseEnv(validEnv()); // validEnv 不含 FEISHU_*。
    expect(env.FEISHU_WEBHOOK_URL).toBeUndefined();
    expect(env.FEISHU_SIGN_SECRET).toBeUndefined();
    expect(isFeishuEnabled(env)).toBe(false);
  });

  it('两者全配 → enabled', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook/abc',
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(isFeishuEnabled(env)).toBe(true);
  });

  it('仅配 webhook（缺 secret）→ 快速失败', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook/abc',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/FEISHU_SIGN_SECRET/);
  });

  it('仅配 secret（缺 webhook）→ 快速失败', () => {
    const source = {
      ...validEnv(),
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/FEISHU_WEBHOOK_URL/);
  });

  it('webhook 非法 URL → 报错', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'not-a-url',
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— 飞书 cron 默认避整点/半点（feishu-push / p0-alert-lane A1）', () => {
  // 判据主语是【展开集】不是字段字符串：旧字面量判据（字段字符串 ∉ {'0','30'}）对 */15
  // （展开 {0,15,30,45}，同时撞整点与半点）恒绿，正是它漏掉了 ALERT_SCAN_CRON 的违反。

  /** 避整点判据：expandCronMinutes(cron) ∩ {0,30} ≠ ∅ 即违反；展开抛错同计违反（fail-closed）。 */
  function violatesQuietMinutes(cron: string): boolean {
    try {
      const minutes = expandCronMinutes(cron);
      return minutes.has(0) || minutes.has(30);
    } catch {
      return true; // 无法展开 = 违反——绝不静默空集判过（空集 ∩ {0,30} = ∅ 恒判过）。
    }
  }

  it('全部 3 条走飞书发送的定时 cron 默认值：分钟展开集 ∩ {0,30} = ∅（任一违反即失败）', () => {
    const env = parseEnv(validEnv());
    // 覆盖清单 = 全部会触发飞书发送的定时 cron；新增飞书 cron 时 MUST 同步加进本清单
    // （清单是判据唯一的强制手段）。不发飞书的 4 条（MR_EVENT_REVIEW / MR_SCRAPE_HTTP /
    // MR_SCRAPE_BROWSER / MR_STALENESS）不在覆盖面。
    const feishuCrons: Record<string, string> = {
      DAILY_DIGEST_CRON: env.DAILY_DIGEST_CRON, // {3}
      ALERT_SCAN_CRON: env.ALERT_SCAN_CRON, // {4,19,34,49}
      MR_PRICE_CURATION_CRON: env.MR_PRICE_CURATION_CRON, // {53}
    };
    for (const [name, cron] of Object.entries(feishuCrons)) {
      expect(
        violatesQuietMinutes(cron),
        `${name}="${cron}" 的分钟展开集撞整点/半点（或无法展开）`,
      ).toBe(false);
    }
  });

  // 负例断言（A1.5，防判据退回字面量后无人察觉）：这些 cron 的分钟字段字符串都 ∉ {'0','30'}
  // （字面量判据恒放行），但展开集与 {0,30} 有交——判据 MUST 判违反。
  it.each(['*/15 * * * *', '*/20 * * * *', '* * * * *', '0/15 * * * *'])(
    '负例：%s 判违反（字面量判据在此恒绿）',
    (cron) => {
      expect(violatesQuietMinutes(cron)).toBe(true);
    },
  );
});

describe('parseEnv —— RSS_FEEDS 带 vendor 的 feed 配置解析（design D2）', () => {
  it('逗号分隔的 url|vendor 解析为 {url, vendor}[]，去空白', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS:
        ' https://a.example/feed.xml|openai , https://b.example/rss|deepmind ,, ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.RSS_FEEDS).toEqual([
      { url: 'https://a.example/feed.xml', vendor: 'openai' },
      { url: 'https://b.example/rss', vendor: 'deepmind' },
    ]);
  });

  it('空 RSS_FEEDS → 空数组', () => {
    const env = parseEnv({ ...validEnv(), RSS_FEEDS: '' } as NodeJS.ProcessEnv);
    expect(env.RSS_FEEDS).toEqual([]);
  });

  it('url|（尾随空 vendor）→ vendor 取 null，不报错、不阻塞', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://blog.example/feed|',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.RSS_FEEDS).toEqual([
      { url: 'https://blog.example/feed', vendor: null },
    ]);
  });

  it('旧裸 URL 格式（无 |）启动即报错并提示新格式', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://legacy.example/feed.xml',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/url\|vendor/);
  });

  it('混入一条旧裸 URL（其余合法）整体报错', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://a.example/feed|openai,https://legacy.example/feed',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('URL 含 | 字符（条目含多于一个 |）→ 配置错误报错', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://a.example/feed?x=1|2|openai',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/多于一个/);
  });
});

describe('parseEnv —— SITEMAP_SOURCES 解析（add-tier1-ai-sources / design D3，FIX-6）', () => {
  it('合法 3 段（url|pathPrefix|vendor）解析为 {sitemapUrl, pathPrefix, vendor}', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES:
        ' https://www.anthropic.com/sitemap.xml|/news/|anthropic , https://lab-b.example.com/sitemap.xml|/blog/|lab_b ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.SITEMAP_SOURCES).toEqual([
      {
        sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
        pathPrefix: '/news/',
        vendor: 'anthropic',
      },
      {
        sitemapUrl: 'https://lab-b.example.com/sitemap.xml',
        pathPrefix: '/blog/',
        vendor: 'lab_b',
      },
    ]);
  });

  it('空字符串 → 空数组（该源不采）', () => {
    const env = parseEnv({ ...validEnv(), SITEMAP_SOURCES: '' } as NodeJS.ProcessEnv);
    expect(env.SITEMAP_SOURCES).toEqual([]);
  });

  it('缺省（未设置）→ 默认含 Anthropic News 一条', () => {
    const env = parseEnv(validEnv()); // validEnv 不含 SITEMAP_SOURCES。
    expect(env.SITEMAP_SOURCES).toEqual([
      {
        sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
        pathPrefix: '/news/',
        vendor: 'anthropic',
      },
    ]);
  });

  it('2 段（缺 vendor、| 不足 2 个）→ 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml|/news/',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('含空段（中间段为空）→ 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml||anthropic',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('pathPrefix 不以 / 开头 → 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml|news/|anthropic',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— P3 语义去重 + 知识库 embedding 配置（add-semantic-dedup-and-store-hardening，任务 7.1）', () => {
  it('未提供时取默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(env.EMBEDDING_TEXT_MAX_CHARS).toBe(2000);
    expect(env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN).toBe(500);
    expect(env.SEMANTIC_DEDUP_HIGH).toBe(0.88);
    expect(env.SEMANTIC_DEDUP_LLM).toBe(0.82);
    expect(env.SEMANTIC_WINDOW_DAYS).toBe(14);
  });

  it('自定义合法值生效', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_TEXT_MAX_CHARS: '4000',
      EMBEDDING_BOOTSTRAP_MAX_PER_RUN: '200',
      SEMANTIC_DEDUP_HIGH: '0.9',
      SEMANTIC_DEDUP_LLM: '0.8',
      SEMANTIC_WINDOW_DAYS: '7',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(env.EMBEDDING_TEXT_MAX_CHARS).toBe(4000);
    expect(env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN).toBe(200);
    expect(env.SEMANTIC_DEDUP_HIGH).toBe(0.9);
    expect(env.SEMANTIC_DEDUP_LLM).toBe(0.8);
    expect(env.SEMANTIC_WINDOW_DAYS).toBe(7);
  });

  it('EMBEDDING_TEXT_MAX_CHARS 非正（"0"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_TEXT_MAX_CHARS: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EMBEDDING_BOOTSTRAP_MAX_PER_RUN 非整（"1.5"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_BOOTSTRAP_MAX_PER_RUN: '1.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('SEMANTIC_DEDUP_HIGH 越界（>1）→ 报错', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '1.2',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('SEMANTIC_WINDOW_DAYS 负数（"-1"）→ 报错', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_WINDOW_DAYS: '-1',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('阈值倒挂（LLM >= HIGH）→ 快速失败（superRefine 跨字段校验）', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '0.8',
      SEMANTIC_DEDUP_LLM: '0.85',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/SEMANTIC_DEDUP_LLM/);
  });

  it('阈值相等（LLM == HIGH）→ 快速失败（灰区为空）', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '0.85',
      SEMANTIC_DEDUP_LLM: '0.85',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— BLOGGER_FEEDS / EXPERIENCE_TEXT_MAX_CHARS（add-ai-blogger-experience-mining，任务 1.3）', () => {
  it('BLOGGER_FEEDS 复用 url|vendor 解析为 {url, vendor}[]，去空白', () => {
    const source = {
      ...validEnv(),
      BLOGGER_FEEDS:
        ' https://blog.example/feed|simonw , https://www.youtube.com/feeds/videos.xml?channel_id=UCxx| ,, ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.BLOGGER_FEEDS).toEqual([
      { url: 'https://blog.example/feed', vendor: 'simonw' },
      {
        url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxx',
        vendor: null,
      },
    ]);
  });

  it('空 BLOGGER_FEEDS → 空数组', () => {
    const env = parseEnv({ ...validEnv(), BLOGGER_FEEDS: '' } as NodeJS.ProcessEnv);
    expect(env.BLOGGER_FEEDS).toEqual([]);
  });

  it('缺省（未设置）BLOGGER_FEEDS → 空数组', () => {
    const env = parseEnv(validEnv()); // validEnv 不含 BLOGGER_FEEDS。
    expect(env.BLOGGER_FEEDS).toEqual([]);
  });

  it('BLOGGER_FEEDS 旧裸 URL 格式（无 |）启动即报错', () => {
    const source = {
      ...validEnv(),
      BLOGGER_FEEDS: 'https://legacy.example/feed.xml',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EXPERIENCE_TEXT_MAX_CHARS 缺省 → 默认 2000（镜像 EMBEDDING_TEXT_MAX_CHARS）', () => {
    const env = parseEnv(validEnv());
    expect(env.EXPERIENCE_TEXT_MAX_CHARS).toBe(2000);
  });

  it('EXPERIENCE_TEXT_MAX_CHARS 自定义合法值（"4000"）生效', () => {
    const source = {
      ...validEnv(),
      EXPERIENCE_TEXT_MAX_CHARS: '4000',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.EXPERIENCE_TEXT_MAX_CHARS).toBe(4000);
    expect(typeof env.EXPERIENCE_TEXT_MAX_CHARS).toBe('number');
  });

  it('EXPERIENCE_TEXT_MAX_CHARS 非正（"0"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EXPERIENCE_TEXT_MAX_CHARS: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EXPERIENCE_TEXT_MAX_CHARS 负数（"-1"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EXPERIENCE_TEXT_MAX_CHARS: '-1',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EXPERIENCE_TEXT_MAX_CHARS 非整（"3.5"）→ 报错（int 校验）', () => {
    const source = {
      ...validEnv(),
      EXPERIENCE_TEXT_MAX_CHARS: '3.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EXPERIENCE_TEXT_MAX_CHARS NaN（"abc"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EXPERIENCE_TEXT_MAX_CHARS: 'abc',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— HF_PAPERS_MAX_PER_RUN 校验（add-tier1-ai-sources，FIX-6）', () => {
  it('合法值（"30"）coerce 为 number 30', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '30',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.HF_PAPERS_MAX_PER_RUN).toBe(30);
    expect(typeof env.HF_PAPERS_MAX_PER_RUN).toBe('number');
  });

  it('缺省 → 默认 50', () => {
    const env = parseEnv(validEnv());
    expect(env.HF_PAPERS_MAX_PER_RUN).toBe(50);
  });

  it('非正（"0"）→ 报错（positive 校验）', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('负数（"-1"）→ 报错', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '-1',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('非整（"3.5"）→ 报错（int 校验）', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '3.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— 按源陈旧度告警配置（add-per-source-staleness-alert，任务 4.1）', () => {
  // 覆盖串解析**有意不 fail-fast**（advisory 配置）：坏项跳过并记日志、绝不使 parseEnv 抛错。
  // 用 vi.spyOn 静默 console.warn（避免测试输出噪音），必要处断言跳过发生。
  // afterAll 恢复：否则 spy 泄漏到同文件后续 suite，静默其真实告警。
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('SOURCE_STALENESS_ALERT_DAYS 缺省 → 默认 3', () => {
    const env = parseEnv(validEnv());
    expect(env.SOURCE_STALENESS_ALERT_DAYS).toBe(3);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES).toBeInstanceOf(Map);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.size).toBe(0);
  });

  it('SOURCE_STALENESS_ALERT_DAYS 非正（"0"）/ 负 / 非整 → 报错（fail-fast，与覆盖串相反）', () => {
    for (const bad of ['0', '-1', '3.5', 'abc']) {
      const source = {
        ...validEnv(),
        SOURCE_STALENESS_ALERT_DAYS: bad,
      } as NodeJS.ProcessEnv;
      expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    }
  });

  it('正常覆盖串解析为 Map<source, days>', () => {
    const env = parseEnv({
      ...validEnv(),
      SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: ' product_hunt:2 , blogger:7 ',
    } as NodeJS.ProcessEnv);
    const overrides = env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES;
    expect([...overrides.entries()]).toEqual([
      ['product_hunt', 2],
      ['blogger', 7],
    ]);
  });

  it('非正整数天数（blogger:0 / blogger:-1 / blogger:abc / blogger:2.5）被跳过', () => {
    for (const bad of ['blogger:0', 'blogger:-1', 'blogger:abc', 'blogger:2.5']) {
      const env = parseEnv({
        ...validEnv(),
        SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: bad,
      } as NodeJS.ProcessEnv);
      // 坏项被跳过 → blogger 无覆盖 → Map 为空（回退全局默认由检测层处理）。
      expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.has('blogger')).toBe(false);
      expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.size).toBe(0);
    }
  });

  it('未知源名（拼写错误 blooger:7）被跳过并记日志（skip+log 的 log 半边）', () => {
    warnSpy.mockClear();
    const env = parseEnv({
      ...validEnv(),
      SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: 'blooger:7',
    } as NodeJS.ProcessEnv);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.size).toBe(0);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.has('blogger')).toBe(false);
    // skip+log 的「log」半边：误配项（非纯空串）必须记日志（提示运营发现），非静默丢弃。
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('blooger')),
    ).toBe(true);
  });

  it('缺段 / 空串项（"blogger" / ":7" / "blogger:" / 空项）被跳过', () => {
    const env = parseEnv({
      ...validEnv(),
      SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: 'blogger,:7,blogger:,, ,arxiv:4',
    } as NodeJS.ProcessEnv);
    // 仅合法项 arxiv:4 留存。
    expect([...env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.entries()]).toEqual([
      ['arxiv', 4],
    ]);
  });

  it('同源多次 last-wins（blogger:7,blogger:2 → 2）', () => {
    const env = parseEnv({
      ...validEnv(),
      SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: 'blogger:7,blogger:2',
    } as NodeJS.ProcessEnv);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.get('blogger')).toBe(2);
  });

  it('空值 → 空 Map', () => {
    const env = parseEnv({
      ...validEnv(),
      SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: '',
    } as NodeJS.ProcessEnv);
    expect(env.SOURCE_STALENESS_ALERT_DAYS_OVERRIDES.size).toBe(0);
  });
});

describe('parseEnv —— 首次启用发布时间基线水位 fail-fast（add-high-freq-p0-push，任务 6.4）', () => {
  // 跨字段不变量：ALERT_SCAN_ENABLED='true' 但 ALERT_MIN_PUBLISHED_AT **未设**（既非 ISO 亦非显式空串
  // opt-out）→ superRefine fail-fast，防「启用却忘设基线 → 存量 P0 刷屏」（守 policy-push-timeliness）。
  // 三态可分：未设(undefined) / 显式空串('') opt-out / 合法 ISO；非法 ISO 由 .datetime() 拒。

  it('启用告警 + 基线未设 → 抛错（superRefine 跨字段 fail-fast，报错含字段名）', () => {
    const source = { ...validEnv(), ALERT_SCAN_ENABLED: 'true' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/ALERT_MIN_PUBLISHED_AT/);
  });

  it('启用告警 + 合法 ISO 基线 → 通过', () => {
    const source = {
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: '2026-07-11T00:00:00.000Z',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.ALERT_SCAN_ENABLED).toBe('true');
    expect(env.ALERT_MIN_PUBLISHED_AT).toBe('2026-07-11T00:00:00.000Z');
  });

  it('启用告警 + 显式空串基线 → 通过（明示放弃基线 opt-out，与 undefined 三态可分）', () => {
    const source = {
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: '',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.ALERT_MIN_PUBLISHED_AT).toBe(''); // 空串（opt-out），非 undefined。
  });

  it('启用告警 + 非法 ISO 基线（"not-a-date"）→ 抛错（.datetime() 校验，不静默匹配空）', () => {
    const source = {
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: 'not-a-date',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('禁用告警 + 基线未设 → 通过（默认关部署照常启动，不触发 fail-fast）', () => {
    const source = { ...validEnv(), ALERT_SCAN_ENABLED: 'false' } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.ALERT_SCAN_ENABLED).toBe('false');
    expect(env.ALERT_MIN_PUBLISHED_AT).toBeUndefined();
  });

  // alertMinPublishedAt() 三态合并（env 三态 → 查询谓词的 Date|null 水位）：未设/空串 opt-out 都无水位，
  // 仅合法 ISO 出 Date——这是「三态 env」与「候选查询 published_at>=基线 谓词」之间的接缝，集成测用
  // 显式 Date/null 绕过它，故此处直测合并逻辑。
  it('alertMinPublishedAt：ISO → Date，未设/空串 opt-out → null', () => {
    const iso = '2026-07-11T00:00:00.000Z';
    const withIso = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: iso,
    } as NodeJS.ProcessEnv);
    expect(alertMinPublishedAt(withIso)).toEqual(new Date(iso));

    const optOut = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: '',
    } as NodeJS.ProcessEnv);
    expect(alertMinPublishedAt(optOut)).toBeNull(); // 显式空串 opt-out → 无水位。

    const unset = parseEnv({ ...validEnv(), ALERT_SCAN_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(alertMinPublishedAt(unset)).toBeNull(); // undefined（未设）→ 无水位。
  });
});

describe('parseEnv —— 不支持组合 fail-fast：启用告警 × 窗口=0 × 基线空串（p0-alert-lane A4）', () => {
  // 跨字段不变量（不新增 env）：ALERT_SCAN_ENABLED='true' ∧ ALERT_FIRST_SEEN_WINDOW_DAYS=0（旁路
  // 时效下界）∧ ALERT_MIN_PUBLISHED_AT=''（显式 opt-out 基线水位）→ 候选谓词只剩「published_at 非
  // NULL 且 <= now」，告警候选域扩成全表历史 → superRefine 启动期拒绝（守 policy-push-timeliness）。

  it('三元组合同时成立 → 抛错（superRefine fail-fast，报错含字段名）', () => {
    const source = {
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_FIRST_SEEN_WINDOW_DAYS: '0',
      ALERT_MIN_PUBLISHED_AT: '',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/ALERT_FIRST_SEEN_WINDOW_DAYS/);
  });

  it('窗口 > 0（其余同组合）→ 正常加载（时效下界仍在，候选域有界）', () => {
    const env = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_FIRST_SEEN_WINDOW_DAYS: '3',
      ALERT_MIN_PUBLISHED_AT: '',
    } as NodeJS.ProcessEnv);
    expect(env.ALERT_FIRST_SEEN_WINDOW_DAYS).toBe(3);
  });

  it('基线为合法 ISO（其余同组合）→ 正常加载（水位挡住历史存量）', () => {
    const env = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_FIRST_SEEN_WINDOW_DAYS: '0',
      ALERT_MIN_PUBLISHED_AT: '2026-07-11T00:00:00.000Z',
    } as NodeJS.ProcessEnv);
    expect(env.ALERT_FIRST_SEEN_WINDOW_DAYS).toBe(0);
    expect(env.ALERT_MIN_PUBLISHED_AT).toBe('2026-07-11T00:00:00.000Z');
  });

  it('车道关（ALERT_SCAN_ENABLED=false，其余同组合）→ 正常加载（纯日报部署不受此闸约束）', () => {
    const env = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'false',
      ALERT_FIRST_SEEN_WINDOW_DAYS: '0',
      ALERT_MIN_PUBLISHED_AT: '',
    } as NodeJS.ProcessEnv);
    expect(env.ALERT_SCAN_ENABLED).toBe('false');
  });
});

describe('parseEnv —— 告警侧判分预算 N × (F + A×L + W) < cron 周期（p0-alert-lane A5.1c）', () => {
  // N = ALERT_JUDGE_MAX_PER_RUN(3) 是 env.ts 模块常量；F/L/W/cron 周期四项是 env ⇒ 约束必须落
  // superRefine（散文约束在生产上调 LLM_TIMEOUT_MS 或调密 cron 时静默失效）。合取门 =
  // ALERT_SCAN_ENABLED='true'（纯日报部署不受此约束拒启）。cron 周期 = expandCronMinutes 展开
  // 分钟集在 mod-60 环上的最小相邻间隔（单元素 ⇒ 环绕 60min）。

  /** 车道开的最小合法组合（基线水位必设 ISO，否则先撞 ALERT_MIN_PUBLISHED_AT 的 superRefine）。 */
  const laneOn = (): NodeJS.ProcessEnv =>
    ({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'true',
      ALERT_MIN_PUBLISHED_AT: '2026-07-11T00:00:00.000Z',
    }) as NodeJS.ProcessEnv;

  it('默认值组合（N=3、F=15s、A×L=180s、W=60s、周期 15min：765s < 900s）→ 正常加载', () => {
    const env = parseEnv(laneOn());
    expect(env.ALERT_SCAN_CRON).toBe('4-59/15 * * * *'); // 展开 {4,19,34,49} ⇒ 周期 15min。
  });

  it('调高 LLM_TIMEOUT_MS 使不等式不成立 → 抛错，且错误消息报出五项当前值', () => {
    // 3 × (15s + 3×300s + 60s) = 2925s ≥ 900s（15min 周期）→ fail-fast。
    // JUDGE_CLAIM_RECLAIM_MS 同步调高（> F+A×L+W = 975s），隔离出本条 superRefine（而非 T 阈值先红）。
    const source = {
      ...laneOn(),
      LLM_TIMEOUT_MS: '300000',
      JUDGE_CLAIM_RECLAIM_MS: '2000000',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    // 五项当前值（N / F / A×L / W / cron 周期）都在消息里——否则运维拿到一条不可行动的报错。
    expect(() => parseEnv(source)).toThrow(/ALERT_JUDGE_MAX_PER_RUN\(3\)/);
    expect(() => parseEnv(source)).toThrow(/COLLECTOR_FETCH_TIMEOUT_MS\(15000ms\)/);
    expect(() => parseEnv(source)).toThrow(/LLM_TIMEOUT_MS\(300000ms\)/);
    expect(() => parseEnv(source)).toThrow(/JUDGE_WRITE_BUDGET_MS\(60000ms\)/);
    expect(() => parseEnv(source)).toThrow(/cron 周期=900000ms/);
  });

  it('cron 调密（*/3，周期 3min < 单条最坏 255s×3）→ 抛错（生产调密 cron 时约束不静默失效）', () => {
    const source = { ...laneOn(), ALERT_SCAN_CRON: '*/3 * * * *' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/ALERT_SCAN_CRON/);
  });

  it('单元素分钟集（"9 * * * *"）⇒ 周期取 mod-60 环绕 60min → 正常加载', () => {
    const env = parseEnv({ ...laneOn(), ALERT_SCAN_CRON: '9 * * * *' } as NodeJS.ProcessEnv);
    expect(env.ALERT_SCAN_CRON).toBe('9 * * * *');
  });

  it('展开器对非法 cron 抛错 → superRefine 同样 fail-fast（fail-closed，绝不静默跳过校验）', () => {
    const source = { ...laneOn(), ALERT_SCAN_CRON: 'x * * * *' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/无法展开/);
  });

  it('车道关（ALERT_SCAN_ENABLED=false）+ 高 LLM_TIMEOUT_MS → 正常加载（合取门：纯日报部署不受此约束拒启）', () => {
    const env = parseEnv({
      ...validEnv(),
      ALERT_SCAN_ENABLED: 'false',
      LLM_TIMEOUT_MS: '300000',
      JUDGE_CLAIM_RECLAIM_MS: '2000000',
    } as NodeJS.ProcessEnv);
    expect(env.LLM_TIMEOUT_MS).toBe(300000);
  });
});

describe('parseEnv —— claim 回收阈值 T > F + A×L + W（unify-judge-stage）', () => {
  // 补全折进判分入口后 T 的下界 = COLLECTOR_FETCH_TIMEOUT_MS(15000) + JUDGE_MAX_ATTEMPTS(3)×
  // LLM_TIMEOUT_MS(60000) + JUDGE_WRITE_BUDGET_MS(60000) = 255000（validEnv 全默认）。
  it('T = F+A×L+W（相等，非严格 >）→ 启动 fail-fast', () => {
    const source = { ...validEnv(), JUDGE_CLAIM_RECLAIM_MS: '255000' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('T = 180000（旧默认，不满足真实下界）→ 启动 fail-fast（本次修的 bug 的回归钉）', () => {
    const source = { ...validEnv(), JUDGE_CLAIM_RECLAIM_MS: '180000' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('T = 300000（新默认）→ 通过', () => {
    const env = parseEnv({ ...validEnv(), JUDGE_CLAIM_RECLAIM_MS: '300000' } as NodeJS.ProcessEnv);
    expect(env.JUDGE_CLAIM_RECLAIM_MS).toBe(300000);
  });

  it('未显式设置 → 默认 300000、通过', () => {
    const env = parseEnv(validEnv());
    expect(env.JUDGE_CLAIM_RECLAIM_MS).toBe(300000);
  });
});

/**
 * 自有 env 文件来源（add-env-file-overlay）。
 *
 * 两条路都要走：纯函数压 `loadEnvFile` / `resolveEnvSource`；**装配期行为压子进程**——
 * 顶层 dotenv 的条件化只在 import 期发生，而 `vi.resetModules()` 不复位外部化 CJS 的副作用，
 * 「换 DOTENV_CONFIG_PATH 再重载」对忠实实现不可达（写出来只会是假绿）。
 */
describe('自有 env 文件来源 —— 纯函数', () => {
  let loadEnvFile: typeof import('../env.js').loadEnvFile;
  let resolveEnvSource: typeof import('../env.js').resolveEnvSource;
  let dir: string;

  beforeAll(async () => {
    ({ loadEnvFile, resolveEnvSource } = await import('../env.js'));
    dir = mkdtempSync(join(tmpdir(), 'env-file-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('[场景:引导键必须是绝对路径] 相对路径 → 抛错且信息含「绝对路径」', () => {
    expect(() => loadEnvFile('relative/.env')).toThrow(/绝对路径/);
  });

  it('[场景:引导键指向的文件不存在时启动即失败] 文件不存在 → 抛出【包装过的】错误且含该路径', () => {
    const missing = join(dir, 'nope.env');
    // 断包装文案而不是路径正则，一箭三雕：
    // ① 钉住 loadEnvFile 的 try/catch —— 删掉整块、或改成 `catch { return {} }`（读失败当空文件
    //    继续）都会让这条红；此前这两个变异都能全绿通过，那整块生产代码是零覆盖的。
    // ② toThrow(string) 本就是子串匹配，不必 new RegExp(路径)——后者在 tmpdir 含 + ( [ 时会误红
    //    （macOS /var/folders 那段是 base64 派生，确会出现 +）。
    expect(() => loadEnvFile(missing)).toThrow(/AI_RADAR_ENV_FILE 指向的文件无法读取/);
    expect(() => loadEnvFile(missing)).toThrow(missing);
  });

  it('[场景:引导键指向符号链接时跟随到目标文件] 软链指普通文件 → 读到目标内容', () => {
    const target = join(dir, 'link-target.env');
    const link = join(dir, 'link.env');
    writeFileSync(target, 'DATABASE_URL=postgres://via-symlink/db\n');
    symlinkSync(target, link);
    // 跟随语义：lstatSync 会判 isFile()===false，从而拒掉每一个 k8s/docker secret 挂载。
    expect(loadEnvFile(link)).toEqual({ DATABASE_URL: 'postgres://via-symlink/db' });
  });

  it('[场景:自有文件缺必填键时启动即失败，而不是回落共享环境] 文件缺 DATABASE_URL 而 procEnv 有 → 抛错并指明该键', () => {
    const f = join(dir, 'missing-db.env');
    const { DATABASE_URL: _omit, ...rest } = validEnv();
    writeFileSync(f, Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    // procEnv 备齐【全部】必填键：任何「文件缺某键就从 procEnv 补」的实现都会让它通过而漏红。
    expect(() => parseEnv(resolveEnvSource(f, validEnv()))).toThrow(/DATABASE_URL/);
  });

  it('[场景:读取自有文件不污染共享环境] 读文件前后 process.env 逐键不变', () => {
    const f = join(dir, 'a.env');
    writeFileSync(f, 'SOME_KEY_XYZ=v\n');
    // 比对摘要而不是原文：点燃这条断言的正是「有人让 loadEnvFile 写了 process.env」，
    // 而此刻 process.env 里有真 .env（套件 beforeAll 已 import 过 env.ts）。仓库是 public，
    // 失败输出常被贴进 PR / issue，整串打印等于泄漏 LLM_API_KEY / BOT_TOKEN / 带口令的 DSN。
    const digest = () => createHash('sha256').update(JSON.stringify(process.env)).digest('hex');
    const before = digest();
    expect(loadEnvFile(f)).toEqual({ SOME_KEY_XYZ: 'v' });
    expect(digest()).toBe(before);
  });

  it('[场景:设了引导键时只读自有文件，不继承共享环境] 返回的【就是】文件内容，与 procEnv 无任何叠加', () => {
    const f = join(dir, 'b.env');
    writeFileSync(f, 'DATABASE_URL=postgres://own/db\n');
    // 深度相等，不是「不含某个键」——后者挡不住选择性叠加。
    expect(resolveEnvSource(f, { LLM_BASE_URL: 'sibling', PATH: '/x' })).toEqual(loadEnvFile(f));
  });

  it('[场景:空值的引导键等同未设] boot 为 undefined 时原样返回传入的 procEnv', () => {
    const procEnv = { A: '1' } as NodeJS.ProcessEnv;
    expect(resolveEnvSource(undefined, procEnv)).toBe(procEnv);
  });
});

/**
 * 自有 env 文件来源 —— 装配期（子进程）。
 *
 * 形态钉死：直接跑 `node_modules/.bin/tsx`，**不用 `npx`**——从临时 cwd 解析不到 tsx 会转去
 * registry 安装（联网、慢，且自己往 stdout 打字，会打掉下面的 stdout 断言）。
 * `tsx -e` 走 cjs、**不支持顶层 await**，故探针一律用 `.then()`。
 * 断言载荷走 **stderr**，stdout 留给「必须洁净」那条。
 */
describe('自有 env 文件来源 —— 装配期（子进程）', () => {
  const repoRoot = join(__dirname, '..', '..', '..');
  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const envTs = join(repoRoot, 'src', 'config', 'env.ts');
  /** 自足 fixture：7 个必填键 + 满足全部跨字段 superRefine。 */
  const SELF_SUFFICIENT = [
    'DATABASE_URL=postgres://own:own@own-host:5432/own',
    'REDIS_URL=redis://own-host:6379',
    'LLM_API_KEY=own-key',
    'LLM_MODEL=own/model',
    'TELEGRAM_BOT_TOKEN=111:own',
    'TELEGRAM_CHAT_ID=-100111',
    'PRODUCT_HUNT_TOKEN=own-ph',
  ].join('\n');

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-boot-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function probe(cwd: string, env: NodeJS.ProcessEnv, expr: string) {
    const script = `import(${JSON.stringify(envTs)}).then(m => { process.stderr.write(String(${expr})); }).catch(e => { process.stderr.write('THREW:' + e.message); process.exitCode = 1; });`;
    return spawnSync(tsx, ['-e', script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, VITEST: '1', ...env },
      encoding: 'utf8',
      // spawnSync 阻塞事件循环，vitest 的 it(…, 60_000) 抢占不了它——防挂死必须落在这里。
      // VITEST 上面一并注入：将来 env.ts 若长出带出口副作用的 import，子进程不会以生产态跑。
      timeout: 30_000,
    });
  }

  it('[场景:设了引导键时不加载工作目录 `.env`] 端到端：唯一来源 + cwd .env 未被灌入', () => {
    const own = join(dir, 'own.env');
    writeFileSync(own, SELF_SUFFICIENT + '\n');
    // cwd 必须有一份带 sentinel 的 .env：没有它，删掉 `if (!bootPath)` 也无可观测差异，
    // 「设了引导键就不加载 cwd .env」这条就没有任何机械证明。
    const sub = mkdtempSync(join(dir, 'set-'));
    writeFileSync(join(sub, '.env'), 'CWD_DOTENV_SENTINEL=leaked\n');
    // 兄弟值放进【子进程自己的 process.env】。放 cwd .env 是无效的判别点——
    // 设了引导键时 dotenv 根本不跑，那些值本就进不来，断言会结构上不可能红。
    const r = probe(sub, {
      AI_RADAR_ENV_FILE: own,
      LLM_BASE_URL: 'https://SIBLING.example/v1',
      DATABASE_URL: 'postgres://SIBLING/db',
    }, `m.env.LLM_BASE_URL + '|' + m.env.DATABASE_URL + '|' + (process.env.LLM_MODEL === 'own/model') + '|' + (process.env.CWD_DOTENV_SENTINEL ?? 'absent')`);

    expect(r.status).toBe(0);
    const [baseUrl, dbUrl, polluted, sentinel] = r.stderr.split('|');
    expect(baseUrl).toBe('https://openrouter.ai/api/v1'); // schema 默认，不是兄弟值
    expect(dbUrl).toBe('postgres://own:own@own-host:5432/own'); // 文件里那份
    expect(polluted).toBe('false'); // process.env 未被写入文件里的键
    expect(sentinel).toBe('absent'); // 顶层 dotenv 未跑 ⇒ cwd .env 未被灌进共享环境
  }, 60_000);

  it('[场景:引导键指向非普通文件时在读取之前失败] FIFO → 有界失败，不是挂死', () => {
    // FIFO 而非目录：目录会被 readFileSync 自己以 EISDIR 抛掉，删了 statSync 守卫也照绿。
    // 但 FIFO 无写端时 readFileSync 会**同步永久阻塞**，而 vitest 的 it(…, 60_000) 是定时器、
    // 抢占不了同步 syscall——这条若留在同进程里，删守卫的后果不是变红，是 runner 无声挂到 CI
    // job 超时、reporter 不指认任何用例、afterAll 不跑（本轮 review 真实发生过一次）。
    // 故必须走 probe()：挂死被 spawnSync 的 timeout 收敛成 30s 内的红。
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const r = probe(dir, { AI_RADAR_ENV_FILE: fifo }, `m.env.DATABASE_URL`);

    expect(r.signal).toBeNull(); // 被 timeout 杀掉 ⇒ 守卫没拦住 ⇒ 红
    expect(r.stderr).toContain('普通文件');
    expect(r.status).not.toBe(0);
  }, 60_000);

  it('[场景:未设引导键时行为与本变更前一致] 加载 cwd .env，进程环境仍优先，且 stdout 洁净', () => {
    const sub = mkdtempSync(join(dir, 'unset-'));
    writeFileSync(join(sub, '.env'), SELF_SUFFICIENT + '\nLLM_BASE_URL=https://from-cwd.example/v1\n');
    // 场景承诺的是「取值来源【与优先级】不变」。只断言「.env 的值读到了」证不到优先级那半：
    // 改成 dotenv.config({ override: true, quiet: true }) 时 banner 照样抑制、值照样读到，全绿。
    // 优先级反了的生产后果是真的：compose 的 environment: 覆盖层会被 .env 里的 localhost 顶掉。
    const r = probe(sub, { LLM_BASE_URL: 'https://from-proc.example/v1' },
      `m.env.LLM_BASE_URL + '|' + m.env.DATABASE_URL`);

    expect(r.status).toBe(0);
    const [baseUrl, dbUrl] = r.stderr.split('|');
    expect(baseUrl).toBe('https://from-proc.example/v1'); // 进程环境赢（dotenv 不覆盖已存在键）
    expect(dbUrl).toBe('postgres://own:own@own-host:5432/own'); // cwd .env 确实被加载了
    expect(r.stdout).toBe(''); // 裸调 dotenv.config() 会在此处打 banner ⇒ 必红
  }, 60_000);

  it('[场景:引导键只认进程环境，写在 `.env` 里无效] 走「未设」路径，不出现半生效态', () => {
    const sub = mkdtempSync(join(dir, 'viadotenv-'));
    const own = join(dir, 'own.env');
    writeFileSync(own, SELF_SUFFICIENT + '\n');
    writeFileSync(
      join(sub, '.env'),
      SELF_SUFFICIENT.replace('postgres://own:own@own-host:5432/own', 'postgres://cwd/db') +
        `\nAI_RADAR_ENV_FILE=${own}\n`,
    );
    const r = probe(sub, {}, `m.env.DATABASE_URL`);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('postgres://cwd/db'); // 取 cwd .env，未切到 own.env
  }, 60_000);

  it('[场景:空值的引导键等同未设] 纯空白 → 走未设路径', () => {
    const sub = mkdtempSync(join(dir, 'blank-'));
    writeFileSync(join(sub, '.env'), SELF_SUFFICIENT + '\n');
    const r = probe(sub, { AI_RADAR_ENV_FILE: '   ' }, `m.env.DATABASE_URL`);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('postgres://own:own@own-host:5432/own');
  }, 60_000);

  it('[场景:被进程内托管时，配置不合法只让本应用失败] 加载失败 → 非零退出，不回落共享环境', () => {
    const r = probe(dir, {
      AI_RADAR_ENV_FILE: join(dir, 'missing.env'),
      DATABASE_URL: 'postgres://SIBLING/db',
      REDIS_URL: 'redis://s:6379', LLM_API_KEY: 'k', LLM_MODEL: 'm',
      TELEGRAM_BOT_TOKEN: '1:1', TELEGRAM_CHAT_ID: '-1', PRODUCT_HUNT_TOKEN: 'p',
    }, `m.env.DATABASE_URL`);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('THREW');
  }, 60_000);

  it('[场景:被进程内托管时，配置不合法只让本应用失败] 配置加载路径不得出现 process.exit', () => {
    const src = readFileSync(envTs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/process\s*\.\s*exit/);
  });
});

/**
 * 元用例：spec 的 `#### 场景:` 表 ↔ 本文件用例标题里的 `[场景:X]` 标签，双向覆盖。
 *
 * 存在的理由：此前每一条承重性质都要等某个 reviewer 单独指着它才获得机械证明，而下一轮总能再点出
 * 没被点过的——判据「不存在能逃逸的变异」是无界的、永不满足。换成「spec 的场景表」后判据有界可数。
 *
 * **它证明的是标签存在，不是用例会红**：静态文本检查够不到后者（掏空成 `expect(1).toBe(1)` 照绿）。
 * 变异测试因此降级为编写手法，不再是通过条件。下面那条 `.skip` 断言补的是唯一能整块归零覆盖的洞。
 *
 * 约束：场景标签必须住在**本文件**（`bound` 只扫 `__filename`）。加了 scenario 没写用例 ⇒ 红；
 * 写了用例而 scenario 里没有 ⇒ 也红（逼「只活在代码注释里的承诺」要么进 scenario、要么删掉声称）。
 */
describe('spec 场景 ↔ 用例 双向覆盖', () => {
  it('本变更 requirement 的每条场景都至少被一条用例标签绑定，且无孤儿标签', () => {
    const specPath = join(
      __dirname, '..', '..', '..',
      // 已归档：本变更的 delta 已并入主规范。切片正则「到下一条 `### ` 或文件尾」不依赖邻居
      // requirement 的名字，故主规范里此 requirement 后面紧跟 2 条无关 requirement 也切得干净。
      'openspec/specs/platform-foundation/spec.md',
    );
    const spec = readFileSync(specPath, 'utf8');

    // 只取本变更负责的那条 requirement 的场景，边界是「下一条 `### ` 或文件尾」。
    const section = spec.match(/### 需求:环境配置校验[\s\S]*?(?=\n### |$)/)?.[0] ?? '';
    expect(section).not.toBe(''); // requirement 被改名 ⇒ 这里就红，不会静默退化成空集
    const declared = new Set(
      [...section.matchAll(/^#### 场景:(.+)$/gm)].map((m) => m[1]!.trim()),
    );
    const self = readFileSync(__filename, 'utf8');
    const bound = new Set(
      [...self.matchAll(/it(?:\.each\([\s\S]*?\))?\(\s*'\[场景:(.+?)\]/g)].map((m) => m[1]!.trim()),
    );

    expect([...declared].filter((x) => !bound.has(x))).toEqual([]); // 场景无用例
    expect([...bound].filter((x) => !declared.has(x))).toEqual([]); // 标签无场景
    // 标签存在 ≠ 用例真跑：单条用例加跳过修饰符会让标签一起消失（自然变红），但整块 describe 加
    // 上去时标签仍在源码里 ⇒ 上面两条照绿而覆盖已归零。本文件禁用这三个修饰符，堵掉这个洞。
    // （正则字面量自身不自命中：交替语法里 `it` 后面跟的是 `)` 而不是字面点号。）
    expect(self).not.toMatch(/\b(?:describe|it)\.(?:skip|todo|only)\b/);
  });
});
