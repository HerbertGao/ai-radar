/**
 * 价格/选型前置闸单测（task 1.4 + p0-alert-lane D1.8，design D5）——纯函数、无 env / 无 DB / 无网络。
 *
 * 锁的行为：
 * 1. 裸词分支：多字价格/额度/选型短语命中 → `非我域`（含 price-bait 包装、取值型限额「用量上限」）。
 * 2. 共现分支（D1.9）：`NOT(NEG) ∧ INTENT ∧ FACT`——英文取值型与中英交叉格确定性拦截；
 *    运维问法（照样含意图词）由共现否定项一票否决放行。
 * 3. 器物名否定 `NEGATIVE_PATTERNS`（D1.10）：判定序在最前、一票否决【裸词与共现两条分支】。
 * 4. CJK 单字/子串歧义不假阳；死词删除零影响（命中集不变）。
 */
import { describe, expect, it } from 'vitest';
import { isPriceOrSelectionQuery } from '../price-gate.js';

describe('isPriceOrSelectionQuery：裸词命中价格/额度/选型（非我域）', () => {
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
    // 取值型限额（D1.8 正向裸词；不要用「额度上限」做正例——「额度」本就在词表内，证明不了新词生效）
    '周用量上限提到多少了',
  ])('「%s」→ 命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(true);
  });

  it('中文运维问法「用量上限撞了多久恢复」被拦——已登记的有意假阳（D1.9 已知代价二），且钉住共现 NEG 不外溢到裸词分支', () => {
    // 「撞」在共现否定词表内，但共现 NEG 只在共现判定内部——裸词分支照常由「用量上限」命中。
    // 若这条变绿（不拦），说明有人把共现 NEG 误提升成了全局否决，或把「用量上限」移出了核心
    //（后者会让 P0 招牌用例「周用量上限提升 50%」静默失联）。
    expect(isPriceOrSelectionQuery('Codex 的用量上限撞了之后多久恢复?')).toBe(true);
  });
});

describe('isPriceOrSelectionQuery：共现命中英文/交叉取值型（D1.9）', () => {
  it.each([
    "what is Claude's rate limit?",
    "what's the max usage limit?", // 由 what's 命中，不靠裸 max（max ⊂ max_tokens/maxed，不入表）
    'rate limit 最高是多少', // 中英交叉格：中文意图 ∧ 英文名词——意图/事实跨语言取并集
    "what is Claude's rate limit for white-label apps?", // 该拦；钉死「否定项 MUST NOT 含 hit」（hit ⊂ white）
  ])('「%s」→ 命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(true);
  });
});

describe('isPriceOrSelectionQuery：中英文运维类提问不被误拦（假阳无兜底）', () => {
  it.each([
    'API 限流了怎么办 / 429 怎么处理',
    '429 怎么退避重试',
    '我一直撞 rate limit 怎么办',
    '速率限制撞了怎么退避重试',
    '怎么降低 token 用量',
    'GPT-5 的使用量大吗', // '使用量'.includes('用量') 恒真 ⇒ 裸「用量」不在任何一组
    'how to handle rate limit errors from the Claude API',
    'GPT-4 被弃用了吗', // 变更词只在 P0 扩展内，不进本闸
  ])('「%s」→ 不命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(false);
  });
});

describe('isPriceOrSelectionQuery：共现的五条毒例（含意图词，光靠共现挡不住——放行的是否定项）', () => {
  it.each([
    'how do I set max_tokens to avoid hitting the rate limit?', // avoid 否决 + 裸 max 不在表内
    'I maxed out my rate limit, how do I back off?', // maxed / back off 否决
    'how to handle current rate limit errors', // handle / error 否决（含意图词 current）
    'what is a rate limit error?', // error 否决（含意图词 what is）
    'Show HN: a rate limiter for LLM APIs', // 无意图词；且器物名 NEGATIVE_PATTERNS 前置否决
  ])('「%s」→ 不命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(false);
  });
});

describe('isPriceOrSelectionQuery：器物名否定一票否决【两条分支】（D1.10）', () => {
  it.each([
    'what is a rate limiter?', // 共现分支：what is ∧ rate limit(⊂ rate limiter)——由器物名否决
    '这个 rate limiter 的定价怎么算', // 裸词分支：命中核心裸词「定价」——只把否定项并进共现的实现会拦下它（唯一能证伪否定项放错层的用例）
    'Nginx 限流器怎么配', // 中文侧同型
    '速率限制器的价格', // 裸词分支：命中核心裸词「价格」——由「速率限制器」否决
  ])('「%s」→ 不命中', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(false);
  });
});

describe('isPriceOrSelectionQuery：`rate limiting` 不在否定项内（D1.10 裁决，防有人顺手加进去）', () => {
  it.each([
    'Improved rate limiting',
    'Updating rate limiting for the Claude API',
  ])('「%s」→ 按既有口径不命中（无意图词/裸词，而非被否定项放行）', (q) => {
    expect(isPriceOrSelectionQuery(q)).toBe(false);
  });

  it('含取值意图词的 rate limiting 提问仍由共现命中——若 rate limiting 被误加进否定项，这条会变红', () => {
    // fact 词 rate limit ⊂ rate limiting ⇒ 共现照常命中（what is/current ∧ rate limit、无 NEG）。
    expect(isPriceOrSelectionQuery('what is the current rate limiting policy?')).toBe(true);
  });
});

describe('isPriceOrSelectionQuery：共现否定项含 handling（防「死词」误删）', () => {
  it('「current rate limit handling」→ 不命中——handling 与 handle 并存、不是死词（handling 不含子串 handle）', () => {
    // 曾有一轮按「死词」误删 handling：'handling'.includes('handle') 为 false（e 在 -ing 前脱落），
    // 删掉它则本条含意图词 current 的运维问法会被共现误拦（无兜底拒答）。
    expect(isPriceOrSelectionQuery('current rate limit handling')).toBe(false);
  });
});

describe('isPriceOrSelectionQuery：死词删除零影响（命中集不变，D1.4）', () => {
  it.each([
    '性价比最高的编程订阅是哪个', // 原由死词「性价比最高」描述，仍由「性价比」命中
    'how much does Claude Code cost?', // 原由死词「how much does」描述，仍由「how much」命中
  ])('「%s」→ 仍命中', (q) => {
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
