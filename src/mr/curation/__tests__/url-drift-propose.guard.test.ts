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

// 匹配 `from '...'`（具名/namespace/re-export）与 `import '...'`（侧效应）两种静态 import；不匹配注释/字符串里的裸词。
// name 经转义——含正则元字符时按字面匹配、不误当通配（否则 backstop 会静默漏检侧效应导入）。
function importsModule(src: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\bfrom\\s+|\\bimport\\s*)['"][^'"]*${escaped}(?:\\.js)?['"]`).test(src);
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

  it('importsModule 匹配 from 与侧效应 import、不误命中注释（backstop 完整性回归）', () => {
    expect(importsModule("import { safeFetch } from './http-tier.js';", 'http-tier')).toBe(true);
    expect(importsModule("import '../scrape/http-tier.js';", 'http-tier')).toBe(true); // 侧效应导入
    expect(importsModule('// 提到 http-tier 的注释、非 import', 'http-tier')).toBe(false);
  });
});
