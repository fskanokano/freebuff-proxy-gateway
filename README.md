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
  Authorization:    │  · 鉴权 GATEWAY_API_KEYS              │
  Bearer <gw-key>   │  · 选路 + 钉住 + failover             │
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
| `PROXIES` | ✅ | JSON 数组 `[{"name":"p1","url":"https://p1.xxx.dev","apiKey":"k1"}, ...]`。`apiKey` 必须被对应 proxy 的 `API_KEYS` 接受 |
| `GATEWAY_API_KEYS` | ✅ | 逗号分隔的下游客户端 key（客户端用它调网关） |
| `PIN_MODE` | | `client`（默认，按网关 key 钉住）\| `header`（按 `X-Sticky-Id`）\| `off` |
| `PIN_TTL_SECONDS` | | 钉住有效期，默认 `3600`（每次成功请求刷新） |
| `STATE_TTL_SECONDS` | | ok 状态 `/healthz` 刷新间隔，默认 `60`（下限 60） |
| `DEPLETED_PROBE_SECONDS` | | depleted 探测最大退避，默认 `300` |
| `DOWN_PROBE_SECONDS` | | down 探测基础退避，默认 `120` |
| `PROBE_TIMEOUT_MS` | | healthz 探测超时，默认 `3000` |
| `MAX_ATTEMPTS` | | 单请求最大尝试 proxy 数，默认 `3` |
| `LOG_LEVEL` | | `info`（默认）\| `debug` |

### 2. wrangler

```bash
npx wrangler deploy
# 或本地开发
npx wrangler dev
```

`wrangler.jsonc` 已声明各 vars；`PROXIES` / `GATEWAY_API_KEYS` 用 `wrangler secret put` 设置（避免明文进配置）或填在 vars 里均可。

## 客户端用法

与直接用 proxy 完全相同，只是把 base URL 换成网关、key 换成 `GATEWAY_API_KEYS` 之一：

```bash
curl https://<gateway>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <your-gateway-key>" \
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

14 个场景覆盖：按余量选路 / 钉住 / 钉住切换与重钉 / SSE 流式 / 全 depleted 429 / 恢复探测重新入池 / 客户端错不透传 / 鉴权 / header 钉住 + models 聚合 / banned / 5xx 退避 / 网关 healthz / healthz 预判模型额度耗尽与冷却。mock proxies 是本地 HTTP 服务，运行时 shim 模拟 `caches.default` 与假时钟。
