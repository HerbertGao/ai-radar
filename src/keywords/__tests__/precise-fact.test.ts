/**
 * 精确事实词表结构单测（p0-alert-lane D1.2–D1.6/D1.9/D1.10）——锁「导出常量分组正确」。
 * 成员选取的逐词裁决由 SOT（openspec/changes/p0-alert-lane/specs/conversational-rag/spec.md
 * 穷举表）定死，这里把裁决钉进测试防回归；行为面（拦/不拦）见 src/rag/__tests__/price-gate.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  FACT_CHANGE_EXT,
  NEGATIVE_PATTERNS,
  PRECISE_FACT_CORE,
  PRECISE_FACT_COOCCUR,
  SELECTION_QUERY_EXT,
} from '../precise-fact.js';

/** advisor 裸词消费集（本闸）；P0 词源 = CORE ∪ FACT_CHANGE_EXT（纯裸词，不消费共现）。 */
const advisorBare = [...PRECISE_FACT_CORE, ...SELECTION_QUERY_EXT];
const p0Source = [...PRECISE_FACT_CORE, ...FACT_CHANGE_EXT];

describe('词表分组：共现不外溢到 P0（D1.9——P0 是纯标题 LIKE ANY 谓词）', () => {
  it('P0 词源 = CORE ∪ FACT_CHANGE_EXT，不含共现意图词', () => {
    for (const w of PRECISE_FACT_COOCCUR.intent) {
      expect(p0Source).not.toContain(w);
    }
  });

  it('共现否定词不混进任何裸词组', () => {
    for (const w of PRECISE_FACT_COOCCUR.negative) {
      expect(p0Source).not.toContain(w);
      expect(advisorBare).not.toContain(w);
    }
  });
});

describe('NEGATIVE_PATTERNS：器物名否定模式（D1.10）', () => {
  it('成员 = 三个器物名，逐词照 SOT', () => {
    expect([...NEGATIVE_PATTERNS]).toEqual(['rate limiter', '限流器', '速率限制器']);
  });

  it('MUST NOT 含 rate limiting——公告常用动名词，挡它 = 漏掉真的限流变更公告', () => {
    expect(NEGATIVE_PATTERNS).not.toContain('rate limiting');
  });
});

describe('共现三表成员裁决（D1.9，每条对应一个实测的静默失效）', () => {
  it('intent 不含裸 max（⊂ max_tokens/maxed）、how much（已是 SELECTION_QUERY_EXT 裸词 ⇒ 死规则）、是多少（⊂ 多少 ⇒ 死词）', () => {
    expect(PRECISE_FACT_COOCCUR.intent).not.toContain('max');
    expect(PRECISE_FACT_COOCCUR.intent).not.toContain('how much');
    expect(PRECISE_FACT_COOCCUR.intent).not.toContain('是多少');
  });

  it('fact 不含 用量上限（已是核心裸词 ⇒ 该共现规则恒 no-op）', () => {
    expect(PRECISE_FACT_COOCCUR.fact).not.toContain('用量上限');
    expect(PRECISE_FACT_CORE).toContain('用量上限'); // 恒留核心：P0 招牌用例「周用量上限提升 50%」由它命中
  });

  it('negative 含 handle 与 handling 两个词（handling 不是死词）、不含 hit（⊂ white）', () => {
    expect(PRECISE_FACT_COOCCUR.negative).toContain('handle');
    expect(PRECISE_FACT_COOCCUR.negative).toContain('handling');
    // 'handling' 不含子串 'handle'（e 在 -ing 前脱落）——删 handling 则 handle 兜不住它
    expect('handling'.includes('handle')).toBe(false);
    expect(PRECISE_FACT_COOCCUR.negative).not.toContain('hit');
  });
});

describe('中英一致 + 语义过宽（D1.5）', () => {
  it('运维泛词只进 FACT_CHANGE_EXT（仅 P0），不作裸词进 advisor 消费集', () => {
    for (const w of ['限流', 'rate limit', 'usage limit', '速率限制']) {
      expect(FACT_CHANGE_EXT).toContain(w);
      expect(advisorBare).not.toContain(w);
    }
  });

  it('语义过宽的 报价/单价/售价 只归 SELECTION_QUERY_EXT（仅 advisor），不进核心', () => {
    for (const w of ['报价', '单价', '售价']) {
      expect(SELECTION_QUERY_EXT).toContain(w);
      expect(PRECISE_FACT_CORE).not.toContain(w);
    }
  });
});

describe('全角变体（D1.6）与死词（D1.3/D1.4）', () => {
  it('token 包三变体全在核心：半角空格 / 全角空格 U+3000 / 无空格', () => {
    expect(PRECISE_FACT_CORE).toContain('token 包');
    expect(PRECISE_FACT_CORE).toContain('token　包');
    expect(PRECISE_FACT_CORE).toContain('token包');
  });

  it('裸「用量」不入任何一组（⊂ 使用量，CJK 子串陷阱）', () => {
    for (const set of [
      PRECISE_FACT_CORE,
      SELECTION_QUERY_EXT,
      FACT_CHANGE_EXT,
      NEGATIVE_PATTERNS,
      PRECISE_FACT_COOCCUR.intent,
      PRECISE_FACT_COOCCUR.fact,
      PRECISE_FACT_COOCCUR.negative,
    ]) {
      expect(set).not.toContain('用量');
    }
  });

  it('死词不入 advisor 消费集：额度上限（⊂ 额度）+ 存量死词已清（删除不改变命中集）', () => {
    for (const dead of ['额度上限', '性价比最高', '哪个划算', '哪个更划算', 'how much does']) {
      expect(advisorBare).not.toContain(dead);
    }
  });
});

describe('模块加载断言的口径（D1.2——加载已断言，这里文档化钉住）', () => {
  it('全部 7 组非空且不含 LIKE 元字符（% _ \\）', () => {
    const groups = {
      PRECISE_FACT_CORE,
      FACT_CHANGE_EXT,
      SELECTION_QUERY_EXT,
      NEGATIVE_PATTERNS,
      COOCCUR_INTENT: PRECISE_FACT_COOCCUR.intent,
      COOCCUR_FACT: PRECISE_FACT_COOCCUR.fact,
      COOCCUR_NEG: PRECISE_FACT_COOCCUR.negative,
    };
    for (const set of Object.values(groups)) {
      expect(set.length).toBeGreaterThan(0);
      for (const k of set) {
        expect(k).not.toMatch(/[%_\\]/);
      }
    }
  });
});
