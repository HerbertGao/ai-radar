/**
 * cron 分钟字段展开器（feishu-push「避整点」判据的共享文法，p0-alert-lane A1 / design D7）。
 *
 * 「避整点」判据 = 分钟字段**展开后的分钟集合** ∩ {0,30} = ∅——主语是展开集，不是字段字符串。
 * 字面量比较（字段字符串 ∉ {'0','30'}）对一切步进/列表形式恒真判过：步进「每 15 分钟」展开
 * {0,15,30,45} 同时撞整点与半点却被放行，正是它长期漏掉 ALERT_SCAN_CRON 的违反。
 *
 * 零依赖叶子模块：由 env.test.ts 的避整点断言与 env.ts 的 superRefine（cron 周期计算，A5.1c）
 * 共同 import——同一份文法只此一份，绝不抄第二份（两份必静默漂移）。避整点【判据】只在测试侧
 * 断言、不进运行时；进生产路径的只有「cron 周期计算」这一个消费点。
 *
 * fail-closed（数值有效性同为文法的一部分）：任一项无法按文法展开、或数值非法（分钟越界 /
 * 步进非正 / 倒置区间）一律抛错，**绝不静默返回空集**——空集 ∩ {0,30} = ∅ 恒判过，「解析不出
 * 就当合规」正是本判据整节论证要杀死的空守卫（漏 `a/n` 时 `0/15` 被空集判过即是此类失效）。
 */

/** 分钟字段合法域上界（[0, 59]）。 */
const MINUTE_MAX = 59;

// 文法各形式的正则（数值段只认十进制数字：无符号、无小数；数值有效性另行校验后抛错）。
const STEP_ALL_RE = /^\*\/(\d+)$/; // */n：{m ∈ [0,59] | m mod n = 0}
const RANGE_RE = /^(\d+)-(\d+)(?:\/(\d+))?$/; // a-b 与 a-b/n：自 a 起步进 n（缺省 1）且 <= b
const START_STEP_RE = /^(\d+)\/(\d+)$/; // a/n：隐式 a-59/n（cron-parser 支持，如 0/15）
const SINGLE_RE = /^(\d+)$/; // 纯数字：单元素集

/**
 * 把 cron 表达式的第 1 段（分钟字段）按 `,` 切项、逐项展开为分钟集合的并集。
 *
 * 文法（缺一即重开「空守卫」缺口，见模块头）：
 *   `*` 全集 / `*` 带 `/n` 步进 / `a-b` 区间 / `a-b/n` 区间步进 /
 *   `a/n` 隐式起点步进（= a-59/n）/ `a,b,c` 列表 / 纯数字。
 *
 * 入参可为完整 cron 表达式或裸分钟字段；任一项无法展开或数值非法即抛错（fail-closed，
 * 判据侧把「抛错」计为违反）。
 */
export function expandCronMinutes(pattern: string): Set<number> {
  const trimmed = pattern.trim();
  if (trimmed === '') {
    throw new Error('cron 表达式为空串，无法展开分钟字段（fail-closed 计为违反）');
  }
  const minuteField = trimmed.split(/\s+/)[0]!;
  const minutes = new Set<number>();
  for (const item of minuteField.split(',')) {
    for (const minute of expandItem(item)) {
      minutes.add(minute);
    }
  }
  return minutes;
}

/** 展开单个列表项；不属于既定文法或数值非法即抛错（绝不静默产出空集）。 */
function expandItem(item: string): number[] {
  if (item === '*') {
    return rangeBy(0, MINUTE_MAX, 1);
  }

  const stepAll = STEP_ALL_RE.exec(item);
  if (stepAll) {
    // {m | m mod n = 0} 与「自 0 起步进 n 到 59」在 [0,59] 上等价，共用 rangeBy。
    return rangeBy(0, MINUTE_MAX, parseStep(stepAll[1]!, item));
  }

  const range = RANGE_RE.exec(item);
  if (range) {
    const from = parseMinute(range[1]!, item);
    const to = parseMinute(range[2]!, item);
    if (to < from) {
      throw new Error(`cron 分钟项 "${item}" 为倒置区间（${to} < ${from}），非法（fail-closed 计为违反）`);
    }
    const step = range[3] === undefined ? 1 : parseStep(range[3], item);
    return rangeBy(from, to, step);
  }

  const startStep = START_STEP_RE.exec(item);
  if (startStep) {
    // a/n = 隐式 a-59/n。漏掉此形式的文法会让 0/15（实际展开 {0,15,30,45}、撞整点半点）
    // 因各项皆不匹配而抛错之外别无出路——若彼时选择静默空集，就是恒绿的空守卫。
    return rangeBy(parseMinute(startStep[1]!, item), MINUTE_MAX, parseStep(startStep[2]!, item));
  }

  const single = SINGLE_RE.exec(item);
  if (single) {
    return [parseMinute(single[1]!, item)];
  }

  throw new Error(
    `cron 分钟项 "${item}" 不属于既定文法（全集 * / 步进 / 区间 / a-b/n / a/n / 列表 / 纯数字），` +
      '无法展开（fail-closed 计为违反）',
  );
}

/** 分钟值校验：越界（> 59）抛错；regex 已保证无符号整数（≥ 0）。 */
function parseMinute(text: string, item: string): number {
  const value = Number(text);
  if (value > MINUTE_MAX) {
    throw new Error(
      `cron 分钟项 "${item}" 的分钟值 ${value} 越界（合法域 0-${MINUTE_MAX}），非法（fail-closed 计为违反）`,
    );
  }
  return value;
}

/** 步进校验：非正（0）抛错；regex 已保证整数。 */
function parseStep(text: string, item: string): number {
  const value = Number(text);
  if (value <= 0) {
    throw new Error(`cron 分钟项 "${item}" 的步进 ${value} 非正整数，非法（fail-closed 计为违反）`);
  }
  return value;
}

/** 自 from 起按 step 递增到 to（含）的整数序列。 */
function rangeBy(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let minute = from; minute <= to; minute += step) {
    out.push(minute);
  }
  return out;
}
