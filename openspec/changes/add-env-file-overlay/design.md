## Context

动机见 `proposal.md`。本节只记**实测确认、且直接决定设计形状**的几条（行号为本变更前的基线快照，实现落地即失效——按符号名找）。

- `parseEnv(source: NodeJS.ProcessEnv)` 已经是导出的纯函数（`env.ts`，行号随本变更移动，按符号名找），单例是 `parseEnv(process.env)`。**取值来源已经是一个可替换的入参**，本变更不需要动校验逻辑。
- **生产 dotenv 站点两处**：`src/config/env.ts:4`（本变更条件化的那个）与 `drizzle.config.ts:3`（迁移 CLI，保护面外，见 Risks）。**生产侧裸读 `process.env` 三处**：`src/index.ts:26`（`PORT`，web 入口）、`src/mcp/env.ts:73`、`drizzle.config.ts:21`；`src/` 内其余读点全在 `VITEST` 守卫内。
- **zod 4.4.3**：`envSchema` 经 6 次 `.superRefine()` 后仍是 `ZodObject`、`.shape` 可读（94 键）。但「无默认值」只有**语义式**判据站得住：`shape[k].safeParse(undefined).success === false`（≡ `isOptional() === false`）得 **7 键**；结构式 `_zod.def.type !== 'default'` 得 **15 键**——多出的 8 键分两类：5 个 `z.string().default('').transform(...)`（v4 外层是 `ZodPipe` 而非 `ZodDefault`）与 3 个 `ZodOptional`，都有可用取值却在结构上看不出来。
- **dotenv 17.4.2**：`dotenv/config` = `config({...env-options, ...cli-options(argv)})`，而 `cli-options` 在**默认 argv、未显式设 `quiet`／`DOTENV_CONFIG_QUIET`、非 debug** 时注入 `quiet:'true'`——这正是本仓所有入口的形态。裸调 `dotenv.config()`、或只转交 `DOTENV_CONFIG_*`，都会**每次启动往 stdout 打一行 banner**（污染 `kb:search` 这类把 stdout 当数据通道的 CLI）。另：`DOTENV_KEY` 由 dotenv 的 `main.js` 自读、不会丢；env 侧真正的变量名是 `DOTENV_CONFIG_DOTENV_KEY`。
- **dotenv 的解析器不是全或无**：对「合法键行 + 非法字节尾部」的输入，它能把该键提出来。
- **vitest 4.1.10**：`vi.resetModules()` **不复位外部化 CJS 的副作用**——第二次 `import 'dotenv/config'` 是 no-op，而 `dotenv/lib/env-options` 是**首次 require 时的 `process.env` 快照**。

## Goals / Non-Goals

**Goals:** 让本应用在同进程托管下**只读到属于自己的配置**；让「配置不合法」这件事在两种进程拓扑下都有确定且可测的后果；未设引导键时取值行为与今天一致。

**Non-Goals:** 见 `proposal.md` 非目标，逐条一致。

**信任模型（先读这条——不写出来，下面每条结论都会被读错）**：本机制的对手是**善意但共享命名空间的兄弟应用**——失效源于撞键，不是恶意。**同进程内不存在安全边界**：任何同进程代码都能改 `process.env`、patch `fs`/loader，或 `import` 同一个模块实例直接拿到 `env` 单例里的凭据。这不可缓解，也不是本变更的目标；要抵御恶意的兄弟应用需要进程/容器级隔离，属另一层。本文档里**裸用**的「隔离」一律指**卫生隔离**（带限定词的复合用法——「进程/容器级隔离」「故障隔离」「worker 级隔离」——各按其字面）（别读到、别写到邻居的东西），不是机密性。

**本模型内有两个失效源**：**撞键**与**运维误操作**（provision 指错 / 漏写 / 照抄兄弟那份）。Risks 里最大的三条残余全属后者，**不要**把它们读成模型外。

**第三个 principal 是宿主，而且它是信任的根**：引导键的值由它注入、那份文件由它 provision、D5 的「失败被记账」全靠它兑现。宿主失守则本机制整体落空——机制的根是宿主，不是文件。

## Decisions

### D1：设了引导键 ⇒ **文件即唯一来源**，不与 `process.env` 叠加

```ts
// env.ts 顶部，在任何 dotenv 之前取一次，全模块共用这一个 const：
const bootPath = process.env.AI_RADAR_ENV_FILE?.trim() || undefined;

// 双参：**函数内绝不再读引导键**。单参版会在装配处二次读活的 process.env，
// 而那时 dotenv 已经跑过了 —— 三个 lane 各自实测过那条路会产出下面判死的半生效态。
export function resolveEnvSource(
  boot: string | undefined,
  procEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return boot ? loadEnvFile(boot) : procEnv;
}

export const env: Env = parseEnv(resolveEnvSource(bootPath, process.env));
```

