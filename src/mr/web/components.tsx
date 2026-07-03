/**
 * Model Radar 比价 Web 页（5d-B，组 B1）的 `hono/jsx` 组件（task 2.4 / 3.x / 4.x / 6.x）。
 *
 * 组件**只组装** render.ts 的纯函数输出 + 快照 DTO 字段——判定逻辑全在 render.ts（组 C 单测）。
 * a11y 基线（design D8 / spec「WCAG 2.2 AA」）：原生 `<table>/<caption>/<th scope>` + `<details>/<summary>`，
 * 徽标含文字标签（emoji `aria-hidden`），地标 + skip-link + `lang` + 描述性 `<title>`。
 * XSS（design D7）：所有快照串经 `hono/jsx` 默认转义；**无 `raw()`/`dangerouslySetInnerHTML`**；
 * `source_url` 经 `safeHref` gate scheme，否则降级纯文本。
 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { mrCurrencySchema } from '../../db/mr-schema.zod.js';
import type { SnapshotPlan, SnapshotPlanGroup, SnapshotProvenance } from '../snapshot/dto.js';
import { estimateRounds } from '../snapshot/limits.js';
import {
  ageBadge,
  availabilityBadge,
  bestPeriod,
  bestPeriodSummary,
  cheapestInfo,
  oldestFactBadge,
  periodPriceLine,
  PERIOD_LABELS,
  resolveTokensPerRound,
  safeHref,
  sortPlansByFreshness,
  sourceHost,
  withParams,
  TOKENS_PER_ROUND_OPTIONS,
  type AgeBadge,
  type AvailabilityBadge,
  type FacetOptions,
  type FreshnessSort,
} from './render.js';

/** 本页识别的 web query 参数（透传给排序链接 / 移除 chip；估算旋钮等 B2 参数不在此）。 */
export interface WebQuery {
  model?: string;
  tool?: string;
  protocol?: string;
  currency?: string;
  maxMonthlyPrice?: string;
  sort?: string;
  /** 用量档（web-only；带入抽屉排序链接以免点排序丢失该设定 → 静默回落引擎默认 medium）。 */
  usageProfile?: string;
  /** 估算旋钮（web-only query-param，不入 .strict() schema / 不进哈希；render 层用，task 5.x）。 */
  tokensPerRound?: string;
}

