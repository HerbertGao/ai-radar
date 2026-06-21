## 1. 新增飞书 URL 专用转义器（M1）

- [x] 1.1 在 `src/push/message.ts` 新增并**导出** `escapeLarkMdUrl(url: string): string`：对 `(`/`)`/`[`/`]`/`\` 做 **percent-encode**（`%28`/`%29`/`%5B`/`%5D`/`%5C`，单次 `url.replace(/[()[\]\\]/g, ...)`），使 URL 段无括号/方括号、对任意 lark_md 解析模型都不破链（correct-by-construction）；**禁止复用 `escapeLarkMdText`**（后者转 `[ ] ( ) \` 会过度转义、改变 href）。补 JSDoc 说明：① 为何 percent-encode 而非反斜杠（解析器无关、点击解码回原字符、href 不变）；② 为何**同时** encode 开括号 `(`/`[`（只 encode 闭括号 `)`/`]` 会在配对模型下留不配对开括号反而破链）、为何也编码 `[`/`]`（path 段可字面残留、闭源 lark_md 可能当链接文本起始）；③ 与 `escapeLarkMdText`（文本/标题/正文）分工不同、不可互换，与 Telegram 侧 `escapeMarkdownV2`/`escapeMarkdownV2Url` 对称。

## 2. 应用到全部 4 个飞书 lark_md 渲染器（M2）

- [x] 2.1 `buildFeishuCard`（事件，约 line 306）：`[原文](${url})` → `[原文](${escapeLarkMdUrl(url)})`
- [x] 2.2 `buildDailyFeishuCard` 的**事件**块（约 line 771）：`[原文](${url})` → `[原文](${escapeLarkMdUrl(url)})`
- [x] 2.3 `buildDailyFeishuCard` 的**产品**块（约 line 791）：`[官网](${url})` → `[官网](${escapeLarkMdUrl(url)})`
- [x] 2.4 `buildWeeklyFeishuCard`（周报，约 line 410）：`[原文](${url})` → `[原文](${escapeLarkMdUrl(url)})`
- [x] 2.5 `buildExperienceFeishuCard`（经验，约 line 521）：`[来源](${url})` → `[来源](${escapeLarkMdUrl(url)})`
- [x] 2.6 自检：不动 Telegram 分支（已用 `escapeMarkdownV2Url`）、不动各渲染器的 `MAX_URL_LENGTH` 超长丢弃保护 / `canonicalUrl` 缺失不渲染链接逻辑；`escapeLarkMdText` 仍只用于链接文本/标题/摘要正文，不与 URL 转义混用

## 3. 测试（M3）

- [x] 3.1 在 `src/push/__tests__/message.test.ts` 新增飞书渲染用例：对 4 个飞书渲染器（事件 `buildFeishuCard` / 产品+事件 `buildDailyFeishuCard` 经 `renderDailyDigest` / 周报 `buildWeeklyFeishuCard` / 经验 `buildExperienceFeishuCard` 经 `renderDigest experience`）各喂含 `(`/`)`（`https://en.wikipedia.org/wiki/Go_(programming_language)`）、含 `[`/`]` 与含 `\` 的 URL，断言渲染输出里 URL 段**无裸 `(`/`)`/`[`/`]`/`\`**（已成 `%28`/`%29`/`%5B`/`%5D`/`%5C`）、链接结构 `[label](...)` 完整、且 decode 后等于原 URL（证 href 不变）
- [x] 3.2 反向断言（防过度转义）：干净 URL（含 `.`/`-`/`_`/`=`/`?`/`/`/`:`）经 `escapeLarkMdUrl` **原样不变**（只 `()[]\\` 五字符被编），证明未误用文本转义器；并直接单测 `escapeLarkMdUrl` 输入输出
- [x] 3.3 全量验证：`npx tsc --noEmit` 0 错、`npm run lint` 0 错、`npx vitest run` 全绿（840 passed / 0 skip / 0 fail，连真实 pg+redis）

## 4. 上线前真实飞书确认性实测（M4，交付用户执行；非实现阻塞）

- [ ] 4.1 **上线前确认渲染/点击正常（确认性实测，非实现 gate）**：percent-encode 方案 correct-by-construction（URL 段无括号，对任意 lark_md 解析模型都不破链），实现无需实测即正确；本步为上线前肉眼确认。用真实飞书测试群发一条含 `(`/`)` URL 的卡片（如 `[来源](https://en.wikipedia.org/wiki/Go_%28programming_language%29)` 经 `escapeLarkMdUrl` 后），确认链接文本完整不泄漏、点击解码跳转到完整含 `)` 的原 URL；结果作 artifact 附 PR
