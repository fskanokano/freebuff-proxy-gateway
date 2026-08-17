# freebuff-proxy-gateway

分布式额度感知 API 网关 (Cloudflare Workers)，用于把 **N 个 freebuff-proxy 实例**（每实例 1 个 FreeBuff token）整合成一个 OpenAI 兼容入口：

- **按剩余额度选路** —— 读取各 proxy 的 `/healthz`（每日用量百分比 + 每模型会话额度 `recent/limit`），选余量最多的 proxy
- **钉住路由 (sticky pin)** —— 同一客户端（或 `X-Sticky-Id` 会话）持续路由到当前 proxy，直到它额度耗尽，避免一个对话烧多个账号的额度
- **带内失败切换** —— 收到 `429 rate_limited` / `402 out_of_credits` / `403 banned` / 5xx / 网络错误时，标记该 proxy 状态并**重放请求**切换到下一个 proxy
- **智能恢复探测** —— 对 depleted/down 的 proxy 按退避（60→300s）或在 `resetAt + 10s` 时刻懒探测 `/healthz`，恢复即重新入池

零依赖，免费计划可用。状态存 `caches.default`（跨 isolate 共享，最终一致——钉住偶尔过期只会导致一次请求换 proxy，自愈）。

---

## 架构

```
                     ┌──────────────────────────────────────┐
  OpenAI 客户端 ───► │  cf-quota-gateway (CF Workers)       │
  Authorization:    │  · 鉴权 API_KEY                      │
  Bearer <API_KEY>  │  · 选路 + 钉住 + failover             │
                     │  · 状态: caches.default + L1          │
                     └──────┬──────────────┬───────────────┘
                    probe /healthz   POST /v1/chat/completions
                     (60s 刷新)        (Bearer <proxy-key>)
              ┌──────────┴────┐   ┌────┴─────────┐   ┌────┴─────────┐
              │ proxy #1      │   │ proxy #2     │   │ proxy #N     │
              │ AUTH_TOKENS=t1│   │ AUTH_TOKENS=t2│   │ AUTH_TOKENS=tN│
              │ API_KEYS=k1   │   │ API_KEYS=k2   │   │ API_KEYS=kN  │
              └───────────────┘   └───────────────┘   └───────────────┘
```

每个 proxy 只配 **1 个** FreeBuff token（`AUTH_TOKENS=<token>`）。额度判断全部在网关侧完成。

## 前置: proxy 端配置

对每个 proxy 实例（Vercel / Runsite / Northflank 部署均可），确保：

```env
# 每实例只放 1 个 token
AUTH_TOKENS=<该实例的 FreeBuff token>
# 网关调用本实例用的 key (每个实例可以一样, 也可以各不相同)
API_KEYS=<gateway-key-for-this-proxy>
# 推荐
SAFE_MODE=true
AUTO_DISCOVER_TOKEN=false
LISTEN_ADDR=:3457          # 或平台要求的 :$PORT, 见各平台适配
```

验证：`curl https://<proxy-url>/healthz` 应返回 `{"status":"ok","tokens":[{...,"UsagePct":0,...}]}`。

> 额度信号说明：`/healthz` 的 `UsagePct` 是 proxy 侧 `MAX_MESSAGES_PER_DAY` 的滚动 24h 用量（未配置则为 0）；`quota.<model>.{limit,recent_count,reset_at}` 是 FreeBuff 会话额度（proxy 通过其内部零成本 GET 探测维护，≤60s 刷新一次）。两个信号网关都消费。

## 部署网关

### 1. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PROXIES` | ✅ | 下游 proxy base URL，**至少 1 个**。单个：`https://p1.xxx.dev`；多个用英文逗号分隔：`https://p1.xxx.dev,https://p2.xxx.dev` |
| `GATEWAY_API_KEYS` | ✅ | 网关调用下游 proxy 的 key，英文逗号分隔。**只配 1 个** → 所有下游共用；**配 N 个** → 按顺序一一对应 N 个下游 |
| `API_KEY` | ✅ | **网关自身鉴权 key**，客户端调用网关时用 `Authorization: Bearer <API_KEY>`（可逗号分隔配多个）。不配则网关拒绝启动，防他人盗用 |
| `PIN_MODE` | | `client`（默认，按客户端 key 钉住）\| `header`（按 `X-Sticky-Id`）\| `off` |
| `PIN_TTL_SECONDS` | | 钉住有效期，默认 `3600`（每次成功请求刷新） |
| `STATE_TTL_SECONDS` | | ok 状态 `/healthz` 刷新间隔，默认 `60`（下限 60） |
| `DEPLETED_PROBE_SECONDS` | | depleted 探测最大退避，默认 `300` |
| `DOWN_PROBE_SECONDS` | | down 探测基础退避，默认 `120` |
| `PROBE_TIMEOUT_MS` | | healthz 探测超时，默认 `3000` |
| `MAX_ATTEMPTS` | | 单请求最大尝试 proxy 数，默认 `3` |
| `LOG_LEVEL` | | `info`（默认）\| `debug` |