/** a11y CSS（内联 `<style>`，CSP `style-src 'self' 'unsafe-inline'` 容之；对比 ≥4.5:1、可见焦点环、目标尺寸基线）。 */
const PAGE_CSS = `
  /* ── 视觉方向「分层产品界面」（layered product surface）：微冷中性 page 背景 → 抬升 surface 面板（圆角 + 微阴影 +
     真实 border/ring）；筛选区 / 比价表各成一张卡；一个克制的签名蓝 --accent 贯穿焦点/最划算/交互态；语义状态 ramp
     (fresh/stale/estimate/discontinued) 只给 CSS 绘制的记号上色，文字承载状态。价格用 Hanken Grotesk 的 tabular 数字，
     中文回退系统字体栈；禁紫渐变/glassmorphism/emoji-UI/hero-metric 巨号/侧边条/每段小标签；零外部资源、无 JS。
     暗色-ready：所有观感由 :root token 表达，本期只交付亮色（prefers-color-scheme:dark 结构留位、未填值）。 */

  /* 自托管 Latin webfont（字体二进制由组 A 放入 src/mr/web/assets/；此处只引用族名/路径）。中文不含于子集 →
     浏览器逐字回退到 --font-ui 后段的苹方/雅黑。size-adjust/override 使 swap 换字时价格列不抖动（压 CLS）。 */
  @font-face {
    font-family: "Hanken Grotesk";
    src: url(/model-radar/assets/hanken-grotesk-latin-400.woff2) format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
    size-adjust: 100%;
    ascent-override: 92%;
    descent-override: 24%;
    line-gap-override: 0%;
  }
  @font-face {
    font-family: "Hanken Grotesk";
    src: url(/model-radar/assets/hanken-grotesk-latin-600.woff2) format("woff2");
    font-weight: 600 700;                 /* SemiBold 实体字重覆盖 600（套餐名）与 700（标题），避免合成粗体 */
    font-style: normal;
    font-display: swap;
    size-adjust: 100%;
    ascent-override: 92%;
    descent-override: 24%;
    line-gap-override: 0%;
  }

  :root {
    color-scheme: light;
    /* ── 颜色角色（亮色）；对比值均逐层实测（见各行注释） */
    --page-bg: #f3f5f8;      /* 微冷中性 page 背景 */
    --surface: #ffffff;      /* 抬升面板表面 */
    --surface-sunken: #f7f8fa; /* 详情区浅底（<dl> 内） */
    --ink: #12151a;          /* 主文本：on surface ≈16.8:1 / on page-bg ≈15.6:1 */
    --muted: #565b63;        /* 次级文本：on surface 6.8:1 / on page-bg 6.3:1 / on accent-soft 6.4:1（均≥4.5） */
    --ring: #d5d9e0;         /* 面板装饰描边 ring（~1.42:1 vs #fff，装饰性——由 box-shadow + forced-colors border 兜底承载分隔，非交互边界线） */
    --border-control: #8a9099; /* 交互控件静息边框（3.22:1 vs #fff，≥3:1，UI 组件对比 1.4.11）：白底表单控件的唯一边界线索 */
    --hair: #e5e8ec;         /* 表内细分隔线 */
    /* 签名强调色 #1d4ed8（蓝，非紫）——双角色定死取严 4.5:1：白字其上 6.7:1（≥4.5），作焦点环对相邻面(surface#fff 6.7:1 / page-bg 6.14:1) ≥3:1 */
    --accent: #1d4ed8;
    --accent-soft: #eef2ff;  /* 最划算 tinted pill 底（极浅蓝）；--accent 文本其上 6.0:1（≥4.5） */
    /* ── 语义状态 ramp：主用于 CSS 绘制记号上色；同值作文本时各≥4.5:1 on surface（逐项实测） */
    --state-fresh: #0f5132;       /* 今日：墨绿 on surface 9.4:1 */
    --state-stale: #a4161a;       /* 陈旧：告警红 on surface 7.75:1 */
    --state-estimate: #8a5a00;    /* 估算/待复核：告警琥珀 on surface 5.9:1 */
    --state-discontinued: #565b63;/* 已停售/未知：中性灰 on surface 6.8:1 */
    /* ── 圆角阶 / 阴影阶 / 字阶 */
    --r-1: 6px; --r-2: 10px;
    --shadow-1: 0 1px 2px rgba(16,21,32,.05), 0 1px 3px rgba(16,21,32,.06);
    --fs-1: .74rem; --fs-2: .82rem; --fs-3: .9rem; --fs-4: 1rem; --fs-5: 1.08rem; --fs-6: 1.35rem; --fs-7: 2rem;
    /* ── 字体族：Latin/数字用自托管 Hanken Grotesk，中文回退系统字体栈（苹方/雅黑） */
    --font-ui: "Hanken Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    --font-num: "Hanken Grotesk", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", sans-serif;
    --font-display: "Hanken Grotesk", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    /* ── 品牌 / 现代：深色「定论面板」+ 大气页头（answer-first v3）；深底色均以 WCAG 相对亮度实测 ≥4.5:1 */
    --brand-navy: #0e1424;       /* 定论面板深底（蓝黑，品牌向） */
    --brand-navy-2: #1a2236;     /* 面板内次级底（警告条） */
    --brand-navy-hair: rgba(255,255,255,.14);  /* 深底发丝线 */
    --on-navy: #f2f5fb;          /* 深底主文本 16.8:1 */
    --on-navy-muted: #b8c0cf;    /* 深底次级 10:1 */
    --accent-lift: #7aa2ff;      /* 深底品牌蓝 7.4:1（链接/记号/chip 底） */
    --on-navy-fresh: #63d69b;    /* fit 够用 10:1 */
    --on-navy-exceeds: #ff9d9d;  /* fit 不够 9.2:1 */
    --on-navy-estimate: #ffcf85; /* fit 未知/警告 12.7:1 */
  }
  /* 跨文档整页 GET 导航的 app 般转场（纯 CSS，无 JS）；reduce 下把三个伪元素动画置零（非仅省 at-rule） */
  @view-transition { navigation: auto; }
  @media (prefers-reduced-motion: reduce) {
    ::view-transition-old(*), ::view-transition-new(*), ::view-transition-group(*) { animation: none !important; }
  }
  * { box-sizing: border-box; }
  /* 大气 page 底：顶部一抹极浅冷色光晕（品牌氛围，非 glassmorphism/非渐变文字），其下微冷中性 */
  body { font: 16px/1.6 var(--font-ui); margin: 0; color: var(--ink);
    background: radial-gradient(130% 62% at 50% -12%, #e7edf8 0%, rgba(231,237,248,0) 58%), var(--page-bg);
    background-attachment: fixed; }
  a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }
  /* 可见焦点环（2.4.7）MUST 用 outline（forced-colors 不剥离、不被圆角面板 overflow 裁）、MUST NOT box-shadow；签名蓝对相邻面 ≥3:1 */
  a:focus-visible, button:focus-visible, summary:focus-visible, select:focus-visible,
  input:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .skip-link { position: absolute; left: -9999px; top: 0; background: var(--ink); color: #fff; padding: .5rem 1rem; z-index: 10; border-radius: 0 0 var(--r-1) 0; }
  .skip-link:focus { left: 0; }                      /* skip-link（2.4.1） */
  /* 品牌页头：wordmark + 雷达 mark + 定位 tagline（品牌官网气质） */
  .site-header { padding: 2.5rem 1.25rem 1.4rem; max-width: 1180px; margin: 0 auto; }
  .brand { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .brand-mark { width: 1.6rem; height: 1.6rem; border-radius: 8px; flex: none; position: relative;
    background: linear-gradient(145deg, var(--accent) 0%, #3f6fe4 100%); box-shadow: 0 2px 8px rgba(29,78,216,.35); }
  .brand-mark::before { content: ""; position: absolute; inset: 38%; border-radius: 50%; background: #fff; }
  .brand-mark::after { content: ""; position: absolute; inset: 16%; border: 1.5px solid rgba(255,255,255,.6);
    border-radius: 50%; border-top-color: transparent; border-right-color: transparent; }  /* 雷达扫描弧 */
  .brand-name { font-family: var(--font-display); font-size: 1.5rem; font-weight: 700; letter-spacing: -.02em; margin: 0; color: var(--ink); }
  .brand-sub { font-size: var(--fs-1); font-weight: 700; letter-spacing: .04em; color: var(--accent);
    background: var(--accent-soft); padding: .25em .65em; border-radius: 999px; }              /* accent on accent-soft 6.0:1 */
  .brand-tagline { margin: .75rem 0 0; font-size: var(--fs-3); color: var(--muted); max-width: 54ch; text-wrap: pretty; }  /* muted on page-bg 6.3:1 */
  nav, main { padding: 0 1.25rem; max-width: 1180px; margin: 0 auto; }
  nav { padding-top: .4rem; padding-bottom: 1rem; font-size: var(--fs-3); }
  main { padding-bottom: 3rem; }
  .muted { color: var(--muted); }
  /* 筛选区 = 抬升 surface 卡（圆角 + 微阴影 + 真实 ring）；流式换行、不产生第二处横滚 */
  form.filters { display: flex; flex-wrap: wrap; gap: 1rem 1.1rem; align-items: end; margin: 0 0 1.5rem;
    padding: 1.1rem 1.2rem; background: var(--surface); border: 1px solid var(--ring); border-radius: var(--r-2);
    box-shadow: var(--shadow-1); }
  form.filters label { display: flex; flex-direction: column; font-size: var(--fs-1); letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted); gap: .35rem; position: relative; }
  /* 控件驯化：去 OS 默认外观、统一圆角描边；hover/focus 微交互（无 JS）。目标 ≥28px（表单控件）。 */
  form.filters select, form.filters input {
    min-height: 32px; padding: .45rem .65rem; font: var(--fs-4)/1.2 var(--font-ui); color: var(--ink);
    background: var(--surface); border: 1px solid var(--border-control); border-radius: var(--r-1);
    transition: border-color .15s ease; }
  form.filters select { appearance: none; -webkit-appearance: none; padding-right: 1.8rem; cursor: pointer; }
  form.filters label:has(select)::after {                 /* CSS 自绘下拉箭头（替代 OS 原生箭头） */
    content: ""; position: absolute; right: .75rem; bottom: .85rem; pointer-events: none;
    width: .42rem; height: .42rem; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
    transform: rotate(45deg); }
  form.filters select:hover, form.filters input:hover { border-color: var(--muted); }
  form.filters select:focus, form.filters input:focus { border-color: var(--accent); }
  form.filters input::placeholder { color: var(--muted); }
  form.filters button { min-height: 32px; padding: .5rem 1.4rem; font: 600 var(--fs-4)/1 var(--font-ui); color: #fff;
    background: var(--accent); border: 1px solid var(--accent); border-radius: var(--r-1); cursor: pointer;
    transition: filter .15s ease, transform .05s ease; }             /* 签名蓝填充、白字 6.7:1 */
  form.filters button:hover { filter: brightness(1.08); }
  form.filters button:active { transform: translateY(1px); }
  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: .5rem; padding: 0; margin: 0 0 1.5rem; }
  .chip { display: inline-flex; align-items: center; gap: .4rem; min-height: 28px;   /* ≥24px（2.5.8） */
    padding: .3rem .75rem; background: var(--surface); border: 1px solid var(--border-control); border-radius: 999px;
    text-decoration: none; font-size: var(--fs-2); color: var(--ink);
    transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
  .chip:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .chip[aria-current="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }  /* 白字 6.7:1 */
  .chip[aria-current="true"]:hover { filter: brightness(1.08); color: #fff; }
  /* 比价表 = 抬升 surface 卡；Reflow（1.4.10/1.4.4）：仅 <table> 保留单向横滚，面板本身不产生第二处横滚。 */
  .table-scroll { overflow-x: auto; max-width: 100%; margin: 0 0 2rem; background: var(--surface);
    border: 1px solid var(--ring); border-radius: var(--r-2); box-shadow: var(--shadow-1); padding: .4rem .9rem 1rem; }
  table { border-collapse: collapse; width: 100%; min-width: 720px; margin: 0; background: transparent; }
  caption { text-align: left; font-family: var(--font-display); font-weight: 700; font-size: var(--fs-6);
    color: var(--ink); padding: .9rem .2rem .6rem; border-bottom: 2px solid var(--accent); margin-bottom: .2rem; }
  th, td { border: 0; border-bottom: 1px solid var(--hair); padding: .8rem .7rem; text-align: left; vertical-align: top; }
  thead th { border-bottom: 2px solid var(--ink); font-size: var(--fs-1); font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted); white-space: nowrap; padding-top: .5rem; padding-bottom: .5rem; }
  th[scope="row"] { position: sticky; left: 0; background: var(--surface);
    font-family: var(--font-display); font-weight: 600; font-size: var(--fs-5); }   /* 套餐名：稍大偏重 */
  tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
  tbody tr:hover > td, tbody tr:hover > th[scope="row"] { background: #f6f8fc; transition: background-color .12s ease; }
  .row-discontinued:hover > td, .row-discontinued:hover > th[scope="row"] { background: #eef0f3; }
  /* 月价 / 折算：Hanken Grotesk tabular 数字，中号偏重（非巨号 hero-metric）；数字对齐可竖读 */
  .price { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 600;
    font-size: var(--fs-5); white-space: nowrap; letter-spacing: -.01em; }
  /* 徽标 = 文字标签 + CSS 绘制记号（记号见下 ::before 段，纯装饰/不承载可及名）：文字承载状态。 */
  .badge { display: inline-flex; align-items: center; gap: .1rem; font-size: var(--fs-1); font-weight: 700;
    letter-spacing: .01em; white-space: nowrap; padding: .05rem .2rem; }
  .badge-cheap { color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: .12rem .5rem; }  /* accent 文本 on accent-soft 6.0:1 */
  .badge-best-period { color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: .05rem .45rem; font-weight: 600; }
  .badge-stale { color: var(--state-stale); }        /* 陈旧红 7.75:1 */
  .badge-review { color: var(--state-estimate); }    /* 待复核琥珀 5.9:1 */
  .badge-estimate { color: var(--state-estimate); }  /* 估算琥珀 5.9:1 */
  .badge-discontinued { color: var(--state-discontinued); font-weight: 600; }  /* 已停售：中性（+整行降权+删除线承载） */
  .badge-unknown { color: var(--state-discontinued); font-weight: 600; }        /* 状态未知：次级 */
  /* ── CSS 绘制状态记号（弃 emoji）：伪元素、aria-hidden 由标签本身不含记号保证；形状尽量可辨、语义状态 ramp 上色。
     forced-colors 下这些装饰记号由系统调色板重着色（不 pin 自定义色），状态始终由文字标签承载（见文末 @media forced-colors）。 */
  .age-today::before, .age-days::before, .age-unchecked::before,
  .badge-stale::before, .badge-review::before, .badge-estimate::before,
  .badge-cheap::before, .badge-best-period::before,
  .badge-discontinued::before, .badge-unknown::before {
    content: ""; display: inline-block; width: .62em; height: .62em; margin-right: .42em; flex: none; }
  .age-today::before { border-radius: 50%; background: var(--state-fresh); }                 /* 今日：实心圆（绿） */
  .age-days::before { border-radius: 50%; border: .13em solid var(--muted); }                /* N天前：空心环（灰） */
  .age-unchecked::before { border-radius: 50%; border: .12em dashed var(--muted); }          /* 待核：虚线空心环 */
  .badge-stale::before { background: var(--state-stale); transform: rotate(45deg); }         /* 陈旧：实心菱形（红） */
  .badge-review::before, .badge-estimate::before {                                            /* 待复核/估算：实心三角（琥珀，警示） */
    width: 0; height: 0; margin-right: .42em; background: transparent;
    border-left: .34em solid transparent; border-right: .34em solid transparent;
    border-bottom: .56em solid var(--state-estimate); }
  .badge-cheap::before { border-radius: 50%; background: var(--accent); }                     /* 最划算 实心圆（签名蓝） */
  .badge-best-period::before { border-radius: 50%; border: .14em solid var(--accent); }       /* 最佳周期：空心环（签名蓝） */
  .badge-discontinued::before { background: var(--state-discontinued); }                      /* 已停售：实心方块（灰） */
  .badge-unknown::before { border: .13em solid var(--state-discontinued); transform: rotate(45deg); } /* 未知：空心菱形（灰） */
  .price-struck { text-decoration: line-through; text-decoration-thickness: 1.5px; color: var(--muted); }
  /* 停售行降权：淡冷灰底 + 次级文字（≥4.5:1）；状态靠「已停售」+ 删除线承载，灰仅装饰。主行 + 详情行同挂。 */
  .row-discontinued td, .row-discontinued th { background: #f2f4f7; color: #4a4d52; }
  .row-discontinued th[scope="row"] { background: #eceff3; }
  .age-today { color: var(--state-fresh); font-weight: 600; }   /* 今日：墨绿 9.4:1 */
  .age-days { color: #4a4d52; }                      /* N天前：中性暗灰（非告警）7.9:1 */
  .age-unchecked, .unchecked { color: var(--muted); font-style: italic; }
  summary { min-height: 24px; cursor: pointer; }     /* ≥24px（2.5.8） */
  /* 详情抽屉条：小字次级、+/− 记号；prefers-reduced-motion 关动画。 */
  details > summary { list-style: none; display: inline-flex; align-items: center; gap: .4rem;
    color: var(--muted); font-size: var(--fs-2); letter-spacing: .01em; padding: .3rem .2rem; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: ""; display: inline-block; width: .55em; height: .55em; flex: none;
    background: var(--accent);
    -webkit-mask: linear-gradient(var(--accent) 0 0) center/100% 2px no-repeat, linear-gradient(var(--accent) 0 0) center/2px 100% no-repeat;
    mask: linear-gradient(#000 0 0) center/100% 2px no-repeat, linear-gradient(#000 0 0) center/2px 100% no-repeat;
    transition: transform .15s ease; }               /* ＋号（两条线）；[open] 收成 － */
  details[open] > summary::before {
    -webkit-mask: linear-gradient(var(--accent) 0 0) center/100% 2px no-repeat;
    mask: linear-gradient(#000 0 0) center/100% 2px no-repeat; }
  @media (prefers-reduced-motion: reduce) { details > summary::before { transition: none; } }
  /* 详情内容防撑歪（spec F5）：colspan 单元格 + 内部长文本 overflow-wrap:anywhere + min-width:0。 */
  .detail-cell { overflow-wrap: anywhere; padding-top: .2rem; padding-bottom: 1rem; }
  .detail-cell, .detail-cell dd, .detail-cell dt { min-width: 0; }
  /* 详情分区 <dl>：MUST NOT 对 <dl> 本身用 display:grid/flex（Safari/VO 丢 list role）；grid 落在 wrapper .detail-row 上。 */
  .detail-dl { margin: .3rem 0 0; padding: .7rem .9rem; background: var(--surface-sunken); border: 1px solid var(--hair); border-radius: var(--r-1); }
  .detail-row { display: grid; grid-template-columns: 6.5rem 1fr; gap: .25rem 1.2rem; padding: .45rem 0;
    border-top: 1px solid var(--hair); overflow-wrap: anywhere; }
  .detail-row:first-child { border-top: 0; padding-top: 0; }
  .detail-row dt { font-size: var(--fs-1); font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); }
  .detail-row dd { margin: 0; }
  .detail-row ul { margin: .1rem 0; padding-left: 1.1rem; }
  @media (max-width: 560px) { .detail-row { grid-template-columns: 1fr; } }  /* 窄屏堆叠 */
  /* 目标尺寸（2.5.8）：排序控件独立点击区 ≥24px。 */
  .sort-link { display: inline-block; min-height: 24px; padding: .15rem .4rem; font-weight: 400;
    text-transform: none; letter-spacing: 0; }
  /* 估算轮次：视觉次于官方额度（小字次级色），文字承载「估算」。 */
  .estimate { margin: .35rem 0 0; font-size: var(--fs-2); color: var(--muted); }
  .estimate-note { color: var(--muted); }
  /* forced-colors（Windows 高对比）兜底：面板真实 border 承载分隔、focus outline 仍可见。
     装饰记号 MUST NOT pin 自定义色——交给 forced-colors 以系统调色板重着色（形状仍在、状态由文字标签承载），
     尊重用户的高对比主题；不设 forced-color-adjust: none。 */
  @media (forced-colors: active) {
    form.filters, .table-scroll, .chip, .detail-dl,
    .answer-card, .rec-section, .evidence-drawer { border: 1px solid; }
  }

  /* ── 答案优先层 v3「深色定论面板 + 排名账本」──────────────────────────────────────────────────
     答案卡=**深色定论面板**（--brand-navy #0e1424 深底 → 答案作独立高级材质、一锤定音；on-navy 16.8:1/
     on-navy-muted 10:1/accent-lift 7.4:1/fit 浅色变体 ≥9:1 均实测）。备选=账本行平铺于 page-bg（--ink 15.6:1/
     --muted 6.3:1），层级分明：深色答案 ≫ 浅色账本。价格作 tabular 锚数字、accent-lift chip。mobile-first：默认单列、
     宽屏面板头双栏；320px 无表外双向横滚。状态记号 CSS 绘制 + 文字（无 emoji）。 */
  .answer-card { position: relative; background: var(--brand-navy); border: 1px solid var(--brand-navy);
    border-radius: 14px; color: var(--on-navy);
    box-shadow: 0 22px 48px -18px rgba(14,20,36,.55), 0 4px 14px rgba(14,20,36,.28);
    padding: 1.55rem 1.6rem; margin: 0 0 1.9rem; overflow: hidden; }
  @media (min-width: 720px) { .answer-card { padding: 2rem 2.2rem; } }
  .answer-card a { color: var(--accent-lift); }                                                /* 深底链接 7.4:1 */
  /* 深色面板上焦点环改用 accent-lift（#7aa2ff 对 brand-navy 7.4:1）；默认 --accent(#1d4ed8) 对深底仅 2.74:1，破 WCAG 2.4.11/1.4.11 */
  .answer-card a:focus-visible, .answer-card [tabindex]:focus-visible { outline-color: var(--accent-lift); }
  .answer-card .muted { color: var(--on-navy-muted); }                                         /* 置信度等 10:1 */
  .answer-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: .5rem 1.6rem; padding-bottom: 1.1rem; border-bottom: 1px solid var(--brand-navy-hair); }
  .answer-lede { flex: 1 1 58%; min-width: 12rem; }
  .answer-verdict { margin: 0 0 .7rem; }
  .verdict-chip { display: inline-flex; align-items: center; gap: .45em; background: var(--accent-lift); color: var(--brand-navy);
    font-size: var(--fs-1); font-weight: 800; letter-spacing: .04em; padding: .32em .8em; border-radius: 999px; }  /* navy on accent-lift 7.4:1 */
  .verdict-chip::before { content: ""; width: .46em; height: .46em; border-radius: 50%; background: var(--brand-navy); }
  .answer-title { font-family: var(--font-display); font-size: var(--fs-7); line-height: 1.1; font-weight: 700;
    letter-spacing: -.02em; margin: 0; color: var(--on-navy); text-wrap: balance; }             /* on-navy 16.8:1 */
  .answer-vendor { font-size: var(--fs-4); font-weight: 400; letter-spacing: 0; color: var(--on-navy-muted); }  /* 10:1 */
  .answer-figure { flex: 0 0 auto; margin: 0; text-align: right; white-space: nowrap; }
  .answer-cost { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 2.55rem; line-height: 1;
    font-weight: 700; letter-spacing: -.02em; color: var(--on-navy); }                          /* on-navy 16.8:1 */
  .answer-unit { font-size: var(--fs-4); font-weight: 500; color: var(--on-navy-muted); margin-left: .12em; }
  .answer-fit { margin: 1.1rem 0 0; }
  .answer-reasons { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: .5rem;
    color: var(--on-navy); font-size: var(--fs-3); line-height: 1.5; }                          /* on-navy 16.8:1 */
  .answer-reasons li { position: relative; padding-left: 1.15rem; }
  .answer-reasons li::before { content: ""; position: absolute; left: .12rem; top: .58em; width: .34rem; height: .34rem;
    border-radius: 50%; background: var(--accent-lift); }                                       /* accent-lift 记号 */
  .answer-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .7rem; margin: 1.2rem 0 0;
    padding-top: .95rem; border-top: 1px solid var(--brand-navy-hair); font-size: var(--fs-2); color: var(--on-navy-muted); }  /* 10:1 */
  .answer-meta-sep { color: var(--brand-navy-hair); }
  .answer-card .badge-stale { color: var(--on-navy-exceeds); }                                  /* 深底陈旧标 9.2:1 */
  /* thin-data 撞窗未知警告：一等公民、DOM 序先于结论；深底琥珀 #ffcf85 on #1a2236 实测 11:1 */
  .answer-warn { margin: 0 0 1.15rem; padding: .62rem .9rem; font-size: var(--fs-3); font-weight: 600;
    color: var(--on-navy-estimate); background: var(--brand-navy-2); border: 1px solid rgba(255,207,133,.4); border-radius: var(--r-1); }
  /* fitsWindow 结论徽标（CSS 记号 + 文字）——默认浅面（备选账本/表）用深色 state；深色答案面板内用浅色变体（scoped） */
  .badge-fits { color: var(--state-fresh); }                                                    /* on #fff/page-bg ≥5.5:1 */
  .badge-exceeds { color: var(--state-stale); }
  .badge-unknown-fit { color: var(--state-estimate); }
  .answer-card .badge-fits { color: var(--on-navy-fresh); }                                     /* 深底浅绿 10:1 */
  .answer-card .badge-exceeds { color: var(--on-navy-exceeds); }                                /* 深底浅红 9.2:1 */
  .answer-card .badge-unknown-fit { color: var(--on-navy-estimate); }                           /* 深底浅琥珀 12.7:1 */
  .badge-fits::before, .badge-exceeds::before, .badge-unknown-fit::before {
    content: ""; display: inline-block; width: .62em; height: .62em; margin-right: .42em; flex: none; }
  .badge-fits::before { border-radius: 50%; background: var(--state-fresh); }                 /* 实心圆（绿） */
  .badge-exceeds::before { background: var(--state-stale); transform: rotate(45deg); }        /* 实心菱形（红） */
  .badge-unknown-fit::before { width: 0; height: 0; margin-right: .42em; background: transparent;
    border-left: .34em solid transparent; border-right: .34em solid transparent; border-bottom: .56em solid var(--state-estimate); }  /* 实心三角（琥珀） */
  .answer-card .badge-fits::before { background: var(--on-navy-fresh); }
  .answer-card .badge-exceeds::before { background: var(--on-navy-exceeds); }
  .answer-card .badge-unknown-fit::before { border-bottom-color: var(--on-navy-estimate); }
  /* 深色面板内的新鲜度 age 徽标（AgeBadgeView）：浅色变体，记号同步 */
  .answer-card .age-today { color: var(--on-navy-fresh); }
  .answer-card .age-today::before { background: var(--on-navy-fresh); }
  .answer-card .age-days, .answer-card .age-unchecked { color: var(--on-navy-muted); }
  .answer-card .age-days::before, .answer-card .age-unchecked::before { border-color: var(--on-navy-muted); }
  /* 一处克制的品牌动效：深色定论面板 load 时轻抬入（reduced-motion 关） */
  @media (prefers-reduced-motion: no-preference) {
    .answer-card { animation: verdict-in .6s cubic-bezier(.22,.61,.36,1) both; }
  }
  @keyframes verdict-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  /* 备选=排名账本行（非卡网格）：rank 索引 + 名称 + 右对齐 tabular 价格 + fit/来源 副行；发丝线分隔，平铺 page-bg */
  .section-heading { font-family: var(--font-ui); font-size: var(--fs-2); font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: var(--muted); margin: 0 0 .5rem; }                        /* muted on page-bg 6.3:1 */
  .alt-section { margin: 0 0 1.75rem; }
  .alt-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--hair); }
  .alt-row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; column-gap: .95rem;
    row-gap: .2rem; padding: .9rem .1rem; border-bottom: 1px solid var(--hair); }
  .alt-name { grid-column: 1; font-family: var(--font-display); font-size: var(--fs-4); font-weight: 600;
    color: var(--ink); min-width: 0; }                                                          /* ink 15.6:1 */
  .alt-vendor { font-family: var(--font-ui); font-size: var(--fs-3); font-weight: 400; color: var(--muted); }
  .alt-cost { grid-column: 2; grid-row: 1; text-align: right; font-family: var(--font-num); font-variant-numeric: tabular-nums;
    font-size: var(--fs-5); font-weight: 700; color: var(--ink); white-space: nowrap; }
  .alt-unit { font-size: var(--fs-2); font-weight: 500; color: var(--muted); }
  .alt-sub { grid-column: 1 / 3; display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .7rem; font-size: var(--fs-2); color: var(--muted); }
  .alt-overflow { margin: .85rem 0 0; font-size: var(--fs-3); }
  /* ── 推荐说明 = 结构化候选表（从 structured candidates 渲染、非解析 explanation 串）：逐候选 判级/月成本/撞窗/缘由，
     含未入选（不推荐/待核）行、判级 CSS 上色无 emoji；表在 --surface 卡（#fff → A 已验对比复用）、.table-scroll 单向横滚 reflow。
     引擎完整 explanation 原文折叠保留于表下（thin-data：原样、不裁剪）。 */
  .rec-section { background: var(--surface); border: 1px solid var(--ring); border-radius: var(--r-2); box-shadow: var(--shadow-1);
    padding: 1.1rem 1.3rem 1.2rem; margin: 0 0 1.75rem; }
  .rec-section .section-heading { margin: 0 0 .4rem; }
  .rec-caption { caption-side: top; text-align: left; font-size: var(--fs-2); color: var(--muted); margin-bottom: .6rem; }  /* muted 6.8:1 */
  .rec-table { width: 100%; border-collapse: collapse; font-size: var(--fs-3); min-width: 620px; }
  .rec-table thead th { text-align: left; font-size: var(--fs-1); font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); padding: .35rem .7rem .55rem; border-bottom: 1px solid var(--ring); white-space: nowrap; }
  .rec-table tbody th, .rec-table tbody td { text-align: left; padding: .7rem .7rem; border-bottom: 1px solid var(--hair);
    vertical-align: top; color: var(--ink); font-weight: 400; }                                   /* ink 16.8:1 */
  .rec-table tbody tr:last-child th, .rec-table tbody tr:last-child td { border-bottom: 0; }
  .rec-plan { font-family: var(--font-display); font-weight: 600; }
  .rec-vendor { font-weight: 400; color: var(--muted); }                                          /* muted 6.8:1 */
  .rec-table thead th.rec-col-cost, .rec-table td.rec-cost { text-align: right; white-space: nowrap; }
  .rec-cost { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 700; }
  .rec-reason { color: var(--muted); max-width: 36ch; line-height: 1.5; }                          /* muted 6.8:1 */
  .v-badge { display: inline-flex; align-items: center; gap: .4em; font-weight: 700; font-size: var(--fs-2); white-space: nowrap; }
  .v-badge::before { content: ""; width: .5em; height: .5em; border-radius: 50%; flex: none; }
  .v-primary { color: var(--accent); } .v-primary::before { background: var(--accent); }          /* accent 6.7:1 */
  .v-alt { color: var(--ink); } .v-alt::before { background: var(--accent); }                      /* ink 16.8:1，点用 accent */
  .v-no { color: var(--state-stale); } .v-no::before { background: var(--state-stale); }           /* 7.75:1 */
  .v-pend { color: var(--state-estimate); } .v-pend::before { background: var(--state-estimate); } /* 5.9:1 */
  /* 引擎完整说明原文（折叠、从属；原样透传、pre-line 保换行）——后代选择器绕开内联 style 的 > 转义 */
  .explanation-note { margin: 1rem 0 0; }
  .explanation-note summary { color: var(--muted); font-size: var(--fs-2); font-weight: 600; }     /* muted 6.8:1 */
  .explanation-body { white-space: pre-line; color: var(--ink); font-size: var(--fs-3); line-height: 1.7; margin-top: .5rem; }  /* ink 16.8:1 */
  /* 「描述你的配置」输入区：fieldset 用响应式 grid 铺满宽度（窄屏 1 列 / 平板 2 / 桌面 3），legend 跨整行给组语义
     （1.3.1/3.3.2），控件填满各自 cell。注：内联 style 里 hono/jsx 会把子代组合器（大于号）转义成实体而失效，故本区
     一律用**后代选择器**（空格；此处无嵌套 fieldset/label/button，语义等价、不误伤）。 */
  form.setup-form { display: block; padding: 1.4rem 1.5rem; }          /* 覆盖 form.filters 的 flex（element+class 特指度）：让 fieldset 独占整宽 */
  form.setup-form fieldset { display: grid; grid-template-columns: 1fr; gap: .9rem 1.15rem;
    align-items: end; margin: 0; padding: 0; border: 0; min-width: 0; width: 100%; }
  @media (min-width: 560px) { form.setup-form fieldset { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 900px) { form.setup-form fieldset { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .setup-form legend { grid-column: 1 / -1; float: none; width: 100%; padding: 0; margin: 0 0 .2rem; font-family: var(--font-display);
    font-size: var(--fs-5); font-weight: 700; color: var(--ink); }
  .setup-form label { min-width: 0; }
  .setup-form label select, .setup-form label input { width: 100%; }
  .setup-form fieldset button { align-self: end; }
  .setup-form fieldset .chip { align-self: center; justify-self: start; }
  .setup-hint { margin: .9rem 0 0; font-size: var(--fs-2); color: var(--muted); }  /* muted 6.8:1 */
  /* 证据抽屉：比价表原样嵌入；summary 稍抬升为可辨识 affordance（≥24px 由 summary 基线保证） */
  .evidence-drawer { margin: 0 0 2rem; background: var(--surface); border: 1px solid var(--ring);
    border-radius: var(--r-2); box-shadow: var(--shadow-1); padding: .3rem 1rem; }
  /* 用类名而非 evidence-drawer 直接子 summary 选择器：hono/jsx 会把内联 style 里的子代组合符转义使规则失效；
     且抽屉内比价表含嵌套 details/summary 详情行，用后代选择器会误命中，故给抽屉自身 summary 挂类。 */
  .evidence-summary { font-size: var(--fs-3); font-weight: 600; color: var(--ink); padding: .7rem .2rem; }
  .evidence-body { padding: .2rem 0 .6rem; }
`;

