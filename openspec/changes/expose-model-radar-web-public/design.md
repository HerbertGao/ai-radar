## 上下文

Model Radar 答案优先页 `GET /model-radar` 已挂进生产 app（`src/app.ts:85`，与 `/health`、只读比价 API 同一 Hono HTTP server），随 GHCR 镜像发布、由 compose `web` 服务（`app` profile）在 ts.mac-mini 上监听 `:3000`。当前只在 **tailnet** 可达。页面是**动态 SSR**：每请求跑纯函数 `recommend(snapshot, input)`、读 setup 表单 GET query、按只读快照渲染；快照由常驻 rebuild worker + Redis pub/sub 保鲜（5d-A）。自托管 webfont 经 `serveStatic` 从 `src/mr/web/assets` 出（`/model-radar/assets/*`），CSP `font-src 'self'`。

origin 是家宽后的 mac-mini：不能开入站端口 / 暴露公网 IP。需求是「公网可访问 + 不暴露 origin + 不改应用」。

## 目标 / 非目标

**目标：**
- 只读 Model Radar web 表面（**仅页 + 字体**）经一个公网 HTTPS 域名可达；`/health` 与比价 JSON API 保持容器内 / tailnet-only、公网 ingress 落 404。
- origin 不开入站端口、不暴露家宽 IP；凭据作 secret 不入库。
- 零应用改写：SSR / `recommend()` / 快照 / 数据回路一律留在 origin、原样不动。
- 边缘防护（限流 / WAF）+ 诚实失败语义（origin 挂→如实报错、不伪造陈旧）。

**非目标：**
- 不做 CF Pages/Workers 边缘 SSR + 快照发布到 R2（未来升级路，另议）。
- 不改页面行为 / money-path / 引擎 / 数据层 / CSP 口径；不启用自动抓取；不建鉴权 / 策展 UI。
- 不公开只读比价 JSON API（默认不路由；待定）。

## 决策

**D1 — 用 Cloudflare Tunnel（`cloudflared`）出站隧道，而非端口转发 / 自建反代 / 边缘 SSR。**
mac-mini 侧常驻 `cloudflared` **连出**到 Cloudflare 边缘，边缘回源到容器内 `web:3000`。得公网 HTTPS + 自动 TLS（边缘终结）+ WAF/限流 + **零入站端口 / 不暴露家宽 IP**，且**零应用改写**。
- **替代（否决）**：① 端口转发 + DDNS——暴露家宽 IP、自管 TLS、无边缘防护，安全面差；② 自建 VPS 反向代理——多一台机 + 自管 TLS/证书，比隧道重；③ CF Pages/Workers 边缘 SSR——需移植 `@hono/node-server` 的 `serve`/`serveStatic` + 把快照源从 PG 缓存改为 R2/KV 发布管道，是「全球边缘快 / origin 可离线」的升级路、非本期最小步。

**D2 — `cloudflared` 作 compose `app` 服务，用 locally-managed 隧道（凭据文件 + `config.yml`），不用 `--token`。**
Cloudflare 隧道两种模式互斥：**token / remotely-managed**（`tunnel run --token`）把 ingress 路由交 CF 仪表盘、**本地 `config.yml` ingress 被忽略**；**locally-managed**（`tunnel --config config.yml run <uuid>`）本地 `config.yml` 权威。spec R2 要求「作用域由配置即代码承载」→ **必须选 locally-managed**：`cloudflared tunnel create` 生成的**凭据 JSON 文件**（隧道 UUID + secret）作 secret 挂进容器（bind mount，**不用 env 变量**——env 会落进 `docker inspect`/`/proc/environ`），`config.yml`（提交进仓、不含 secret）声明 `tunnel: <uuid>` / `credentials-file:` / `ingress:`。用官方 `cloudflare/cloudflared` 镜像、经 compose 内网直连 `http://web:3000`（`app` profile、随栈起停）。
- **fail-closed**：凭据文件缺失 / 空 → `cloudflared` 非零退出（+ 一个 nonempty 预检，防空文件静默）；**畸形但非空**（`{garbage` / 缺必需字段的合法 JSON）→ 由 **cloudflared 原生 parse/必填校验非零退出**捕获（**非** nonempty 预检——预检只挡空/缺文件、不验 JSON）；凭据**无效 / 已吊销** → cloudflared 无限重试、不退出，**边缘返回 CF 1033（无健康隧道）**——仍诚实、不服务任何陈旧内容。（原「无效即非零退出」表述有误，已更正。）三态终局都是 fail-closed：公网无任何路由被服务。

