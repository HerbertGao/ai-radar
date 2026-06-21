## 为什么

全仓**飞书（lark_md）卡片渲染器**把来源 URL **裸插**进内联链接 `[文本](${url})`，无任何 URL 转义（CodeRabbit PR #34 #6 提出，已核实是全仓 pre-existing 约定）。`canonical_url` / `canonical_source_url` 来自外部 feed，可含 `)` `\`（如维基百科 `..._(programming_language)`、带括号 query 的 URL）。lark_md 按 markdown 语法解析内联链接的 `(...)` 段：URL 内未转义的 `)` 会在**第一个 `)` 处提前闭合链接**，把剩余 URL 当普通文本泄漏、链接指向被截断的错误地址、破坏卡片渲染与可点击性。

Telegram 侧早已用专用 URL 转义器 `escapeMarkdownV2Url`（仅转 `)` 与 `\`）正确处理这一情形（见 telegram-push「链接 URL 含特殊字符用独立规则转义」场景）；**飞书侧缺对应的 URL 转义器**——4 个飞书 lark_md 渲染器（事件 / 产品 / 周报 / 经验）全部裸插 URL。这是飞书通道与 Telegram 通道之间的转义缺口，属 spec 级正确性要求，须统一收口加固。

## 变更内容

- **新增 `escapeLarkMdUrl(url)`**：飞书 lark_md 内联链接 `[文本](url)` 的 **URL 段专用**转义器，**percent-encode 会破坏链接结构的 `( ) [ ] \`（`%28`/`%29`/`%5B`/`%5D`/`%5C`）**（与 Telegram 的 `escapeMarkdownV2Url` URL 专用语义对称，但用 percent-encode 而非反斜杠——解析器无关、href 不变，见 design D1）。**禁止复用 `escapeLarkMdText`**——后者转义 `[ ] ( ) \` 是为**链接文本/正文**设计，作用在 URL 上会破坏 URL 本身（把 URL 里合法的 `(`/`)` 当 markdown 语法处理、点击跳错）。文本转义器与 URL 转义器是两套不可互换的规则，与 Telegram 侧（`escapeMarkdownV2` 文本 vs `escapeMarkdownV2Url` URL）对称。
- **应用到全部 4 个飞书 lark_md 渲染器的链接行**，统一收口（飞书侧 URL 一律经 `escapeLarkMdUrl` 再插入 `(...)`）：
  - 事件卡片 `buildFeishuCard` 的 `[原文](${url})`。
  - 日报双段卡片 `buildDailyFeishuCard` 的事件 `[原文](${url})` 与产品 `[官网](${url})`。
  - 周报卡片 `buildWeeklyFeishuCard` 的 `[原文](${url})`。
  - 实践锦囊卡片 `buildExperienceFeishuCard` 的 `[来源](${url})`。
- **在 `message.ts` 已有飞书相关测试新增用例**：含 `)` / `\` 的 URL 经渲染后链接结构完整（断言转义后的输出片段，验证 `)` 不再提前闭合链接、URL 全段在 `(...)` 内）。
- **转义机制决策（已定）**：采用 **percent-encode**（`( ) [ ] \` → `%28`/`%29`/`%5B`/`%5D`/`%5C`）而非反斜杠——percent-encode 后 URL 段无括号/方括号，对「首个 `)` 即闭合」与「CommonMark 配对括号」两种 lark_md 解析模型都不破链（correct-by-construction、与解析器无关、无需实测即正确），`%xx` 为合法 URL 编码、点击解码回原字符、href 不变。上线前以真实飞书测试群发一条含 `(`/`)` URL 的卡片做**确认性实测**（非实现阻塞）。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增功能。本变更是对既有飞书卡片渲染需求的正确性加固。 -->

### 修改功能
- `feishu-push`: 现有需求「飞书自定义机器人通道推送 / 推送渲染为飞书 JSON 卡片」要求卡片跳转用 lark_md 文字链（内联链接 `[文本](url)`）。**新增正确性约束**：lark_md 内联链接的 **URL 段必须经独立 URL 转义器转义 `)` 与 `\`**（不得裸插、不得复用文本转义器），以防来自外部 feed 的 `canonical_url` / `canonical_source_url` 含 `)` 时在第一个 `)` 处截断链接、破坏卡片渲染与跳转。增量补「飞书链接 URL 含特殊字符用独立规则转义」场景，与 telegram-push 同名约束对称。

## 影响

- **代码**：`src/push/message.ts` —— 新增 `escapeLarkMdUrl`（导出）；4 个飞书渲染器（`buildFeishuCard` / `buildDailyFeishuCard`〔事件 + 产品两处〕 / `buildWeeklyFeishuCard` / `buildExperienceFeishuCard`）的链接行由裸 `${url}` 改为 `${escapeLarkMdUrl(url)}`。
- **测试**：`src/push/` 既有 message 测试新增含 `)` / `\` URL 的飞书渲染断言。
- **范围 = 全仓飞书 URL 转义统一加固**（碰事件 / 产品 / 周报 / 经验 4 处 lark_md 链接）；**不改 Telegram**（已用 `escapeMarkdownV2Url` 正确转义）。
- **不影响**：链接跳转目标语义（转义后点击仍到原 URL）、卡片其它结构、dispatcher 状态机、幂等四元组、URL 归一、推送时效性策略；不新增功能 / 依赖 / env / 调度。

## 非目标

- **不改 Telegram 渲染器**：Telegram 已用 `escapeMarkdownV2Url` 正确转义，本变更不碰。
- **不改链接跳转目标语义**：转义只为修复链接结构截断，点击后仍跳转到原 `canonical_url` / `canonical_source_url`（含其中的 `)`）。
- **不改卡片其它结构 / 状态机 / 幂等口径**：不动 dispatcher、`UNIQUE(target_type, target_id, channel, push_date)` 幂等、URL 归一（去 utm/ref 等）、`published_at` 时效窗口与任一既有不变量。
- **不把确定性状态交给 LLM**：URL 转义是纯程序确定性字符串处理，与 LLM 无关；来源 URL 仍取自确定性 `canonical_url` / `canonical_source_url`，不经 Agent。
- **不新增功能 / 依赖 / 环境变量 / 队列 / cron**：仅修复既有渲染器的转义缺口。