/** 徽标：文字标签承载状态 + CSS 绘制记号（`::before`，纯装饰、不承载可及名，spec WCAG ③；无 emoji）。 */
export const AgeBadgeView: FC<{ badge: AgeBadge }> = ({ badge }) => {
  const cls = badge.kind === 'today' ? 'age-today' : badge.kind === 'days' ? 'age-days' : 'age-unchecked';
  return <span class={`badge ${cls}`}>{badge.label}</span>;
};

/** availability 徽标（CSS 记号 + 文字标签）；on_sale 静默由 `availabilityBadge` 返 null 决定，此处只渲实心徽标。 */
const AvailabilityBadgeView: FC<{ badge: AvailabilityBadge }> = ({ badge }) => (
  <span class={`badge ${badge.kind === 'discontinued' ? 'badge-discontinued' : 'badge-unknown'}`}>
    {badge.label}
  </span>
);

/** 套餐名旁的 availability 小标：仅 discontinued/unknown 出标，on_sale → 不渲染（含前导空格由调用点提供）。 */
const AvailabilityTag: FC<{ availability: SnapshotPlan['availability'] }> = ({ availability }) => {
  const badge = availabilityBadge(availability);
  return badge ? <AvailabilityBadgeView badge={badge} /> : null;
};

/**
 * 估算中等任务轮次区间（task 5.1/5.2）：从快照既供限额事实算、视觉次于官方额度（小字次级色）、文字标「估算」（CSS 记号 + 文字，无 emoji）。
 * `limit.value` 为 NULL / 无 token 额度 / 旋钮非正 → `estimateRounds` 返 null → 不输出区间（优雅降级、不 NPE）。
 */