**D3 — ingress 精确路径枚举 + catch-all 404（不用宽正则）。**
**关键更正**：只读比价 JSON API 的路由是 `/model-radar/snapshot` 与 `/model-radar/plans`（`src/mr/api/model-radar.ts:46,65`）——它们**在 `/model-radar/` 前缀下**（`createModelRadarApp` 虽 `app.route('/')` 挂载，但内部路由带 `/model-radar` 前缀）。故宽正则 `^/model-radar(/.*)?$` 会**误命中并公开整个 API**（含一发即导出全量定价的 `/snapshot`）。必须**精确枚举**、把 API 与 `/health` 落到 catch-all 404：
```
ingress:
  - hostname: <public-host>
    path: ^/model-radar$                              # 仅页（match origin 严格路由；querystring 不在 path，表单 GET 仍匹配）
    service: http://web:3000
  - hostname: <public-host>
    path: ^/model-radar/assets/[A-Za-z0-9._-]+\.woff2$  # 仅字体文件名（严格：不放行 assets/ 下任意子路径，堵住 ..%2f 遍历在边缘转发）
    service: http://web:3000
  - service: http_status:404                          # catch-all：/snapshot、/plans、/health、遍历、其余一律 404
```
（用严格 `.woff2` 文件名而非 `assets/.*`：宽 `.*` 会把 `/model-radar/assets/..%2f..%2fsnapshot` **转发到 origin**——虽 origin serveStatic 会拒 `..`、但让遍历在边缘即 404 更稳、少一层依赖。）
`/health` **不列入公网白名单**（见 D6a）。`config.yml`（locally-managed，D2）经 bind mount 进容器（`./cloudflared/config.yml:/etc/cloudflared/config.yml:ro`）——它是权威作用域源、被 cloudflared 实际读取（token 模式则会被忽略，故 D2 选 locally-managed）。

**D4 — 动态页用短 edge micro-cache，cache key 只含**已识别** setup 参数（非全 querystring）。**
（更正 review：「不缓存」对 DoS 是最坏默认；但「cache key 含**完整** querystring」几乎无防护——攻击者每请求加个垃圾参 `?_=<rand>` 即 100% MISS 打满 origin。）页面**只这批已识别参影响输出、忽略未识别参**：**`API_QUERY_KEYS`（model/tool/protocol/currency/maxMonthlyPrice）+ `sort` + `usageProfile` + `tokensPerRound`**（`model-radar-page.tsx`——**注意 `usageProfile` 改 `recommend()` 排名、`tokensPerRound` 改成本估算，二者都影响输出、都 MUST 入 key**，勿只取 `API_QUERY_KEYS`）。故 cache key MUST **只含这批已识别参全集（排序后）、丢弃未知参**（CF「自定义 cache key：仅纳入指定 query 参」），使垃圾参坍缩到规范键、而识别参各异者得不同 key。TTL 30–60s（快照后台变、age 天级，60s 陈旧可忽略）。因 origin `/model-radar` **不发 `Cache-Control`**，CF 默认不缓 `text/html` → cache rule MUST **显式标 HTML 可缓 + Edge-TTL=override/ignore-origin**，否则 `CF-Cache-Status: DYNAMIC` 直穿、micro-cache 形同虚设（4.6 以 `CF-Cache-Status != DYNAMIC` 兜底验）。规则 MUST **只缓 200 响应**（防冷启 503 / 参错 400 被边缘缓存把故障窗延长一个 TTL）。`/model-radar/assets/*.woff2` 长 TTL。**不启用「Always Online」**。**诚实边界**：micro-cache 只是命中率优化（坍缩**诚实重复**流量），**参值仍无界、非洪泛防护**——真正的洪泛兜底是 D5 的 per-IP 限流 + 资源上限。

