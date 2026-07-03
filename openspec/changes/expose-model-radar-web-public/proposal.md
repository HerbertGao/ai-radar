## 为什么

Model Radar 答案优先选型页（`GET /model-radar`）已挂进生产 app 并随镜像发布，但当前只在 **tailnet**（`web:3000`）可达——对外不可访问。目标是让开发者**公网可访问**这个选型顾问，同时 **不暴露家宽 origin 的 IP / 端口**、**不改动已过评审的 SSR 页与数据回路**（money-path / 引擎 / 快照 / ingestion 一律不动）。Cloudflare Tunnel 是最小、务实的一步：出站隧道把只读 web 服务经 Cloudflare 边缘暴露为公网 HTTPS 域名，零应用改写，保住零-JS SSR 设计。

## 变更内容

- **新增 Cloudflare Tunnel（`cloudflared`）出站隧道**：mac-mini 侧常驻 `cloudflared` 连出到 Cloudflare 边缘，把请求回源到容器内 `web:3000`。**不开任何入站端口 / 不做端口转发 / 不暴露宿主或家宽 IP**。
- **ingress 精确作用域到页 + 字体**：隧道**精确枚举**只转发页 `^/model-radar$` 与字体文件名 `^/model-radar/assets/[A-Za-z0-9._-]+\.woff2$`，**catch-all 404**。只读比价 JSON API（其路由 `/model-radar/snapshot`、`/model-radar/plans` **同在 `/model-radar/` 前缀下**）与 `/health` **落 404、不公开**（默认留 tailnet）；**不得用宽正则** `^/model-radar(/.*)?$`（会误公开该 API）。Postgres / Redis / worker / 宿主端口 **MUST NOT** 经隧道暴露。
- **compose 集成 + locally-managed 隧道**：`cloudflared` 作 compose `app` 服务（官方镜像、随栈起停），用 **locally-managed 隧道**（`config.yml` 权威 ingress）——**非 token 模式**（token 会让本地 `config.yml` 失效、作用域漂到未版本化的仪表盘）。
- **凭据作挂载文件 secret**：隧道凭据 JSON 经**挂载文件 / Docker secret**（**非 env 变量**、不落 `docker inspect`）注入，**MUST NOT 入库**；nonempty 预检 + 缺/空凭据 fail-closed（不静默起空凭据隧道）。
- **边缘防护（参数具体、可验证）**：洪泛真正兜底 = Cloudflare WAF + **具体阈值**速率限制（baseline **60/IP/min·block·10min**，全方法、按 path、忽略 querystring）+ compose **资源上限**（加在 `web`——`recommend()` 爆炸半径主体）使公网洪泛不饿死同机 DB/Redis/ingestion worker；`/model-radar` 另用**短 edge micro-cache（30–60s、key 只含已识别参全集**，非全 querystring**）**作命中率优化（**非洪泛防护**）。
- **origin-IP 无残留 + 唯一 ingress**：公开 hostname 仅 **CNAME→隧道（proxied）、无 A/AAAA**，审计 CT/passive-DNS 无历史家宽记录；**关掉冗余的宿主 `:3000` 映射**（隧道作唯一外部 ingress）或绑 tailscale 接口。
- **可观测 / 失败语义**：origin 不可达时边缘如实 502（不 Always-Online 陈旧回放）；隧道健康是 cloudflared↔边缘连接（本地指标）、origin 就绪由容器内 healthcheck 查——**不需 `/health` 公网路由**。
- **[强烈建议、待用户拍板] Phase-1 置于 Cloudflare Access 后**：首次公网暴露先在边缘登录门（零应用改动）后验证，再撤门全公网。

### 非目标

- **不做 Cloudflare Pages / Workers 边缘 SSR 移植**（把 Hono app 跑到 Workers + 快照发布到 R2/KV）——那是「全球边缘快 / origin 可离线」的未来升级路，本提案只做隧道代理、origin 仍托管 SSR。
- **不改页面行为 / money-path / 推荐器引擎 / DTO / 数据层 / ingestion**——本变更是纯 ingress/ops，`src/mr/**` 应用逻辑不动（至多确认 `/health`）。
- **不启用自动抓取**（browser egress + Playwright）——独立提案 `enable-model-radar-auto-scraping`。
- **不建应用层鉴权 / 人工策展 UI**（ROADMAP P7）；不引任何客户端 JS 框架。（**CF Access 边缘门**是零应用改动的可选 phase-1 建议，与此非目标不冲突——它不在 app 里建鉴权，见 design 待定。）
- **不改 CSP / XSS / safeHref 口径**——首个公开页的输出编码与 scheme 闸已在 5d-B/变更 B 落地，本变更不放松（至多按公网域名核对 CSP 仍自洽）。

## 功能 (Capabilities)

### 新增功能
- `model-radar-web-public-exposure`: 经 Cloudflare Tunnel 把只读 Model Radar web 表面暴露到公网 HTTPS 的 ingress 契约——作用域限定、origin 不直接暴露、凭据作 secret、边缘防护与失败语义。

### 修改功能
<!-- 无：页面行为与主规范需求不变；本变更是 ingress/ops 层，不改任何既有 capability 的 spec 级行为。 -->

## 影响

- **新增**：`docker-compose.yml`（`cloudflared` 服务、web-only 网络、`web` 与 `cloudflared` 资源上限）、`cloudflared/config.yml`（精确枚举 ingress，提交、不含 secret）、部署 / 运维文档（provision + 凭据轮换）、**凭据 JSON 挂载文件 / Docker secret**（`config.yml` + 凭据文件路径校验；**无 token、无 env 变量**）。
- **改（收敛暴露面）**：移除 `web` 的宿主 `:3000` 映射（或绑 tailscale 接口），使隧道为唯一外部 ingress。
- **Cloudflare 侧（人工 / API，一次性）**：创建 locally-managed tunnel、DNS **CNAME→隧道（proxied、无 A/AAAA）**、公开 hostname、WAF / **具体阈值**限流 / micro-cache 规则——记入文档、凭据不入库。
- **不改**：`src/mr/**` 应用代码、迁移、快照 / 数据回路、CI 镜像构建口径。
- **依赖**：一个 Cloudflare 账号 + 一个可用域名（用户侧前置）。
