/**
 * buildCitations 单元测试（纯函数，不触网/DB）。
 * 覆盖 fix:M1-ordinal-citations —— LLM 可回 kb_id **或序号**（spec「LLM 只输出散文 answer + 选中的 kb_id（或序号）」）。
 */
import { describe, expect, it } from 'vitest';
import type { KbSearchResult } from '../../kb/retrieval-core.js';
import { buildCitations } from '../citations.js';

const MIN = 0.5;

function makeHit(id: string, cosineSim: number): KbSearchResult {
  return {
    id,
    kbTitle: `T-${id}`,
    summaryZh: `摘要-${id}`,
    entities: null,
    sourceUrls: [`https://example.com/${id}`],
    eventDate: null,
    longTermValue: null,
    cosineSim,
  };
}

describe('buildCitations 序号/kb_id 双匹配', () => {
  it('LLM 回序号 [1]（无 kb_id 为 "1"）→ 映射到第一条 eligible 命中', () => {
    const hits = [makeHit('42', 0.8), makeHit('17', 0.7)];
    const out = buildCitations(['1'], hits, MIN);
    expect(out.map((c) => c.kb_id)).toEqual(['42']);
  });

  it('LLM 回伪造 [999]（非 kb_id、越界序号）→ 丢弃（空）', () => {
    const hits = [makeHit('42', 0.8), makeHit('17', 0.7)];
    expect(buildCitations(['999'], hits, MIN)).toEqual([]);
  });

  it('kb_id 精确匹配优先于序号：第一条 eligible 是 "2" 时回 ["2"] → 引 literal "2"（非序号 2→第二条）', () => {
    const hits = [makeHit('2', 0.8), makeHit('5', 0.7)];
    const out = buildCitations(['2'], hits, MIN);
    expect(out.map((c) => c.kb_id)).toEqual(['2']); // 序号 2 会指向 '5'，literal 胜出证明优先级
  });

  it('引低于阈值命中的 id → 丢弃', () => {
    const hits = [makeHit('42', 0.8), makeHit('17', 0.1)]; // '17' 低于阈值，eligible N=1
    expect(buildCitations(['17'], hits, MIN)).toEqual([]);
  });

  it('低分命中的 id 恰在序号区间 [1,N] 内 → 仍丢弃（不误当序号重映射到别的 eligible）', () => {
    // eligible = ['9','8'](N=2）；'2' 是一条低于阈值的真实命中 id，且 2∈[1,2]。
    // 无 allHitIds 守卫时 '2' 会被当序号映射到 orderedEligible[1]='8'（误引）；有守卫 → 丢弃。
    const hits = [makeHit('9', 0.8), makeHit('8', 0.7), makeHit('2', 0.1)];
    expect(buildCitations(['2'], hits, MIN)).toEqual([]);
    // 对照：纯序号 '2'（无 kb_id 为 '2'）仍正常映射到第二条 eligible。
    const hits2 = [makeHit('9', 0.8), makeHit('8', 0.7)];
    expect(buildCitations(['2'], hits2, MIN).map((c) => c.kb_id)).toEqual(['8']);
  });

  it('去重：["1","42"] 序号 1 解析到 kb_id 42 → 单条（不重复）', () => {
    const hits = [makeHit('42', 0.8), makeHit('17', 0.7)];
    const out = buildCitations(['1', '42'], hits, MIN);
    expect(out.map((c) => c.kb_id)).toEqual(['42']);
  });
});