**引导键只读一次，读在 dotenv 之前（承重）**：D3 的条件判断必须发生在 dotenv 之前（否则没法决定要不要加载它），而取值发生在模块末尾。若这是**两次**读取，中间那次 dotenv 会改写 `process.env`，于是产生两种都坏的实现：

- **在 `:830` 重读**：`.env` 里写的引导键在 `:4` 时还不存在 ⇒ dotenv 照常把整个 `.env` 灌进共享 `process.env`（**本变更要消除的污染方向，发生了**）⇒ 而后又切「文件即唯一来源」。两个决策各生效一半。
- **只在顶部读一次、但允许 `.env` 提供该键**：写在 `.env` 里的引导键**永不生效** ⇒ 隔离静默不开启，而运维以为开了——**正是本变更要消灭的失败形态**。

故：**引导键只能由进程环境提供，`.env` 与自有文件内的同名键一律不参与**；空串等同未设（`?.trim() || undefined`）。`.env.example` 因此**不给它可赋值行**，只留一行注释说明「必须由进程环境提供，写在本文件里无效」——一个语义是「别读 `.env`」的键不能住在 `.env` 里。

**替代方案「叠加」（`{...process.env, ...file}`）被否。** 叠加只护住**文件里显式写了的键**：文件没写的键——不论它有默认值、可选、还是**必填**——都会落回 `process.env`，即兄弟应用的值；必填键因此也照样能被兄弟的值满足而通过校验。schema 94 键里只有 7 键无默认，其余 87 键在叠加式下全部暴露。受害面见 `proposal.md`。

**「唯一来源」把问题从「哪些键需要护」变成「不存在未被护的键」——这是本设计唯一真正的杠杆，也是唯一需要机械证明的性质**（判据是 `resolveEnvSource` 的返回对象与 `loadEnvFile` 的结果**深度相等**——「不含某个兄弟键」挡不住选择性叠加，而「断言 `parseEnv(loadEnvFile(f))`」连装配处都够不着）。

### D2：完整性契约就是 zod 自身的必填校验，不另建键名清单

文件成为唯一来源后，缺任何必填键都会在 `parseEnv` 里被现有 schema 挡下。**不需要**「从 schema 机械导出必填键集再逐项断言」那套机制。

**这不是省事，是因为那套机制的判据无法定义**：如 Context 所记，v4 下结构式与语义式判据分别得 15 / 7 键，而 15 键口径会让 `cp .env.example` 出来的文件**被拒且无可满足取值**（`SOURCE_STALENESS_ALERT_DAYS_OVERRIDES=` 与 `TELEGRAM_APPROVER_IDS=` 在示例里就是空值）。一个数不清自己要数什么的检查，不是护栏。

### D3：条件化顶层 dotenv 用 `createRequire`，未设引导键时**加载同一个模块**

```ts
if (!bootPath) createRequire(import.meta.url)('dotenv/config');  // 复用同一个 const
```

**替代方案「改调 `dotenv.config()` 并转交选项」被否**：`dotenv/config` 的行为等于 `config({...env-options, ...cli-options(argv)})`，而 `cli-options` 在本仓所有入口的形态下（默认 argv、未显式设 quiet、非 debug）注入 `quiet:'true'`。显式传 `{quiet:true}` 当然也能不漏，但那是**手抄一份会漂移的副本**——漏掉它的结果是每次启动多一行 stdout banner——`kb:search` 这类把 stdout 当数据通道的 CLI 会被污染。

`createRequire` 加载的是**同一个模块**，等价性由构造保证，不靠枚举选项，也就没有「将来 dotenv 加了新选项而我们没跟上」这条漂移路径。

### D4：`loadEnvFile` 是导出的纯函数，路径校验在它里面

`loadEnvFile(absPath): NodeJS.ProcessEnv`——校验路径为绝对路径、读文件、`dotenv.parse`。**必须绝对路径**：托管态下 cwd 是 daemon 的，相对路径的含义随宿主漂移，而漂移的后果正是本变更要挡的那一类（安静地读到别的东西）。

导出为纯函数，是为了让路径校验与解析可以被直接单测。

**但纯函数单测不足以覆盖本变更**——装配处（来源选择那一行）才是 D1 的杠杆点，而它不在任何纯函数里。故来源选择本身也抽成纯函数（签名见 D1），并额外用**子进程**覆盖 import 期的装配（形态见 tasks §3，仓内已有先例，不是新机制）。

**验收判据本身也要有界。** 前几轮的判据是「不存在能逃逸的变异」——变异空间无界，这个判据在原理上永不满足：每加一批用例，下一轮总能再造出新的错误实现。故改为**由 spec 的 `#### 场景:` 表定义「必须被机械证明的性质」**，并加一条元用例守住「场景 ↔ 用例」的双向覆盖：加了场景没写用例则红，写了用例而场景里没有也红。变异测试由此从**通过条件**降级为**编写用例时的手法**（写每条用例时投一个对应的错误实现验它会红即可）。

