/**
 * 组 C SSR 页测（add-model-radar-compare-web-page / task 7.x）——注入合成快照、`app.request()` 取 HTML，
 * 对 HTML 串断言（不需浏览器 e2e）。**全合成、不触 DB/Redis**（getSnapshot 可注入；测试安全红线）。
 *
 * 覆盖：7.1 筛选/溯源/分组、7.2 诚实分层 + 未核不入最划算 + 桶2 gate、7.3 XSS + CSP、
 * 7.4 不挂 version-304（无 ETag、每请求重渲）、7.5 只读 + 冷启动 503、7.6 估算页面侧、7.7 a11y。
 */
import { describe, expect, it, vi } from 'vitest';
import { modelRadarQueryParamsSchema, queryModelRadarSnapshot } from '../../snapshot/query.js';
import { recommend } from '../../recommend/recommend.js';
import { client, known, limit, model, periodPrice, prov, provider, snap, unknown } from './fixtures.js';

// 页面静态导入链 cache→db→env 会在 import 时校验 env（dotenv 不覆盖已存在值）。本仓 .env 缺省时先设占位、
// 再**动态** import 页面（静态 import 会提升到占位赋值之上 → 触发校验失败）。全 dummy，且注入 getSnapshot 后
// DB/Redis 永不被拨号（pg Pool 惰性、页面不导入 redis；守「测试绝不连真 DB/Redis」红线）。镜像 snapshot/cache.test.ts。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { createModelRadarWebApp } = await import('../model-radar-page.js');

// 加入 `font-src 'self'`（refresh design system：放行同源自托管 webfont，且不放行任何外部/CDN 源）。
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 9 个状态 emoji（🟢🟡🔴🟠⭐🏆🚫❓⚠）——弃 emoji 改 CSS 记号后，SSR 输出不得残留。 */
const STATUS_EMOJI = /[🟢🟡🔴🟠⭐🏆🚫❓⚠]/u;

/** 取页面 HTML（默认 GET /model-radar）。 */
async function render(getSnapshot: () => Promise<{ snapshot: ReturnType<typeof snap>; version: string }>, path = '/model-radar') {
  const app = createModelRadarWebApp(getSnapshot);
  const res = await app.request(path);
  return { res, html: await res.text() };
}

/**
 * 剥离**引擎散文层**（推荐说明正文 `<div class="explanation-body">…</div>` + 答案卡引擎 reasons 列
 * `<ul class="answer-reasons">…</ul>`）后再做无-emoji 断言。二者由 `recommend()` 的 `explanation`/`reasons`
 * **原样透传**（task 2.1/2.2 红线：MUST NOT 裁剪/改写），其中 `recommend.ts` 的 `windowReason` 含 `⚠ 估算`
 * 记号——那是**已发布引擎散文层**（5e），非本页 render.ts 绘制的状态徽标。「无 emoji」不变量只约束视觉徽标系统
 * （答案卡 fitsWindow/新鲜度徽标、备选卡、比价表徽标），故校验前先剥离引擎散文（见返回 JSON 的 design-issue）。
 */
function stripExplanation(html: string): string {
  return html
    .replace(/<div class="explanation-body">[\s\S]*?<\/div>/g, '')
    .replace(/<ul class="answer-reasons">[\s\S]*?<\/ul>/g, '')
    .replace(/<td class="rec-reason">[\s\S]*?<\/td>/g, ''); // 推荐说明表「缘由」列亦透传引擎 reasons（含 ⚠ 散文，见 design-issue）
}

/** 取答案卡 `<section class="answer-card">…</section>` 区（无 primary 时为空串）。 */
function answerCardRegion(html: string): string {
  const s = html.indexOf('<section class="answer-card"');
  return s < 0 ? '' : html.slice(s, html.indexOf('</section>', s));
}

/** 取备选账本列表 `<ol class="alt-list">…</ol>` 区（无备选时为空串）。 */
function altCardsRegion(html: string): string {
  const s = html.indexOf('<ol class="alt-list">');
  return s < 0 ? '' : html.slice(s, html.indexOf('</ol>', s));
}

/** 取证据抽屉正文 `<div class="evidence-body">…`（到抽屉 `</details>` 前）——比价表所在区。 */
function evidenceBodyRegion(html: string): string {
  const s = html.indexOf('<div class="evidence-body">');
  return s < 0 ? '' : html.slice(s, html.indexOf('</details></main>', s));
}

describe('7.1 SSR 渲染：按模型筛选答「谁含 X」+ 每格可溯源 + 分组不跨桶/币', () => {
  it('?model=glm:5.2 → 表只列含该模型的 plan，其余不出现', async () => {
    const alpha = known('Alpha', '30', 'CNY', { models: [model('glm', '5.2')], clients: [client('tool', 'claude-code')] });
    const beta = known('Beta', '40', 'CNY', { models: [model('other', '1.0')] });
    const { res, html } = await render(provider(snap(alpha, beta)), '/model-radar?model=glm:5.2');

    expect(res.status).toBe(200);
    // 套餐 th 现带 id="plan-{id}"（供详情行 aria-labelledby 关联）；名后可能跟 availability 标签（unknown→状态未知）。
    expect(html).toContain('id="plan-Alpha">Alpha'); // 名格
    expect(html).not.toContain('plan-Beta'); // 不含 glm:5.2 → 被 queryModelRadarSnapshot 过滤（行头/详情 id 均不出现）
  });

  it('每格可溯源：行展开 <details> 呈现 source_url 链接（http 经 safeHref）', async () => {
    const p = known('Alpha', '30', 'CNY', {
      models: [model('glm', '5.2', { sourceUrl: 'https://docs.example.com/compat' })],
    });
    const { html } = await render(provider(snap(p)));
    expect(html).toContain('<details');
    expect(html).toContain('查看来源');
    expect(html).toContain('href="https://docs.example.com/compat"');
  });

  it('排序经 queryModelRadarSnapshot：混币种分独立组（不跨币比）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'), known('B', '20', 'USD'))));
    // 两个 (category,currency) 组 → 抽屉内两张表两个 caption，各自只含本币种（推荐说明表另有自己的 caption，故限抽屉区）
    expect((evidenceBodyRegion(html).match(/<caption/g) ?? []).length).toBe(2);
    expect(html).toContain('Coding Plan · CNY');
    expect(html).toContain('Coding Plan · USD');
  });
});