const EstimatedRounds: FC<{ plan: SnapshotPlan; tokensPerRound: number }> = ({ plan, tokensPerRound }) => {
  const est = estimateRounds(plan.limits, tokensPerRound);
  if (!est) return null;
  return (
    <p class="estimate">
      <span class="badge badge-estimate">估算</span>{' '}
      约 {est.low}–{est.high} 轮中等任务
      <span class="estimate-note">（假设每轮 {est.tokensPerRound} tokens，非官方事实）</span>
    </p>
  );
};

/** 页面外壳：lang/title/地标/skip-link/内联样式（task 6.3）。 */
export const PageShell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="zh-Hans">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{PAGE_CSS}</style>
    </head>
    <body>
      <a class="skip-link" href="#main">
        跳到主内容
      </a>
      <header class="site-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <h1 class="brand-name">Model Radar</h1>
          <span class="brand-sub">选型顾问</span>
        </div>
        <p class="brand-tagline">
          给开发者的 AI 编程订阅比价与推荐 —— 先给答案，价格 / 兼容 / 额度逐格可溯源。
        </p>
      </header>
      <main id="main" tabindex={-1}>{children}</main>
    </body>
  </html>
);

/** 已选筛选 chip（aria-current 标已选态 + 移除链接，键盘可清除；task 6.2）。 */
const ActiveFilterChips: FC<{ query: WebQuery }> = ({ query }) => {
  const items: { key: keyof WebQuery; label: string }[] = [];
  if (query.model) items.push({ key: 'model', label: `模型 ${query.model}` });
  if (query.tool) items.push({ key: 'tool', label: `工具 ${query.tool}` });
  if (query.protocol) items.push({ key: 'protocol', label: `协议 ${query.protocol}` });
  if (query.currency) items.push({ key: 'currency', label: `币种 ${query.currency}` });
  if (query.maxMonthlyPrice) items.push({ key: 'maxMonthlyPrice', label: `预算 ${query.maxMonthlyPrice}` });
  if (items.length === 0) return null;
  return (
    <ul class="chips" aria-label="已应用的筛选">
      {items.map((it) => (
        <li>
          <a
            class="chip"
            aria-current="true"
            href={withParams(query as Record<string, string | undefined>, { [it.key]: null })}
            aria-label={`移除筛选：${it.label}`}
          >
            <span aria-hidden="true">×</span>
            {it.label}
          </a>
        </li>
      ))}
    </ul>
  );
};

