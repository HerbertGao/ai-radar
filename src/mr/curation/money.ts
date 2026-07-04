/**
 * Model Radar 价格 curation 共享 money 比较原语（design D2/D5）。
 *
 * **writer-free**：本文件是纯函数，**绝不** import 任何事实 writer（`recordPriceChange`/`upsert*` 等；
 * eslint `no-restricted-imports` 对 `curation/**` 除 `approve.ts` 外收窄禁 writer）。
 *
 * `sameMoney` 统一「同一笔钱？」判定，供 store 的同候选判定与 approve 的基线未漂移判定复用（两处曾各自
 * 维护一份字节等价实现）。语义：两侧 NULL 视为同（NULL 占位基线）；一侧 NULL 一侧有值 = 不同；
 * 均有值 → 数值归一比额（numeric 列以 string 存，`Number()` 归一）+ 币种直比。
 */
export function sameMoney(
  v1: string | number | null,
  c1: string | null,
  v2: string | number | null,
  c2: string | null,
): boolean {
  const n1 = v1 == null;
  const n2 = v2 == null;
  if (n1 || n2) return n1 && n2 && c1 === c2;
  return Number(v1) === Number(v2) && c1 === c2;
}
