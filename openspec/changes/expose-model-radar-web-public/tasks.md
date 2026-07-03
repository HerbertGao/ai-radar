# 实现任务

## 1. Cloudflare 侧 provision（一次性，用户在 CF 控制台 / API；记入文档、凭据不入库）

- [ ] 1.1 `cloudflared tunnel create <name>` 建 **locally-managed** named tunnel → 得**凭据 JSON 文件**（含隧道 UUID + secret；**非 token 模式**）；选定一个**全新**公开 hostname
- [ ] 1.2 DNS 加 **CNAME**（proxied，橙云）把 hostname 指向 `<tunnel-id>.cfargotunnel.com`；**MUST NOT 加任何 A/AAAA 指向 origin/家宽 IP**；审计该 hostname（及 apex）**CT 日志 / passive-DNS 历史**无历史家宽 A 记录（有则换 hostname）
- [ ] 1.3 配 WAF 托管规则 + 对 `/model-radar` 的速率限制：**把选定的具体阈值记进配置/文档**（起点 60/IP/min·action=block·duration=10min；**不留占位 `N`**）、规则 **匹配所有方法、按 path 计（忽略 querystring）**——这 + 资源上限是洪泛真正兜底；配 cache rule：`/model-radar` **30–60s micro-cache，custom cache key 仅纳入已识别参全集 `API_QUERY_KEYS`+`sort`+`usageProfile`+`tokensPerRound`（丢弃未知参）**（漏 `usageProfile`/`tokensPerRound` 会同 key 服务不同用户的错误推荐）、**显式标 HTML 可缓 + Edge-TTL=override + 只缓 200 响应**（origin 无 `Cache-Control`，否则直穿 DYNAMIC；只缓 200 防冷启 503/400 被边缘缓存延长故障窗一个 TTL）、`/model-radar/assets/*.woff2` 长 TTL；**不启用 Always-Online**

## 2. compose 集成 `cloudflared` 服务（`app` profile，locally-managed）

- [x] 2.1 `docker-compose.yml` 加 `cloudflared` 服务：官方 `cloudflare/cloudflared` 镜像**按 digest 钉死**、`command: tunnel --config /etc/cloudflared/config.yml run <uuid>`（**非 `--token`**）、`profiles: ["app"]`、依赖 `web`、随栈起停；**不映射任何宿主端口**（纯出站）；挂载凭据 JSON（`credentials-file`，见 2.3）与 `config.yml`（`./cloudflared/config.yml:/etc/cloudflared/config.yml:ro`）；**置于只含 `web` 的专用网络、不入 Postgres/Redis 网络**（防御纵深，见 design D5）；**`web.networks` MUST 同列数据网络 + 该专用网络两者**（compose `networks:` 替换非追加，别让 `web` 掉出数据网断 DB/Redis）；`mem_limit`/`cpus` 资源上限**同时加在 `web`**（爆炸半径主体）与 `cloudflared`，且 `web` 的上限 **按实测基线（快照 + `recommend()` 峰值 RSS）留头寸取具体值、记进配置**（勿留空——太松无防护、太紧 OOM 触发容器内 healthcheck 重启环）
- [x] 2.2 提交 `cloudflared/config.yml`（不含 secret）：`tunnel: <uuid>` + `credentials-file:` + ingress **精确枚举** `^/model-radar$`（页）与 `^/model-radar/assets/[A-Za-z0-9._-]+\.woff2$`（字体文件名，严格、堵边缘遍历转发）→ `http://web:3000`，**catch-all `service: http_status:404`**；**不用宽正则** `^/model-radar(/.*)?$` / `assets/.*`——确保 `/model-radar/snapshot`、`/model-radar/plans`、`/health`、遍历载荷均落 404
- [x] 2.3 凭据作**挂载文件 secret**（**非 env 变量**）：凭据 JSON 经 Docker secret / bind mount 注入、`.gitignore` 确保凭据文件与 UUID secret 不入库；**nonempty 预检**（空/缺文件即拒起）+ `cloudflared` 缺文件原生非零退出 → fail-closed；**畸形但非空**凭据（坏 JSON / 缺必需字段）依赖 `cloudflared` 原生 parse/必填校验非零退出兜底（预检只挡空/缺、不验 JSON——文档写明此分工）

## 3. 宿主暴露面收敛 + 文档