describe('7.2 诚实呈现：徽标分层 + 未核不入最划算 + 桶2 gate', () => {
  it('plan 级 🔴 待复核 与 per-fact 🟢🟡 分层共存', async () => {
    // 价格 provenance 设未来日 → 🟢 今日；model fact 设远古日 → 🟡 N 天前；reviewStatus.pending → 🔴 待复核。
    const p = known('Rev', '30', 'CNY', {
      reviewStatus: { pending: true },
      provenance: prov({ lastCheckedDate: '2099-01-01' }),
      models: [model('x', '1', { lastCheckedDate: '2020-01-01' })],
    });
    const { html } = await render(provider(snap(p)));
    expect(html).toContain('待复核'); // plan 级
    expect(html).toContain('今日核对'); // per-fact 🟢（价格格）
    expect(html).toContain('天前核对'); // per-fact 🟡（新鲜度列最旧 fact）
  });

  it('已核≥2 + N 个未核 → 最划算标已核最低 + 「另有 N 个未核价未参与」，未核不入', async () => {
    const { html } = await render(provider(snap(known('Alpha', '30', 'CNY'), known('Beta', '40', 'CNY'), unknown('Gamma'))));
    expect(html).toContain('class="badge badge-cheap"'); // 渲染出最划算徽标
    expect(html).toContain('最划算：Alpha'); // 已核中最低
    expect(html).toContain('另有 1 个未核价未参与'); // 跨引 currency=null 组的 unknownCount
    expect(html).toContain('待核'); // Gamma 显式占位
  });

  it('已核 <2（数 plans.length）→ 不输出最划算、标「已核价不足 2」', async () => {
    const { html } = await render(provider(snap(known('Solo', '30', 'CNY'), unknown('U1'))));
    expect(html).toContain('已核价不足 2');
    expect(html).not.toContain('class="badge badge-cheap"');
    // 不编造名次：cheapest 具名 caption（`最划算：{name}（已核价中最低）`）不渲染。
    // 注：不能裸断 `最划算：`——PAGE_CSS 内联样式的注释含该子串（badge-cheap 记号说明），验其唯一后缀更精确。
    expect(html).not.toContain('（已核价中最低）');
    expect(html).not.toContain('最划算：'); // 更强：证根本无具名赢家（`最划算：` 现仅出现于渲染 caption，PAGE_CSS 无该子串）
  });

  it('桶2 gate：?category=token_plan 仍只显 coding_plan（用户无 category 手段切桶）', async () => {
    const tok = known('TokPlan', '5', 'USD', { category: 'token_plan' });
    const cod = known('CodPlan', '30', 'CNY');
    const { html } = await render(provider(snap(cod, tok)), '/model-radar?category=token_plan');
    expect(html).toContain('id="plan-CodPlan">CodPlan'); // 名格（th 带 plan.id 派生行头 id）
    expect(html).not.toContain('plan-TokPlan'); // token_plan 数据在库但本期 UI 不暴露
  });
});

describe('5d-C 桶2 真价策展：≥2 真月价转出 cheapest 赢家 + 1 价仍数据不足（task 2.2，合成 fixture）', () => {
  // 组 A 已策展的 6 个 (coding_plan, CNY) 真月价（讯飞无忧 ¥19 为同档最低）。合成 fixture 镜像真价、不触 DB。
  const curatedCny = (): ReturnType<typeof known>[] => [
    known('讯飞星火 Coding Plan 无忧', '19', 'CNY'),
    known('千帆 Coding Plan Lite', '40', 'CNY'),
    known('火山方舟 Coding Plan Lite', '40', 'CNY'),
    known('GLM Coding Plan Lite', '49', 'CNY'),
    known('GLM Coding Plan Pro', '149', 'CNY'),
    known('百炼 Coding Plan Pro', '200', 'CNY'),
  ];

  it('6 个真月价 + 腾讯停售未核 → 最划算转出讯飞无忧 ¥19、腾讯未核不入', async () => {
    const tencent = unknown('腾讯混元 Coding Plan', { reviewStatus: { pending: true } }); // 停售占位（NULL 价 + 停售待复核）
    const { html } = await render(provider(snap(...curatedCny(), tencent)));
    expect(html).toContain('class="badge badge-cheap"'); // 渲出最划算徽标
    expect(html).toContain('最划算：讯飞星火 Coding Plan'); // ¥19 同档最低赢家
    expect(html).toContain('另有 1 个未核价未参与'); // 腾讯停售未核不参与
    expect(html).toContain('待核'); // 腾讯显式占位
    expect(html).toContain('待复核'); // 腾讯停售 → plan 级待复核徽标（已停售≠普通待核，render 层验证）
  });

  it('对照：仅 1 个真月价（讯飞 ¥19）→ 仍 render「已核价不足 2」、不评最划算（证 compare-web ≥2 闸生效）', async () => {
    const { html } = await render(provider(snap(known('讯飞星火 Coding Plan 无忧', '19', 'CNY'))));
    expect(html).toContain('已核价不足 2');
    expect(html).not.toContain('class="badge badge-cheap"');
    // 不编造名次：cheapest 具名 caption（`最划算：{name}（已核价中最低）`）不渲染。
    // 注：不能裸断 `最划算：`——PAGE_CSS 内联样式的注释含该子串（badge-cheap 记号说明），验其唯一后缀更精确。
    expect(html).not.toContain('（已核价中最低）');
    expect(html).not.toContain('最划算：'); // 更强：证根本无具名赢家（`最划算：` 现仅出现于渲染 caption，PAGE_CSS 无该子串）
  });
});

describe('7.3 XSS：危险 scheme source_url 降级纯文本 + CSP 头', () => {
  it('javascript:/data: source_url → 无可点 <a href>、以纯文本出现、无原始 <script>', async () => {
    const p = known('Xss', '30', 'CNY', {
      provenance: prov({ sourceUrl: 'javascript:alert(1)' }),
      models: [model('glm', '5.2', { sourceUrl: 'data:text/html,<script>alert(1)</script>' })],
    });
    const { res, html } = await render(provider(snap(p)));

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('javascript:alert(1)'); // 纯文本呈现（已转义、不可点）
    expect(html).not.toContain('<script>alert(1)'); // hono/jsx 默认转义，无原始脚本注入
    expect(res.headers.get('content-security-policy')).toBe(CSP);
  });
});

