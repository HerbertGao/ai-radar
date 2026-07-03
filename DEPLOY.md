# 部署指南（容器化）

把整个 ai-radar 以容器跑在目标主机上。组件全在 `docker-compose.yml`：

| 服务 | 作用 | 重启策略 |
| --- | --- | --- |
| `postgres` | pgvector/pgvector:pg16，主数据库 | unless-stopped |
| `redis` | redis:7-alpine，BullMQ 队列 | unless-stopped |
| `migrate` | 一次性跑 `drizzle-kit migrate`，幂等 | no（跑完退出） |
| `worker` | 常驻：日报 / 产品发现 / 实时告警三条调度链（周报默认禁用） | unless-stopped |
| `web` | Hono HTTP，暴露 `/health` 供探活 | unless-stopped |

`migrate`/`worker`/`web` 归入 `app` profile：不带 `--profile app` 时只起 `postgres`+`redis`（本地开发用法不变）。

---

## 一、准备 .env

在目标主机仓库根目录放一份 `.env`（**不进 git**）。`DATABASE_URL` / `REDIS_URL` 在 compose 里已用容器服务名覆盖，`.env` 里这两项写什么都会被覆盖；其余为业务凭据，**必须真实**：

必填：

```
LLM_API_KEY=...
LLM_MODEL=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
PRODUCT_HUNT_TOKEN=...        # 启动期强校验，缺失则 worker 起不来
```

可选（按需启用通道 / 调参，键清单见 .env.example）：

```
FEISHU_WEBHOOK_URL=...        # 与 FEISHU_SIGN_SECRET 必须同时给或同时不给
FEISHU_SIGN_SECRET=...
PUSH_TIMEZONE=Asia/Shanghai
DAILY_DIGEST_CRON=3 8 * * *   # 避开整点/半点，防飞书限流
WEEKLY_REPORT_ENABLED=false   # 周报暂缓打磨，默认禁用
```

数据库口令如需自定义，同时设 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`（compose 会据此拼 `DATABASE_URL`）。**注意**：`POSTGRES_PASSWORD` 会原样插入 `DATABASE_URL` 不做编码，故须 URL 安全（字母数字等）；若密码含 `@ : / % #` 等保留字符，改为设 `AI_RADAR_DATABASE_URL=postgres://用户:已百分号编码的密码@postgres:5432/库` 整串覆盖（主机名仍用服务名 `postgres`）。

---

## 二、两种部署方式

### 方式 A：本地构建（无需镜像仓库，最省事）

在目标主机上：

```bash
git clone <repo> ai-radar && cd ai-radar
# 放好 .env（见上）
docker compose --profile app up -d --build
docker compose ps                 # postgres/redis healthy，migrate 已 Exit 0，worker/web Up
docker compose logs -f worker     # 看到「已启动 N 条调度链」即成功
curl localhost:3000/health        # {"db":"ok","redis":"ok"}（全 ok 返回 200，任一 down 返回 503）
```

arm64 / amd64 主机都能本地构建（基础镜像均为多架构）。

### 方式 B：拉 CI 构建的镜像（GHCR）

CI（`.github/workflows/docker-image.yml`）构建 **amd64+arm64** 多架构镜像推 `ghcr.io/herbertgao/ai-radar`（owner 取 `github.repository_owner`，与 compose 的 `image:` 默认值一致）。tag 策略：
- **push `main`** → 更新 `:latest`（compose 默认拉的就是它，即「跟随 main 的滚动部署镜像」）。
- **打 `v*` tag**（如 `v1.2.3`）→ 发布版本 tag `:1.2.3`（`{{version}}` 去掉 `v` 前缀），**不动 `:latest`**。要部署某个固定版本，设 `AI_RADAR_IMAGE=ghcr.io/herbertgao/ai-radar:1.2.3` 再 pull；也可用 `:sha-<短哈希>` 钉到具体 commit。

目标主机直接拉（默认 `:latest`，即最新 main）：

```bash
# 若该 GHCR package 为私有，先登录（PAT 需 read:packages）：
echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin

docker compose --profile app pull          # 拉 worker/web/migrate 共用的镜像
docker compose --profile app up -d
```

> 公开该 package 后可免登录直接 pull。
> 镜像名如需改（如 fork 到别的 owner），设环境变量 `AI_RADAR_IMAGE=ghcr.io/<owner>/ai-radar:latest` 即可，compose 会用它覆盖默认值。

---

## 三、运维

