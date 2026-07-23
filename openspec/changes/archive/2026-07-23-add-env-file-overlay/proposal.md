## Why

同进程托管下，env 是**共享命名空间**，撞键即静默走错目标。

把本仓 re-host 成 hangar pilot 后，pilot 走**进程内 `import`**、跨 app 的 run 在同一事件循环交错，env 全靠 daemon 进程共享——脊柱**没有 per-app env 注入机制**。实测本仓与 inbox 撞 `DATABASE_URL` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 三键且**值全不同**：它们都是合法值、Zod 校验照过，于是安静地连到别人的库、用别人的 bot 往别人的群里发。**失败形态不是报错，是无声地对着错误的目标正常工作。**

本变更不依赖任何其它前置，可以先做。

## What Changes

- **主应用 env 单例支持一份自有 env 文件作为值来源**：`AI_RADAR_ENV_FILE`（**必须绝对路径**）设了就把该文件解析结果喂给已导出的 `parseEnv(source)`（`src/config/env.ts`），**绝不写 `process.env`**。
- **设了引导键 ⇒ 该文件是取值的唯一来源，不与 `process.env` 叠加。** 叠加式只护住「**文件里显式写了的键**」——没写的键（有默认值的、可选的、乃至必填的）一律落回 `process.env`，即兄弟应用的值。schema 94 键里只有 7 键无默认，其余 87 键在叠加式下全部暴露。受害面（已在代码中逐条核实）：
  - `FEISHU_WEBHOOK_URL` + `FEISHU_SIGN_SECRET`（两键都来自兄弟 ⇒ `isFeishuEnabled()` 转真 ⇒ **日报推进别人的飞书群**）；
  - `LLM_BASE_URL`（**带自己的 key 打向兄弟端点**）；
  - `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`（`/advisor` 从「谁都不放行」变成「凭**兄弟那个 CF Access application** 的 token 放行」——不是变公开，也通常不是换 IdP：同一个 Zero Trust 组织下 `iss` 相同、被换掉的是 per-application 的 `aud`，属**受众混淆**。凡能访问兄弟应用的人都能访问本仓 `/advisor`）；
  - `TELEGRAM_APPROVER_IDS`（兄弟的 user id 成为本仓的合法批准人）；它与 `MR_PRICE_CURATION_ENABLED` **两键同来自兄弟、且 chat id 可数值化**时，还会翻转 `isMrPriceCurationApprovalReady()` ⇒ 翻转 worker 的 **lane 注册**（那处注释自称「跨镜像 fail-closed」）；
  - **以及全部 6 个 `*_ENABLED` 门控**——一律 `z.enum(['true','false']).default('false')`，兄弟设 `'true'` 即开闸。真·静默开闸的招牌是 `MR_SCRAPE_ENABLED` / `MR_URL_DRIFT_ENABLED`（无跨字段闸）；**`ALERT_SCAN_ENABLED` 是这一类里唯一响的一个**——它另有以自身为合取门的 superRefine，本仓未设基线水位时表现为**启动失败**而非静默开闸。这是**一整类**，不是几个例子。
- **完整性契约就是 zod 自身的必填校验**，不另建键名清单：文件成为唯一来源后，缺任何必填键都会被现有 schema 挡下。**不引入「机械导出必填键集」那套机制**。
- **条件化 `env.ts:4` 顶层的 `import 'dotenv/config'`**：它今天在 import 期按**进程 cwd** 写共享 `process.env`，方向是本仓污染别人。设了引导键时不做 cwd 加载；未设时**加载同一个模块**（`createRequire(import.meta.url)('dotenv/config')`），等价性由构造保证。
- **引导键只在 env 模块首次求值时读一次**（读在本模块加载工作目录 `.env` 之前）；空值等同未设。`.env` 与自有文件里的同名键一律不参与——一个语义是「别读 `.env`」的键不能住在 `.env` 里。
- **`loadEnvFile` 与来源选择 `resolveEnvSource` 都导出为纯函数**：前者让路径校验与解析可直接单测，后者让「文件即唯一来源」这条**唯一的杠杆**可以被机械证明（判据见 design D1）。装配期的行为另用子进程用例覆盖，且全部场景由一条元用例守住「场景 ↔ 用例」双向覆盖（它证明标签存在，不证明用例会红——见 design D4）。
- **正面定义「配置不合法时怎么办」**：现行主规范写的是「应用退出」，那是独立进程的说法——同进程托管下 `process.exit` 会拖垮兄弟应用。改为行为级表述：**该应用不得带着未校验或错误的配置继续运行**——启动期抛错、绝不 `process.exit`、绝不开始干活。独立进程下兑现为非零退出；托管下兑现为 `await import()` reject、兄弟应用不受影响。**「宿主据此记账」是宿主契约不是本变更的保证**；另登记一条 ESM 语义：模块求值抛错后在该 realm 内被永久缓存，托管态下修好配置也不恢复、须重启宿主。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `platform-foundation`: 「环境配置校验」——增补主应用 env 单例的可选文件来源及其「文件即唯一来源」语义；并把「配置不合法 ⇒ 应用退出」改写为不依赖进程拓扑的行为级表述。
- `platform-foundation`: 「测试环境必须隔离生产外部出口」——**仅校正一处因果陈述**：其「根因」句提到的 `import 'dotenv/config'` 已被本变更条件化，故限定为「未设引导键时」。守卫判据（`process.env.VITEST`）不变。

