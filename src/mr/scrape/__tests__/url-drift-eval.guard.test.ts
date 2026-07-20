/**
 * url-drift-agent.eval.ts 的静态守卫（task 10.4，design D7 / DD1）——纯读 fs、不触 LLM / DB / 网络。
 *
 * 断言离线 eval：① **绝不 import / 构造 `buildOpsAlertSink`**（DD1：eval 跑 vitest、`telegram.ts:43` VITEST
 * 守卫令 ops-alert-sink 发不出、架构上死；breach 只表现为红 CI job、不经 ops-alert）；② 用 vitest 标准
 * `describe`/`it`（不用虚构的 describe.eval）；③ 具备 skip-clean creds 检测（占位/缺失 creds → skip、绝不
 * green-claim floor）；④ 断言 `precision >= floor`；⑤ 不写 mr_review_flag、不加 cron。
 *
 * **只看代码、不看注释**：eval 的文档注释里为解释「不做什么」会**提及**这些禁词（buildOpsAlertSink / cron
 * 等）；故先剥离**块注释**（禁词只出现在顶部块注释里），再对代码体做 presence/absence 断言——`ci-placeholder-key`
 * / `describe.skip` 等要断言存在的 token 落在代码/字符串字面里、剥注释后仍在。运行时「skip 干净」由
 * `npm run test:eval` 在占位 creds 下确认（reports skipped、非 passed）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EVAL = join(process.cwd(), 'src/mr/scrape/__tests__/url-drift-agent.eval.ts');
const raw = readFileSync(EVAL, 'utf8');
// 剥块注释（禁词只在顶部块注释里出现——剥后代码体不该再有）。行内 `//` 注释保留（不含禁词、且含 URL 的 //）。
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** 只匹配 `... from '...<name>(.js)?'` 静态 import/export，不匹配注释/字符串里的裸词。 */
function importsModule(s: string, name: string): boolean {
  // 匹配 `from '...'` 与 `import '...'`（侧效应）；name 经转义防元字符误匹配。
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\bfrom\\s+|\\bimport\\s*)['"][^'"]*${escaped}(?:\\.js)?['"]`).test(s);
}

describe('10.4 url-drift-agent.eval.ts 静态守卫', () => {
  it('绝不 import 或构造 buildOpsAlertSink（DD1：离线 eval 不装配 ops-alert-sink）', () => {
    expect(code.includes('buildOpsAlertSink')).toBe(false);
    expect(importsModule(code, 'ops-alert-sink')).toBe(false);
  });

  it('用 vitest 标准 describe/it（不用虚构的 describe.eval）', () => {
    expect(code.includes('describe.eval')).toBe(false);
    expect(/\bdescribe\b/.test(code)).toBe(true);
    expect(/\bit\b/.test(code)).toBe(true);
  });

  it('具备 skip-clean creds 检测（ci-placeholder-key / example.invalid → describe.skip）', () => {
    expect(code.includes('describe.skip')).toBe(true);
    expect(code.includes('ci-placeholder-key')).toBe(true);
    expect(code.includes('example.invalid')).toBe(true);
  });

  it('断言 precision >= floor（读 MR_URL_DRIFT_PRECISION_FLOOR）', () => {
    expect(code.includes('MR_URL_DRIFT_PRECISION_FLOOR')).toBe(true);
    expect(/toBeGreaterThanOrEqual/.test(code)).toBe(true);
  });

  it('不写 mr_review_flag、不加 cron（生产侧质量监控 = CI job，不落 flag）', () => {
    expect(code.includes('mr_review_flag')).toBe(false);
    expect(code.toLowerCase().includes('cron')).toBe(false);
  });
});