```bash
docker compose logs -f worker            # 跟随 worker 日志
docker compose --profile app restart worker
docker compose --profile app down        # 停（保留数据卷）
docker compose --profile app down -v     # 停并删卷（清空 DB/Redis，谨慎）

# 升级：拉新代码/镜像后重建
git pull && docker compose --profile app up -d --build   # 方式 A
docker compose --profile app pull && docker compose --profile app up -d  # 方式 B
```

升级时 `migrate` 会先于 worker/web 重新跑一次（幂等，已应用的迁移自动跳过）。

---

## 四、要点

- **时区**：镜像内置 tzdata 且 `TZ=Asia/Shanghai`；推送日期（push_date）由应用按 `PUSH_TIMEZONE` 显式计算，不依赖容器 TZ。
- **健康探活**：`web` 的 `/health` 同时检 DB 与 Redis；可经主机或内网/VPN 访问 `http://<主机>:${APP_PORT:-3000}/health`。
- **首次真实凭据勘验**：先 `up -d`（确保 `migrate` 已完成建表）后，用 `docker compose --profile app run --rm worker npm run smoke` 立刻触发一次日报流程，不必等 cron。
- **数据持久化**：DB/Redis 落在命名卷 `postgres_data` / `redis_data`，`down`（不带 `-v`）不丢数据。

---

## Model Radar 公网暴露（Cloudflare Tunnel）

把只读 Model Radar 答案页经 Cloudflare 边缘暴露公网 HTTPS，origin 零入站端口、零应用改写。按顺序执行。

1. **概览**：新增 `cloudflared` 服务（`app` profile）经 **locally-managed** 隧道**出站连**到 CF 边缘，边缘回源到容器内 `web:3000`。只放行 `/model-radar` 答案页 + `/model-radar/assets/*.woff2` 字体，其余（比价 JSON API / `/health` / 遍历载荷）一律边缘 404。origin 不开任何入站端口、不暴露家宽 IP；TLS 由边缘终结。

2. **CF 侧 provision（一次性，用户在 CF 控制台 / CLI）**：
   - `cloudflared tunnel create <name>` → 得**隧道 UUID** + **credentials JSON**，把 JSON 放到 `./cloudflared/credentials.json`（**勿入库**，已 gitignore）。
   - **文件权限（易踩）**：`cloudflare/cloudflared` 官方镜像以**非 root（UID 65532）**跑；`credentials.json` 与 `config.yml` 若属 root/宿主用户且不对该 UID 可读，容器会 **`permission denied` 退出**。执行 `chmod 644 cloudflared/credentials.json cloudflared/config.yml`（或 `chown 65532:65532 cloudflared/credentials.json`）使容器用户可读。
   - DNS 加 **CNAME（proxied、橙云）** 把公开 hostname 指向 `<uuid>.cfargotunnel.com`；**MUST NOT 加任何 A/AAAA** 指向 origin/家宽 IP。
   - 审计该 hostname 及 apex 的 **CT 日志 / passive-DNS 历史**，确认无历史家宽 A 记录（有则换一个全新 hostname，否则直连扫描绕过 CF）。
   - 把 `<TUNNEL_UUID>` 与 `<PUBLIC_HOST>` 填进 `cloudflared/config.yml`（该文件入库、不含 secret）。

3. **CF 规则（一次性，用户在 CF 控制台）**：
   - **WAF**：启用托管规则集。
   - **速率限制** `/model-radar`：**60/IP/min · action=block · duration=10min**；规则 **匹配所有方法、按 path 计、忽略 querystring**（否则 `POST` 或变参绕过）。
   - **Cache rule** `/model-radar`：30–60s micro-cache；**custom cache key 仅纳入 `API_QUERY_KEYS` + `sort` + `usageProfile` + `tokensPerRound`（丢弃未知参）**；**显式标 HTML 可缓 + Edge-TTL=override + 只缓 200 响应**（origin `/model-radar` 不发 `Cache-Control`，不 override 则 `CF-Cache-Status: DYNAMIC` 直穿；只缓 200 防冷启 503 / 参错 400 被边缘缓存延长故障窗一个 TTL）。`/model-radar/assets/*.woff2` 配长 TTL。**不启用 Always-Online**（破 freshness 诚实）。

4. **镜像 digest 钉死**：compose 已按多架构 manifest-list digest 钉死（`cloudflare/cloudflared:2026.6.1@sha256:…`，跨 amd64/arm64）；后续按耦合清单⑨定期刷新防 CVE 陈旧。要换版本时同法取 digest：`docker buildx imagetools inspect cloudflare/cloudflared:<版本>` 取 manifest-list `Digest:`。

