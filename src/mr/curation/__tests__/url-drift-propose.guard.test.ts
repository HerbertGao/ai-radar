/**
 * url-drift-propose 不 import authorized setter / 不抓候选 URL 的 grep 守卫（task 6.3 ①，design D9/m3）。
 *
 * 断言 `url-drift-propose.ts` **不** import `set-source-url`（落 `mr_source.source_url` 唯一走 approve.ts）/
 * `http-tier` / `browser-tier`（propose 不物理访问候选 URL、只解释）——验证既有 curation `no-restricted-imports`
 * block + url-drift per-file no-fetch block 真实生效、防 eslint config 重构时静默掉守卫。
 *
 * 纯逻辑（只读 fs，无 DB / 网络 / LLM）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROPOSE = join(process.cwd(), 'src/mr/curation/url-drift-propose.ts');

// 只匹配 `... from '...<name>(.js)?'` 静态 import/export 语句，不匹配注释/字符串里的裸词。
function importsModule(src: string, name: string): boolean {
  return new RegExp(`\\bfrom\\s+['"][^'"]*${name}(?:\\.js)?['"]`).test(src);
}

describe('6.3 url-drift-propose 不 import setter / 不抓候选 URL（grep 守卫）', () => {
  const src = readFileSync(PROPOSE, 'utf8');

  it('不 import set-source-url authorized setter', () => {
    expect(importsModule(src, 'set-source-url')).toBe(false);
  });

  it('不 import http-tier 抓取原语（safeFetch）', () => {
    expect(importsModule(src, 'http-tier')).toBe(false);
  });

  it('不 import browser-tier 抓取原语（fetchWithBrowser）', () => {
    expect(importsModule(src, 'browser-tier')).toBe(false);
  });
});
