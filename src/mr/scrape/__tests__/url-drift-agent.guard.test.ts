/**
 * url-drift-agent 不抓候选 URL / 不 import authorized setter 的 grep 守卫（task 4.3 ②③，design D9/m3）。
 *
 * 断言 `url-drift-agent.ts` **不** import `set-source-url` / `http-tier` / `browser-tier`——验证 eslint
 * `no-restricted-imports` 新 pattern（scrape 两块 set-source-url + m3 per-file http-tier/browser-tier 禁令）
 * 真实生效、防 eslint config 重构时静默掉守卫。agent 只看 mr_source 行 + reason + vendorDomainSet、不物理访问候选 URL。
 *
 * （url-drift-propose.ts 尚不存在——propose 侧 grep 断言 deferred 到其 wave，本处仅断言 agent。）
 *
 * 纯逻辑（只读 fs，无 DB / 网络 / LLM）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT = join(process.cwd(), 'src/mr/scrape/url-drift-agent.ts');

// 只匹配 `... from '...<name>(.js)?'` 静态 import/export 语句，不匹配注释/字符串里的裸词。
function importsModule(src: string, name: string): boolean {
  return new RegExp(`\\bfrom\\s+['"][^'"]*${name}(?:\\.js)?['"]`).test(src);
}

describe('4.3 url-drift-agent 不抓候选 URL / 不 import setter（grep 守卫）', () => {
  const src = readFileSync(AGENT, 'utf8');

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