**这条元用例证明的是标签存在，不是用例会红**——静态文本检查够不到后者（用例体掏空成 `expect(1).toBe(1)` 照样绿）。它另断言本文件不出现 `describe`/`it` 的跳过修饰符：单条跳过会让标签一起消失、自然变红，而整块 describe 跳过时标签仍在源码里，是唯一能把覆盖整块归零而不被察觉的洞。**场景正文里写了、但机械上不可断言的句子仍在守卫之外**（如「同进程内其它应用不受影响」——它是应用侧保证与宿主前置的合取），这类句子须在场景里显式标成条件结论，不得写成无条件承诺。

**唯一走不通的是「同进程内换 `DOTENV_CONFIG_PATH` 再 `vi.resetModules()` 重载」**：Context 那条 vitest 事实说明它对忠实实现不可达（外部化 CJS 的副作用不复位），只有手抄内联推导才会绿。**那一种写法是假绿，不要写；子进程那种不是。**

### D5：「配置不合法」的后果按**行为**定义，不按进程拓扑

主规范现行写法是「应用退出」。同进程托管下这句话是空的：`process.exit` 会拖垮兄弟应用，而只让 `await import()` reject 又没兑现「退出」。

改写时必须把**应用能保证的**与**只有宿主能保证的**分开——早稿把后者写成了前者。

**应用侧的承诺（本变更负责，可测）**：读文件失败或 schema 校验失败时，**模块求值抛错**；**绝不调用 `process.exit`**；**绝不带着未校验的配置开始干活**。实现上不需要新机制——今天的 module init 抛错即是。

**宿主侧的前置（本变更不负责，写进托管启用条件）**：宿主必须 `await` 这个 `import()`，并在 **per-pilot 边界** `try/catch` 住 rejection、记为该 pilot 的失败后**继续运行其它 pilot**——**不得让它逸出到进程级未处理路径**（顶层 await 逸出的 rejection 会被 Node 默认升级为未捕获异常，宿主进程照样会死）。Node 只保证 `import()` 返回的 promise 会 reject；**它不保证宿主去 await、不 catch、或据此记账**。宿主若 catch 后继续，本应用不会跑起来（承诺仍成立），但「run 被记为失败」这件事就没有兑现——那是宿主的契约，不是 Node 的语义。

**登记的失败模式（ESM 语义，不可在本变更内修复）**：模块求值抛错后，该 module record 在**同一个 ESM loader / module map、同一个 resolved URL** 下被标记为 errored——此后每次 `import` 重抛同一个错误、**不重新求值**（换 query/fragment 或新建 module graph 可重新求值，但宿主每轮 run 用的是同一个 specifier）。

**两条对称的推论一并登记**：① 触发面不限于「配置错误」——启动瞬间的**瞬时 I/O 错误**（EMFILE / EINTR 等）同样把该 pilot brick 到宿主重启；② **成功路径也被缓存**：同一 daemon 内若以**不同引导键**二次加载本应用，第二次会静默复用第一次的配置，不会重新求值。二者都不在本变更的可修范围内（需宿主提供 worker 级隔离）。所以托管态下一次配置错误的后果不是「这次 run 失败、下次可以好」，而是**该 pilot 在宿主进程剩余生命周期内每次 run 都失败，改好 env 文件也不会恢复，必须重启宿主进程**。**故障隔离**不受影响（错误被限制在本 pilot 内），但它使「恢复」在同一进程内不可测，也不可达。

可测面因此是：独立进程断非零退出码；应用侧断模块求值 reject 且源码中不出现 `process.exit`。**「宿主记为失败」与「改好后恢复」都不在本变更的可测面内**，前者是宿主契约、后者被上面那条 ESM 语义排除。

## Risks / Trade-offs

