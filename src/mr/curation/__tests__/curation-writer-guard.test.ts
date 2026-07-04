/**
 * curation 写入口收窄机械验证（task 5.4，design D1）：「只人批准写事实」从散文降为 lint 错误。
 *
 * 用 `ESLint().lintText` 对合成代码断言：`src/mr/curation/**` 中 import `src/mr/ingest/` 事实 writer
 * （`recordPriceChange`/`_recordPriceChangeTx`/`upsertPlan`/`setPlanAvailability`/`upsertPlanPeriodPrice`）——
 * - `propose.ts`/`extract.ts`/`price-review-store.ts` 等**必须**触发 `no-restricted-imports`；
 * - **仅** `approve.ts`（批准落库核心）豁免、不报错。
 *
 * 纯逻辑（跑项目 flat config 的 lintText），无 DB / 网络 / LLM。
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const ESLINT_TIMEOUT_MS = 30_000;

async function restrictedImportErrors(code: string, filePath: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath });
  return results[0]!.messages.filter((m) => m.ruleId === 'no-restricted-imports')
    .length;
}

describe('5.4 curation 写入口收窄：仅 approve.ts 可 import 事实 writer', () => {
  it('curation/propose.ts import recordPriceChange → eslint 报错', async () => {
    const code = `import { recordPriceChange } from '../ingest/record-price-change.js';\nexport { recordPriceChange };\n`;
    const n = await restrictedImportErrors(code, 'src/mr/curation/propose.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it('curation/extract.ts import upsertPlan → eslint 报错', async () => {
    const code = `import { upsertPlan } from '../ingest/upsert.js';\nexport { upsertPlan };\n`;
    const n = await restrictedImportErrors(code, 'src/mr/curation/extract.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it('curation/propose.ts import setPlanAvailability/upsertPlanPeriodPrice → eslint 报错', async () => {
    const code = `import { setPlanAvailability, upsertPlanPeriodPrice } from '../ingest/upsert.js';\nexport { setPlanAvailability, upsertPlanPeriodPrice };\n`;
    const n = await restrictedImportErrors(code, 'src/mr/curation/propose.ts');
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);

  it('curation/approve.ts import _recordPriceChangeTx → 豁免、不报错', async () => {
    const code = `import { _recordPriceChangeTx } from '../ingest/record-price-change.js';\nexport { _recordPriceChangeTx };\n`;
    const n = await restrictedImportErrors(code, 'src/mr/curation/approve.ts');
    expect(n).toBe(0);
  }, ESLINT_TIMEOUT_MS);

  it('curation/price-review-store.ts import recordPriceChange → eslint 报错（非 approve 一律禁）', async () => {
    const code = `import { recordPriceChange } from '../ingest/record-price-change.js';\nexport { recordPriceChange };\n`;
    const n = await restrictedImportErrors(
      code,
      'src/mr/curation/price-review-store.ts',
    );
    expect(n).toBeGreaterThan(0);
  }, ESLINT_TIMEOUT_MS);
});
