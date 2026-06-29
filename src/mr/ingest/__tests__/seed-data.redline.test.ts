/**
 * Model Radar 5c seed fixture 数据红线守卫（task 1.3，纯逻辑无 DB/网络/LLM）。
 *
 * 守住 spec「seed/录入 fixture 数据卫生」+ 「桶2数据策展只录已核价格、允许零已核价」：
 * - `needs_login_recheck` 价格/币种必 NULL（与价格同生同灭，不写真价）。
 * - 未核实 provenance **不得**标成 `official_pricing`/`official_doc`：fixture 任一带非 NULL 价的 plan
 *   其 source_confidence 必属已核官方集合；反之占位价 plan 必为非官方 confidence。
 *   机械落点 = 每条 seed plan 过共享 `mrPlanWriteValidator`（confidence↔price 绑定，task 1.6）。
 * - MiMo（非 5c 主桶）未核 provenance 保持 `manual` + `needs_login_recheck` 占位（design D6）。
 * - 桶2 五家（百炼/千帆/腾讯混元/火山方舟/讯飞星火）本期 0 已核价（结构性录入即验收）。
 */
import { describe, expect, it } from 'vitest';
import { SEED_VENDORS } from '../seed-data.js';
import { mrPlanWriteValidator } from '../validators.js';
import { isOfficialConfidence } from '../../../db/mr-schema.zod.js';

const allPlans = SEED_VENDORS.flatMap((v) =>
  v.plans.map((p) => ({ vendor: v.normalizedName, ...p })),
);

describe('1.3 seed fixture 数据红线', () => {
  it('每条 seed plan 过共享 mrPlanWriteValidator（confidence↔price 绑定 + 同生同灭）', () => {
    for (const p of allPlans) {
      expect(() =>
        mrPlanWriteValidator.parse({
          category: p.category,
          currentPrice: p.currentPrice,
          currency: p.currency,
          sourceConfidence: p.sourceConfidence,
        }),
      ).not.toThrow();
    }
  });

  it('needs_login_recheck plan 的价格与币种必 NULL（同生同灭）', () => {
    for (const p of allPlans) {
      if (p.sourceConfidence === 'needs_login_recheck') {
        expect(p.currentPrice).toBeNull();
        expect(p.currency).toBeNull();
      }
    }
  });

  it('非官方 confidence plan 不得携带非 NULL 价（未核 provenance 不冒充已核价）', () => {
    for (const p of allPlans) {
      if (p.currentPrice !== null) {
        expect(isOfficialConfidence(p.sourceConfidence)).toBe(true);
      }
    }
  });

  it('MiMo 未核 provenance：source=manual + plan=needs_login_recheck + 价 NULL（design D6）', () => {
    const mimo = SEED_VENDORS.find((v) => v.normalizedName === 'mimo');
    expect(mimo).toBeDefined();
    expect(mimo!.sources.every((s) => s.fetchStrategy === 'manual')).toBe(true);
    for (const p of mimo!.plans) {
      expect(p.sourceConfidence).toBe('needs_login_recheck');
      expect(p.currentPrice).toBeNull();
    }
  });

  it('桶2 五家结构性录入：coding_plan 占位齐全、0 已核价（本期允许）', () => {
    const bucket2 = ['bailian', 'qianfan', 'tencent-hunyuan', 'volcengine-ark', 'xfyun-spark'];
    for (const name of bucket2) {
      const v = SEED_VENDORS.find((x) => x.normalizedName === name);
      expect(v, `桶2 vendor ${name} 缺失`).toBeDefined();
      expect(v!.plans.length).toBeGreaterThan(0);
      for (const p of v!.plans) {
        expect(p.category).toBe('coding_plan');
        // 0 已核价：本期一律 NULL 占位。
        expect(p.currentPrice).toBeNull();
        expect(p.sourceConfidence).toBe('needs_login_recheck');
        // 结构性录入：model/client/limit 各 ≥1。
        expect(p.models.length).toBeGreaterThan(0);
        expect(p.clients.length).toBeGreaterThan(0);
        expect(p.limits.length).toBeGreaterThan(0);
      }
    }
  });

  it('腾讯 coding_plan 与 CodeBuddy(ide_membership) 用不同 normalizedName（task 1.2 vendor 去重键不歧义）', () => {
    const names = SEED_VENDORS.map((v) => v.normalizedName);
    expect(names).toContain('codebuddy');
    expect(names).toContain('tencent-hunyuan');
    expect(new Set(names).size).toBe(names.length); // normalizedName 全局唯一
  });
});