5. **起服务**：先**预检凭据**（正规文件且可读——防缺文件被 short-form bind mount 成空目录、防 UID 65532 权限错）：
   ```bash
   test -s cloudflared/credentials.json && test -r cloudflared/credentials.json || { echo '凭据缺失/空/不可读，勿起'; exit 1; }
   docker compose --profile app up -d cloudflared        # 随现有 web/worker 栈起，依赖 web healthy
   ```

6. **[用户决策] 宿主端口收敛（design D7）**：建议移除 `web` 的 `${APP_PORT:-3000}:3000` 映射，使隧道成为唯一外部 ingress（tailnet 用户改用公网 URL；容器内 healthcheck 用 `127.0.0.1` 不受影响）。若确需直连 tailnet `:3000`，把映射绑到 **tailscale 接口 IP**（非 `0.0.0.0`），别留公网/LAN 扫描面。默认保留，由用户按需改。

7. **部署验证清单**（对应 tasks 4.1–4.8，mac-mini 上逐条对账）：
   - `https://<host>/model-radar` 返回 200 SSR 页、TLS 有效；字体经隧道可加载、公网域名下 CSP `font-src 'self'` 自洽、无混合内容 / 无 CSP 拦。
   - 公网请求 `/model-radar/snapshot`、`/model-radar/plans`、`/health` 均 **404**；编码穿越走**页与 assets 两条分支**（`/model-radar/..%2fsnapshot`、`/model-radar/assets/..%2f..%2fsnapshot`、`//model-radar/snapshot`）、大小写变体、伪 Host 均落 catch-all 404；仅页 `/model-radar`（含 querystring）与 `.woff2` 字体可达。
   - 家宽 **IPv4+IPv6** 端口探测无 web/DB/Redis 开放、宿主 `:3000` 非公网/LAN 第二 ingress；hostname 无 A/AAAA 指 origin、CT/passive-DNS 无历史家宽记录。
   - **凭据 / 失败语义**：缺 / 空 / 畸形非空（坏 JSON / 缺字段）/ 无效凭据起 `cloudflared` → 公网无任何路由被服务（缺/空/畸形 → 原生非零退出拒起，无效 → 边缘 CF 1033）；停 `web` → 边缘如实 502（非 Always-Online 陈旧）。
   - **防护 / 缓存**：高频洪泛触发限流；`CF-Cache-Status` 命中（非长期 DYNAMIC）；仅差未知参（`?_=1` vs `?_=2`）→ 同一缓存页，仅差已识别参（`usageProfile`/`tokensPerRound`）→ 不同页；变参洪泛（`?_=<rand>`）仍被限流/资源上限兜底；页不发 `Set-Cookie`/个性化头；同机 Postgres/Redis/ingestion worker 不被饿死。
   - **网络分段（双向）**：`cloudflared` 容器内**无法解析 / 触达 Postgres·Redis**，而 `web` **仍能达**（容器内 `/health` 报 db+redis OK）。
   - 确认 ingestion 从不把 `source_url` 填成内部 / tailnet URL。

8. **凭据轮换**：CF 重生凭据 → 换 `./cloudflared/credentials.json` → 重启 `cloudflared`（`docker compose --profile app restart cloudflared`）。

9. **⚠️ 需同步维护的耦合（task 3.3，防漂移）**：
   - ① CF custom cache-key 参集 **MUST 等于**应用 `src/mr/web/model-radar-page.tsx` 的已识别读参集（`API_QUERY_KEYS` + `sort` + `usageProfile` + `tokensPerRound`）——日后加输出相关 query 参时**两处同改**，否则边缘会用同一 key 服务不同用户的错误推荐。
   - ② `cloudflared` digest 须定**周期刷新**（renovate/dependabot digest bump 或手动 cadence），防网络面守护进程 CVE 陈旧。

10. **[可选、用户拍板] CF Access phase-1（task 3.4）**：首发可先在 hostname 上加 Cloudflare Access（邮箱 OTP/SSO、零应用改动）作访问门，验证公网路径（ingress 作用域 / 限流 / IP 隐藏）；生产核实后再撤门开放全网。

11. **回滚**：`docker compose stop cloudflared` → 公网回退（应用零影响）；若已移除宿主 `:3000` 且需临时 tailnet 直连，恢复 `ports:` 映射（绑 tailscale 接口）。

> 口径：注释 / 文档不写具体设备名。具体 hostname / WAF 参数由用户在 CF 侧填（速率 baseline 已定 60/IP/min·block·10min，非待填）。