**最简示例**（单 proxy，最常见）：

```env
PROXIES=https://proxy-a.workers.dev
GATEWAY_API_KEYS=gw-secret-1
API_KEY=client-secret-1
```

**多 proxy 共用 1 个 key**：

```env
PROXIES=https://proxy-a.workers.dev,https://proxy-b.workers.dev
GATEWAY_API_KEYS=gw-secret-1
API_KEY=client-secret-1
```

**多下游各配各的 key**（按顺序对应）：

```env
PROXIES=https://proxy-a.workers.dev,https://proxy-b.workers.dev
GATEWAY_API_KEYS=gw-key-for-a,gw-key-for-b
API_KEY=client-secret-1
```

### 2. wrangler

```bash
npx wrangler deploy
# 或本地开发
npx wrangler dev
```

`wrangler.jsonc` 不再注入任何 vars（可选参数的默认值内置于代码，`keep_vars: true` 保证部署不删除你在 dashboard 手动添加的变量）；`PROXIES` / `GATEWAY_API_KEYS` / `API_KEY`（可选 `ADMIN_KEY`）用 `wrangler secret put` 或 Dashboard **Variables & Secrets** 设置。参考 `.env.example` 或本 README 的示例。

### 3. Cloudflare 面板一键导入（无需本地操作）

1. Dashboard → **Workers & Pages → Create → Import from repository** → 连接 GitHub，选 `fskanokano/freebuff-proxy-gateway`
2. 点 **Deploy**（零构建步骤，无 binding 需要创建）
3. 部署后进入 Worker → **Settings → Variables and Secrets**，添加 3 个变量。⚠️ **类型务必选 `Secret`**（不要选 Text/文本）——wrangler 每次部署会删除 Worker 上所有文本变量再写入配置文件里的 vars（`wrangler.jsonc` 已设 `keep_vars: true` 做双保险，但 **secrets 是唯一绝对不会被部署清除的类型**）：
   - `PROXIES`（Secret）：`https://proxy-a.workers.dev`（单个或多个逗号分隔）
   - `GATEWAY_API_KEYS`（Secret）：下游共用/对应 key
   - `API_KEY`（Secret）：客户端调网关的 key
4. **添加后必须点一次 "Deploy"（或推送一次代码触发 Git 自动部署），变量才会进入运行版本**——否则会报 `PROXIES missing: ... config_error`（此时错误响应里的 `received_env_keys` 字段会显示运行时实际收到了哪些变量，可用于排查）

> 零绑定：不依赖 KV / Durable Objects / 任何 binding，免费计划直接可用。`wrangler.jsonc` 中的可选 vars 已在导入时预填默认值。

> **配置了仍报 config_error？** 按顺序检查：① 变量类型是否选的是 **Secret**（文本变量会被每次部署清除——secrets 不会被清除）；② 是否配在 **Settings → Variables and Secrets**（不是 Build settings）；③ 添加后是否触发了新的 Deploy；④ 变量名是否与文档完全一致（`PROXIES` 全大写）；⑤ 是否配在了正确的 Worker/账户下。请求任意路径，网关的错误响应会列出 `received_env_keys`，一眼看出哪些变量进了运行时。

## 管理后台

访问 `https://<gateway>.workers.dev/admin`（iOS 风格界面，手机底部 Tab / 桌面侧边栏自适应，支持深色模式）：

- **总览**：代理健康度卡片、用量进度条、请求统计、状态灯
- **代理**：每代理详情（状态/原因/分数/配额/重置时刻/连续错误）、**立即探测**、**启用开关**（关 = 进入维护，不参与选路）、**添加/编辑/删除代理**（保存后立即生效，跨边缘传播延迟几秒）
- **日志**：状态变更 / failover / 探测失败 / 管理操作事件流
- **测试**：发一条真实请求走完整路由链路（模型下拉自动聚合各代理），结果人类可读
- **设置**：**路由参数可编辑并保存**（PIN_MODE / 各 TTL / 探测超时 / 尝试次数）、鉴权脱敏展示、当前代理列表、**恢复环境变量**（清除后台运行时配置）、外观切换

**运行时配置**：后台的代理增删改与参数修改会保存为"运行时配置"（优先级高于环境变量，用户改动为准），部署/重启后仍生效；点"恢复环境变量"即清除并回到环境变量配置。默认值内置于代码（不再通过 wrangler vars 注入），可用 Variables & Secrets 覆盖。

管理 API（`/admin/api/*`）用 `ADMIN_KEY` 鉴权；未配置 `ADMIN_KEY` 时复用 `API_KEY`。页面本身公开（无敏感数据），登录密钥保存在浏览器 localStorage。本地预览 UI：`node preview.mjs` → 打开 `http://127.0.0.1:8788/admin`。