describe('4.1 自托管 webfont：CSP font-src + @font-face/@view-transition + serveStatic 路由（refresh design system）', () => {
  it('CSP 含 font-src self、不放行任何外部/CDN 字体源', async () => {
    const { res } = await render(provider(snap(known('A', '30', 'CNY'))));
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/font-src[^;]*https?:/); // font-src 指令内无外部 URL
    expect(csp).not.toContain('fonts.googleapis'); // 无 Google Fonts
    expect(csp).not.toContain('fonts.gstatic');
  });

  it('SSR HTML 含 @font-face（同源 woff2 src）与 @view-transition（纯 CSS 跨文档转场），无外部字体 URL', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(html).toContain('@font-face');
    expect(html).toContain('@view-transition');
    expect(html).toContain('/model-radar/assets/hanken-grotesk-latin-400.woff2'); // 同源自托管 src
    expect(html).not.toContain('https://fonts.'); // 无外部字体来源
  });

  it('serveStatic：GET /model-radar/assets/*.woff2 → 200 + Content-Type font/woff2 + 长缓存 immutable', async () => {
    const app = createModelRadarWebApp(provider(snap(known('A', '30', 'CNY'))));
    const res = await app.request('/model-radar/assets/hanken-grotesk-latin-400.woff2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('assets 外路径 / 穿越 → 非 200 且不泄露源码（root 钉死 assets、`..` 守卫 + URL 归一双重）', async () => {
    const app = createModelRadarWebApp(provider(snap(known('A', '30', 'CNY'))));
    // 安全不变量：任何穿越形状的请求 MUST NOT 返回 200，且响应体 MUST NOT 含源码内容——
    // 无论 404 来自路由归一未匹配、serveStatic 解码后 `..` 守卫、还是 literal 缺文件，源码都不得被服务。
    // 断言 body 不含源码标记 → 即使某天状态码/守卫逻辑变化导致源码被服务，也会失败（防 false-green）。
    for (const p of [
      '/model-radar/assets/../model-radar-page.tsx',        // 明文 `../`：URL 归一后不匹配 assets 路由
      '/model-radar/assets/%2e%2e%2fmodel-radar-page.tsx',  // 编码 `../`：new URL() 不预归一
      '/model-radar/assets/%2e%2e%2frender.ts',
      '/model-radar/assets/..%2f..%2frender.ts',            // 混合 `..%2f`
      '/model-radar/assets/%2e%2e%5cmodel-radar-page.tsx',  // 反斜杠 `..\` 形式
      '/model-radar/assets//model-radar-page.tsx',          // 双斜杠 `//` 形式
    ]) {
      const res = await app.request(p);
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain('createModelRadarWebApp'); // model-radar-page.tsx 源码标记
      expect(body).not.toContain('export function');        // 任一 .ts 源码标记
    }
    // assets 内不存在的资源 → 404。
    const missing = await app.request('/model-radar/assets/does-not-exist.woff2');
    expect(missing.status).toBe(404);
  });
});

describe('4.2 弃 emoji：富数据 SSR（停售 + 待复核 + 陈旧 + 估算 + 最佳周期）无任何残留状态 emoji', () => {
  it('全状态徽标一次渲染仍无 🟢🟡🔴🟠⭐🏆🚫❓⚠，且 CSS 记号载体类在', async () => {
    const dead = known('Dead', '10', 'CNY', {
      availability: 'discontinued',
      reviewStatus: { pending: true },
      freshness: { stale: true },
      limits: [limit('monthly_tokens', '300000', 'monthly')],
    });
    const best = known('Best', '100', 'CNY', { periodPrices: [periodPrice('annual', '1080', 'CNY', 90)] });
    const peer = known('Peer', '40', 'CNY');
    const { html } = await render(provider(snap(dead, best, peer)));
    // 弃 emoji：视觉徽标系统无任一状态 emoji（剥离引擎「推荐说明」散文——其 `⚠ 估算` 记号是已发布引擎层，非 render 徽标）
    expect(stripExplanation(html)).not.toMatch(STATUS_EMOJI);
    // CSS 记号载体类逐条在（记号由 ::before 绘制、文字标签承载状态）
    for (const cls of ['badge-discontinued', 'badge-review', 'badge-stale', 'badge-estimate', 'badge-best-period', 'badge-cheap'])
      expect(html).toContain(`class="badge ${cls}"`); // 断渲染标记（class="badge ..." 仅 JSX 出现），非 <style> 内 CSS 选择器（防 false-green）
  });
});

