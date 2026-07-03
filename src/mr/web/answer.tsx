/**
 * Model Radar 答案优先层组件（add-model-radar-answer-first-web，组 1）。
 *
 * **纯呈现层**：把已建好的推荐器 `recommend()` 结果（`RankedCandidate`/`explanation`）渲成答案卡 + 备选卡 +
 * 从属「推荐说明」+「描述你的配置」输入。**零判定**——不重排/不重判/不重算 primary、不手搓 cheapest、不裁剪
 * explanation 剔首选、不提升任何候选为卡（design D2/D3/D4，money-path/DTO 完全不动）。
 * 判定语义全在 `recommend.ts`；本层只映射 verdict/fitsWindow → 文案/记号 + 复用变更 A 的视觉系统与 a11y 契约。
 *
 * XSS：所有候选串经 `hono/jsx` 默认转义；`source_url` 经 `SourceLink`（内含 `safeHref` 单闸，与比价表同闸）。
 */
import type { FC } from 'hono/jsx';
import { mrCurrencySchema } from '../../db/mr-schema.zod.js';
import type { RankedCandidate } from '../recommend/schema.js';
import { AgeBadgeView, SourceLink } from './components.js';
import { ageBadge, displayMonthly, type FacetOptions } from './render.js';

/** 「描述你的配置」表单读到的 setup query（web-only；`usageProfile` 不在快照 schema 内，校验/clamp 在 handler）。 */
export interface SetupQuery {
  model?: string;
  tool?: string;
  protocol?: string;
  currency?: string;
  /** 既有 wire 键名（值形如 `"100 CNY"`），不新造 `budget` 键。 */
  maxMonthlyPrice?: string;
  usageProfile?: string;
}

const USAGE_LABELS: { value: string; label: string }[] = [
  { value: 'light', label: '轻度' },
  { value: 'medium', label: '中度' },
  { value: 'heavy', label: '重度' },
];

const FIT_VIEW = {
  fits: { cls: 'badge-fits', label: '额度够用' },
  exceeds: { cls: 'badge-exceeds', label: '额度不够' },
  unknown: { cls: 'badge-unknown-fit', label: '额度未知' },
} as const;

/** 四态 verdict → 判级标签（纯映射，CSS 上色，无 emoji）。用于「推荐说明」表逐候选判级。 */
const VERDICT_VIEW: Record<RankedCandidate['verdict'], { cls: string; label: string }> = {
  primary: { cls: 'v-primary', label: '首选' },
  alternative: { cls: 'v-alt', label: '备选' },
  not_recommended: { cls: 'v-no', label: '不推荐' },
  insufficient_data: { cls: 'v-pend', label: '待核' },
};

/** fitsWindow 结论徽标（纯映射，CSS 记号 + 文字承载，无 emoji；估算如实标）。 */
const FitConclusion: FC<{ fitsWindow: RankedCandidate['fitsWindow'] }> = ({ fitsWindow }) => {
  const v = FIT_VIEW[fitsWindow];
  return (
    <span class={`badge ${v.cls}`}>
      {v.label}（估算）
    </span>
  );
};

/**
 * 答案卡（hero，唯一 primary，engine 保证至多 1）——「分析师定论」主刊：方案名 lede ↔ 价格锚数字（tabular）双栏头 +
 * `首选推荐` accent chip（非 eyebrow/非顶部色条）+ reasons（accent 记号）+ fitsWindow 结论 + 发丝线 meta 页脚
 * （新鲜度 `stale` + 该候选价格事实 `provenance.lastCheckedDate` age，非聚合「最旧事实」 + provenance 经 `SourceLink`/safeHref）。
 * thin-data（2.5）：`fitsWindow==='unknown'` 时「额度未知」警告在 **DOM/源序上先于**结论元素（非 CSS `order`）。
 */
export const AnswerCard: FC<{ candidate: RankedCandidate; now: Date }> = ({ candidate, now }) => (
  <section class="answer-card" aria-labelledby="answer-heading">
    {/* 撞窗未知警告：一等公民，源序先于下方 fitsWindow 结论元素 */}
    {candidate.fitsWindow === 'unknown' ? (
      <p class="answer-warn" role="note">
        额度未知、无法确认是否够用（估算）
      </p>
    ) : null}
    <div class="answer-head">
      <div class="answer-lede">
        <p class="answer-verdict">
          <span class="verdict-chip">首选推荐</span>
        </p>
        <h2 id="answer-heading" class="answer-title">
          {candidate.name}
          <span class="answer-vendor"> · {candidate.vendorName}</span>
        </h2>
      </div>
      <p class="answer-figure">
        <span class="answer-cost">
          {candidate.currency} {displayMonthly(candidate.monthlyCost ?? 0)}
        </span>
        <span class="answer-unit">/月</span>
      </p>
    </div>
    <p class="answer-fit">
      <FitConclusion fitsWindow={candidate.fitsWindow} />
    </p>
    {candidate.reasons.length > 0 ? (
      <ul class="answer-reasons">
        {candidate.reasons.map((r) => (
          <li>{r.detail}</li>
        ))}
      </ul>
    ) : null}
    <p class="answer-meta">
      <AgeBadgeView badge={ageBadge(candidate.provenance.lastCheckedDate, now)} />
      {candidate.stale ? <span class="badge badge-stale">陈旧</span> : null}
      <span class="answer-meta-sep" aria-hidden="true">·</span>
      <SourceLink url={candidate.provenance.sourceUrl} />
      <span class="muted">置信度 {candidate.provenance.sourceConfidence}</span>
    </p>
  </section>
);

