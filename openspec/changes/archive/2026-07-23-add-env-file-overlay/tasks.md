## 1. 实现（全部落在 `src/config/env.ts`）

- [x] 1.1 **在文件顶部、任何 dotenv 之前**取一次引导键：`const bootPath = process.env.AI_RADAR_ENV_FILE?.trim() || undefined;`。**全模块只此一次读取**——`:830` 处不得重读（design D1 论证了两种「读两次」的实现都会坏）。空串/纯空白等同未设。
- [x] 1.2 新增导出的纯函数 `loadEnvFile(absPath: string): NodeJS.ProcessEnv`：非绝对路径即抛（信息含「绝对路径」）→ **`statSync(absPath).isFile()` 必须先于 `readFileSync`**（FIFO 上 `readFileSync` 无写端时会**永久挂起**，不抛不超时；`statSync` **跟随符号链接**，这是有意的——secret 挂载普遍是 symlink）→ `readFileSync` → `dotenv.parse`。**不存在 / 不可读 / 非普通文件必须抛**，**绝不返回 `{}`、绝不回落 `process.env`**。**只返回解析结果，绝不写 `process.env`。**
- [x] 1.3 新增导出的纯函数 `resolveEnvSource(boot: string | undefined, procEnv): NodeJS.ProcessEnv`——`return boot ? loadEnvFile(boot) : procEnv;`。⚠️ **函数内绝不再读引导键**：单参版（自己从 `procEnv` 取）会在装配处二次读活的 `process.env`，而那时 dotenv 已经跑过 ⇒ 产出 design D1 判死的半生效态（三个 lane 各自实测复现过）。
- [x] 1.4 条件化顶层 dotenv：`if (!bootPath) createRequire(import.meta.url)('dotenv/config');`（复用 1.1 那个 const）。⚠️ **必须加载同一个模块**——不要改调 `dotenv.config()` 也不要自拼选项（理由见 design D3）。
- [x] 1.5 单例改为 `parseEnv(resolveEnvSource(bootPath, process.env))`（复用 1.1 那个 const）。⚠️ **绝不要写 `{...process.env, ...file}`**，也不要在这一行外层再叠加——3.8 就是钉这一行的（design D1）。
- [x] 1.6 `parseEnv` 的校验规则**零改动**；不新增任何键名清单、不新增导出的必填键集（design D2）。
- [x] 1.7 **校正 `:1-3` 的现存注释**——它写着「dotenv 默认不覆盖已存在的 `process.env`，故 CI / shell 注入的变量仍优先」，这句话在**设了引导键的路径下是假的**（那时 CI/shell 注入被整体忽略）。限定为「未设引导键时」。
- [x] 1.8 文件头注释说明机制与边界，并**指向主规范 `platform-foundation`「环境配置校验」**作为权威表述——**不要在注释里复制论证**（它的真值依赖实测，放在代码里没有机械守卫，改一次就与规范漂移）。

## 2. 配置样例

- [x] 2.1 `.env.example` 加**注释行**说明该键，**不给可赋值的 `AI_RADAR_ENV_FILE=`**——它的语义是「别读 `.env`」，写在 `.env` 里必然无效（1.1 在 dotenv 之前就读完了）。注释须点明「必须由进程环境提供，写在本文件里无效」。

## 3. 测试（`src/config/__tests__/env.test.ts`）

> **两条路，都要走**：纯函数用例压 `loadEnvFile` / `resolveEnvSource`；**装配期行为用子进程用例**。形态钉死：
> `spawnSync(path.join(repoRoot, 'node_modules/.bin/tsx'), ['-e', script], { cwd: tmpDir, env: 裁剪过的 env, timeout: 30_000 })`。
> ⚠️ **硬超时必须落在 `spawnSync` 的选项上**：它阻塞事件循环，`it(…, 60_000)` 是定时器、抢占不了它。
> ⚠️ **不要用 `npx`**：从 `/tmp` 解析不到 tsx 会转去 registry 安装——联网、慢，**且自己往 stdout 打字**，直接打掉 3.7 的 stdout 断言。（仓内先例 `src/mcp/__tests__/query-chain-env.test.ts` 五处 spawn 全是 `cwd: repoRoot`，**没覆盖「换 cwd」这一半**，而换 cwd 恰是这几条的承重部分。）
> ⚠️ **断言载荷走 stderr、结论走退出码**——探针一旦 `console.log` 就把 stdout 断言弄脏了。
> ⚠️ **fixture 必须是自足 env**（7 个必填键 + 6 条跨字段 superRefine 都要满足），且**逐条设 60s 超时**：`vitest.config.ts` 无 `testTimeout`（默认 5s），而先例注释明写子进程冷启动可 >5s。
> ⚠️ **唯一禁止的写法是「同进程内换 `DOTENV_CONFIG_PATH` 再 `vi.resetModules()` 重载」**：它对忠实实现不可达（外部化 CJS 的副作用不复位），只有手抄内联推导才会绿。子进程那条路不受此限（design D4）。

