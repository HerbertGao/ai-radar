import { describe, it, expect } from 'vitest';
import { sameMoney } from '../money.js';

// money-path 共享原语的直接自检（design D2/D5）：store 同候选判定 + approve 基线未漂移判定都靠它，
// 语义漂移会静默破坏「同候选去重」或「基线漂移守卫」。逐分支钉死，含唯一可达的 NULL 分支
// （现价在 propose→approve 间漂到 NULL → 基线判不同 → fail-closed 不写）。
describe('sameMoney', () => {
  it.each([
    // 描述,                         v1,       c1,     v2,       c2,     expected
    ['both null same currency',      null,     'CNY',  null,     'CNY',  true],
    ['both null diff currency',      null,     'CNY',  null,     'USD',  false],
    ['null vs value',                null,     'CNY',  40,       'CNY',  false],
    ['value vs null (可达漂移)',      40,       'CNY',  null,     'CNY',  false],
    ['0 vs null (0 是真值非 NULL)',   0,        'CNY',  null,     'CNY',  false],
    ['0 vs 0 same currency',         0,        'CNY',  0,        'CNY',  true],
    ["'40' vs '40.00' 数值归一",      '40',     'CNY',  '40.00',  'CNY',  true],
    ['40 number vs "40" string',     40,       'CNY',  '40',     'CNY',  true],
    ['same value diff currency',     40,       'CNY',  40,       'USD',  false],
    ['diff value same currency',     40,       'CNY',  45,       'CNY',  false],
  ] as const)('%s', (_desc, v1, c1, v2, c2, expected) => {
    expect(sameMoney(v1, c1, v2, c2)).toBe(expected);
  });
});