/**
 * 「推荐说明」区（**所有状态**的答案区从属）：**原样**渲染引擎 `result.explanation`（全量逐候选叙述、含首选复述 +
 * 备选 + 落选 + guidance）。容器 `white-space: pre-line` 保 `\n`/`\n\n`（CSS 已置）。
 * `hasPrimary=false`（无 primary）→ 醒目卡、唯一答案内容；`hasPrimary=true` → 折叠 `<details>`（视觉次于答案卡、
 * label「推荐说明」，不作竞争的第二答案）。**MUST NOT** 裁剪/解析该串剔首选、MUST NOT 提升候选为卡（thin-data 红线）。
 */
export const ExplanationNote: FC<{ candidates: RankedCandidate[]; explanation: string; hasPrimary: boolean }> = ({
  candidates,
  explanation,
  hasPrimary,
}) => (
  <section class="rec-section" aria-labelledby="rec-heading">
    <h2 id="rec-heading" class="section-heading">
      推荐说明
    </h2>
    {candidates.length > 0 ? (
      <div class="table-scroll" role="group" aria-label="全部候选与判级" tabindex={0}>
        <table class="rec-table">
          <caption class="rec-caption">各候选的判级与缘由（含未入选原因）</caption>
          <thead>
            <tr>
              <th scope="col">判级</th>
              <th scope="col">方案</th>
              <th scope="col" class="rec-col-cost">月成本</th>
              <th scope="col">额度撞窗</th>
              <th scope="col">缘由</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const v = VERDICT_VIEW[c.verdict];
              return (
                <tr>
                  <td>
                    <span class={`v-badge ${v.cls}`}>{v.label}</span>
                  </td>
                  <th scope="row" class="rec-plan">
                    {c.name}
                    <span class="rec-vendor"> · {c.vendorName}</span>
                  </th>
                  <td class="rec-cost">
                    {c.monthlyCost !== null && c.currency !== null ? (
                      <>
                        {c.currency} {displayMonthly(c.monthlyCost)}
                      </>
                    ) : (
                      <span class="muted">待核</span>
                    )}
                  </td>
                  <td>
                    <FitConclusion fitsWindow={c.fitsWindow} />
                  </td>
                  <td class="rec-reason">{c.reasons.map((r) => r.detail).join('；')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : null}
    {/* thin-data：引擎完整说明原文（含 guidance/空态诚实语）原样透传、不裁剪（design D4）。
        无 primary → 默认展开（唯一答案内容、醒目，覆盖零候选时说明区近空白的问题）；有 primary → 折叠、从属于答案卡。 */}
    <details class="explanation-note" open={!hasPrimary}>
      <summary>引擎完整说明</summary>
      <div class="explanation-body">{explanation}</div>
    </details>
  </section>
);

/**
 * 备选卡（`verdict==='alternative'`，engine 已按同币种已核升序，web 取前 3、不重排）。每张含方案 + 厂商 +
 * 月成本（恒已核）+ fitsWindow + provenance。>3 → 显「另有 N 个备选」并以**页内锚点** `#evidence` 指向证据抽屉。
 */
export const AlternativeCards: FC<{ candidates: RankedCandidate[] }> = ({ candidates }) => {
  if (candidates.length === 0) return null;
  const shown = candidates.slice(0, 3);
  const overflow = candidates.length - shown.length;
  return (
    <section class="alt-section" aria-labelledby="alt-heading">
      <h2 id="alt-heading" class="section-heading">
        备选方案
      </h2>
      <ol class="alt-list">
        {shown.map((c) => (
          <li class="alt-row">
            <span class="alt-name">
              {c.name}
              <span class="alt-vendor"> · {c.vendorName}</span>
            </span>
            <span class="alt-cost">
              {c.currency} {displayMonthly(c.monthlyCost ?? 0)}
              <span class="alt-unit"> /月</span>
            </span>
            <span class="alt-sub">
              <FitConclusion fitsWindow={c.fitsWindow} />{' '}
              <SourceLink url={c.provenance.sourceUrl} />
            </span>
          </li>
        ))}
      </ol>
      {overflow > 0 ? (
        <p class="alt-overflow">
          <a href="#evidence">另有 {overflow} 个备选，见证据抽屉</a>
        </p>
      ) : null}
    </section>
  );
};

/**
 * 「描述你的配置」输入区（措辞面向「说清你的编程场景」，非「过滤器」）：原生 `<form>` GET + `<fieldset>` + `<legend>`
 * 分组语义（1.3.1/3.3.2）；控件 model/tool/protocol/currency/`maxMonthlyPrice`（wire 键名，值形如 `"100 CNY"`）/
 * usageProfile（带 label 的 `<select>` 轻/中/重）；每控件 `<label>` 包裹关联可及名；复用变更 A 的 `form.filters`
 * 样式 + `--border-control`/outline 焦点/目标 ≥24px；query 参数、整页 GET、渐进增强**无 JS 可用**。
 */
export const SetupForm: FC<{ options: FacetOptions; query: SetupQuery }> = ({ options, query }) => (
  <form class="filters setup-form" method="get" aria-label="描述你的配置">
    <fieldset>
      <legend>描述你的配置</legend>
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
            默认币种
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
        用量档
        <select name="usageProfile">
          {USAGE_LABELS.map((u) => (
            <option value={u.value} selected={query.usageProfile === u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">获取推荐</button>
      <a class="chip" href="/model-radar">
        重置
      </a>
    </fieldset>
    <p class="setup-hint">
      说清你的编程场景，获取更精确的推荐。
    </p>
  </form>
);
