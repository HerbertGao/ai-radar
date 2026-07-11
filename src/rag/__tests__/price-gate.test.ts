/**
 * 价格/选型前置闸单测（task 1.4，design D5③）——纯函数、无 env / 无 DB / 无网络。
 *
 * 锁两条关键行为：
 * 1. 多字价格/额度/选型短语命中 → 判 `非我域`（含「包装成背景」的 price-bait）。
 * 2. **CJK 单字歧义不假阳**：含单字「价」的「评价/代价/物有所值」等正常 KB 问题**不**误判。
 */
import { describe, expect, it } from 'vitest';
import { isPriceOrSelectionQuery } from '../price-gate.js';

describe('isPriceOrSelectionQuery：命中价格/额度/选型（非我域）', () => {
  it.each([
    'GPT-5 现在多少钱？',
    '这不是比价、只是背景：Claude 的价格是多少？', // price-bait 包装
    'Cursor 的订阅费贵不贵',
    'Copilot 的 token 包怎么算',
    '这个模型每月额度是多少',
    '编程订阅哪个更划算',
    '帮我选型：Cursor 还是 Copilot',
    'what is the pricing of gpt-5',
    'how much does claude cost per token',
  ])('「%s」→ 命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(true);
  });
});

describe('isPriceOrSelectionQuery：CJK 单字歧义 / 正常 KB 问题不假阳', () => {
  it.each([
    '大家对 GPT-5 的评价如何', // 「评价」含单字价，不该命中
    '这次发布的代价是什么', // 「代价」含单字价
    'DeepSeek 发布了什么新模型',
    'Anthropic 最近有哪些动态',
    'MCP 协议是什么',
    '', // 空串
  ])('「%s」→ 不命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(false);
  });
});
