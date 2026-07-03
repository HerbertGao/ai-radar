## 新增需求

### 需求:只读 Model Radar web 表面必须经 Cloudflare Tunnel 公网可达、origin 不直接暴露

Model Radar web 页 MUST 可经一个公网 HTTPS 域名访问，且该访问 MUST 经 **Cloudflare Tunnel 出站隧道**（mac-mini 侧 `cloudflared` 连出到 Cloudflare 边缘、边缘回源到容器内 `web:3000`）实现。**MUST NOT** 为此开任何入站端口 / 端口转发 / 暴露宿主机或家宽公网 IP；Postgres / Redis / BullMQ worker / 宿主任何端口 **MUST NOT** 经隧道或此变更被公网可达。TLS 由 Cloudflare 边缘终结（公网段 HTTPS）。**origin-IP 无残留泄漏**：公开 hostname MUST 为 **CNAME → `<uuid>.cfargotunnel.com`（proxied）、无任何 A/AAAA 指向 origin / 家宽 IP**，且 MUST 审计该 hostname（及 apex）**CT 日志 / passive-DNS 历史**无历史家宽 A 记录。**唯一外部 ingress**：先于本变更存在的宿主 `:3000` 映射 MUST NOT 作为**第二条外部（公网 / LAN）ingress** 留存（移除、或绑到 tailscale 接口，见 design D7）；IPv4 与 IPv6 两栈 MUST 均无 web/DB/Redis 开放于公网/LAN。**网络分段（防御纵深）**：公网面的 `cloudflared` MUST 置于**只含 `web` 的专用 compose 网络**、**MUST NOT 与 Postgres/Redis 同网**——使数据层不可达不只押在 ingress 白名单一处（ingress 配错 / 镜像被换也无法触达 DB）。**仅约束 `cloudflared`**：`web` MUST 仍挂在数据网络（即 `web` **同时**在数据网络与该 web-cloudflared 专用网络上、多网卡）——compose `networks:` 是**替换非追加**，故实现时 `web.networks` MUST 同列两网、不得因加专用网而掉出数据网使 `web` 断 DB/Redis（5d-A pub/sub）。`cloudflared` 镜像 MUST 按 digest 钉死。

#### 场景:公网 HTTPS 可达选型页
- **当** 从公网访问隧道绑定的 `https://<hostname>/model-radar`
- **那么** 返回 200 的答案优先 SSR 页（经 Cloudflare 边缘回源到 `web:3000`），TLS 有效

#### 场景:origin 不直接暴露（含 DNS 残留与双栈）
- **当** 对 mac-mini 家宽 IPv4+IPv6 做端口探测（HTTP/DB/Redis 端口），并查该 hostname 的 A/AAAA 记录与 CT/passive-DNS 历史
- **那么** 无因本变更新增的入站开放端口、宿主 `:3000` 不作公网/LAN 第二 ingress；hostname 仅 CNAME 到隧道（无 A/AAAA 指 origin）、无历史家宽 A 记录暴露 origin；公网仅经 Cloudflare 边缘域名可达

### 需求:隧道 ingress 必须以精确路径枚举作用域到只读页与字体、其余一律 404

隧道 ingress 规则 MUST 用**精确路径枚举**（非宽前缀正则）**仅**路由两类只读表面：页 `^/model-radar$`（match origin 严格路由）与字体 **`^/model-radar/assets/[A-Za-z0-9._-]+\.woff2$`**（严格文件名、非 `assets/.*`——宽 `.*` 会把 `assets/..%2f..%2fsnapshot` 遍历载荷转发到 origin）；**catch-all MUST 为 `http_status:404`**。只读比价 JSON API（其路由为 `/model-radar/snapshot`、`/model-radar/plans`，**同在 `/model-radar/` 前缀下**）与 `/health` **MUST 落 catch-all 404、MUST NOT 经隧道对外路由**。**MUST NOT 用宽正则 `^/model-radar(/.*)?$`**——它会误命中并公开上述 API（含一发导出全量定价的 `/snapshot`）。作用域 MUST 由**被 cloudflared 实际读取**的显式 ingress 配置（locally-managed `config.yml`，见凭据需求）机械承载，而非依赖应用层自证或仪表盘未版本化配置。

#### 场景:比价 JSON API 与 /health 经隧道 404
- **当** 从公网按名请求 `/model-radar/snapshot`、`/model-radar/plans`、`/health`
- **那么** 隧道 ingress 落 catch-all 返回 404，不回源公开（这些路由保持 tailnet-only）

#### 场景:仅页与字体可达、含编码/伪 Host 变体不绕过
- **当** 从公网请求页 `/model-radar`（含表单 GET querystring）、字体 `/model-radar/assets/*.woff2`，以及编码穿越 / 双斜杠 / 大小写变体 / 伪 Host
- **那么** 仅精确匹配的页与字体回源可达；编码/变体/伪 Host 落 catch-all 404，不触达非白名单路由