- [ ] 3.1 **关掉冗余宿主 ingress（design D7，用户决策）**：移除 `web` 服务的 `${APP_PORT:-3000}:3000` 映射（隧道 + compose 内网为唯一路径，tailnet 用户改用公网 URL）；若确需直连 tailnet `:3000` 则绑到 **tailscale 接口 IP**（非 `0.0.0.0`），不留公网/LAN 扫描面；容器内 healthcheck 用 `127.0.0.1` 不受影响
- [x] 3.2 写公网暴露部署文档：CF 侧 provision（tunnel/DNS-CNAME-no-A/WAF/限流 baseline 60/IP/min·block·10min/micro-cache）、compose 起停、凭据文件注入与**轮换**步骤（CF 重生凭据 → 换 secret 文件 → 重启 `cloudflared`）、回滚（`compose stop cloudflared` → 回退 tailnet-only）；注明「注释/文档不写具体设备名」口径；具体 hostname / WAF 参数由用户在 CF 侧填（速率 baseline 已定、非待填）
- [x] 3.3 **文档化两处需同步维护的耦合**（防漂移）：① CF custom cache-key 参集 **MUST 等于**应用 `model-radar-page.tsx` 的已识别读参集（`API_QUERY_KEYS`+`sort`+`usageProfile`+`tokensPerRound`）——加输出相关参时**两处同改**，否则边缘串用户推荐；② `cloudflared` digest 钉死须定**周期刷新**（renovate/dependabot digest bump 或手动 cadence），防网络面守护进程 CVE 陈旧
- [ ] 3.4 **[可选、用户拍板] CF Access phase-1**：文档化在 hostname 上加 Cloudflare Access（邮箱 OTP/SSO、零应用改动）作首发门；生产核实 ingress 作用域 / 限流 / IP 隐藏后再撤门全公网

## 4. 部署验证（mac-mini 上，spec 场景对账）

- [ ] 4.1 `compose --profile app up -d cloudflared` 起隧道；`https://<host>/model-radar` 返回 200 SSR 页、TLS 有效（spec R1「公网 HTTPS 可达」）
- [ ] 4.2 字体经隧道可加载、公网域名下 CSP `font-src 'self'` 自洽、无混合内容 / 无 CSP 拦（spec R2「静态字体经隧道可加载」）
- [ ] 4.3 **ingress 作用域按名核对**：公网请求 `/model-radar/snapshot`、`/model-radar/plans`、`/health` 均 **404**；编码穿越走**页与 assets 两条分支**（`/model-radar/..%2fsnapshot`、**`/model-radar/assets/..%2f..%2fsnapshot`**、`//model-radar/snapshot`）、大小写变体、伪 Host 均落 catch-all 404；仅页 `/model-radar`（含 querystring）与 `.woff2` 字体可达（spec R2「比价 JSON API 与 /health 经隧道 404」「含编码/伪 Host 变体不绕过」）
- [ ] 4.4 **origin 不暴露核对**：家宽 **IPv4+IPv6** 端口探测无 web/DB/Redis 开放、宿主 `:3000` 非公网/LAN 第二 ingress；hostname 无 A/AAAA 指 origin、CT/passive-DNS 无历史家宽记录（spec R1「origin 不直接暴露（含 DNS 残留与双栈）」）
- [ ] 4.5 **凭据 / 失败语义核对**：缺 / 空 / **畸形非空（坏 JSON / 缺字段）** / 无效 凭据起 `cloudflared` → 公网无任何路由被服务（缺/空/畸形 → 预检或原生 parse 非零退出拒起、无效 → 边缘 CF 1033）（spec R3「缺/空凭据 fail-closed」+ 畸形经原生 parse）；停 `web` 时边缘如实 502 而非 Always-Online 陈旧（spec R4「origin 不可达时诚实报错」）
- [ ] 4.6 **防护 / 缓存核对**：对 `/model-radar` 高频洪泛触发具体阈值限流；`CF-Cache-Status` 命中（非长期 DYNAMIC 直穿——证 HTML 可缓 + Edge-TTL override 生效）；**cache key 正确性**：仅差未知参（`?_=1` vs `?_=2`）→ 同一缓存页（坍缩），但**仅差已识别参**（`?usageProfile=light` vs `heavy`、或 `?tokensPerRound=…`）→ **不同页**（证识别参全集入 key、不串用户推荐）；且**变参洪泛（`?_=<rand>`）仍被限流/资源上限兜底**（证不靠 cache 挡洪泛）；确认页**不发 `Set-Cookie`/个性化头**（stateless SSR，缓存正确性前提）；同机 Postgres/Redis/ingestion worker 不被饿死（spec R4「请求洪泛被限流 + micro-cache、同机管线不被饿死」）
- [ ] 4.7 **网络分段核对（双向）**：负向——从 `cloudflared` 容器内**无法解析 / 触达 Postgres·Redis**（仅 `web` 可达）；正向——`web` **仍能达 Postgres·Redis**（容器内 `/health` 报 db+redis OK、或改价后快照 age 前进），证加专用网未把 `web` 掉出数据网（spec R1「网络分段」）
- [ ] 4.8 确认 ingestion 从不把 `source_url` 填成内部 / tailnet URL（provenance 公开无碍，仅确认无内部主机名泄漏）
