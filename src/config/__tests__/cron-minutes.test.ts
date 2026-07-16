/**
 * cron 分钟字段展开器单元测试（p0-alert-lane A1.4 / design D7）。
 *
 * 覆盖文法全部形式的展开集 + 非法输入（文法/数值）一律抛错（fail-closed）——
 * 展开器绝不静默返回空集：空集 ∩ {0,30} = ∅ 恒判过，等于把未知语法默认当合规。
 * 纯函数测试，零依赖（不触 env 单例）。
 */
import { describe, expect, it } from 'vitest';
import { expandCronMinutes } from '../cron-minutes.js';

/** 断言展开集恰为期望集合（用排序数组比较，同时钉住元素与基数）。 */
function expectMinutes(pattern: string, expected: number[]): void {
  expect([...expandCronMinutes(pattern)].sort((a, b) => a - b)).toEqual(expected);
}

describe('expandCronMinutes —— 文法各形式的展开集', () => {
  it('* → 0..59 全集', () => {
    expectMinutes('*', Array.from({ length: 60 }, (_, i) => i));
  });

  it('*/15 → {0,15,30,45}（含 0 和 30——步进形式撞整点半点的招牌反例）', () => {
    expectMinutes('*/15', [0, 15, 30, 45]);
  });

  it('*/20 → {0,20,40}（含 0）', () => {
    expectMinutes('*/20', [0, 20, 40]);
  });

  it('4-59/15 → {4,19,34,49}（新默认值的展开集，避开 {0,30}）', () => {
    expectMinutes('4-59/15', [4, 19, 34, 49]);
  });

  it('9-59/20 → {9,29,49}（阶段 B 生产覆盖值的展开集）', () => {
    expectMinutes('9-59/20', [9, 29, 49]);
  });

  it('0/15（a/n 隐式 a-59/n）→ {0,15,30,45}——漏此形式即恒绿缺口', () => {
    expectMinutes('0/15', [0, 15, 30, 45]);
  });

  it('3（纯数字）→ {3}', () => {
    expectMinutes('3', [3]);
  });

  it('3,7,53（列表）→ 各项并集 {3,7,53}', () => {
    expectMinutes('3,7,53', [3, 7, 53]);
  });

  it('1-3,52/3（列表混合区间与 a/n）→ {1,2,3,52,55,58}', () => {
    expectMinutes('1-3,52/3', [1, 2, 3, 52, 55, 58]);
  });

  it('a-b（区间无步进）→ 连续整数', () => {
    expectMinutes('10-13', [10, 11, 12, 13]);
  });

  it('完整 5 段 cron 表达式只取第 1 段（分钟字段）展开', () => {
    expectMinutes('4-59/15 * * * *', [4, 19, 34, 49]);
    expectMinutes('7 9 * * 1', [7]);
  });
});

describe('expandCronMinutes —— 非法输入 MUST 抛错（fail-closed，绝不静默空集）', () => {
  it.each([
    ['x', '不属于既定文法'],
    ['', '空串'],
  ])('文法非法："%s" 抛错', (pattern) => {
    expect(() => expandCronMinutes(pattern)).toThrow();
  });

  it('60（分钟值越界）抛错', () => {
    expect(() => expandCronMinutes('60')).toThrow(/越界/);
  });

  it('*/0（步进非正）抛错', () => {
    expect(() => expandCronMinutes('*/0')).toThrow(/步进/);
  });

  it('0/0（a/n 步进非正）抛错', () => {
    expect(() => expandCronMinutes('0/0')).toThrow(/步进/);
  });

  it('30-10（倒置区间）抛错', () => {
    expect(() => expandCronMinutes('30-10')).toThrow(/倒置区间/);
  });

  it('列表中任一项非法（"3,x"）即整体抛错——绝不跳过坏项静默给出部分展开', () => {
    expect(() => expandCronMinutes('3,x')).toThrow();
  });
});