- [x] 3.1 `loadEnvFile` 收到相对路径 ⇒ 抛错，信息含「绝对路径」。
- [x] 3.2 `loadEnvFile` 指向**不存在**的路径 ⇒ 抛出**包装过的**错误（断 `/AI_RADAR_ENV_FILE 指向的文件无法读取/` 与路径子串两条）。⚠️ **断包装文案而非路径正则**：前者同时钉住 1.2 的 try/catch（删掉整块、或改成 `catch { return {} }` 都会红——此前这两个变异都能全绿），后者在 tmpdir 含 `+`/`(`/`[` 时会误红。
- [x] 3.3 `resolveEnvSource(f, { LLM_BASE_URL: 'sibling' })` 的返回对象与 `loadEnvFile(f)` **深度相等**（不是「不含某个键」——那挡不住选择性叠加）。
- [x] 3.4 `resolveEnvSource(undefined, procEnv)` 返回**传入的 `procEnv` 本身**（trim / 空值归一在 1.1 一处完成，函数只认 `undefined`）。
- [x] 3.5 `loadEnvFile` 调用前后 `process.env` **逐键不变**。
- [x] 3.6 缺必填键不回落：文件缺 `DATABASE_URL` 而 `procEnv` 里有 ⇒ `parseEnv(resolveEnvSource(...))` 抛错并指明该键。
- [x] 3.7 **（子进程）未设引导键**：临时 cwd 放 `.env` ⇒ 断言取到该值，**且 stdout 为空**（钉 design D3 的 banner 抑制——将来有人改成 `dotenv.config()` 时必红）。
- [x] 3.8 **（子进程）设了引导键 —— 这是 D1 唯一的端到端证明**：子进程**自己的 `process.env`** 里放兄弟值 `LLM_BASE_URL=https://sibling.example/v1`（文件**不写**该键）与一份兄弟 `DATABASE_URL`（文件**写**自己那份）。断言 ① `env.LLM_BASE_URL === 'https://openrouter.ai/api/v1'`（**schema 默认，不是兄弟值**）② `env.DATABASE_URL === 文件里那份` ③ 子进程 `process.env` 未被写入文件里的键。①② 同时钉死 `{...process.env, ...file}` 与 `{...file, ...process.env}` 两个方向。
  ⚠️ **兄弟值必须放进子进程的 `process.env`，不能放 cwd `.env`**——设了引导键时 dotenv 根本不跑，放在 `.env` 里的值本就进不来，那样断言**结构上不可能红**。
- [x] 3.9 **（子进程）`.env` 里写引导键无效**：cwd `.env` 内含 `AI_RADAR_ENV_FILE=/abs/x.env`、进程环境不含 ⇒ 断言走「未设」路径（取到 cwd `.env` 的值），**不出现半生效状态**。
- [x] 3.13 **（子进程）非普通文件（FIFO）在读取之前失败**。⚠️ **这条必须走子进程 harness**：FIFO 上 `readFileSync` 同步永久阻塞，留在同进程里时删掉守卫的后果不是变红，而是 vitest 无声挂到 CI job 超时、reporter 不指认任何用例、`afterAll` 不跑（评审期真实发生过一次）。走 `probe()` 后同一变异收敛成 31s 内的红（实测）。
- [x] 3.10 **源码守卫**：断言 `src/config/env.ts` **剔除注释后**不出现 `process.exit`（1.7/1.8 要写的注释天然会提到它，裸文本匹配会误红）。口径与 spec 一致：只管**配置加载与校验路径**，不是全仓。
- [x] 3.12 **元用例：spec 场景 ↔ 用例双射**——读 spec 抽出本 requirement 的全部 `#### 场景:`，与用例标题里的 `[场景:X]` 标签断言集合相等。加了场景没写用例则红，写了用例而场景里没有也红。⚠️ **归档时该 spec 会并入主规范并搬走**，须把用例里的路径常量改指主规范；改不到就是这条变红——响亮、不静默。切片边界用「下一条 `### ` 或文件尾」而非邻居 requirement 的名字，故**除该常量外无需再改**（早前按具名邻居切，在主规范里两者之间夹着 2 条无关 requirement / 5 条场景 ⇒ 归档后会红成「你漏写了 5 条用例」，误导且照注释改也修不好）。元用例另断言本文件不出现跳过修饰符——它是唯一能整块归零覆盖而不被察觉的洞。
- [x] 3.11 `npm run typecheck && npm run lint && npm run test` 全绿；守 `test-no-prod-sends`。

## 4. 收尾

- [x] 4.1 `git diff` 复核：未设引导键时无行为差异。3.7 钉住取值与 stdout；**加载时序的等价性依赖一个未被断言钉住的前提**——被提升的静态 import 均不在求值期读 `process.env`（今日人工核过：zod / dotenv / cron-minutes 零依赖、collectors/types 是 `import type`）。工作区无探针遗留文件。
- [x] 4.2 `npm run spec:validate add-env-file-overlay` 通过。
- [x] 4.3 **同步 `docs/hangar-migration-plan-a.md`**：它仍写着被本变更否决的叠加式 `{...process.env, ...自己那份 .env}`，改为「文件即唯一来源」并指向本 requirement。（一行文档修正；留着不改等于归档后仍有一份权威文档教人用错做法。）
- [x] 4.4 提 PR（#103，已合并）；归档时元用例路径常量已改指主规范。
- [x] 4.5 **部署无动作**（引导键可选、未设即现状；无新增必填 env、无迁移、无新依赖）。启用托管前须**逐条核对** proposal Impact 的前置清单（不在此重复誊抄）。