## Impact

- **代码**：`src/config/env.ts`（可选文件来源 + 顶层 dotenv 条件化 + `loadEnvFile` / `resolveEnvSource` 纯函数导出 + `:1-3` 注释校正）、`.env.example`（只加注释行）、`src/config/__tests__/env.test.ts`。
- **不改**：`parseEnv` 的校验规则、`src/mcp/env.ts`（独立进程、自带校验入口）、`src/index.ts`、任何 lane / 流水线 / 幂等 / 锁。
- **行为**：`AI_RADAR_ENV_FILE` 未设 ⇒ 与今天完全相同（取值来源与优先级不变，dotenv 的 banner 抑制行为也不变）。
- **DB / 迁移**：无。
- **部署**：**本变更只提供机制、不接线**。当前单应用部署无需任何动作。将来启用同进程托管时的前置是**可执行约束，不是一句提醒**：
  - provision 的文件必须是一份**自足**的 env，含托管拓扑下正确的 `DATABASE_URL` / `REDIS_URL`；
  - **复用仓内 `.env` 前必须按拓扑核验 endpoint 归属**：`docker-compose.yml` 给应用的 env 是两层（`env_file` 打底 + `environment:` 覆盖 `DATABASE_URL`/`REDIS_URL`/`PORT` 三键），`.env` 里 DB/Redis 那份是 `localhost`。本变更废掉的是这三键中**落在 schema 内的两个**。`PORT` 不在 schema 内、由 web 入口裸读 `process.env`：在 compose 拓扑下它由 `environment:` 直供、不受影响；但在**依赖 `.env` 供 `PORT`** 的拓扑（如 `npm run dev`）下，设了引导键会掐断这条供给路径。宿主上的 daemon 若经已发布端口访问同一套 pg/redis，`localhost` **恰是正确目标**；**只有当宿主上不止一套服务占着同组端口时**才会静默连错。故这是核验义务，不是对该文件的无条件禁用；
  - **引导键必须在 env 模块首次求值前已在 `process.env` 里**——写进工作目录 `.env` 在 `npm run dev` 下**无效**（它在 dotenv 之前就被读了），而 compose 的 `env_file:` 在 node 启动前就注入为真进程环境变量、必然更早、**是生效的**。同一行配置在两种拓扑下行为不同，provision 时必须明确走的是哪条；
  - provision 路径必须含本应用标识（如 `/etc/hangar/ai-radar/env`），使「照抄兄弟应用的 provisioning」这类最可能的失误在值本身即可见（不构成归属保证，归属仍是登记的残余）；
  - **不得给 MCP 进程设该引导键**——后果落在**同一个 MCP 进程内的两个配置纪元**：其校验入口启动时读进程环境（该进程内无 dotenv 站点），推送路径要到首次调用推送工具时才动态 `import` 主 env 单例。设了引导键则纪元二变成「文件即唯一来源」，可与纪元一在全部 10 个同名键上分歧 ⇒ 跨目标读取与推送。**该禁令只有散文、没有守卫**（见「非目标」）；
  - 确认宿主会 `await` 本应用的 `import()`，并在 **per-pilot 边界** `try/catch` 住 rejection、记为该 pilot 失败后**继续运行其它 pilot**，**不得让它逸出到进程级未处理路径**（顶层 await 逸出的 rejection 会被 Node 升级为未捕获异常，宿主进程照样会死）。「兄弟不受影响」以满足这些前置为条件，不是本变更单方面能保证的。

## 非目标

- **不做 per-pilot env 隔离的通用机制**，也不向 hangar 提任何改动。
- **不改 `parseEnv` 的校验规则**，只多一个可选的值来源。
- **保护面限于主应用 env 单例**：`src/mcp/env.ts`（独立进程、自带校验入口）与 `src/index.ts` 的裸读 `PORT` 不在其内，本变更也不去改它们。
- **不承诺「畸形或二进制文件必被拒绝」**（解析器能从部分损坏的文件里提出合法键行）——见 design Risks。本契约回答的是「本应用是否拿到了属于自己的全部必填值」。
- **不保证文件归属**（指错到一份键齐的他人文件时校验会过）——**登记为残余**，完整论证见 design Risks。
- **不覆盖 `npm run migrate`**：`drizzle.config.ts`（`:3` 自读 dotenv、`:21` 裸读 `DATABASE_URL`）属独立 CLI，**不在本变更的保护面内**。**登记为残余**：托管态下跑迁移会打到兄弟的库，启用托管前必须另行处理。
- **不改 MCP 的配置来源**：其推送路径动态加载依赖主 env 单例的模块，给该进程设引导键会让同一进程内的两个配置纪元整体分歧。**登记为残余 + 明确禁止**；统一它属独立变更。
  **该禁令是本变更爆炸半径最大的一条 MUST，而它只有散文**：`src/config/env.ts` 结构上无从知道自己跑在 MCP 进程里，故没有场景、也没有守卫。落点已写进 `docs/hangar-migration-plan-a.md` 的 M 前置（执行 provision 的人读的是那份）。**在 MCP 启动入口加一条 fail-closed 拒绝**（该进程若检出引导键则 stderr + 非零退出）是已识别的后续项，不在本变更内——它要动 `src/mcp/server.ts`，而本变更的 Impact 明写不碰 MCP。
- **不把确定性状态交给 LLM**：env 校验全在程序侧。