/** 筛选表单（GET、渐进增强、无 JS 可用；选项预选用原生 `selected`，task 3.1）。 */
export const FilterForm: FC<{ options: FacetOptions; query: WebQuery }> = ({ options, query }) => (
  <form class="filters" method="get" role="search" aria-label="筛选 Coding Plan">
    <label>
      模型
      <select name="model">
        <option value="" selected={!query.model}>
          全部模型
        </option>
        {options.models.map((m) => (
          <option value={m.value} selected={query.model === m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
    <label>
      工具
      <select name="tool">
        <option value="" selected={!query.tool}>
          全部工具
        </option>
        {options.tools.map((t) => (
          <option value={t} selected={query.tool === t}>
            {t}
          </option>
        ))}
      </select>
    </label>
    <label>
      协议
      <select name="protocol">
        <option value="" selected={!query.protocol}>
          全部协议
        </option>
        {options.protocols.map((p) => (
          <option value={p} selected={query.protocol === p}>
            {p}
          </option>
        ))}
      </select>
    </label>
    <label>
      币种
      <select name="currency">
        <option value="" selected={!query.currency}>
          全部币种
        </option>
        {mrCurrencySchema.options.map((c) => (
          <option value={c} selected={query.currency === c}>
            {c}
          </option>
        ))}
      </select>
    </label>
    <label>
      预算上限
      <input
        type="text"
        name="maxMonthlyPrice"
        value={query.maxMonthlyPrice ?? ''}
        placeholder="如 100 CNY"
        inputmode="text"
      />
    </label>
    <label>
      每轮 token（估算用）
      <select name="tokensPerRound">
        {TOKENS_PER_ROUND_OPTIONS.map((opt) => (
          <option value={String(opt.value)} selected={resolveTokensPerRound(query.tokensPerRound) === opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
    {/* 透传当前排序，使提交筛选不丢失新鲜度排序 */}
    {query.sort ? <input type="hidden" name="sort" value={query.sort} /> : null}
    <button type="submit">应用筛选</button>
    <a class="chip" href="/model-radar">
      重置
    </a>
  </form>
);

/**
 * source_url 链接——**全页唯一 `safeHref` 渲染点**（单一 XSS 闸，易审计）：
 * 经 scheme 闸过则渲可点 `<a>`，危险/畸形 scheme（javascript:/data: 等）降级纯文本（design D7）。
 */
export const SourceLink: FC<{ url: string }> = ({ url }) => {
  const href = safeHref(url);
  return href ? (
    <a href={href} rel="noopener noreferrer">
      查看来源（{sourceHost(href)}）
    </a>
  ) : (
    <span class="muted">来源（不可链接）：{url}</span>
  );
};

/** 单条事实 provenance 行（source 链接 + age 徽标 + confidence）。 */
const ProvenanceLine: FC<{ label: string; prov: SnapshotProvenance; now: Date }> = ({ label, prov, now }) => (
  <li>
    <strong>{label}</strong>：{' '}
    <SourceLink url={prov.sourceUrl} />{' '}
    <span class="muted">置信度 {prov.sourceConfidence}</span>{' '}
    <AgeBadgeView badge={ageBadge(prov.lastCheckedDate, now)} />
  </li>
);

/** 溯源列表：每条价/兼容/额度事实 + 关联源的 provenance（逐条 age，task 2.5）；供详情 `<dl>` 的「溯源」段用。 */
const ProvenanceList: FC<{ plan: SnapshotPlan; now: Date }> = ({ plan, now }) => (
  <ul>
    <ProvenanceLine label="价格" prov={plan.provenance} now={now} />
    {plan.periodPrices.map((pp) => (
      <ProvenanceLine label={`${PERIOD_LABELS[pp.billingPeriod]}价（${pp.currency}）`} prov={pp.provenance} now={now} />
    ))}
    {plan.models.map((m) => (
      <ProvenanceLine label={`模型 ${modelLabel(m.family, m.version)}`} prov={m.provenance} now={now} />
    ))}
    {plan.clients.map((c) => (
      <ProvenanceLine label={`${c.clientType === 'tool' ? '工具' : '协议'} ${c.clientId}`} prov={c.provenance} now={now} />
    ))}
    {plan.limits.map((l) => (
      <ProvenanceLine label={`额度 ${l.limitType}`} prov={l.provenance} now={now} />
    ))}
    {plan.sources.map((s) => (
      <li>
        <strong>关联源（{s.fetchStrategy}）</strong>：{' '}
        <SourceLink url={s.sourceUrl} />{' '}
        <AgeBadgeView badge={ageBadge(s.lastCheckedDate, now)} />
      </li>
    ))}
  </ul>
);

/**
 * 全宽详情（task 2.2/2.5）：原生 `<details>`（无 JS），`<summary>` 携带 plan 名（SR 可区分，F2）；
 * 分区 `<dl>`（模型/工具·协议/额度/季·年付明细/溯源），每 `<dt>+<dd>` 对包一层 `.detail-row` wrapper——
 * `<dl>` 本身不 `display:grid`（防 Safari/VO 丢 list role，M-b）。无数据段用 `—` 占位、不渲染空 `<dd>`（F8）。
 * 季/年付明细复用 `periodPriceLine`（不内联 age）、获胜档挂「最佳周期」记号（CSS 绘制，三元谓词定位，与 `bestPeriod` 一致）；溯源逐条 age。
 */
const PlanDetails: FC<{ plan: SnapshotPlan; now: Date; tokensPerRound: number }> = ({ plan, now, tokensPerRound }) => {
  const winner = bestPeriod(plan);
  return (
    <details>
      <summary>{plan.name} 详情</summary>
      <dl class="detail-dl">
        <div class="detail-row">
          <dt>模型</dt>
          <dd>
            {plan.models.length === 0 ? (
              <span class="muted">—</span>
            ) : (
              plan.models.map((m) => <div>{modelLabel(m.family, m.version)}</div>)
            )}
          </dd>
        </div>
        <div class="detail-row">
          <dt>工具 / 协议</dt>
          <dd>
            {plan.clients.length === 0 ? (
              <span class="muted">—</span>
            ) : (
              plan.clients.map((c) => (
                <div>
                  {c.clientType === 'tool' ? '工具' : '协议'}：{c.clientId}
                </div>
              ))
            )}
          </dd>
        </div>
        <div class="detail-row">
          <dt>额度</dt>
          <dd>
            {plan.limits.length === 0 ? (
              <span class="muted">—</span>
            ) : (
              plan.limits.map((l) => (
                <div>
                  {l.limitType}：{l.value ?? '不限 / 待定'} / {l.window}
                </div>
              ))
            )}
            <EstimatedRounds plan={plan} tokensPerRound={tokensPerRound} />
          </dd>
        </div>
        <div class="detail-row">
          <dt>季 / 年付明细</dt>
          <dd>
            {plan.periodPrices.length === 0 ? (
              <span class="muted">—</span>
            ) : (
              plan.periodPrices.map((pp) => (
                <div>
                  {periodPriceLine(pp)}
                  {winner !== null &&
                  pp.billingPeriod === winner &&
                  pp.currency === plan.currency &&
                  pp.priceStatus === 'known' ? (
                    <>
                      {' '}
                      <span class="badge badge-best-period">最佳周期</span>
                    </>
                  ) : null}
                </div>
              ))
            )}
          </dd>
        </div>
        <div class="detail-row">
          <dt>溯源</dt>
          <dd>
            <ProvenanceList plan={plan} now={now} />
          </dd>
        </div>
      </dl>
    </details>
  );
};

/**
 * 月价主列（瘦身，task 2.3/2.7）：只留 canonical 月价（`.price` 等宽 tabular「数字+币种」+ 停售删除线）+ 最划算（CSS 记号 + 文字）。
 * 季/年付子行、per-fact age 已移出——季年付进详情「季/年付明细」段、age 归主行新鲜度列 + 详情溯源段。
 * 月价段保留 `currentPrice!==null && currency!==null` null-format 守卫（防 SSR NPE），待核显「待核」。
 */
const PriceCell: FC<{ plan: SnapshotPlan; isCheapest: boolean }> = ({ plan, isCheapest }) => {
  const struck = plan.availability === 'discontinued';
  return (
    <td>
      {plan.priceStatus === 'known' && plan.currentPrice !== null && plan.currency !== null ? (
        <>
          <span class={struck ? 'price price-struck' : 'price'}>
            {plan.currency} {plan.currentPrice}
          </span>
          {isCheapest ? (
            <>
              {' '}
              <span class="badge badge-cheap">最划算</span>
            </>
          ) : null}
        </>
      ) : (
        <span class="unchecked">待核</span>
      )}
    </td>
  );
};

/**
 * 最佳周期主列（task 2.4）：命中 → `{周期名} ≈{价 token}/月`，价 token（数字+币种）进等宽 `.price` span、
 * 中文周期标签与 `/月` 在 span 外（防 CJK monospace 方块，NEW-1）；判定/文案复用 `bestPeriodSummary`（内走 `bestPeriod` 口径）。
 * null → `—`（次级灰、诚实留白）。
 */
const BestPeriodCell: FC<{ plan: SnapshotPlan }> = ({ plan }) => {
  const summary = bestPeriodSummary(plan);
  return (
    <td>
      {summary ? (
        <>
          {summary.periodLabel} ≈<span class="price">{summary.priceToken}</span>/月
        </>
      ) : (
        <span class="muted">—</span>
      )}
    </td>
  );
};

/**
 * 新鲜度主列（task 2.1/2.6）：plan 最旧事实 age 徽标 + 陈旧态（CSS 记号 + 文字，读 plan 级 `freshness.stale`，非由 age 天数反推）。
 * 二者为各自独立元素、文字标签分隔（不拼成单 token），使屏幕阅读器分别读出（n-c）。
 */
const FreshnessCell: FC<{ plan: SnapshotPlan; now: Date }> = ({ plan, now }) => (
  <td>
    <AgeBadgeView badge={oldestFactBadge(plan, now)} />
    {plan.freshness.stale ? (
      <>
        {' '}
        <span class="badge badge-stale">陈旧</span>
      </>
    ) : null}
  </td>
);

function modelLabel(family: string, version: string): string {
  return version === '' ? family : `${family}:${version}`;
}

/** 排序方向链接（方向性可访问名，task 6.1）。 */
const SortLinks: FC<{ query: WebQuery; kind: 'price' | 'fresh' }> = ({ query, kind }) => {
  const q = query as Record<string, string | undefined>;
  if (kind === 'price') {
    return (
      <a class="sort-link" href={withParams(q, { sort: null })} aria-label="按价格升序排序">
        价格升序
      </a>
    );
  }
  return (
    <>
      <a class="sort-link" href={withParams(q, { sort: 'stale' })} aria-label="按数据新鲜度排序，最陈旧优先">
        最陈旧优先
      </a>{' '}
      <a class="sort-link" href={withParams(q, { sort: 'fresh' })} aria-label="按数据新鲜度排序，最新核对优先">
        最新优先
      </a>
    </>
  );
};

/** 单个 (category,currency) 组的比价表（原生 table + caption + th scope + aria-sort，task 6.1）。 */
const GroupTable: FC<{
  group: SnapshotPlanGroup;
  unknownInCategory: number;
  query: WebQuery;
  sort?: FreshnessSort;
  now: Date;
  tokensPerRound: number;
}> = ({ group, unknownInCategory, query, sort, now, tokensPerRound }) => {
  const known = group.sortScope.currency !== null;
  const info = cheapestInfo(group, unknownInCategory);
  const plans = sort ? sortPlansByFreshness(group.plans, sort) : group.plans;
  const cheapestName = info.cheapestPlanId
    ? group.plans.find((p) => p.id === info.cheapestPlanId)?.name
    : undefined;

  const caption = known ? (
    <>
      Coding Plan · {group.sortScope.currency} ·{' '}
      {info.showCheapest ? (
        <span>
          最划算：{cheapestName}（已核价中最低）
          {info.unknownCount > 0 ? <span class="muted">；另有 {info.unknownCount} 个未核价未参与</span> : null}
        </span>
      ) : (
        <span class="muted">
          已核价不足 2，暂不评最划算
          {info.unknownCount > 0 ? <span>（{info.unknownCount} 个待核）</span> : null}
        </span>
      )}
    </>
  ) : (
    <>
      Coding Plan · 未核价 ·{' '}
      <span class="muted">暂不参与最划算比较（{group.plans.length} 项待核）</span>
    </>
  );

  // aria-sort：仅已核组默认价格升序（query 保证同币种组价升序）；未核组无意义价序 / freshness 排序时 → none。
  const priceSort = !known || sort ? 'none' : 'ascending';
  const freshSort = sort === 'stale' ? 'ascending' : sort === 'fresh' ? 'descending' : 'none';
  const scopeLabel = known ? `Coding Plan ${group.sortScope.currency}` : 'Coding Plan 未核价';

  return (
    <div class="table-scroll" role="group" tabindex={0} aria-label={`比价表：${scopeLabel}（可横向滚动）`}>
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">套餐</th>
          <th scope="col">厂商</th>
          <th scope="col" aria-sort={priceSort}>
            月价 <SortLinks query={query} kind="price" />
          </th>
          <th scope="col">最佳周期</th>
          <th scope="col" aria-sort={freshSort}>
            数据新鲜度 <SortLinks query={query} kind="fresh" />
          </th>
        </tr>
      </thead>
      <tbody>
        {plans.map((p) => {
          const discontinued = p.availability === 'discontinued';
          const rowClass = discontinued ? 'row-discontinued' : undefined;
          return (
            <>
              <tr class={rowClass}>
                <th scope="row" id={`plan-${p.id}`}>
                  {p.name} <AvailabilityTag availability={p.availability} />
                  {p.reviewStatus.pending ? (
                    <>
                      {' '}
                      <span class="badge badge-review">待复核</span>
                    </>
                  ) : null}
                </th>
                <td>{p.vendorName}</td>
                <PriceCell plan={p} isCheapest={info.showCheapest && p.id === info.cheapestPlanId} />
                <BestPeriodCell plan={p} />
                <FreshnessCell plan={p} now={now} />
              </tr>
              <tr class={rowClass}>
                <td class="detail-cell" colspan={5} aria-labelledby={`plan-${p.id}`}>
                  <PlanDetails plan={p} now={now} tokensPerRound={tokensPerRound} />
                </td>
              </tr>
            </>
          );
        })}
      </tbody>
    </table>
    </div>
  );
};

/**
 * 证据抽屉（answer-first 变更 3.1 / design D6）：把变更 A 的比价表 `GroupTable` **原样复用**包进默认折叠的
 * 原生 `<details id="evidence">`（无 JS、`<summary>` 描述性点明内含全部方案对比与依据 → 答 Q1/Q2/Q4，2.4.6）。
 * `#evidence` 为答案区/备选溢出的页内锚点目标。
 *
 * 契约（调用方 model-radar-page.tsx 必守）：传入的 `groups` MUST 只按**召回维度 `{category,model,tool,protocol}`**
 * 查询得到（`queryModelRadarSnapshot`），**MUST NOT 传 `currency`/`maxMonthlyPrice`**——否则 `matchesFilters` 会
 * 滤掉超预算/他币种 plan，使答案区 guidance 引用的落选候选在证据里不可见。表口径/结构/最划算/provenance/A 既有
 * 标级一律不变；**MUST NOT 向 A 表注入 recommend 的 verdict/超预算/撞窗列**（此组件不接收、不渲染任何 verdict）。
 * `query`（WebQuery）仅用于表内排序链接的参数保留（不参与快照过滤）。
 */
export const EvidenceDrawer: FC<{
  groups: SnapshotPlanGroup[];
  unknownInCategory: number;
  query: WebQuery;
  now: Date;
  tokensPerRound: number;
  sort?: FreshnessSort;
}> = ({ groups, unknownInCategory, query, now, tokensPerRound, sort }) => (
  <details id="evidence" class="evidence-drawer">
    <summary class="evidence-summary">查看全部方案对比与依据（含模型 / 工具、新鲜度）</summary>
    <div class="evidence-body">
      {groups.length === 0 ? (
        <p>无匹配 Coding Plan 套餐。可调整「描述你的配置」。</p>
      ) : (
        groups.map((g) => (
          <GroupTable
            group={g}
            unknownInCategory={unknownInCategory}
            query={query}
            {...(sort ? { sort } : {})}
            now={now}
            tokensPerRound={tokensPerRound}
          />
        ))
      )}
    </div>
  </details>
);

/** 比价页主体：筛选 + 已选 chip + 各组表（task 2.4）。 */
export const ComparePage: FC<{
  groups: SnapshotPlanGroup[];
  unknownInCategory: number;
  options: FacetOptions;
  query: WebQuery;
  sort?: FreshnessSort;
  now: Date;
  tokensPerRound: number;
}> = ({ groups, unknownInCategory, options, query, sort, now, tokensPerRound }) => (
  <>
    <FilterForm options={options} query={query} />
    <ActiveFilterChips query={query} />
    {groups.length === 0 ? (
      <p>无匹配 Coding Plan 套餐。可调整或重置筛选。</p>
    ) : (
      groups.map((g) => (
        <GroupTable
          group={g}
          unknownInCategory={unknownInCategory}
          query={query}
          {...(sort ? { sort } : {})}
          now={now}
          tokensPerRound={tokensPerRound}
        />
      ))
    )}
  </>
);