describe('7.4 不挂 version-304：每请求 live 重渲、无 ETag', () => {
  it('HTML 响应无 ETag、状态 200（不会 304-with-stale 出陈旧 age）', async () => {
    const { res } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('7.5 只读不变量：合成快照唯一数据源、不写库、冷启动失败 503', () => {
  it('每请求都经注入 getSnapshot 重渲（无 304 短路）、无副作用', async () => {
    let calls = 0;
    const getSnapshot = async () => {
      calls += 1;
      return { snapshot: snap(known('A', '30', 'CNY')), version: 'v1' };
    };
    const app = createModelRadarWebApp(getSnapshot);
    const r1 = await app.request('/model-radar');
    const r2 = await app.request('/model-radar');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toBe(2); // 渲染路径只读注入快照（不碰 DB writer）；每请求各取一次、不挂版本缓存
  });

  it('冷启动首建失败（getSnapshot 抛错）→ 503，不渲坏快照', async () => {
    // 本例**有意**走 fail-closed 的 console.error 日志路径；本地 stub 掉以免污染 CI stderr（不弱化断言）。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createModelRadarWebApp(async () => {
        throw new Error('snapshot build failed (DB down)');
      });
      const res = await app.request('/model-radar');
      expect(res.status).toBe(503);
      expect(errSpy).toHaveBeenCalled(); // 确证确实走了 fail-closed 日志路径
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('7.6 估算旋钮（页面侧）：区间随假设重算、标为估算（CSS 记号 + 文字、无 ⚠ emoji）、不入 strict schema', () => {
  const tokenPlan = known('Est', '30', 'CNY', { limits: [limit('monthly_tokens', '300000', 'monthly')] });

  it('tokensPerRound 改变 → 区间文案变 + 文字「估算」+ CSS 记号（弃 ⚠ emoji）', async () => {
    const { html: h5k } = await render(provider(snap(tokenPlan)), '/model-radar?tokensPerRound=5000');
    const { html: h40k } = await render(provider(snap(tokenPlan)), '/model-radar?tokensPerRound=40000');
    expect(h5k).toContain('约 40–120 轮');
    expect(h40k).toContain('约 5–15 轮');
    expect(h5k).toContain('估算'); // 文字承载（非仅 emoji）
    expect(h5k).toContain('class="badge badge-estimate"'); // 估算记号载体（渲染标记，非 <style> 选择器，弃 ⚠）
    expect(stripExplanation(h5k)).not.toMatch(STATUS_EMOJI); // 徽标区无残留 ⚠（引擎散文层除外）
  });

  it('limit.value=null → 优雅降级：不输出估算徽标、不 NPE（仍 200）', async () => {
    const nullLimit = known('NullLim', '30', 'CNY', { limits: [limit('monthly_tokens', null, 'monthly')] });
    const { res, html } = await render(provider(snap(nullLimit)));
    expect(res.status).toBe(200);
    expect(html).toContain('不限 / 待定'); // 限额占位
    expect(html).not.toContain('badge badge-estimate'); // 无估算区间
  });

  it('tokensPerRound 是 web-only param、不在 .strict() 查询 schema（不进哈希/不喂 query）', () => {
    // 从**有效**查询（仅 category 即可过）出发，再加 tokensPerRound → .strict() 必拒：
    // 证明确是 tokensPerRound 被排除，而非因缺 category 顺带失败（避免「断言因错误原因通过」）。
    expect(modelRadarQueryParamsSchema.safeParse({ category: 'coding_plan' }).success).toBe(true);
    expect(
      modelRadarQueryParamsSchema.safeParse({ category: 'coding_plan', tokensPerRound: '5000' }).success,
    ).toBe(false);
  });
});

describe('7.7 a11y：原生语义 + 文字徽标 + 地标/lang/aria-sort', () => {
  it('渲染 HTML 含原生表语义、details、lang、aria-sort、文字徽标、地标、skip-link', async () => {
    const p = known('Alpha', '30', 'CNY', {
      reviewStatus: { pending: true },
      models: [model('glm', '5.2')],
      clients: [client('tool', 'claude-code')],
      limits: [limit('monthly_tokens', '300000', 'monthly')],
    });
    const { html } = await render(provider(snap(p)));

    // 原生表语义（禁 div-grid）
    expect(html).toContain('<table');
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    // 无 JS 行展开
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    // 外壳：lang / 地标 / skip-link
    expect(html).toContain('lang="zh-Hans"');
    expect(html).toContain('<main');
    expect(html).toContain('<header');
    expect(html).toContain('跳到主内容'); // skip-link
    // 排序列可访问性
    expect(html).toContain('aria-sort');
    expect(html).toContain('按价格升序排序'); // 方向性可访问名
    // 徽标文字标签（非仅色/emoji）承载状态；CSS 记号由 badge class 的 ::before 绘制（装饰、无可及名、无 emoji 字符）
    expect(html).toContain('待复核');
    expect(html).toContain('class="badge badge-review"'); // 待复核 CSS 记号载体类存在
    expect(stripExplanation(html)).not.toMatch(STATUS_EMOJI); // 状态记号弃 emoji、SSR 无残留（引擎散文层除外）
    // 链接描述性可访问名（2.4.4，非裸 URL）
    expect(html).toContain('查看来源');
  });
});

describe('3.2/3.4 分层新布局 SSR 结构：主行恰 5 列 + 全宽 details 详情行 + 分区 dl + 状态各归其位 + carry-over ARIA', () => {
  /** 富数据 plan：状态未知(availability) + 待复核 + 陈旧 + 年付最佳周期 + 模型/工具/额度/溯源 全备。 */
  const rich = () =>
    known('RichPlan', '100', 'CNY', {
      reviewStatus: { pending: true },
      freshness: { stale: true },
      models: [model('glm', '5.2', { sourceUrl: 'https://docs.example.com/compat' })],
      clients: [client('tool', 'claude-code')],
      limits: [limit('monthly_tokens', '300000', 'monthly')],
      periodPrices: [periodPrice('annual', '1080', 'CNY', 90)],
    });

  it('主行恰 5 列、模型/工具/额度/季年付/溯源不在表头列', async () => {
    const { html } = await render(provider(snap(rich())), '/model-radar?model=glm:5.2');
    const ev = evidenceBodyRegion(html); // 限抽屉区（推荐说明表的 thead 现排在前，避免误取）
    const thead = ev.slice(ev.indexOf('<thead'), ev.indexOf('</thead>'));
    expect((thead.match(/scope="col"/g) ?? []).length).toBe(5); // 恰 5 列
    for (const col of ['套餐', '厂商', '月价', '最佳周期', '数据新鲜度']) expect(thead).toContain(col);
    // 明细字段不占主表头列（模型/额度/溯源/季年付均迁入详情区）
    for (const notCol of ['模型', '额度', '溯源', '季 / 年付']) expect(thead).not.toContain(notCol);
  });

  it('每 plan 一条全宽 details 详情行，td colspan=5 且 aria-labelledby 指向行头 id', async () => {
    const { html } = await render(provider(snap(rich())), '/model-radar?model=glm:5.2');
    expect(html).toContain('id="plan-RichPlan">RichPlan'); // 行头 id 由 plan.id 派生
    expect(html).toContain('colspan="5"');
    expect(html).toContain('aria-labelledby="plan-RichPlan"'); // 详情 td 关联行头
    expect(html).toContain('<details');
    expect(html).toContain('<summary>RichPlan 详情</summary>'); // summary 携带 plan 名（SR 可区分）
  });

  it('详情内分区 dl（wrapper .detail-row 承 grid，非 dl 自身）含季年付明细与溯源', async () => {
    const { html } = await render(provider(snap(rich())), '/model-radar?model=glm:5.2');
    expect(html).toContain('<dl class="detail-dl">');
    expect(html).toContain('class="detail-row"'); // grid 落 wrapper（防 Safari/VO 丢 dl list role）
    for (const dt of ['<dt>模型</dt>', '<dt>工具 / 协议</dt>', '<dt>额度</dt>', '<dt>季 / 年付明细</dt>', '<dt>溯源</dt>'])
      expect(html).toContain(dt);
    expect(html).toContain('年付 CNY 1080（≈CNY 90/月）'); // 季年付明细
    expect(html).toContain('查看来源（docs.example.com）'); // 溯源链接名含 host
    expect(html).toContain('年付价'); // 周期价独立 provenance 行
    // 季/年付明细 MUST 在详情 <details> 内、MUST NOT 占主行价格格：首个 <details> 之前的主行区无周期明细原文
    const beforeDetails = html.slice(0, html.indexOf('<details'));
    expect(beforeDetails).not.toContain('年付 CNY 1080'); // 价格格 .price 区无周期明细
  });

  it('availability + 待复核 在套餐格，陈旧在新鲜度列，最佳周期主列摘要用 .price', async () => {
    const { html } = await render(provider(snap(rich())), '/model-radar?model=glm:5.2');
    // 套餐格（行头 th）同时承 availability(状态未知) + 待复核
    const th = html.slice(html.indexOf('id="plan-RichPlan"'), html.indexOf('</th>', html.indexOf('id="plan-RichPlan"')));
    expect(th).toContain('状态未知');
    expect(th).toContain('待复核');
    // 陈旧在新鲜度列（🔴 态、badge-stale）
    expect(html).toContain('class="badge badge-stale"'); // 渲染标记（非 <style> 选择器）
    expect(html).toContain('陈旧');
    // 最佳周期主列摘要：数字+币种进等宽 .price、中文标签在外
    expect(html).toContain('年付 ≈<span class="price">CNY 90</span>/月');
    // 月价列 .price 等宽
    expect(html).toContain('<span class="price">CNY 100</span>');
  });

  it('carry-over 标记/ARIA：table-scroll role/tabindex/aria-label + aria-sort + 方向排序名 + chip aria-current + title 反映筛选 + skip-link #main', async () => {
    const { html } = await render(provider(snap(rich())), '/model-radar?model=glm:5.2');
    expect(html).toContain('class="table-scroll" role="group" tabindex="0" aria-label="比价表：');
    expect(html).toContain('aria-sort="ascending"'); // 已核组默认价升序
    expect(html).toContain('aria-label="按价格升序排序"');
    expect(html).toContain('aria-label="按数据新鲜度排序，最陈旧优先"');
    expect(html).toContain('aria-label="按数据新鲜度排序，最新核对优先"');
    // 答案优先页无筛选 chip（SetupForm 用带 label 的 <select>，非可移除 chip）；title 反映 setup 且四态皆有意义。
    // rich()=RichPlan 待复核 → insufficient_data → 无 primary → title 用「未找到匹配首选」（不误导为「推荐/答案」）。
    expect(html).toContain('<title>未找到匹配首选 · 模型 glm:5.2 · Model Radar · Coding Plan</title>');
    expect(html).toContain('href="#main"'); // skip-link 目标
    expect(html).toContain('id="main"'); // 目标地标存在
  });

  it('最佳周期空态：无同币种已核周期 → 主列显 — ；on_sale plan 套餐格不出 availability 标', async () => {
    const plain = known('Plain', '50', 'CNY', { availability: 'on_sale' });
    const { html } = await render(provider(snap(plain, known('Peer', '60', 'CNY'))));
    // Plain 无 periodPrices → bestPeriodSummary null → 主列 —（次级灰）
    const row = html.slice(html.indexOf('id="plan-Plain"'), html.indexOf('id="plan-Peer"'));
    expect(row).toContain('<span class="muted">—</span>');
    // on_sale → 套餐格无 availability 徽标
    const th = html.slice(html.indexOf('id="plan-Plain"'), html.indexOf('</th>', html.indexOf('id="plan-Plain"')));
    expect(th).not.toContain('已停售');
    expect(th).not.toContain('状态未知');
  });

  it('详情空段用 — 占位、不渲带标签空 dd（无模型/无季年付的 plan）', async () => {
    const bare = known('Bare', '30', 'CNY'); // 无 models/clients/limits/periodPrices
    const { html } = await render(provider(snap(bare, known('Peer', '40', 'CNY'))));
    // 季/年付明细段紧跟 —（次级灰占位），不出空标签 dd
    const detail = html.slice(html.indexOf('aria-labelledby="plan-Bare"'), html.indexOf('</details>', html.indexOf('aria-labelledby="plan-Bare"')));
    expect(detail).toContain('<dt>季 / 年付明细</dt><dd><span class="muted">—</span></dd>');
    expect(detail).toContain('<dt>模型</dt><dd><span class="muted">—</span></dd>');
  });
});

describe('3.3 停售降权：主行 + 详情行同挂 .row-discontinued、不参与最划算、主列 —', () => {
  it('discontinued plan 主行与详情行同 .row-discontinued、月价删除线、最佳周期主列 —、不评最划算', async () => {
    const dead = known('Dead', '10', 'CNY', {
      availability: 'discontinued',
      periodPrices: [periodPrice('annual', '96', 'CNY', 8)], // 折算更低但停售抑制
    });
    const live1 = known('Live1', '40', 'CNY');
    const live2 = known('Live2', '50', 'CNY');
    const { html } = await render(provider(snap(dead, live1, live2)));
    // 主行 + 详情行同挂 .row-discontinued（两处）
    expect((html.match(/class="row-discontinued"/g) ?? []).length).toBe(2);
    expect(html).toContain('price-struck'); // 月价删除线
    expect(html).toContain('已停售'); // availability 徽标
    // 停售抑制最佳周期：主列 — 、无 🏆 徽标
    const deadRow = html.slice(html.indexOf('id="plan-Dead"'), html.indexOf('id="plan-Live1"'));
    expect(deadRow).toContain('<span class="muted">—</span>');
    expect(html).not.toContain('class="badge badge-best-period"'); // 无 🏆 使用（.badge-best-period 仅在 <style> 声明）
    // 不评停售为最划算（Dead 月价虽最低但停售不入可比候选）
    expect(html).not.toContain('最划算：Dead');
    expect(html).toContain('最划算：Live1'); // 已核在售最低者
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 答案优先层（add-model-radar-answer-first-web / task 4.x）：注入合成快照经 recommend() 驱动，
// 断言页顶答案卡 / 备选卡 / thin-data 诚实 / setup 校验边界 / 证据抽屉四问 / 新表面 a11y。
// 全合成、不触 DB/Redis；断言基于渲染标记（class 属性 / 元素结构 / DOM 顺序 / aria），不臆造。
// ─────────────────────────────────────────────────────────────────────────────

describe('4.1 primary 答案卡 + 备选卡 + 溢出披露（引擎 verdict 驱动、web 不重判）', () => {
  // Alpha 最便宜且 monthly_tokens 大到 medium 用量档撞窗判 fits → primary；Beta–Epsilon 顺次为 alternative。
  const eligibleSnap = () =>
    snap(
      known('Alpha', '30', 'CNY', { limits: [limit('monthly_tokens', '5000000', 'monthly')] }),
      known('Beta', '40', 'CNY'),
      known('Gamma', '50', 'CNY'),
      known('Delta', '60', 'CNY'),
      known('Epsilon', '70', 'CNY'),
    );

  it('答案卡含 primary 方案名/厂商/月成本/fitsWindow 结论/新鲜度，且不出现 web 自撰额外话术', async () => {
    const { res, html } = await render(provider(eligibleSnap()));
    expect(res.status).toBe(200);
    const card = answerCardRegion(html);
    expect(card).not.toBe(''); // 页顶有答案卡
    expect(card).toContain('class="verdict-chip">首选推荐'); // 定论 chip（非 eyebrow）
    expect(card).toContain('id="answer-heading"');
    expect(card).toContain('Alpha'); // 方案名（引擎升序首个 eligible=最便宜）
    expect(card).toContain('class="answer-vendor"> · Vendor 1'); // 厂商
    expect(card).toContain('<span class="answer-cost">CNY 30</span>'); // 月成本（币种代码+空格+金额，复用约定）
    expect(card).toContain('/月');
    expect(card).toContain('class="badge badge-fits">额度够用（估算）'); // fitsWindow 结论
    expect(card).toContain('class="answer-meta"'); // 新鲜度区
    expect(card).toContain('核对'); // 价格事实 age（AgeBadgeView）
    // primary 是引擎升序首个 eligible，Beta（40）不得被误渲进答案卡。
    expect(card).not.toContain('Beta');
  });

  it('备选区渲前 3 个 alternative + >3 时溢出披露「另有 N 个备选」+ #evidence 锚点', async () => {
    const { html } = await render(provider(eligibleSnap()));
    const alts = altCardsRegion(html);
    expect((alts.match(/class="alt-row"/g) ?? []).length).toBe(3); // 恰前 3 张
    for (const name of ['Beta', 'Gamma', 'Delta']) expect(alts).toContain(name);
    expect(alts).not.toContain('Epsilon'); // 第 4 个 alternative 溢出、不进备选卡
    // 溢出可达披露（非静默截断）：文案 + 页内锚点。
    expect(html).toContain('另有 1 个备选');
    expect(html).toContain('href="#evidence"');
  });

  it('陈旧方案入选仍诚实标「陈旧」（不伪装新鲜）', async () => {
    const { html } = await render(provider(snap(known('Stale', '30', 'CNY', { freshness: { stale: true } }))));
    const card = answerCardRegion(html);
    expect(card).toContain('Stale');
    expect(card).toContain('class="badge badge-stale">陈旧'); // stale 显式标注
  });
});

describe('4.2 thin-data 诚实：无 eligible 不编造卡、撞窗未知警告先行、落选不进卡', () => {
  it('全未核/停售（无 eligible）→ 显引擎 explanation、无任何 plan 进 answer/alternative 卡元素', async () => {
    const { res, html } = await render(provider(snap(unknown('U1'), unknown('U2'), known('Dead', '10', 'CNY', { availability: 'discontinued' }))));
    expect(res.status).toBe(200);
    // 断卡元素标记（class="answer-card"/"alt-card" 仅 JSX 渲染出现；PAGE_CSS 内是 `.answer-card {` 选择器、不含 `class="`）。
    expect(html).not.toContain('class="answer-card"'); // 无假 primary 卡
    expect(html).not.toContain('class="alt-row"'); // 无备选卡
    // 推荐说明表（结构化 candidates）呈现落选候选 + 判级；引擎 explanation guidance 原文折叠保留。
    expect(html).toContain('class="rec-table"'); // 结构化候选表
    expect(html).toContain('class="v-badge v-pend"'); // 未核候选判「待核」
    expect(html).toContain('class="v-badge v-no"'); // 停售候选判「不推荐」
    expect(html).toContain('class="explanation-body"'); // 引擎完整说明原样透传
    expect(html).toContain('暂无可用首选'); // 引擎 guidance（composeNoEligible）
  });

  it('fitsWindow=unknown → 「额度未知」警告元素在 DOM/源序上先于结论元素', async () => {
    // 无 limits → fitsWindow=unknown → eligible → primary，且额度未知警告一等公民。
    const { html } = await render(provider(snap(known('Alpha', '30', 'CNY'))));
    const card = answerCardRegion(html);
    const warnAt = card.indexOf('class="answer-warn"');
    const fitAt = card.indexOf('class="badge badge-unknown-fit"');
    expect(warnAt).toBeGreaterThanOrEqual(0); // 警告在
    expect(fitAt).toBeGreaterThanOrEqual(0); // 结论在
    expect(warnAt).toBeLessThan(fitAt); // 源序：警告先于结论（非 CSS order 视觉前置）
  });

  it('not_recommended（停售）/insufficient_data（待复核）候选不进答案/备选卡、仅随抽屉 A 表以 A 标级呈现', async () => {
    const snapshot = snap(
      known('Alpha', '30', 'CNY'), // eligible → primary
      known('Dead', '10', 'CNY', { availability: 'discontinued' }), // not_recommended
      known('Pend', '20', 'CNY', { reviewStatus: { pending: true } }), // insufficient_data
    );
    const { html } = await render(provider(snapshot));
    expect(answerCardRegion(html)).toContain('Alpha'); // 唯一 primary
    expect(html).not.toContain('class="alt-row"'); // Dead/Pend 不作备选
    // 落选候选仍在证据抽屉 A 表可见（A 既有标级）。
    const ev = evidenceBodyRegion(html);
    expect(ev).toContain('Dead');
    expect(ev).toContain('已停售'); // A 表 availability 标级
    expect(ev).toContain('Pend');
    expect(ev).toContain('待复核'); // A 表待复核标级
  });
});

describe('4.3 输入 + 空态 + setup 校验边界', () => {
  it('裸 /model-radar 有 eligible → 给默认答案（answer-card，200）', async () => {
    const { res, html } = await render(provider(snap(known('Alpha', '30', 'CNY'))));
    expect(res.status).toBe(200);
    expect(html).toContain('class="answer-card"');
  });

  it('裸 /model-radar 无 eligible → 显 guidance（explanation-note--primary，非空白，200）', async () => {
    const { res, html } = await render(provider(snap(unknown('U1'))));
    expect(res.status).toBe(200);
    expect(html).not.toContain('class="answer-card"');
    expect(html).toContain('class="rec-table"'); // 推荐说明表（结构化候选）呈现落选候选
    expect(html).toContain('class="v-badge v-pend"'); // U1 未核 → 判「待核」
    expect(html).toContain('class="explanation-body"'); // 引擎完整说明原样透传
  });

  it('usageProfile=heavy 改变答案（同 plan medium→额度够用、heavy→额度未知 + 警告）', async () => {
    const s = () => snap(known('Alpha', '30', 'CNY', { limits: [limit('monthly_tokens', '5000000', 'monthly')] }));
    const { html: med } = await render(provider(s())); // 默认 medium
    const { html: heavy } = await render(provider(s()), '/model-radar?usageProfile=heavy');
    expect(answerCardRegion(med)).toContain('badge-fits'); // medium：额度够用
    const heavyCard = answerCardRegion(heavy);
    expect(heavyCard).toContain('badge-unknown-fit'); // heavy：撞窗判 unknown（用量更高）
    expect(heavyCard).toContain('class="answer-warn"'); // 额度未知警告随之出现
  });

  it('usageProfile=ultra（非法枚举）→ 200 不崩（clamp 到引擎默认 medium）', async () => {
    const { res, html } = await render(
      provider(snap(known('Alpha', '30', 'CNY', { limits: [limit('monthly_tokens', '5000000', 'monthly')] }))),
      '/model-radar?usageProfile=ultra',
    );
    expect(res.status).toBe(200); // 不 TypeError、不 500
    expect(answerCardRegion(html)).toContain('badge-fits'); // clamp 到 medium → 与默认同结论
  });

  it('model=glm（缺冒号）→ 400 非 500（ZodError 于 web 层拦截、不流进 recommend）', async () => {
    const { res } = await render(provider(snap(known('Alpha', '30', 'CNY'))), '/model-radar?model=glm');
    expect(res.status).toBe(400);
  });

  it('maxMonthlyPrice=100 USD（无显式 currency）→ 用串币种 USD 归组/答案（非默认 CNY）', async () => {
    const snapshot = snap(known('UsdPlan', '50', 'USD'), known('CnyPlan', '40', 'CNY'));
    const { res, html } = await render(provider(snapshot), '/model-radar?maxMonthlyPrice=100%20USD');
    expect(res.status).toBe(200);
    const card = answerCardRegion(html);
    expect(card).toContain('UsdPlan'); // 币种取预算串 USD → USD 组内择答案
    expect(card).toContain('USD 50');
    expect(card).not.toContain('CnyPlan'); // 未误配默认 CNY 组
  });

  it('显式 currency 与预算串币种冲突（100 USD + currency=CNY）→ 400（schema superRefine）', async () => {
    const { res } = await render(
      provider(snap(known('A', '30', 'CNY'))),
      '/model-radar?maxMonthlyPrice=100%20USD&currency=CNY',
    );
    expect(res.status).toBe(400);
  });

  it('SetupForm 原生 GET + fieldset/legend 分组 + usageProfile <select>（无 JS 整页 GET）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(html).toContain('class="filters setup-form" method="get"'); // 原生 GET 表单
    expect(html).toContain('<fieldset>');
    expect(html).toContain('<legend>描述你的配置</legend>');
    expect(html).toContain('<select name="usageProfile">');
    for (const label of ['轻度', '中度', '重度']) expect(html).toContain(label);
  });

  // ── review-loop 回归：以下 4 面此前无断言、缺陷曾随绿测发布 ──

  it('裸页 usageProfile 下拉默认选中「中度」而非浏览器首项「轻度」（回显=引擎默认 medium，防自相矛盾/静默降档）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(html).toContain('<option value="medium" selected'); // 与引擎 DEFAULT_USAGE 一致
    expect(html).not.toContain('<option value="light" selected'); // 首项不被浏览器默认选中
  });

  it('usageProfile 带入证据抽屉排序链接（点排序不丢用量档 → 不静默回落 medium）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'), known('B', '40', 'CNY'))), '/model-radar?usageProfile=heavy');
    expect(html).toMatch(/<a class="sort-link"[^>]*href="[^"]*usageProfile=heavy/); // 排序链接保留 heavy
  });

  it('maxMonthlyPrice 数额溢出（400 个 9）→ 400 非 500（边界即拒非有限值、不流进 recommend 的 .finite()）', async () => {
    const big = '9'.repeat(400);
    const { res } = await render(provider(snap(known('A', '30', 'CNY'))), `/model-radar?maxMonthlyPrice=${big}%20CNY`);
    expect(res.status).toBe(400);
  });

  it('无 primary → 引擎说明 details 默认展开（open，唯一答案内容醒目）；有 primary → 折叠（从属答案卡）', async () => {
    const { html: noPrimary } = await render(provider(snap(unknown('U1'))));
    expect(noPrimary).toContain('<details class="explanation-note" open'); // 无 primary 展开
    const { html: withPrimary } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(withPrimary).toContain('<details class="explanation-note">'); // 有 primary 折叠（无 open 属性）
    expect(withPrimary).not.toContain('explanation-note" open');
  });
});

describe('4.4 证据抽屉 + 四问：表在 <details id="evidence"> 内、未注入 verdict 列、按召回维度过滤、primary/cheapest 对账', () => {
  it('比价表在 <details id="evidence"> 内（非 main 顶层）、summary 描述性', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'), known('B', '40', 'CNY'))));
    expect(html).toContain('<details id="evidence"'); // 证据抽屉
    // 比价表在 #evidence 抽屉内（推荐说明表在其之前的 main 顶层、不属证据抽屉）。
    expect(evidenceBodyRegion(html)).toContain('<table');
    expect(html).toContain('查看全部方案对比与依据'); // 描述性 summary（答 Q1/Q2/Q4）
  });

  it('抽屉表恰 5 列、未注入 recommend verdict/超预算/撞窗列（口径/结构不变）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'), known('B', '40', 'CNY'))));
    const ev = evidenceBodyRegion(html);
    const thead = ev.slice(ev.indexOf('<thead'), ev.indexOf('</thead>'));
    expect((thead.match(/scope="col"/g) ?? []).length).toBe(5); // A 表原 5 列
    for (const col of ['套餐', '厂商', '月价', '最佳周期', '数据新鲜度']) expect(thead).toContain(col);
    // recommend 判级词不得作为表列注入。
    for (const injected of ['首选', '备选', '不推荐', 'verdict', '超预算', '撞窗']) expect(thead).not.toContain(injected);
  });

  it('抽屉表按召回维度过滤（{category,model,tool,protocol}），超预算/他币种落选候选仍可见', async () => {
    // 预算 50 CNY：Pricey(80) 超预算、UsdOne 他币种——二者在答案区落选，但抽屉表 MUST 仍可见（否则 guidance 引用不可查）。
    const snapshot = snap(known('Cheap', '30', 'CNY'), known('Pricey', '80', 'CNY'), known('UsdOne', '40', 'USD'));
    const { html } = await render(provider(snapshot), '/model-radar?maxMonthlyPrice=50%20CNY');
    expect(answerCardRegion(html)).toContain('Cheap'); // primary 是同币种预算内最便宜
    const ev = evidenceBodyRegion(html);
    expect(ev).toContain('Pricey'); // 超预算仍在抽屉
    expect(ev).toContain('UsdOne'); // 他币种仍在抽屉（另分 USD 组表）
  });

  it('四问：答案卡答 Q3（同档最划算），抽屉 A 表答 Q1/Q2/Q4', async () => {
    const p = known('Alpha', '30', 'CNY', {
      models: [model('glm', '5.2')],
      clients: [client('tool', 'claude-code')],
    });
    const { html } = await render(provider(snap(p, known('Beta', '40', 'CNY'))));
    expect(answerCardRegion(html)).toContain('Alpha'); // Q3：同档最划算=首选
    const ev = evidenceBodyRegion(html);
    expect(ev).toContain('<dt>模型</dt>'); // Q1：谁含某模型
    expect(ev).toContain('<dt>工具 / 协议</dt>'); // Q2：谁支持某工具/协议
    expect(ev).toContain('数据新鲜度'); // Q4：谁最近被核对/最陈旧
  });

  it('primary≠cheapest 对账（不断言恒等）：更便宜候选撞窗 → 用 recommend 输出核对其 verdict + 答案区交代缘由', async () => {
    // Cheaper(20) 价更低但 monthly_tokens 小到 medium 用量档撞窗 exceeds → not_recommended；Budget(30) eligible → primary。
    const snapshot = snap(
      known('Budget', '30', 'CNY'),
      known('Cheaper', '20', 'CNY', { limits: [limit('monthly_tokens', '300000', 'monthly')] }),
    );
    const input = { currency: 'CNY' as const, maxMonthlyPrice: 50 };
    const result = await recommend(snapshot, input);
    const primary = result.candidates.find((c) => c.verdict === 'primary');
    // 该组 cheapest 用 vetted money-path 取（不手搓）：queryModelRadarSnapshot 的 CNY 组 cheapestPlanId。
    const { groups } = queryModelRadarSnapshot(snapshot, modelRadarQueryParamsSchema.parse({ category: 'coding_plan' }));
    const cheapestPlanId = groups.find((g) => g.sortScope.currency === 'CNY')?.cheapestPlanId;

    expect(primary?.planId).toBe('Budget');
    expect(cheapestPlanId).toBe('Cheaper'); // 月价最低者
    expect(primary?.planId).not.toBe(cheapestPlanId); // 分歧存在
    // 对账：cheapest 的 verdict ∈ {not_recommended, insufficient_data}（本例撞窗 → not_recommended）。
    const cheapestVerdict = result.candidates.find((c) => c.planId === cheapestPlanId)?.verdict;
    expect(['not_recommended', 'insufficient_data']).toContain(cheapestVerdict);

    // 页面答案区 explanation 交代其落选缘由（用户不困惑「为何不是最便宜」）。
    const { html } = await render(provider(snapshot), '/model-radar?maxMonthlyPrice=50%20CNY');
    const body = html.slice(html.indexOf('class="explanation-body"'), html.indexOf('</div>', html.indexOf('class="explanation-body"')));
    expect(body).toContain('Cheaper');
    expect(body).toContain('额度不足'); // 撞窗 exceeds 缘由
  });
});

