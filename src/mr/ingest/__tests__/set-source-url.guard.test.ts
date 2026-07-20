/**
 * set-source-url 授权 setter 可 import 性 grep 守卫（task 2.3 ①，design D9）。
 *
 * 扫全仓生产代码，断言 `set-source-url.ts` 仅被 `src/mr/curation/approve.ts` import——验证 curation block
 * 的 ingest 通配 eslint 守卫真实生效、防 eslint config 重构时静默掉守卫。approve 侧 import 属后续 wave，
 * 故 0 importer 亦合法（⊆ 允许集）；任何其它文件 import 即失败。
 *
 * 纯逻辑（只读 fs，无 DB / 网络 / LLM）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 只匹配 `... from '...set-source-url(.js)?'` 静态 import/export 语句，不匹配注释/字符串里的裸词。
const IMPORT_RE = /\bfrom\s+['"][^'"]*set-source-url(?:\.js)?['"]/;

describe('2.3 set-source-url 仅 approve.ts 可 import（grep 守卫）', () => {
  it('全仓生产代码中，import set-source-url 的文件 ⊆ {mr/curation/approve.ts}', () => {
    const importers = tsFiles(SRC)
      .filter((f) => !f.endsWith('set-source-url.ts') && !f.includes('__tests__'))
      .filter((f) => IMPORT_RE.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1).split(/[\\/]/).join('/'));

    expect(importers.filter((r) => r !== 'mr/curation/approve.ts')).toEqual([]);
  });
});