#### 场景:静态字体经隧道可加载
- **当** 公网页面加载自托管 webfont（`/model-radar/assets/*.woff2`）
- **那么** 字体经隧道可达、`font-src 'self'` CSP 在公网域名下仍自洽（页面排版不因跨源被拦截）

### 需求:隧道凭据必须作挂载文件 secret、缺失时 fail-closed

Cloudflare Tunnel 凭据（locally-managed 隧道的凭据 JSON 文件）MUST 经**挂载文件 / Docker secret** 注入、**MUST NOT 作 env 变量**（env 会落进 `docker inspect` / `/proc/*/environ`），且 **MUST NOT 入库**（不提交进仓库 / 镜像层）。`cloudflared` 服务 MUST 在**凭据缺失 / 空**时 **fail-closed**：一个 nonempty 预检 + `cloudflared` 缺文件原生非零退出、拒起、如实报错，**MUST NOT** 静默起一个空凭据的隧道。**畸形但非空**凭据（坏 JSON / 缺必需字段）由 `cloudflared` 原生 parse 校验非零退出捕获（nonempty 预检只挡空/缺文件、不验 JSON）。凭据**无效 / 已吊销**时 MUST 诚实降级为「无健康隧道」（边缘 CF 1033、重试），**MUST NOT** 服务任何陈旧内容冒充可用。以上三态终局 MUST 均为公网无路由被服务。凭据轮换步骤 MUST 有文档。

#### 场景:缺/空凭据 fail-closed
- **当** 隧道凭据文件缺失或为空即尝试起 `cloudflared`
- **那么** 预检 / 原生非零退出使服务 fail-closed 拒起并如实报错，不静默进入空凭据运行态，公网无任何路由被服务

#### 场景:凭据经挂载文件、不入库不落 env 表
- **当** 审查仓库、镜像层与运行容器的环境变量（`docker inspect`）
- **那么** 隧道凭据不出现在受版本控制的文件 / 镜像 / 容器 env 表中（仅经挂载文件 / secret 运行期注入）

### 需求:公网暴露必须有边缘防护且失败语义诚实

因页面每请求跑 `recommend()` 计算、且 origin 与 Postgres/Redis/ingestion worker **同机**，公网暴露 MUST 有**参数具体、可验证**的边缘防护（空规则不算达标）：① Cloudflare 速率限制对 `/model-radar` MUST 有**记进配置的具体阈值**（baseline **60/IP/min、action=block、duration=10min**；**MUST NOT 留占位 `N`**）、且 MUST **匹配所有方法、按 path 计（忽略 querystring）**（否则 `POST` 或变参绕过），叠 WAF 托管规则——**这（+③）是洪泛的真正兜底**；② `/model-radar` 用**短 edge micro-cache（30–60s）**作命中率优化，cache key MUST **只含已识别 setup 参全集（`API_QUERY_KEYS` + `sort` + `usageProfile` + `tokensPerRound`、排序后）、丢弃未知参**（`usageProfile` 改排名、`tokensPerRound` 改成本估算——**均影响输出、MUST 入 key**，漏则同 key 服务不同用户的错误推荐；否则 `?_=<rand>` 变参每请求 MISS、缓存形同虚设），且因 origin 不发 `Cache-Control`，规则 MUST **显式标 HTML 可缓 + Edge-TTL=override**（否则 `CF-Cache-Status: DYNAMIC` 直穿）；**micro-cache MUST NOT 被当作洪泛防护**（参值无界、只坍缩诚实重复流量）；③ MUST 有 compose **资源上限**，**加在 `web`**（每请求跑 `recommend()`、是 CPU/mem 爆炸半径主体）**与 `cloudflared`**（只限 cloudflared 无意义），使公网洪泛不能饿死同机 DB/Redis/worker。边缘缓存 TTL MUST NOT 破坏 age 诚实（天级粒度下 ≤60s 陈旧可忽略；MUST NOT 长期把陈旧当新鲜、MUST NOT 启用 Always-Online）。origin 不可达时边缘 MUST 如实返回错误（502），**MUST NOT** 伪造或长期缓存陈旧冒充可用。

#### 场景:请求洪泛被限流 + micro-cache、同机管线不被饿死
- **当** 公网对选型页发起高频请求洪泛
- **那么** 具体阈值的 CF 限流拦超额、short micro-cache 吸收命中，回源被坍缩；资源上限使同机 Postgres/Redis/ingestion worker 不被饿死；`CF-Cache-Status` 显示页面走短缓存（非长期 DYNAMIC 直穿）

#### 场景:origin 不可达时诚实报错（非 Always-Online 陈旧）
- **当** mac-mini / web 服务不可达
- **那么** 边缘返回如实错误 502（未启用 Always-Online、非伪造成功、非长期缓存陈旧冒充新鲜）