describe('4.5 carry-over + 新表面：a11y 硬清单 + thin-data title 有意义 + 无回归', () => {
  const richEligible = () =>
    known('Alpha', '30', 'CNY', {
      models: [model('glm', '5.2')],
      clients: [client('tool', 'claude-code')],
      limits: [limit('monthly_tokens', '5000000', 'monthly')],
    });

  it('a11y 硬清单：skip-link/地标/lang/th scope/detail-row/fieldset+legend + 徽标区无 emoji', async () => {
    const { html } = await render(provider(snap(richEligible(), known('Beta', '40', 'CNY'))));
    expect(html).toContain('跳到主内容'); // skip-link
    expect(html).toContain('href="#main"');
    expect(html).toContain('id="main"');
    expect(html).toContain('lang="zh-Hans"');
    expect(html).toContain('<main');
    expect(html).toContain('<header');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('class="detail-row"'); // 详情 grid 落 wrapper（carry-over）
    expect(html).toContain('<fieldset>');
    expect(html).toContain('<legend>描述你的配置</legend>');
    // 剥离引擎散文后，视觉徽标系统（答案卡/备选卡/表徽标）无状态 emoji。
    expect(stripExplanation(html)).not.toMatch(STATUS_EMOJI);
  });

  it('primary 态 <title>「推荐 {name}」反映 setup；有 primary 时 explanation 折叠为从属 <details>', async () => {
    const { html } = await render(provider(snap(richEligible())), '/model-radar?model=glm:5.2');
    expect(html).toContain('<title>推荐 Alpha · 模型 glm:5.2 · Model Radar · Coding Plan</title>');
    expect(html).toContain('<details class="explanation-note">'); // 引擎完整说明折叠、从属
    expect(html).toContain('<summary>引擎完整说明</summary>');
    expect(html).toContain('class="rec-table"'); // 推荐说明作结构化候选表
  });

  it('thin-data 态 <title> 有意义、不含「答案/推荐」误导措辞', async () => {
    const { html } = await render(provider(snap(unknown('U1'))), '/model-radar?tool=claude-code');
    const title = html.slice(html.indexOf('<title>'), html.indexOf('</title>'));
    expect(title).toContain('未找到匹配首选'); // 诚实措辞
    expect(title).not.toContain('答案');
    expect(title).not.toContain('推荐 '); // 不误导为已有推荐首选
  });

  it('money-path 无回归：证据抽屉最划算仍只依 canonical 月价（未受 recommend verdict 影响）', async () => {
    // A(100) 有超低年付折算、B(40) 月价最低。抽屉表最划算仍标 B（A 的周期折算不撬动 money-path）。
    const a = known('A', '100', 'CNY', { periodPrices: [periodPrice('annual', '12', 'CNY', 1)] });
    const b = known('B', '40', 'CNY');
    const { html } = await render(provider(snap(a, b)));
    const ev = evidenceBodyRegion(html);
    expect(ev).toContain('最划算：B'); // canonical 月价最低
    expect(ev).not.toContain('最划算：A');
  });
});