- **[路径指错到别人的 env]** → **未关闭，接受的残余**：若那份文件本身键齐（如另一租户的同应用文件），完整性检查与 Zod 都会过。本变更的保证只能写成「阻止缺键回落到共享环境」。要保证文件归属需要一套身份契约（如文件内自带 app 标识并与运行时比对），属独立变更。
- **[`npm run migrate` 不在保护面内]** → **接受的残余**：`drizzle.config.ts` 是独立 CLI、自读 `process.env`。托管态下跑迁移会打到兄弟的库。启用托管前必须另行处理（给迁移入口同样的引导键，或把迁移移出托管态执行）。
- **[文件部分损坏时可能被当成有效]** → dotenv 的解析器不是全或无，能从「合法键行 + 非法字节尾部」里提出该键。故本变更**不承诺**畸形文件必被拒绝；兜底仍是 Zod——缺必填键会被挡下，而值本身的合理性不在本变更的射程内。
- **[引导键本身来自共享 `process.env`]** → 不可消去：总得有一个来自环境的入口。**真正的缓解是键名与本应用同名**——善意的**兄弟应用**没有理由去设 `AI_RADAR_ENV_FILE`，在信任模型下撞它的概率≈0。**但唯一有理由设它的是宿主**：hangar 今天缺的正是 per-app env 注入，将来补上时最自然的实现就是按 app 名派生 `<APP>_ENV_FILE`——那会**恰好命中本键**。届时它不是撞键事故，是**需要协调的接口**，应在宿主侧落地前对齐语义（尤其「文件即唯一来源」这条，宿主若按叠加式实现就白做了）。**不要宣称「撞键必然表现为文件不存在」**：兄弟若把它指向一份**存在且键齐**的文件，Zod 会全过，后果是 94 个键**一次性**全走错——即引导键把「能撞单个键」升级成「能一键顶掉整份配置」。恶意设置属信任模型外，同进程内不可缓解。
- **[文件未写的键静默取 schema 默认值]** → **接受的残余**：D1 把「静默继承兄弟的值」换成了「静默取默认值」——方向安全得多，但**仍然是静默**。本变更**不保证任何默认值在生产托管拓扑下都安全**，也不检测漏写：最可能的失误是 provision 新文件时漏写 `FEISHU_WEBHOOK_URL` / `FEISHU_SIGN_SECRET` ⇒ `isFeishuEnabled()` 静默转假 ⇒ **日报少一条通道且不报错**；键名拼错同样静默取默认（这是 D2 放弃键名清单的代价，不是缺陷）。压力顶到部署侧：provision 的文件必须自足。
- **[`VITEST` 守卫的条件本身是生产期的共享环境裸读]** → 8 个生产模块共 17 处调用点以裸读共享 `process.env.VITEST` 判是否测试态。自有文件既设不了也清不掉该键 ⇒ **按构造在保护面外**。共享环境里若留着该键，本应用的 LLM / embedding / 推送调用点会整体抛错——**fail-closed、响亮、不误发**，故不改设计，但必须登记（否则 spec 那句「以下不在其内且 MUST 显式登记」是空的）。
- **[设了引导键后，CI / shell 注入的覆盖被静默忽略]** → **有意的**，但 `src/config/env.ts:1-3` 的现存注释正好写着「CI / shell 注入的变量仍优先」——那句话在引导键路径下变成假的，实现时必须一并限定（见 tasks 1.5）。
- **[给 MCP 进程设引导键 ⇒ 读邻居的库、推自己的群]** → 方向是定死的，不是「配置不一致」这种可权衡的措辞：`parseMcpEnv(raw = process.env)` **直读共享环境**拿 `DATABASE_URL`，而 `push-event-now.ts` 动态 import 的 dispatcher / sender 走**主 env 单例**拿 bot/chat/webhook ⇒ **用邻居的数据推进自己的通道**，属跨租户数据披露。
  另注：MCP 不是「靠进程分离而安全地在保护面外」。**进程分离给出的是环境的一份快照副本，不是隔离**——它由 MCP 客户端按客户端自身配置启动，取值与本仓部署拓扑无关；不设引导键时该进程内也没有 dotenv 站点，主单例要到首次调用推送工具时才被动态 `import` 建立。它是全仓唯一一条由 MCP 触发、真发外部消息的路径。**登记 + 明确禁止**给 MCP 进程设该键；统一其配置来源属独立变更。
- **[provision 时复用仓内 `.env`，其 endpoint 归属取决于拓扑]** → `docker-compose.yml` 给应用的 env 是**两层**：`env_file: .env` 打底 + `environment:` 覆盖三个键（`DATABASE_URL` / `REDIS_URL` / `PORT`；个别服务自带的 `environment:` 只覆盖前两个）。D1 废掉的是其中**落在 env schema 内的两个**——`PORT` 因裸读 `process.env` 不受影响（见保护面残余）。⇒ 引导键指向仓内 `.env` 时 DB/Redis 取到的是 `localhost` 那份。
  **这不必然是错的**：宿主上跑的 daemon 若经宿主已发布端口访问同一套 pg/redis，`localhost` 恰是正确目标。**风险是条件性的**——只有当宿主上不止一套服务占着同组端口时，才会静默连到别人那套。故约束应写成「**按托管拓扑核验 endpoint 的归属**」，**不是**无条件禁用该文件。

## Migration Plan

**无新增必填 env**（引导键是可选的、未设即现状）、无数据迁移。现有未启用部署无动作；托管启用时须满足 proposal Impact 的前置清单。回滚 = revert commit。

## Open Questions

无。D5 已按「应用侧承诺 / 宿主侧前置」拆开定义，全部残余已在 Risks 登记。
