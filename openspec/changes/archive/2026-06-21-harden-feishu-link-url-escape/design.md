## 上下文

`src/push/message.ts` 承载全部推送渲染，按 channel 分叉：Telegram 用 MarkdownV2、飞书用 JSON 卡片（lark_md）。飞书卡片跳转**只用文字链**（lark_md 内联链接 `[文本](url)`），因飞书自定义机器人不支持点击回调到服务端。

**已据实读 `src/push/message.ts` 校正的基线事实（勿凭记忆假设）**：

- Telegram 侧**已有** URL 专用转义器 `escapeMarkdownV2Url(url)`（`message.ts:59`）：`url.replace(/[)\\]/g, ch => '\\' + ch)`——只转 `)` 与 `\`。注释明确「禁止复用 18 字符文本转义器 `escapeMarkdownV2`，后者会把 URL 里常见的 `.`/`-`/`_`/`=` 也加反斜杠破坏链接」。telegram-push spec 有对应场景「链接 URL 含特殊字符用独立规则转义」。
- 飞书侧有文本转义器 `escapeLarkMdText(text)`（`message.ts:197`）：`text.replace(/[[\]()\\]/g, ch => '\\' + ch)`——转 `[ ] ( ) \`，用于**链接文本 / 标题 / 摘要正文**，注释写「URL 段不走此函数（URL 直接置于 `(...)` 内，飞书按原样跳转）」。
- 飞书侧**没有** URL 专用转义器。4 个飞书 lark_md 渲染器全部**裸插** URL：
  - `buildFeishuCard`：`lines.push(\`[原文](${url})\`)`（`message.ts:251`）。
  - `buildDailyFeishuCard`：事件 `lines.push(\`[原文](${url})\`)`（`message.ts:773`）+ 产品 `lines.push(\`[官网](${url})\`)`（`message.ts:794`）。
  - `buildWeeklyFeishuCard`：`blockLines.push(\`[原文](${url})\`)`（`message.ts:375`）。
  - `buildExperienceFeishuCard`：`lines.push(\`[来源](${url})\`)`（`message.ts:506`）。
- URL 取自确定性 `e.canonicalUrl`（事件/产品/周报由 `canonical_url`，经验由 `canonical_source_url` 映射进 `canonicalUrl`），已去 utm/ref 等追踪参数；**但去追踪参数不去路径/query 里的字面 `)`**（如 `https://en.wikipedia.org/wiki/Go_(programming_language)`、`https://x.com/...?foo=(bar)`）。
- 每个渲染器对 URL 已有 `url.length <= MAX_URL_LENGTH`（2000）超长丢弃保护，但**无字符转义**。

**问题**：lark_md 按 markdown 解析内联链接 `[文本](URL)` 的 `(...)` 段——URL 内未转义的 `)` 在第一个 `)` 处提前闭合链接，剩余 URL 当普通文本泄漏，链接 href 被截断到错误地址。注释「飞书按原样跳转」对**含 `)` 的 URL 不成立**，是 pre-existing 缺口。

约束：守住既有不变量（推送幂等四元组、URL 归一、时效性、dispatcher 状态机统一、外部调用带重试 + 错误日志、确定性状态不交 LLM）；技术栈 TS（config.yaml）；中文为主。

## 目标 / 非目标

**目标：**
- 新增飞书 lark_md 内联链接的 **URL 段专用转义器** `escapeLarkMdUrl(url)`，与 Telegram 的 `escapeMarkdownV2Url` 语义对称（percent-encode 破坏链接结构的 `( ) [ ] \`（非反斜杠，见 D1））。
- 把它应用到**全部 4 个**飞书 lark_md 渲染器的链接行（事件 / 产品 / 周报 / 经验），统一收口飞书 URL 转义。
- 含 `)` / `\` 的来源 URL 渲染后链接结构完整、可点击、跳转到正确（含 `)`）的原 URL。
- 在已有飞书测试加用例固化该正确性。

**非目标：**
- 不改 Telegram 渲染器（已正确转义）。
- 不改链接跳转目标语义、卡片其它结构、dispatcher 状态机、幂等口径、URL 归一、时效窗口。
- 不新增功能 / 依赖 / env / 队列 / cron；不把任何确定性状态交给 LLM。

## 决策

**D1 — 新增 `escapeLarkMdUrl(url)`，对 `(`/`)`/`[`/`]`/`\` 做 percent-encode（`%28`/`%29`/`%5B`/`%5D`/`%5C`）；不复用 `escapeLarkMdText`。**
- 实现：`url.replace(/[()[\]\\]/g, ch => ({'(':'%28',')':'%29','[':'%5B',']':'%5D','\\':'%5C'})[ch]!)`——单次 replace 把这五个字符 percent-encode。
- **字符集 = `( ) [ ] \`**：这是经 `normalizeUrl` 后仍可能字面残留进 `canonical_url`/`canonical_source_url` **且**在 markdown 链接目标段**有定界语法意义**的全集（`%`/`'`/`~`/`|`/`^` 等虽可残留但无定界意义、不破坏 `(...)` 结构，故不编码）——空格/`<`/`>`/换行/中文等已被 `new URL` 解析（path）或 `encodeURIComponent`（query）编码、不残留；path 中的 `\` 被规范成 `/`，但 query 中的 `\` 可残留，故仍编码 `\`。`(`/`)` 是定界符、`[`/`]` 在闭源 lark_md 解析器下可能被当链接文本起始、`\` 是转义引导符。
- **为何 percent-encode 而非反斜杠**：lark_md 是否把 `\)` 解析为字面 `)` 未知（解析器相关）。percent-encode 后 URL 段**不含括号/方括号/反斜杠**，对两种 markdown 链接解析模型都不破链——「首个 `)` 即闭合」模型下无 `)` 故不提前闭合；「CommonMark 配对括号」模型下无任何括号故无需配对。**correct-by-construction、与解析器无关、无需实测即正确**。`%28`/`%29`/`%5B`/`%5D`/`%5C` 是合法 URL 编码，点击时浏览器/客户端解码回原字符、href 不变。
- **为何同时 encode 开括号 `(`/`[`**：只 encode 闭括号 `)`/`]` 会在配对模型下留下不配对的开括号，反而破链；故开闭都编。
- **禁止复用 `escapeLarkMdText`**（对 `[ ] ( ) \` **加反斜杠**）：它为**链接文本 / 标题 / 正文**设计——反斜杠转义在 URL 段的解析语义未知、可能改变 href；URL 转义器改用 **href 安全的 percent-encode**（`%xx` 标准解码回原字符）。两者覆盖的字符集相近、但**机制不同（反斜杠 vs percent-encode）、不可互换**，与 Telegram 侧（`escapeMarkdownV2` 文本 vs `escapeMarkdownV2Url` URL）对称——飞书侧补齐这层对称即收口。
- `escapeLarkMdUrl` **导出**（与 `escapeMarkdownV2Url` 一致导出），供测试直接断言。

**D2 — 应用到全部 4 个飞书渲染器的链接行，逐处把裸 `${url}` 改为 `${escapeLarkMdUrl(url)}`。**
- 事件 `buildFeishuCard`、日报 `buildDailyFeishuCard`（事件 + 产品两处）、周报 `buildWeeklyFeishuCard`、经验 `buildExperienceFeishuCard`——5 个插值点（4 个渲染器，日报渲染器内含事件 + 产品两处），全部统一经 `escapeLarkMdUrl`。
- 只改 URL 段插值，链接文本（「原文」/「官网」/「来源」固定字面，无特殊字符）与超长丢弃保护、`MAX_URL_LENGTH` 判断、`canonicalUrl` 缺失不渲染链接等既有逻辑**一律不动**。
- 不动 Telegram 分支（已用 `escapeMarkdownV2Url`）。

**D3 — 转义在 `MAX_URL_LENGTH` 长度判断之后、插值之时；不改长度阈值。**
- 既有 `url.length <= MAX_URL_LENGTH` 判断对**原始 URL 长度**度量（转义会增长字符数，但增量极小、且阈值 2000 远宽于规范化后的典型 URL，转义后仍远低于飞书卡片上限），转义只发生在确定渲染该链接行时——保持与 Telegram 侧同一处理顺序（Telegram 也是先判 `MAX_URL_LENGTH` 再 `escapeMarkdownV2Url`）。

## 风险 / 权衡

- **lark_md 的 URL 段转义语义未知**（曾是命门）→ **percent-encode 方案绕过该不确定性**：URL 段不含括号，对任意 markdown 链接解析模型都不破链，correct-by-construction、不依赖「lark_md 是否认 `\)`」这一未知。已从「实现阻塞」降级为上线前确认性实测（见迁移计划 / tasks 4.1）。
- **转义后字符串变长** → 增量极小（每个 `(`/`)` 由 1 字符变 3 字符、`\` 同），`MAX_URL_LENGTH=2000` 阈值与飞书卡片上限均有充足余量，不触发新的超限。
- **遗漏某个渲染器** → 缓解：design 与 tasks 逐处钉死 5 个插值点（含文件行号锚），测试覆盖 4 个渲染器各一条含 `(`/`)` URL + 一条含 `\` URL 断言；`escapeLarkMdText` 仍保留给链接文本/标题/正文，不与 URL 转义器混用。
- **过度转义破坏 href**（若误用 `escapeLarkMdText` 或多编字符）→ 缓解：`escapeLarkMdUrl` 严格只 percent-encode `(`/`)`/`[`/`]`/`\` 五字符，测试断言干净 URL 里的 `.`/`-`/`_`/`=`/`?`/`/`/`:` 等**原样不变**（与 telegram-push「`.`/`-`/`_`/`=` 不被加反斜杠」断言对称），并断言 decode 后等于原 URL。

## 迁移计划

- 纯渲染层代码改动，无数据模型 / 迁移 / env / 调度变更，无需 DB 迁移、无回滚数据风险。
- 部署即生效；回滚 = 还原 `message.ts` 改动。
- percent-encode correct-by-construction，**实现不阻塞于飞书实测**；上线前做一次确认性实测（tasks 4.1）确认渲染/点击正常即可。

## Open Questions

- **（已解决）lark_md 内联链接 URL 段的转义语义** → 采用 percent-encode 绕过：URL 段对 `(`/`)`/`[`/`]`/`\` 编码为 `%28`/`%29`/`%5B`/`%5D`/`%5C` 后**不含括号**，无论 lark_md 用「首个 `)` 即闭合」还是「CommonMark 配对括号」解析都不破链——correct-by-construction、无需实测即正确，故不再是实现阻塞。`%28`/`%29`/`%5B`/`%5D`/`%5C` 为合法 URL 编码，客户端解码回原字符、href 不变。上线前 tasks 4.1 做一次确认性实测（非 gate）。