**D5 — 边缘防护参数具体化 + 网络分段 + 共享宿主资源隔离。**
（更正 review：规则参数全未定 = 无法测、空规则也「通过」；且 `cloudflared` 与数据层同网，ingress 配错一行即可直达 DB。）
- **具体阈值（不留占位）**：CF 速率限制对 `/model-radar` = **60/IP/min、action=block、duration=10min**（baseline 具体值，直接落配置；日后按真实流量调仍是具体值、不回退成占位 `N`）；规则 **MUST 匹配所有方法、按 path 计（忽略 querystring）**——否则 `POST /model-radar` 或变参绕过。叠 WAF 托管规则。
- **网络分段（防御纵深）**：`cloudflared` MUST 置于**只含 `web` 的专用 compose 网络**、**不入** Postgres/Redis 所在网络——即使 ingress 配错 / 镜像被换，也无法解析 / 触达数据层（不把「数据层不可达」只押在 ingress 白名单一处）。**只约束 `cloudflared`；`web` 保持多网卡**（同时在数据网络 + 该专用网络）——compose `networks:` 替换非追加，`web.networks` 须同列两网，别因加专用网掉出数据网断了 DB/Redis（否则 5d-A 快照 pub/sub 断、页仍返 200 但服务陈旧快照、不易察觉）。`cloudflared` 镜像 **按 digest 钉死**（网络面守护进程，须记周期 digest 刷新防 CVE 陈旧，见 task 3.2）。
- **资源隔离**：`mem_limit`/`cpus` **加在 `web`**（每请求跑 `recommend()`、是 CPU/mem 爆炸半径主体）**与 `cloudflared`**（薄代理），使公网洪泛不能饿死同机 Postgres/Redis/ingestion worker——**只限 cloudflared 无意义**（薄代理不是主要负载）。

**D6 — 失败语义诚实：origin 挂→边缘如实 502。**
不配「Always Online」/长期陈旧回放给动态页（破 freshness 诚实）。origin 不可达 → 边缘 502；字体因 immutable 可从边缘缓存续命（无害）。

**D6a — `/health` 不公开。** `/health` 回 db/redis 逐项存活（`{db,redis}` + 503），公网暴露是 origin 基建的侦察信号、且**非必要**：cloudflared 就绪是隧道↔边缘连接（本地指标）、origin 就绪由容器内 healthcheck（`127.0.0.1:3000/health`）查——都不需公网路由。故 `/health` 落 catch-all 404；公网烟测用 `/model-radar`。（若确需公网存活 ping：回不含依赖细节的 opaque 200，或置于 CF Access 后。）

**D7 — 关掉冗余的宿主端口映射，隧道作唯一外部 ingress。**
`web` 现发布 `${APP_PORT:-3000}:3000`（`0.0.0.0`，先于本变更）。cloudflared 经 compose 内网到 `web:3000`、**不需该宿主映射**；留着 = origin 经 (a) 公网隧道 + (b) LAN/tailnet `:3000` **两条路**可达，且开放 `:3000` 是 IP 扫描的 origin 确认信号。**推荐**：移除 `web` 的 `ports:` 映射（容器仅经 compose 内网 + 隧道可达；tailnet 用户改用公网 URL）；容器内 healthcheck 用 `127.0.0.1` 不受影响。**（用户决策）** 若仍要直连 tailnet `:3000`，则把映射绑到 **tailscale 接口 IP**（非 `0.0.0.0`），别留在公网/LAN 扫描面。

**D8 — origin-IP 无残留泄漏：hostname 仅 CNAME→隧道、无 A/AAAA。**
CF Tunnel 在隧道层藏 IP，但「不暴露家宽 IP」还须堵残留：公开 hostname MUST 是 **CNAME → `<uuid>.cfargotunnel.com`（proxied），无任何 A/AAAA 指向 origin/家宽 IP**；用**全新 hostname**并审计其（及 apex 的）**CT 日志 / passive-DNS 历史**无历史家宽 A 记录（否则直连扫描绕过 CF）；验证 IPv4+IPv6 两栈家宽 IP 上无 web/DB/Redis 开放端口（配合 D7）。

## 风险 / 权衡

