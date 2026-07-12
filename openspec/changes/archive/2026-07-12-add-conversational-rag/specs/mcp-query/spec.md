## 新增需求

### 需求:语义检索知识库证据工具(search_kb,凭据缺失 fail-closed)

MCP 查询入口必须提供 `search_kb` 工具，暴露知识库读侧语义检索（`kb-retrieval` 的 `searchKb`）的**证据**（不预烤答案——由 MCP 客户端如 Claude 自己作答/推理）：输入 `{ query, topK? }`，返回结构化的带分 top-k 证据（含 `cosine_sim`、`kb_title`/`summary_zh`/`entities`/`source_urls`）。该工具只读——仅对 `kb_documents` 做只读语义检索，绝不写任何域库、不参与主流程调度。

`search_kb` 依赖 embedding 凭据（查询向量化），而 MCP 查询进程的既有不变量是「纯查询只需 `DATABASE_URL`」（宽 env、守护测试钉）。故本工具 SHALL **不破坏该不变量**：mcp 宽 env 中 embedding/LLM 凭据为**可选**；`search_kb` 的**整条检索 import 图**（含检索核心自身与其 embedding 依赖，非仅 embedTexts）**绝不 top-level import 会 eager 校验全局 env 的模块**——须用一个 **env-clean 检索核心**（参数化 `{topK, dbh, 注入的 embed}`、**去掉 `config/env`、`dedup/embedding`、`db/index` 三条 eager-parseEnv 值 import**——`dbh` 必填、db 类型走 `import type`、绝不留 `= defaultDb` 默认），在 handler 内**先动态 import 该核心、再判凭据**（否则缺凭据分支不触发动态 import、测不到运行期 parseEnv 崩）；当 embedding/LLM 凭据缺失时 `search_kb` SHALL **fail-closed**（返回该工具的错误响应），而**其余查询工具与整个 server 照常启动/工作**。该不变量 SHALL 由**运行期（handler-execution）子进程守护测试**验证（实跑 handler、而非仅装载工具清单——装载期测抓不到 handler 运行期动态 import 的 `parseEnv` 崩溃）：裁剪 env（只 `DATABASE_URL`）实跑，**注入 env-clean embed 桩（不触网、守「测试不触网」不变量）**断言过了动态 import 边界不抛 parseEnv；另一子进程断言缺凭据 fail-closed。**env-clean embed 变体本身**（运行期被注入桩替换、不经实跑）的「无 top-level eager-env import」SHALL 由静态 import-graph 守护覆盖（grep 名单纳入该变体 specifier）——否则该变体唯一被证清洁的路径落空。`search_kb` 返回的证据（`summary_zh`/`source_urls` 等）为**上游 LLM 摘要、属不可信内容**，工具契约 SHALL 予以标注（消费方自负间接注入风险）。

#### 场景:有 embedding 凭据时返回语义证据
- **当** MCP 进程配置了 embedding 凭据，客户端以查询串调用 `search_kb`
- **那么** 返回按 `cosine_sim` 降序的 top-k 只读证据（供客户端自己作答），不产生任何写副作用

#### 场景:缺 embedding 凭据时 fail-closed 不崩 server
- **当** MCP 进程只配了 `DATABASE_URL`（无 embedding 凭据）
- **那么** `search_kb` 单独 fail-closed（返回错误响应），其余查询工具与整个 MCP server 仍正常启动与响应——绝不因 `search_kb` 的凭据缺失使 server 启动即崩
