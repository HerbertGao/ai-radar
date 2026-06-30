/**
 * Model Radar 5c seed fixture 数据红线守卫（task 1.3，纯逻辑无 DB/网络/LLM）。
 *
 * 守住 spec「seed/录入 fixture 数据卫生」+ 「桶2数据策展只录已核价格、允许零已核价」：
 * - `needs_login_recheck` 价格/币种必 NULL（与价格同生同灭，不写真价）。
 * - 未核实 provenance **不得**标成 `official_pricing`/`official_doc`：fixture 任一带非 NULL 价的 plan
 *   其 source_confidence 必属已核官方集合；反之占位价 plan 必为非官方 confidence。
 *   机械落点 = 每条 seed plan 过共享 `mrPlanWriteValidator`（confidence↔price 绑定，task 1.6）。
 * - MiMo（非 5c 主桶）未核 provenance 保持 `manual` + `needs_login_recheck` 占位（design D6）。
 * - 桶2 五家（百炼/千帆/腾讯混元/火山方舟/讯飞星火）经 **5d-C 人在环策展**：在售四家录 CNY 官方真月价
 *   （同档可比 ≥2）、腾讯混元停售留 NULL 占位 + 停售 flag（spec「已停售 plan 不留作普通待核」）。
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

  it('桶2 五家结构性录入：结构齐全 + 5d-C 在售录 CNY 官方真月价（同档可比 ≥2）/ 停售留占位 + 停售 flag', () => {
    const bucket2 = ['bailian', 'qianfan', 'tencent-hunyuan', 'volcengine-ark', 'xfyun-spark'];
    const inSale = ['bailian', 'qianfan', 'volcengine-ark', 'xfyun-spark']; // 5d-C 在售四家（腾讯停售除外）
    const pricedVendors = new Set<string>();
    for (const name of bucket2) {
      const v = SEED_VENDORS.find((x) => x.normalizedName === name);
      expect(v, `桶2 vendor ${name} 缺失`).toBeDefined();
      expect(v!.plans.length).toBeGreaterThan(0);
      for (const p of v!.plans) {
        expect(p.category).toBe('coding_plan');
        // 结构性录入：model/client/limit 各 ≥1。
        expect(p.models.length).toBeGreaterThan(0);
        expect(p.clients.length).toBeGreaterThan(0);
        expect(p.limits.length).toBeGreaterThan(0);
        // 5d-C 策展三态：在售 → CNY 官方真月价（confidence 官方 + 币种 CNY）；占位 → 价/币种皆 NULL + needs_login_recheck（同生同灭）。
        if (p.currentPrice !== null) {
          expect(isOfficialConfidence(p.sourceConfidence)).toBe(true);
          expect(p.currency).toBe('CNY');
          pricedVendors.add(name);
        } else {
          expect(p.sourceConfidence).toBe('needs_login_recheck');
          expect(p.currency).toBeNull(); // 同生同灭：占位分支也须断言 currency NULL（CR）
        }
      }
    }
    // 退出锚（5d-C 契约冻结）：**在售四家各录到 CNY 真月价**（非仅 ≥2——防两家回退 NULL 漏检，CR）。
    for (const name of inSale) {
      expect(pricedVendors.has(name), `5d-C 在售 ${name} 应已录 CNY 官方真月价`).toBe(true);
    }
    // spec「已停售 plan 不留作普通待核」：腾讯混元停售占位价 NULL + 必带停售 review flag、不计入已核。
    expect(pricedVendors.has('tencent-hunyuan')).toBe(false);
    const tencent = SEED_VENDORS.find((x) => x.normalizedName === 'tencent-hunyuan')!;
    expect(tencent.plans.every((p) => p.currentPrice === null && Boolean(p.reviewFlagReason))).toBe(true);
  });

  it('seed coding_plan CNY 真价同档最低 = 讯飞星火 ¥19（no-DB 价序回归守卫，CR）', () => {
    const cnyCoding = allPlans.filter(
      (p) => p.category === 'coding_plan' && p.currency === 'CNY' && p.currentPrice !== null,
    );
    expect(cnyCoding.length).toBeGreaterThanOrEqual(2);
    const cheapest = cnyCoding.reduce((a, b) => (a.currentPrice! <= b.currentPrice! ? a : b));
    expect(cheapest.vendor).toBe('xfyun-spark');
    expect(cheapest.currentPrice).toBe(19);
  });

  it('腾讯 coding_plan 与 CodeBuddy(ide_membership) 用不同 normalizedName（task 1.2 vendor 去重键不歧义）', () => {
    const names = SEED_VENDORS.map((v) => v.normalizedName);
    expect(names).toContain('codebuddy');
    expect(names).toContain('tencent-hunyuan');
    expect(new Set(names).size).toBe(names.length); // normalizedName 全局唯一
  });
});