- **origin 依赖（mac-mini 挂→页挂）** → 缓解：v1 接受（mac-mini 本就是常驻 origin）；要 origin-可离线走未来 CF Workers+R2（方案2）。
- **DoS / 共享宿主爆炸半径**（公网无鉴权页每请求回源、与 Postgres/Redis/worker 同机）→ 缓解：短 edge micro-cache 坍缩回源（D4）+ 具体速率限制（D5）+ compose 资源上限防饿死管线（D5）；per-IP 限流会被分布式绕，资源隔离是兜底。
- **live-age vs 边缘缓存** → 缓解：动态页 30–60s micro-cache（快照后台变、age 天级、60s 陈旧可忽略）、非 bypass、非 Always-Online（D4/D6）；部署断言 `CF-Cache-Status`。
- **隧道凭据泄漏 = hostname 被冒用观测请求（域下钓鱼）** → 缓解：凭据用**挂载文件 / Docker secret**（非 env、不落 `docker inspect`）、gitignore、仓库/镜像不含；文档化轮换；凭据仅隧道范围、泄漏不含 LAN pivot（攻击者连自己的机器）。
- **ingress 误配放行超预期** → 缓解：locally-managed `config.yml` 精确枚举 + catch-all 404（D2/D3）；部署后按名探测 `/model-radar/snapshot`、`/model-radar/plans`、编码穿越、伪 Host 均 404。
- **双路暴露 / origin-IP 残留** → 缓解：关冗余宿主 `:3000`（D7）+ hostname 无 A/AAAA、审计 CT/passive-DNS、IPv4+IPv6 扫（D8）。
- **公网域名下 CSP 自洽性** → 缓解：页面 CSP 全 `'self'`（origin 相对）、safeHref/XSS 口径不变，换 host 仍有效；部署后核对字体不被 CSP 拦、无混合内容；确认 ingestion 从不把 `source_url` 填成内部/tailnet URL（provenance 是外部厂商价页、公开无碍）。

## 迁移 / 部署计划

1. **CF 侧（一次性，用户）**：`cloudflared tunnel create` 建 **locally-managed** 隧道取**凭据 JSON**（非 token）；DNS 加 **CNAME**（proxied、无 A/AAAA）指向 `<uuid>.cfargotunnel.com`，审计 CT/passive-DNS 无历史家宽记录；配 WAF + **具体阈值**限流 + `/model-radar` 30–60s micro-cache 规则。
2. **仓库**：compose `app` 加 `cloudflared` 服务（`tunnel --config config.yml run <uuid>`、凭据 JSON 经**挂载文件 secret**、`mem/cpus` 上限、不映射宿主端口）+ 提交 `cloudflared/config.yml`（精确枚举 ingress + catch-all 404，不含 secret）；**移除 `web` 的 `:3000` 宿主映射（或绑 tailscale 接口）**；`.gitignore` 凭据文件；文档写 provision + 轮换。
3. **部署**：mac-mini `compose --profile app up -d cloudflared`（随现有 web/worker 栈）；验证 `https://<host>/model-radar` 200、`/model-radar/snapshot`+`/plans`+`/health` 经隧道 404、家宽 IPv4+IPv6 端口探测无开放（含旧 `:3000`）、hostname 无 A/AAAA。
4. **回滚**：`compose stop cloudflared` → 公网回退（应用零影响）；若已移除宿主 `:3000` 且需临时 tailnet 直连，恢复 `ports:` 映射（绑 tailscale 接口）。

## 待定问题

- **是否公开只读比价 JSON API？** 默认经 catch-all 404 **不公开**（tailnet-only）。若日后想公开 `/model-radar/snapshot`（全量定价 JSON），须**单独决策**并加限流/缓存（一发导出、比页面更重）——不在本变更默认放行。
- **[强烈建议、待用户定] Phase-1 置于 Cloudflare Access 后。** 这是本项目首次公网暴露；直接全公网一步翻掉 tailnet-only 边界。CF Access（Zero Trust，邮箱 OTP/SSO，**零应用改动**、作用于 hostname）可在**开放全网前**先在门后验证公网路径（ingress 作用域 / 限流 / 新鲜度 / IP 隐藏）。它**新增一个访问门**（与非目标「不建鉴权」的应用层鉴权不同，是边缘门）——故不默认纳入、由用户拍板；建议 D3(F1)/D8 生产核实后再撤门开放。
- **[用户决策] 宿主 `:3000` 映射去留**（D7）：移除 = 隧道唯一外部 ingress（tailnet 改用公网 URL）；保留则须绑 tailscale 接口、别留公网/LAN 扫描面。
- 具体公开 hostname / WAF 参数由用户在 CF 侧定，记入部署文档（速率限制 baseline 已定 60/IP/min·block·10min，非待填）。
- **[残留、无 v1 action] JSON API 单闸不对称**：`/model-radar/snapshot`·`/plans` 仅靠 ingress 白名单一道闸（数据层有 ingress + 网络分段两道），一行 ingress typo 即可重曝全量定价——应用层再加一闸会碰 `src/mr/**`、超本变更范围；v1 接受，记此残留。
