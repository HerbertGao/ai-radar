/**
 * 离线 eval 专用 vitest 配置（task 10.1，design D7 / DD1）——`npm run test:eval` 用它。
 *
 * **为何单独 config**：vitest 4 的位置参数是**过滤器**、受 `test.include` 门控——默认 include 只命中
 * `.test.` / `.spec.` 后缀，`vitest run src/.../*.eval.ts` 会「No test files found」。故 eval 的 include
 * 必须显式设为 `.eval.ts` glob。**基线 `vitest.config.ts` 不动**——`npm run test` 仍用默认 include、天然
 * 不跑 `.eval.ts`（DD1：eval 与单测隔离靠后缀 + include 分离）。
 *
 * 串行同基线（本套件目前只有 1 个 eval 文件，fileParallelism 无实质影响，保持一致）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/mr/scrape/__tests__/*.eval.ts'],
  },
});