## 客户端用法

与直接用 proxy 完全相同，只是把 base URL 换成网关、key 换成 `API_KEY`：

```bash
curl https://<gateway>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff-1","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

- SSE 流式原样透传（首个字节前才决定路由，失败可透明切换；流开始后不再 failover，中途错误由 proxy 以 SSE error chunk 透出）
- 响应头 `x-gateway-proxy` = 实际服务的 proxy，`x-gateway-attempts` = 尝试次数（>1 表示发生了 failover）
- 可选：发送 `X-Sticky-Id: <conversation-id>` 并设 `PIN_MODE=header`，按会话而非客户端 key 钉住

## 观测

```bash
curl https://<gateway>.workers.dev/healthz   # 公开, 无需 key
```

返回每个 proxy 的 `status`（ok/depleted/down/bad_config/unknown）、`reason`（rate_limited/out_of_credits/model_quota/daily_cap/cooldown/banned/...）、`score`、`usage_pct`、`reset_at`、`next_probe`、`last_ok/last_error`、逐模型额度等。该端点同时会触发所有过期项的探测——挂个定时任务/uptime 轮询即可保持状态热。

## 行为细节

**选路**（每次请求）：
1. 钉住键（客户端 key 或 `X-Sticky-Id`）有 pin 且该 proxy 状态 ok → 直接用它
2. 否则在 ok 的 proxy 里按 `score = max(UsagePct, 模型会话 recent/limit)` 升序选，平分按最近使用（LRU）
3. 全部 depleted/down → 挑恢复时间最早的，对客户端返回 `429 rate_limited` + `Retry-After`（或 403 banned / 502）

**失败分类与处置**（带内）：

| 响应 | 判定 | 处置 |
|---|---|---|
| 429 rate_limited / 402 out_of_credits | depleted | 解析 `Retry-After` 与 body 里 `reset at <RFC3339>`，`nextProbe = resetAt+10s`；重放请求切换 |
| 403 account_banned | depleted(banned) | 长退避（≥300s） |
| 403 country_blocked / 5xx / 网络错 | down | 指数退避 120→300s |
| 401（proxy 拒绝网关 key） | bad_config | 退避重试，最终 502 提示检查 PROXIES 配置 |
| 400 / 404（客户端错） | — | 原样透传，**不** failover |

**探测策略**（懒触发，无后台循环）：
- ok proxy：`STATE_TTL`（60s）到期且被请求需要时才重新探 `/healthz`（探测零成本——proxy 的 healthz 不触达 FreeBuff 上游）
- depleted/down：`nextProbe` 到期才探；`resetAt` 已知则对齐到 `resetAt+10s`，否则按退避；探测成功即回 ok 并重置退避
- 同 isolate 内同名 proxy 单飞（并发去重）；nextProbe 加 ±15s 抖动防羊群

## 限制与取舍

- **状态最终一致**：`caches.default` 跨 isolate 共享但非强一致。极端情况（两个 isolate 同时把不同客户端钉到同一 proxy）只是加速消耗该 proxy 额度，不影响正确性
- **额度是"信号"而非"计数"**：网关不精确扣减每次请求的额度，靠 healthz 刷新 + 带内 429/402 兜底。proxy 侧建议配 `MAX_MESSAGES_PER_DAY` 让 UsagePct 有参考价值
- 请求体会被网关缓冲（≤32MB）以支持 failover 重放；超大/非 JSON 请求体不缓冲（原样转发但无法重放）
- 单 proxy 配了多个 token 也能用（healthz 只取 `tokens[0]`）——但建议按"1 proxy = 1 token"部署以让网关的额度视图精确
- 网关自身无持久化；`/v1/models` 每次聚合各 proxy 实况

## 测试

```bash
node test/test.mjs
```

85 个场景覆盖：核心路由(选路/钉住/failover/恢复/流式) + 配置解析极端(非法URL/重复/数量不匹配/缺必填) + 鉴权极端(大小写/空白/ADMIN_KEY隔离) + 路由极端(单proxy/全down/全网络错/LRU/维护模式/pin失效) + failover极端(429时间信息三态/403矩阵/401/404/重试上限/聚合优先级/流式中断/退避封顶) + 探测极端(healthz 500/超时/畸形/单飞/恢复/未恢复) + 请求体极端(空体/非法JSON/33MB/流式兼容) + 状态缓存极端(写失败/时钟回拨/TTL边界/同名隔离) + 管理后台(overview/脱敏/probe/maintenance/pin/smoke/事件日志)。mock proxies 是本地 HTTP 服务，运行时 shim 模拟 caches.default 与假时钟。测试还抓到并修复了 4 个真实 bug：surface 误标 down、维护标记残留、updatedAt 续期阻止重探测、异常状态保活窗口不足。
