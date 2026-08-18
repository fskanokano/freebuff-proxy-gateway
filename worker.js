/**
 * freebuff-proxy-gateway — 分布式额度感知路由网关 (for freebuff-proxy)
 *
 * 拓扑:  N 个 freebuff-proxy 实例, 每实例只配 1 个 FreeBuff token。
 *        本 Worker 部署在 CF 边缘, 作为统一 OpenAI 兼容入口:
 *          - 按剩余额度选路: 读取各 proxy 的 /healthz (UsagePct + 每模型会话额度),
 *            选 score 最低(余量最多)的 proxy
 *          - 钉住 (sticky pin): 同一客户端(或 X-Sticky-Id)持续路由到当前 proxy,
 *            直到它额度耗尽
 *          - 带内失败切换: 429/402(额度类)/403/5xx/网络错 → 标记状态, 重放请求
 *            切换到下一 proxy
 *          - 智能恢复探测: 对 depleted/down 的 proxy 按退避(60→300s)或
 *            resetAt+10s 懒探测 /healthz, 恢复即重新入池
 *
 * 零依赖, WinterCG 兼容, 免费计划可用 (caches.default 作跨 isolate 状态)。
 * 状态一致性是最终一致的: 钉住偶尔过期只导致一次请求换 proxy, 自愈。
 *
 * 环境变量 (全部逗号分隔, 简洁直白):
 *   PROXIES            下游 proxy base URL, 如 "https://a.xxx.dev,https://b.xxx.dev"
 *   GATEWAY_API_KEYS   网关调用下游的 key: 配 1 个 → 所有下游共用;
 *                      配 N 个 → 按顺序一一对应 N 个下游
 *   API_KEY            网关自身鉴权 key, 客户端调用网关时用
 *                      Authorization: Bearer <API_KEY> (可逗号分隔配多个)
 *   ADMIN_KEY          (可选) 管理后台专用 key; 未配置则复用 API_KEY
 *
 * 端点:
 *   GET  /healthz              公开: 全 proxy 状态/配额 (触发过期项探测)
 *   GET  /v1/models            聚合各 proxy 模型列表 (需 API_KEY)
 *   POST /v1/chat/completions  转发+选路+钉住+failover (需 API_KEY)
 *   GET  /admin                管理后台 SPA (iOS 风格, 手机/桌面自适应)
 *   GET  /admin/api/overview   代理状态/统计/事件 (需 ADMIN_KEY 或 API_KEY)
 *   GET  /admin/api/config     脱敏配置
 *   POST /admin/api/probe      强制探测 (单个/全部)
 *   POST /admin/api/maintenance 维护模式开关
 *   POST /admin/api/pin        按客户端 key 解除钉住
 *   POST /admin/api/smoke      发真实测试请求走完整链路
 */
'use strict';

import { ADMIN_HTML } from './admin.js';
import { GatewayControl } from './control.js';

// ─────────────────────────── 配置解析 ───────────────────────────

const DEFAULTS = {
  PIN_MODE: 'client',            // client | header | off
  PIN_TTL_SECONDS: 3600,         // 钉住有效期 (成功请求后刷新)
  STATE_TTL_SECONDS: 60,         // ok 状态 /healthz 刷新间隔 (cache TTL 下限 60s)
  DEPLETED_PROBE_SECONDS: 300,   // depleted 探测最大退避
  DOWN_PROBE_SECONDS: 120,       // down 探测基础退避
  PROBE_TIMEOUT_MS: 3000,        // healthz 探测超时
  CHAT_TIMEOUT_MS: 120000,       // 非流式 chat 单次尝试超时 (流式不受限, 由客户端断开兜底)
  MAX_ATTEMPTS: 3,               // 单请求最大尝试 proxy 数
  LOG_LEVEL: 'info',             // debug | info | warn
};

// 从 URL host 第一段生成 proxy 名字 (显示用): https://proxy-a.workers.dev → "proxy-a"
function hostPrefix(url) {
  try {
    const seg = (new URL(url).hostname || '').split('.')[0];
    const n = seg.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return n || 'p';
  } catch (e) { return 'p'; }
}

// 逗号分隔 → 去空数组
function splitList(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// 构建版本标识: 仅注入响应头 X-GW-Build 供排查部署版本 (不显示在界面)
const GW_BUILD = 'bb2b565';

function controlStub(env) {
  try {
    if (!env || !env.GATEWAY_CONTROL) return null;
    const id = env.GATEWAY_CONTROL.idFromName('global');
    return env.GATEWAY_CONTROL.get(id);
  } catch (e) { return null; }
}

// Compatibility contract: absent/broken DO binding never throws. Callers
// fall back to the legacy cache path until the binding is available.
async function controlGet(env, key) {
  const stub = controlStub(env);
  if (!stub) return undefined;
  try {
    const r = await stub.fetch('https://control/get?key=' + encodeURIComponent(key));
    if (!r.ok) return undefined;
    const j = await r.json();
    return j.found ? j.value : null;
  } catch (e) { return undefined; }
}

async function controlPut(env, key, value, ttl) {
  const stub = controlStub(env);
  if (!stub) return false;
  try {
    const r = await stub.fetch('https://control/put?key=' + encodeURIComponent(key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, ttl }) });
    return r.ok;
  } catch (e) { return false; }
}

async function controlDelete(env, key) {
  const stub = controlStub(env);
  if (!stub) return false;
  try {
    const r = await stub.fetch('https://control/delete?key=' + encodeURIComponent(key), { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

async function controlAppend(env, key, item, max, ttl) {
  const stub = controlStub(env);
  if (!stub) return false;
  try {
    const r = await stub.fetch('https://control/append?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item, max, ttl }) });
    return r.ok;
  } catch (e) { return false; }
}

async function controlList(env, key, max) {
  const stub = controlStub(env);
  if (!stub) return null;
  try {
    const r = await stub.fetch('https://control/list?key=' + encodeURIComponent(key) + '&max=' + encodeURIComponent(max || 200));
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.value) ? j.value : [];
  } catch (e) { return null; }
}

function parseEnv(env) {
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (env[k] !== undefined && env[k] !== '') cfg[k] = env[k];
  }
  cfg.pinMode = String(cfg.PIN_MODE).toLowerCase();
  cfg.stateTtl = Math.max(60, Math.floor(Number(cfg.STATE_TTL_SECONDS) || 60));
  cfg.pinTtl = Math.max(60, Math.floor(Number(cfg.PIN_TTL_SECONDS) || 3600));
  cfg.depletedProbe = Math.max(60, Math.floor(Number(cfg.DEPLETED_PROBE_SECONDS) || 300));
  cfg.downProbe = Math.max(30, Math.floor(Number(cfg.DOWN_PROBE_SECONDS) || 120));
  cfg.probeTimeout = Math.max(500, Math.floor(Number(cfg.PROBE_TIMEOUT_MS) || 3000));
  // 非流式 chat 单次尝试超时: 挂死(不响应)的 proxy 也要能触发 failover。
  // 刻意不用 probeTimeout(3s): 非流式补全等待模型生成, 3s 会杀掉正常请求。
  cfg.chatTimeout = Math.max(1000, Math.floor(Number(cfg.CHAT_TIMEOUT_MS) || 120000));
  cfg.maxAttempts = Math.max(1, Math.min(6, Math.floor(Number(cfg.MAX_ATTEMPTS) || 3)));
  cfg.debug = String(cfg.LOG_LEVEL).toLowerCase() === 'debug';

  // PROXIES: 逗号分隔的下游 base URL (至少 1 个, 单 proxy 也完全支持)
  const urls = splitList(env.PROXIES);
  if (urls.length === 0) {
    throw new Error('PROXIES missing: set at least one downstream proxy URL, e.g. "https://p1.example.com" (single proxy works fine). For multiple proxies, separate with commas: "https://p1.example.com,https://p2.example.com"');
  }
  const seenUrls = new Set();
  const nameCount = new Map();
  const proxies = [];
  for (const raw of urls) {
    const url = raw.replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/.test(url)) {
      throw new Error('PROXIES: invalid URL ' + JSON.stringify(raw) + ' — expected a plain URL like https://p1.example.com (no quotes/brackets; separate multiple URLs with commas)');
    }
    if (seenUrls.has(url)) {
      throw new Error('PROXIES: duplicate URL ' + url);
    }
    seenUrls.add(url);
    let name = hostPrefix(url);
    const n = (nameCount.get(name) || 0) + 1;
    nameCount.set(name, n);
    if (n > 1) name = name + '-' + n;
    proxies.push({ name, url });
  }

  // GATEWAY_API_KEYS: 网关调用下游的 key。1 个 → 所有下游共用 (最常见, 单 proxy 时必填 1 个);
  // N 个 → 按顺序一一对应 N 个下游。
  const proxyKeys = splitList(env.GATEWAY_API_KEYS);
  if (proxyKeys.length === 0) {
    throw new Error('GATEWAY_API_KEYS missing: the key this gateway sends to the downstream proxy(ies), e.g. "https://p1.example.com" → GATEWAY_API_KEYS=p1-key. One key = shared by all proxies; N keys = one per proxy in order.');
  }
  if (proxyKeys.length !== 1 && proxyKeys.length !== proxies.length) {
    throw new Error('GATEWAY_API_KEYS: got ' + proxyKeys.length + ' key(s) for ' + proxies.length +
      ' proxy(ies) — use 1 (shared) or ' + proxies.length + ' (one per proxy in order)');
  }
  proxies.forEach((p, i) => { p.apiKey = proxyKeys.length === 1 ? proxyKeys[0] : proxyKeys[i]; });

  // API_KEY: 网关自身鉴权 (客户端调用网关)。必填, 防他人盗用。
  const clientKeys = splitList(env.API_KEY);
  if (clientKeys.length === 0) {
    if (env.REQUIRE_GATEWAY_KEY === 'false') {
      cfg.clientKeys = []; // 显式关闭鉴权 (不推荐, 网关将完全开放)
    } else {
      throw new Error('API_KEY missing: set the auth key clients use to call this gateway, e.g. API_KEY=my-client-key (sent as Authorization: Bearer <API_KEY>)');
    }
  } else {
    cfg.clientKeys = clientKeys;
  }

  // ADMIN_KEY: 管理后台专用鉴权 (可选); 未设置则管理操作复用 API_KEY
  const adminKeyConfigured = splitList(env.ADMIN_KEY).length > 0;
  cfg.adminKeyConfigured = adminKeyConfigured;
  cfg.adminKeys = adminKeyConfigured ? splitList(env.ADMIN_KEY) : clientKeys;

  cfg.proxies = proxies;
  return cfg;
}

// ─────────────────────────── 日志 ───────────────────────────

function log(cfg, level, msg, extra) {
  if (level === 'debug' && !cfg.debug) return;
  if (level === 'info' && cfg.debug) level = 'debug';
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) }));
}

// ─────────────────────────── 工具 ───────────────────────────

// FNV-1a 64-bit hex (同步, 用于把钉住键哈希成 cache key)
function hashKey(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

function parseTs(v) {
  if (!v) return 0;
  let n;
  if (typeof v === 'number') n = v > 1e12 ? v : v * 1000; // unix s or ms
  else n = Date.parse(v);
  // 拒绝 0 / 负值 / 1970 前: Go 零值 "0001-01-01T00:00:00Z" 会被 Date.parse 解析成
  // 巨大负数, 落进 st.nextProbe 会让每次请求都立即重探/重试 (探测风暴)。
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function nowMs() { return Date.now(); }

const CACHE_ORIGIN = 'https://cf-quota-gateway.invalid';
// 状态 key 掺入 url 哈希: 同名不同 URL 的 proxy 状态互不串扰 (重配 url 后旧状态作废)
function stateKey(name, url) { return CACHE_ORIGIN + '/state/' + encodeURIComponent(name) + '/' + hashKey(url); }
function pinKey(sticky) { return CACHE_ORIGIN + '/pin/' + hashKey(sticky); }
// 最近路由记录: 独立于状态缓存持久化 (TTL 1h), 不随 STATE_TTL(60s) 过期丢失
function lastUsedKey(name, url) { return CACHE_ORIGIN + '/lastused/' + encodeURIComponent(name) + '/' + hashKey(url); }

// 记录一次成功路由 (幂等累加计数)
async function recordLastUsed(name, url, cfg) {
  const key = 'lastused:' + name + '|' + hashKey(url);
  try {
    let n = 1;
    const controlled = cfg && cfg.env ? await controlGet(cfg.env, key) : undefined;
    if (controlled !== undefined) {
      n = (controlled.requestsOk || 0) + 1;
      await controlPut(cfg.env, key, { at: nowMs(), requestsOk: n }, 3600);
      return;
    }
    const r = await caches.default.get(lastUsedKey(name, url));
    if (r) { try { const j = await r.json(); n = (j.requestsOk || 0) + 1; } catch (e) {} }
    await caches.default.put(lastUsedKey(name, url), new Response(JSON.stringify({ at: nowMs(), requestsOk: n }), {
      headers: { 'Content-Type': 'application/json' },
    }), { ttl: 3600 });
  } catch (e) { /* 尽力而为 */ }
}

// isolate 级 L1 状态缓存 + 单飞探测。键 = name + url 哈希,
// 同名不同 URL 的 proxy 状态互不串扰。
const L1 = new Map();       // key -> state
const INFLIGHT = new Map(); // key -> Promise<state>

function l1Key(name, url) { return name + '|' + hashKey(url); }

function l1Get(name, url) {
  return L1.get(l1Key(name, url)) || null;
}
function l1Set(name, url, st) {
  // 注意: 不在此处盖章 updatedAt — blankState 的 updatedAt=0 表示"从未探测过",
  // ensureFresh 依赖它决定是否发起首次探测。updatedAt 只由 putState/doProbe 维护。
  L1.set(l1Key(name, url), st);
}

// ─────────────────────────── 状态存取 ───────────────────────────

function blankState(p) {
  return {
    name: p.name,
    url: p.url,
    status: 'unknown',       // unknown | ok | depleted | down | bad_config
    reason: '',
    score: 50,               // 0-100 估算用量 (低=余量多); 未知取 50
    usagePct: 0,
    dailyLimit: 0,           // 日额度 (healthz DailyLimit, 供 /healthz 观测)
    messages24h: 0,          // 24h 已用消息数 (healthz Messages24h)
    quota: {},               // model -> {limit, recentCount, resetAt, period}
    cooldownUntil: 0,
    resetAt: 0,              // 已知最早的额度重置时间 (ms)
    retryAfter: 0,           // 秒 (最近一次带内 429)
    lastOk: 0,
    lastError: 0,
    lastUsed: 0,
    consecutiveErrors: 0,
    nextProbe: 0,            // ms: 在此之前不主动探测
    backoff: 60,             // 秒: 当前探测退避
    detail: '',
    updatedAt: 0,
    maint: false,          // 维护模式标记 (双通道: 独立 key + state)
    maintChangedAt: 0,
    // 统计 (尽力而为, 随状态持久化)
    requestsOk: 0,
    requestsFail: 0,
    statusChangedAt: 0,
  };
}

// 状态的"新鲜窗口": ok/unknown 用 stateTtl; 异常状态延长到 nextProbe+60s 缓冲,
// 保证 nextProbe 到期探测时旧状态仍在 (探测失败时可保持 down/depleted 而非退回 unknown)。
function stateFreshAge(st, cfg) {
  const now = nowMs();
  if (st.status !== 'ok' && st.status !== 'unknown' && st.nextProbe > now) {
    return (Math.max(cfg.stateTtl, Math.ceil((st.nextProbe - now) / 1000)) + 60) * 1000;
  }
  return cfg.stateTtl * 1000;
}

async function getState(p, cfg) {
  const mem = l1Get(p.name, p.url);
  if (mem && nowMs() - mem.updatedAt < stateFreshAge(mem, cfg)) return mem;
  try {
    const r = await caches.default.get(stateKey(p.name, p.url));
    if (r) {
      const st = await r.json();
      l1Set(p.name, p.url, st);
      return st;
    }
  } catch (e) { log(cfg, 'debug', 'state cache get failed', { name: p.name, err: String(e) }); }
  const st = blankState(p);
  l1Set(p.name, p.url, st);
  return st;
}

async function putState(st, cfg) {
  // 注意: 不在这里刷新 updatedAt —— updatedAt 表示"最近一次探测/带内状态变更"时间,
  // 由 doProbe / recordFailure 维护。若 putState 也刷新, 每次成功请求都会续期状态
  // 新鲜度, STATE_TTL 的重新探测将永远不会触发。
  l1Set(st.name, st.url, st);
  try {
    const resp = new Response(JSON.stringify(st), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    let ttl = cfg.stateTtl;
    if (st.status !== 'ok' && st.status !== 'unknown' && st.nextProbe > nowMs()) {
      ttl = Math.min(300, Math.max(cfg.stateTtl, Math.ceil((st.nextProbe - nowMs()) / 1000))) + 60;
    }
    await caches.default.put(stateKey(st.name, st.url), resp, { ttl });
  } catch (e) { log(cfg, 'debug', 'state cache put failed', { name: st.name, err: String(e) }); }
}

// 单飞探测: 同一 isolate 内同名同 URL 的 proxy 只并发探测一次
function probeOnce(p, cfg) {
  const key = l1Key(p.name, p.url);
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const pr = doProbe(p, cfg).finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, pr);
  return pr;
}

// ─────────────────────────── healthz 探测 ───────────────────────────

// 解析 proxy /healthz (tokens[0] = 该 proxy 唯一的 token)
function parseHealthz(json, model) {
  const t = Array.isArray(json.tokens) ? json.tokens[0] : null;
  if (!t) return null;
  const quota = {};
  let resetAt = 0;
  if (t.quota && typeof t.quota === 'object') {
    for (const [m, q] of Object.entries(t.quota)) {
      const qr = parseTs(q && q.reset_at);
      quota[m] = {
        limit: Number(q && q.limit) || 0,
        recentCount: Number(q && q.recent_count) || 0,
        resetAt: qr,
        period: (q && q.period) || '',
      };
      if (qr && (resetAt === 0 || qr < resetAt)) resetAt = qr;
    }
  }
  const cooldownUntil = parseTs(t.CooldownUntil);
  const dailyLimit = Number(t.DailyLimit) || 0;
  const messages24h = Number(t.Messages24h) || 0;
  const usagePct = Number.isFinite(Number(t.UsagePct))
    ? Math.max(0, Math.min(100, Number(t.UsagePct)))
    : (dailyLimit > 0 ? Math.min(100, Math.round((messages24h / dailyLimit) * 100)) : 0);
  const mq = model && quota[model];
  const modelUsage = mq && mq.limit > 0 ? (mq.recentCount / mq.limit) * 100 : null;
  let score = Math.max(usagePct, modelUsage === null ? 0 : modelUsage);
  // critical 风险账号降权但不剔除
  if (t.RiskLevel === 'critical') score = Math.max(score, 90);
  return {
    usagePct, quota, resetAt, cooldownUntil, score,
    dailyLimit, messages24h,
    risk: t.RiskLevel || '',
    sessionStatus: t.SessionStatus || '',
  };
}

// 根据一次 healthz 探测结果把状态归一化
function applyHealthz(st, h) {
  st.usagePct = h.usagePct;
  st.dailyLimit = h.dailyLimit || 0;
  st.messages24h = h.messages24h || 0;
  st.quota = h.quota;
  st.cooldownUntil = h.cooldownUntil;
  st.resetAt = h.resetAt || 0;
  st.score = Math.round(h.score);
  st.risk = h.risk;
  st.sessionStatus = h.sessionStatus;

  const now = nowMs();
  if (h.cooldownUntil > now) {
    st.status = 'depleted';
    st.reason = 'cooldown';
    st.detail = 'proxy token in cooldown until ' + new Date(h.cooldownUntil).toISOString();
    st.resetAt = h.cooldownUntil;
    st.nextProbe = h.cooldownUntil + 10 * 1000;
  } else if (h.usagePct >= 100) {
    st.status = 'depleted';
    st.reason = 'daily_cap';
    st.detail = 'daily message cap reached (usagePct=' + h.usagePct + ')';
    st.nextProbe = st.resetAt > now ? st.resetAt + 10 * 1000 : now + 300 * 1000;
  } else {
    // 逐模型检查会话额度
    let exhausted = '';
    for (const [m, q] of Object.entries(h.quota)) {
      if (q.limit > 0 && q.recentCount >= q.limit) {
        exhausted = m;
        break;
      }
    }
    if (exhausted) {
      st.status = 'depleted';
      st.reason = 'model_quota';
      st.detail = 'model "' + exhausted + '" session quota exhausted';
      st.nextProbe = st.resetAt > now ? st.resetAt + 10 * 1000 : now + 300 * 1000;
    } else {
      st.status = 'ok';
      st.reason = '';
      st.detail = 'ok (usagePct=' + h.usagePct + ')';
      st.nextProbe = 0;
    }
  }
}

async function doProbe(p, cfg) {
  const st = (l1Get(p.name, p.url)) || blankState(p);
  st._prev = st.status;
  const started = nowMs();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), cfg.probeTimeout);
    const res = await fetch(p.url + '/healthz', {
      headers: { 'User-Agent': 'cf-quota-gateway/1', Authorization: 'Bearer ' + p.apiKey },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (res.status !== 200) throw new Error('healthz HTTP ' + res.status);
    const json = await res.json();
    const h = parseHealthz(json, null);
    if (!h) throw new Error('healthz missing tokens[0]');
    applyHealthz(st, h);
    st.lastOk = nowMs();
    st.consecutiveErrors = 0;
    st.backoff = 60;
    st.detail = st.detail + ' (probe ' + (nowMs() - started) + 'ms)';
    if (st.status !== st._prev) {
      pushEvent(cfg, 'status_change', { name: p.name, from: st._prev, to: st.status, reason: st.reason, detail: st.detail });
      st.statusChangedAt = nowMs();
    }
    log(cfg, 'debug', 'probe ok', { name: p.name, status: st.status, score: st.score, usagePct: st.usagePct, detail: st.detail });
  } catch (e) {
    st.lastError = nowMs();
    st.consecutiveErrors++;
    st.backoff = Math.min(cfg.depletedProbe, st.backoff * 2);
    if (st.status === 'ok' || st.status === 'unknown') {
      // healthz 失败 ≠ proxy 挂: 降级为 unknown (fail-open), 不立刻剔除
      st.status = 'unknown';
      st.reason = 'probe_failed';
      st.detail = 'healthz probe failed: ' + String(e.message || e);
    } else {
      // 已 depleted/down 的保持原状, 只是记录失败
      st.detail = 'probe failed: ' + String(e.message || e) + ' (backoff ' + st.backoff + 's)';
      // 保底 nextProbe: doProbe 可能被 ensureFresh/adminProbe 直接调用,
      // 确保这里持久化时异常状态的 cache TTL 与退避对齐, 不会提前过期丢状态
      st.nextProbe = Math.max(st.nextProbe || 0, nowMs() + st.backoff * 1000);
    }
    pushEvent(cfg, 'probe_failed', { name: p.name, status: st.status, err: String(e.message || e) });
    log(cfg, 'warn', 'probe failed', { name: p.name, status: st.status, err: String(e.message || e) });
  }
  delete st._prev; // 成功/失败路径都要清理, 避免 _prev 字段泄漏进持久化状态
  st.updatedAt = nowMs();
  l1Set(p.name, p.url, st);
  await putState(st, cfg);
  return st;
}

// 确保状态新鲜: 按 status 决定是否需要探测
// 返回最新 state
async function ensureFresh(p, cfg, { model, now } = {}) {
  let st = await getState(p, cfg);
  now = now || nowMs();
  if (st.status === 'ok') {
    if (st.updatedAt && now - st.updatedAt < cfg.stateTtl * 1000) return st;
    st = await probeOnce(p, cfg);
  } else if (st.status === 'unknown') {
    if (st.updatedAt && now - st.updatedAt < Math.min(cfg.stateTtl, 30) * 1000) return st;
    st = await probeOnce(p, cfg);
  } else {
    // depleted / down / bad_config: 只在 nextProbe 到期时探测
    if (st.nextProbe && now < st.nextProbe) return st;
    st = await probeOnce(p, cfg);
    // 探测成功已回到 ok/unknown; 若仍是异常, 安排下次探测
    if (st.status !== 'ok' && st.status !== 'unknown') {
      const resetSoon = st.resetAt > now ? st.resetAt + 10 * 1000 : 0;
      const delay = resetSoon
        // reset 将至时对齐到 reset+10s, 但仍有最低 60s 兜底 —— 耗尽节点绝不能
        // 因 reset 在 60s 内就每 10s 重探一次 (探测本身消耗额度, 增加封号风险)
        ? Math.max(60 * 1000, resetSoon - now)
        : Math.max(60 * 1000, (st.backoff || cfg.depletedProbe) * 1000);
      st.nextProbe = now + delay + Math.floor(Math.random() * 15 - 7) * 1000; // 抖动防羊群
      await putState(st, cfg);
    }
  }
  return st;
}

// ─────────────────────────── 钉住 (sticky) ───────────────────────────

function stickyKeyFor(req, cfg) {
  if (cfg.pinMode === 'off') return null;
  if (cfg.pinMode === 'header') {
    const v = req.headers.get('x-sticky-id');
    return v ? 'h:' + v : null;
  }
  // client 模式: 用网关 API key 身份
  const k = req._gatewayKey;
  return k ? 'c:' + k : null;
}

async function getPin(sticky, cfg) {
  try {
    const controlled = await controlGet(cfg.env, 'pin:' + sticky);
    if (controlled !== undefined) return controlled && controlled.proxy ? controlled.proxy : null;
    const r = await caches.default.get(pinKey(sticky));
    if (!r) return null;
    const j = await r.json();
    return j && j.proxy ? j.proxy : null;
  } catch (e) { return null; }
}

async function setPin(sticky, proxyName, cfg) {
  try {
    const stored = await controlPut(cfg.env, 'pin:' + sticky, { proxy: proxyName, at: nowMs() }, cfg.pinTtl);
    if (stored) return;
    const resp = new Response(JSON.stringify({ proxy: proxyName, at: nowMs() }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await caches.default.put(pinKey(sticky), resp, { ttl: cfg.pinTtl });
  } catch (e) { log(cfg, 'debug', 'pin put failed', { err: String(e) }); }
}

// ─────────────────────────── 选路 ───────────────────────────

// 候选排序: 全部尝试顺序 (首个尝试尽量是钉住/最优, 后续为 failover 候选)
async function buildCandidates(cfg, model, sticky) {
  // 只探测真正要用的节点: 有钉住时只探测钉住的 proxy, 其余节点仅用缓存状态参与兜底,
  // 避免每次请求对全部节点做 healthz 探测 (探测会消耗额度, 增加封号风险)。
  let pinned = null;
  if (sticky) pinned = await getPin(sticky, cfg);
  const states = await Promise.all(cfg.proxies.map(p => {
    if (pinned && p.name !== pinned) return getState(p, cfg); // 仅缓存, 不探测
    return ensureFresh(p, cfg, { model });
  }));
  // 维护模式: 排除维护中的 proxy (双通道: 独立 key + state.maint 标记)。
  const maint = await Promise.all(cfg.proxies.map(p => isMaintenance(p.name, p.url, cfg)));
  const usable = (s, i) => !maint[i] && !s.maint;
  const ok = states.filter((s, i) => usable(s, i) && s.status === 'ok');
  const unknown = states.filter((s, i) => usable(s, i) && s.status === 'unknown');
  const depleted = states.filter((s, i) => usable(s, i) && s.status === 'depleted');
  const down = states.filter((s, i) => usable(s, i) && (s.status === 'down' || s.status === 'bad_config'));

  let order = [];
  // 1) 钉住
  if (pinned) {
    const idx = states.findIndex(s => s.name === pinned);
    const st = idx >= 0 ? states[idx] : null;
    if (st && usable(st, idx) && (st.status === 'ok' || st.status === 'unknown')) order.push(st);
    else if (st) log(cfg, 'debug', 'pin stale, dropping', { pin: pinned, status: st.status, maint: maint[idx] });
  }
  // 2) 按 score 升序的 ok
  const byScore = (a, b) => (a.score - b.score) || (a.lastUsed - b.lastUsed);
  for (const s of ok.sort(byScore)) if (!order.includes(s)) order.push(s);
  // 3) unknown (fail-open 兜底)
  for (const s of unknown.sort(byScore)) if (!order.includes(s)) order.push(s);
  // 4) 恢复时间最近的 depleted / down
  const recTime = s => {
    const t = s.resetAt > nowMs() ? s.resetAt : s.nextProbe || nowMs() + s.backoff * 1000;
    return t;
  };
  for (const s of [...depleted, ...down].sort((a, b) => recTime(a) - recTime(b))) {
    if (!order.includes(s)) order.push(s);
  }
  return { order, states };
}

// ─────────────────────────── 带内响应分类 ───────────────────────────

function extractResetMs(text, headerRetryAfter) {
  let retryAfterS = 0;
  if (headerRetryAfter) {
    const n = Number(headerRetryAfter);
    if (Number.isFinite(n) && n >= 0) {
      retryAfterS = n;
    } else {
      // RFC 7231 允许 Retry-After 为 HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT"):
      // parseInt 会得 NaN 丢掉信息, 这里换算成相对秒数
      const d = Date.parse(headerRetryAfter);
      if (Number.isFinite(d)) retryAfterS = Math.max(0, Math.ceil((d - nowMs()) / 1000));
    }
  }
  let reset = 0;
  if (text) {
    // proxy 的 RateLimitError message: "reset at 2026-08-18T07:00:00Z" / "retry after 30s"
    // (RFC3339 可能带毫秒: 2026-08-18T07:00:00.123Z)
    // 年份限 19xx/20xx: 排除 Go 零值 "0001-01-01T00:00:00Z" 之类无意义时间
    const mReset = text.match(/reset at\s+((?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]+(?:\.\d+)?(?:Z|[+-][0-9:]+))/i);
    if (mReset) reset = parseTs(mReset[1]);
    const mRetry = text.match(/retry after\s+([0-9]+)\s*s/i);
    if (mRetry && !retryAfterS) retryAfterS = parseInt(mRetry[1], 10);
  }
  if (!reset && retryAfterS > 0) reset = nowMs() + retryAfterS * 1000;
  return { retryAfterS, reset };
}

// 读响应体并分类 (读 body 是为了提取 quota 细节; 非 2xx 才需要)
async function classify(resp) {
  const status = resp.status;
  if (status >= 200 && status < 300) return { kind: 'ok', resp, code: '' };
  const text = await resp.text();
  let code = '';
  try { const j = JSON.parse(text); code = (j.error && j.error.code) || ''; } catch (e) {}
  const { retryAfterS, reset } = extractResetMs(text, resp.headers.get('retry-after'));
  switch (status) {
    case 429: return { kind: 'quota', resp, text, code, retryAfterS, reset };
    case 402: return { kind: 'quota', resp, text, code, retryAfterS, reset }; // out_of_credits
    case 403:
      if (code === 'account_banned') return { kind: 'banned', resp, text, code };
      if (code === 'free_mode_cli_required') return { kind: 'surface', resp, text, code };
      return { kind: 'down', resp, text, code }; // country_blocked 等
    case 401: return { kind: 'bad_config', resp, text, code };
    case 400:
    case 404: return { kind: 'surface', resp, text, code }; // 客户端错, 不 failover
    default:  return { kind: 'down', resp, text, code };    // 5xx 等
  }
}

// 一次失败后更新 proxy 状态 (kind: quota | banned | bad_config | down | surface)
async function recordFailure(st, kind, cfg, extra) {
  // surface = 客户端请求错误 (400/404/free_mode_cli_required): 与 proxy 健康无关,
  // 不标记任何状态, 只计数。
  if (kind === 'surface') { st.requestsFail++; return; }
  const now = nowMs();
  st.lastError = now;
  st.consecutiveErrors++;
  st.requestsFail++;
  switch (kind) {
    case 'quota':
      st.status = 'depleted';
      st.reason = extra.code === 'out_of_credits' ? 'out_of_credits' : 'rate_limited';
      st.retryAfter = extra.retryAfterS || 0;
      if (extra.reset > now) st.resetAt = extra.reset; // 过去的 reset 时间无意义, 不记录
      st.detail = extra.code + ' from proxy (retryAfter=' + (extra.retryAfterS || '?') + 's)';
      // 恢复探测: resetAt+10s (仅当 reset 在未来), 否则退避 —— 过去/零值的 reset
      // 若直接对齐会让 nextProbe 落进过去 → 每次请求立即重探/重试风暴
      if (extra.reset > now) {
        st.nextProbe = extra.reset + 10 * 1000;
      } else {
        st.backoff = Math.min(cfg.depletedProbe, st.backoff * 2);
        st.nextProbe = now + st.backoff * 1000 + jitter();
      }
      break;
    case 'banned':
      st.status = 'depleted';
      st.reason = 'banned';
      st.backoff = Math.min(cfg.depletedProbe, Math.max(300, st.backoff * 2));
      st.nextProbe = now + st.backoff * 1000 + jitter();
      st.detail = 'account banned (403)';
      break;
    case 'bad_config':
      st.status = 'bad_config';
      st.reason = 'auth_config';
      st.backoff = Math.min(600, Math.max(120, st.backoff * 2));
      st.nextProbe = now + st.backoff * 1000;
      st.detail = 'proxy rejected gateway key (401)';
      break;
    default: // down: 5xx / 网络错 / country_blocked
      st.status = 'down';
      st.reason = extra.code || 'http_' + (extra.status || 'err');
      st.backoff = Math.min(cfg.depletedProbe, Math.max(cfg.downProbe, st.backoff * 2));
      st.nextProbe = now + st.backoff * 1000 + jitter();
      st.detail = extra.text ? String(extra.text).slice(0, 160) : 'proxy error';
      break;
  }
  st.updatedAt = now;
  await putState(st, cfg);
}

function jitter() { return Math.floor(Math.random() * 30 - 15) * 1000; }

// ─────────────────────────── 转发 ───────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function buildUpstreamHeaders(req, proxyCfg) {
  const h = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key' || lk === 'host') continue;
    if (lk === 'x-sticky-id') continue;
    h.set(k, v);
  }
  // 网关 → proxy 的鉴权: 用该 proxy 的 key (客户端 key 永不下发)
  h.set('Authorization', 'Bearer ' + proxyCfg.apiKey);
  h.set('X-Gateway-Proxy', proxyCfg.name);
  return h;
}

async function forward(req, targetUrl, proxyCfg, cfg, body, signal) {
  const headers = buildUpstreamHeaders(req, proxyCfg);
  headers.set('Content-Type', req.headers.get('content-type') || 'application/json');
  const init = { method: req.method, headers, signal };
  if (body !== null) {
    init.body = body;
    // ReadableStream 请求体在标准 fetch (Node undici 等) 下要求 duplex: 'half'
    // (Cloudflare Workers 无此要求, 带上无副作用); ArrayBuffer/Uint8Array 不需要
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) init.duplex = 'half';
  }
  const res = await fetch(targetUrl, init);
  return res;
}

function passthroughHeaders(res, proxyName) {
  const h = new Headers();
  for (const [k, v] of res.headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    h.set(k, v);
  }
  h.set('x-gateway-proxy', proxyName);
  return h;
}

// 所有网关响应的公共头。Cache-Control: no-store 防止 CF 边缘/浏览器缓存旧版
// admin UI 或动态状态 (API 网关无缓存语义; 此前用户加载到缓存旧页面导致界面异常)。
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key, X-Sticky-Id',
    'Access-Control-Expose-Headers': 'X-Gateway-Proxy, Retry-After',
    'Cache-Control': 'no-store',
  };
}

// ─────────────────────────── 错误响应 ───────────────────────────

function errorResponse(status, code, message, extra) {
  return new Response(JSON.stringify({
    error: { message, type: 'gateway_error', code, hint: extra && extra.hint },
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(extra && extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {}),
      ...corsHeaders(),
    },
  });
}

// 全部尝试失败后, 汇总成对客户端最友好的错误
function aggregateError(attempts, cfg) {
  const quotas = attempts.filter(a => a.kind === 'quota');
  const banned = attempts.find(a => a.kind === 'banned');
  const badConfig = attempts.find(a => a.kind === 'bad_config');
  const surfaces = attempts.filter(a => a.kind === 'surface');
  if (surfaces.length) {
    // 客户端请求错误(400/404 等): 原样透传第一个
    const s = surfaces[0];
    return { passthrough: true, resp: s.resp, text: s.text, name: s.name };
  }
  if (banned) {
    return { error: errorResponse(403, 'account_banned',
      'All proxies report their accounts banned: ' + banned.text.slice(0, 200),
      { hint: 'Account suspended upstream. Token is dead; create a fresh account.' }) };
  }
  if (quotas.length) {
    let retryAfter = 0;
    for (const q of quotas) {
      const ra = q.retryAfterS || (q.reset ? Math.max(1, Math.ceil((q.reset - nowMs()) / 1000)) : 0);
      if (ra > 0) retryAfter = retryAfter === 0 ? ra : Math.min(retryAfter, ra);
    }
    const names = [...new Set(attempts.map(a => a.name))].join(', ');
    return { error: errorResponse(429, 'rate_limited',
      'All proxies are quota-exhausted: ' + names + '. Wait for quota reset or add another token.',
      { retryAfter: retryAfter || 60, hint: 'Daily/session quota reached. Retry after reset.' }) };
  }
  if (badConfig) {
    return { error: errorResponse(502, 'upstream_auth_rejected',
      'Proxy rejected gateway key (401): ' + badConfig.name + '. Check PROXIES apiKey config.',
      { hint: 'The apiKey in PROXIES must be accepted by that proxy (its API_KEYS).' }) };
  }
  const names = [...new Set(attempts.map(a => a.name))].join(', ');
  return { error: errorResponse(502, 'upstream_unavailable',
    'All proxies unavailable (' + names + '): ' + attempts[0].text.slice(0, 200),
    { hint: 'Proxies are down or unreachable. Check the proxy deployments.' }) };
}

// ─────────────────────────── 主处理: chat / 通用转发 ───────────────────────────

async function routeRequest(req, cfg, body, opts = {}) {
  const url = new URL(req.url);
  const model = extractModel(req, body);
  // noSticky: 仅内部特殊调用显式关闭; 普通请求与 smoke 默认复用 sticky
  const sticky = opts.stickyKey !== undefined
    ? opts.stickyKey
    : (opts.noSticky ? null : stickyKeyFor(req, cfg));
  const isChat = req.method === 'POST' && (url.pathname === '/v1/chat/completions');
  // 判断是否流式请求: 只有缓冲的 JSON body 能可靠判断 (stream:true)。非 JSON 透传 body
  // (ReadableStream) 无法解析 → 按非流式处理, 超时窗口只覆盖响应头等待阶段, 不影响透传流。
  let chatStream = false;
  if (isChat && body && !(body instanceof ReadableStream)) {
    try {
      const j = JSON.parse(new TextDecoder().decode(body));
      if (j && j.stream === true) chatStream = true;
    } catch (e) {}
  }

  const { order, states } = await buildCandidates(cfg, model, sticky);
  if (order.length === 0) {
    return errorResponse(502, 'upstream_unavailable', 'no proxies configured', {});
  }

  const attempts = [];
  const reqStarted = nowMs();
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  // 非流式 chat 才有单次尝试超时: 流式响应由客户端断开兜底 (流一旦开始不能由网关截断)。
  // 这是"客户端 abort 不再误标 down"后, 挂死 proxy (接受连接但不响应) 的唯一带内检测 ——
  // 超时 → 视作 down → failover, 而不是让每次请求挂到客户端超时。
  // 注意: 超时窗口只覆盖"等待上游响应头"阶段, 头到达后计时器立即清除 —— 真正的 SSE
  // 流头会立刻到达, 不会被截断; 无法解析的透传 body 也适用 (noReplay 单次尝试, 同样受益)。
  const attemptTimeout = isChat && !chatStream ? cfg.chatTimeout : 0;

  const max = opts.noReplay ? 1 : Math.min(cfg.maxAttempts, order.length);
  for (let i = 0; i < max; i++) {
    const st = order[i];
    // 转发一律用配置里的 url/apiKey (st.url 只是展示信息, 避免跨实例串状态)
    const pc = cfg.proxies.find(p => p.name === st.name);
    if (!pc) continue;
    const target = pc.url + url.pathname + url.search;
    const started = nowMs();
    // 单次尝试超时信号: 与客户端 abort 叠加 (客户端断开仍优先 → 499)
    let attemptCtrl = null, attemptTimer = null, onAttemptAbort = null;
    let signal = ac.signal;
    if (attemptTimeout > 0) {
      attemptCtrl = new AbortController();
      attemptTimer = setTimeout(() => attemptCtrl.abort(), attemptTimeout);
      onAttemptAbort = () => attemptCtrl.abort();
      ac.signal.addEventListener('abort', onAttemptAbort, { once: true });
      signal = attemptCtrl.signal;
    }
    let resp;
    try {
      resp = await forward(req, target, pc, cfg, body, signal);
    } catch (e) {
      // 客户端断开: abort 会传播到上游 fetch, 以 AbortError 抛到这里。
      // 必须先判 abort —— 客户端中断与 proxy 健康无关, 绝不能把健康 proxy 标 down
      // (否则一次客户端取消就把 proxy 踢出选路池 120s+, 恢复探测前一直不可用)。
      if (ac.signal.aborted) return errorResponse(499, 'client_closed', 'client disconnected', {});
      // 网关侧单次尝试超时 (proxy 挂死: 连接建立但迟迟不响应) → 视作 down 并 failover
      if (attemptCtrl && attemptCtrl.signal.aborted) {
        await recordFailure(st, 'down', cfg, { status: 0, code: 'timeout', text: 'upstream timeout after ' + attemptTimeout + 'ms' });
        attempts.push({ name: st.name, kind: 'down', text: 'upstream timeout after ' + attemptTimeout + 'ms' });
        log(cfg, 'warn', 'upstream timeout', { name: st.name, ms: attemptTimeout });
        continue;
      }
      // 网络层错误
      await recordFailure(st, 'down', cfg, { status: 0, text: String(e.message || e) });
      attempts.push({ name: st.name, kind: 'down', text: String(e.message || e) });
      log(cfg, 'warn', 'upstream fetch failed', { name: st.name, err: String(e.message || e) });
      continue;
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer);
      if (onAttemptAbort) ac.signal.removeEventListener('abort', onAttemptAbort);
    }

    const cl = await classify(resp);
    cl.name = st.name;
    cl.ms = nowMs() - started;
    if (cl.kind === 'ok') {
      st.lastOk = nowMs();
      st.lastUsed = nowMs();
      st.consecutiveErrors = 0;
      st.requestsOk++;
      st.status = 'ok';
      st.reason = '';
      st.backoff = 60;
      st.nextProbe = 0;
      await putState(st, cfg);
      await recordLastUsed(st.name, st.url, cfg); // 最近路由持久化 (独立 TTL, 跨 isolate 可见)
      if (sticky) await setPin(sticky, st.name, cfg);
      attempts.push(cl);
      log(cfg, 'debug', 'relayed', { name: st.name, status: cl.resp.status, ms: cl.ms, sticky: !!sticky });

      // 2xx: 直通响应 (流式/JSON 都原样透传 body)
      const h = passthroughHeaders(cl.resp, st.name);
      for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
      h.set('x-gateway-attempts', String(attempts.length));
      if (isChat && sticky) h.set('x-gateway-pin', st.name);
      // 路由记录: 每次成功响应一条 (含 failover 尝试次数)
      queueRoute(cfg, { name: st.name, status: cl.resp.status, attempts: attempts.length, ms: nowMs() - reqStarted, model: model || null, ok: true }, opts.waitUntil);
      return new Response(cl.resp.body, { status: cl.resp.status, headers: h });
    }

    // 失败: 更新状态 + 记录 (surface 客户端错只透传不标记)
    const prevStatus = st.status;
    await recordFailure(st, cl.kind, cfg, { code: cl.code, retryAfterS: cl.retryAfterS, reset: cl.reset, text: cl.text, status: cl.resp.status });
    attempts.push(cl);
    log(cfg, cl.kind === 'surface' ? 'info' : 'warn', 'attempt failed', {
      name: st.name, status: cl.resp.status, code: cl.code || '', ms: cl.ms,
    });
    if (cl.kind === 'surface') break; // 客户端错: 不再 failover
    // 状态变化或 failover 事件 (只在尝试数 >1 或状态真的变化时记, 控制日志噪音)
    if (st.status !== prevStatus || attempts.length > 1) {
      pushEvent(cfg, st.status !== prevStatus ? 'status_change' : 'failover', {
        name: st.name, from: prevStatus, to: st.status, code: cl.code || '', status: cl.resp.status,
      });
    }
  }

  req.signal.removeEventListener('abort', onClientAbort);
  const agg = aggregateError(attempts, cfg);
  // 路由记录: 全部尝试失败的情况 (记录最终状态与最后尝试的代理)
  const last = attempts[attempts.length - 1];
  queueRoute(cfg, {
    name: last ? last.name : null,
    status: agg.passthrough ? agg.resp.status : (agg.error ? agg.error.status : 502),
    attempts: attempts.length,
    ms: nowMs() - reqStarted,
    model: model || null,
    ok: false,
  }, opts.waitUntil);
  if (agg.passthrough) {
    // x-gateway-proxy 必须指实际产生该 surface 响应的 proxy —— 前面可能已尝试过
    // 5xx/quota 的 proxy (attempts[0] 不一定是 surface 那个), 用 agg.name。
    const h = passthroughHeaders(agg.resp, agg.name);
    for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
    return new Response(agg.text, { status: agg.resp.status, headers: h });
  }
  return agg.error;
}

function extractModel(req, body) {
  if (req.method === 'POST' && body) {
    try {
      const j = JSON.parse(new TextDecoder().decode(body));
      if (j && typeof j.model === 'string') return j.model;
    } catch (e) {}
  }
  return null;
}

// ─────────────────────────── /v1/models 聚合 ───────────────────────────

async function handleModels(req, cfg) {
  const results = await Promise.allSettled(cfg.proxies.map(async p => {
    const st = await ensureFresh(p, cfg, {});
    const url = p.url + '/v1/models';
    // 与 doProbe 一致的上游超时: 挂死的 proxy 不能无限卡住 /v1/models 与后台模型下拉
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), cfg.probeTimeout);
    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + p.apiKey },
        signal: ctrl.signal,
      });
      if (res.status !== 200) throw new Error(p.name + ': /v1/models HTTP ' + res.status);
      const j = await res.json();
      return { name: p.name, ok: st.status === 'ok', data: Array.isArray(j.data) ? j.data : [] };
    } finally {
      clearTimeout(to);
    }
  }));

  const byModel = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') { log(cfg, 'warn', 'models fetch failed', { err: r.reason && r.reason.message }); continue; }
    for (const m of r.value.data) {
      const id = m.id;
      const cur = byModel.get(id) || { id, ok: 0, statuses: {} };
      if (r.value.ok) cur.ok++;
      cur.statuses[m.status || 'unknown'] = (cur.statuses[m.status || 'unknown'] || 0) + 1;
      byModel.set(id, cur);
    }
  }
  const created = Math.floor(Date.now() / 1000);
  const data = [...byModel.values()].map(c => ({
    id: c.id,
    object: 'model',
    created,
    owned_by: 'freebuff',
    available: c.ok > 0,
    status: c.ok > 0 ? 'available' : (c.statuses['quota_exhausted'] ? 'quota_exhausted' : 'unavailable'),
  }));
  return new Response(JSON.stringify({ object: 'list', data }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ─────────────────────────── 路由记录 (每次请求) ───────────────────────────

// 与系统事件分离的独立环形缓冲: 每次请求(成功/失败)一条, 不被状态变更事件挤掉
const ROUTES_KEY = CACHE_ORIGIN + '/routes';
const MAX_ROUTES = 200;
const ROUTE_L1 = [];
let routeFlushChain = Promise.resolve(); // 串行化同 isolate 落盘, 防并发覆盖丢条目

function pushRoute(cfg, detail) {
  ROUTE_L1.push({ t: nowMs(), ...detail });
  // 每推必落盘; 返回 promise 供 fetch(ctx).waitUntil 托管到响应结束后。
  routeFlushChain = routeFlushChain.then(() => flushRoutes(cfg)).catch(() => {});
  return routeFlushChain;
}

function queueRoute(cfg, detail, waitUntil) {
  const task = pushRoute(cfg, detail);
  if (typeof waitUntil === 'function') waitUntil(task);
  return task;
}

async function flushRoutes(cfg) {
  if (ROUTE_L1.length === 0) return;
  const batch = ROUTE_L1.slice();
  let wrote = false;
  try {
    if (cfg.env) {
      const ok = await controlAppend(cfg.env, 'routes', batch, MAX_ROUTES, 86400);
      if (ok) { ROUTE_L1.splice(0, batch.length); wrote = true; }
    }
    if (!wrote) {
      let list = [];
      const r = await caches.default.get(ROUTES_KEY);
      if (r) { const j = await r.json(); if (Array.isArray(j)) list = j; }
      list = [...list, ...batch];
      if (list.length > MAX_ROUTES) list = list.slice(list.length - MAX_ROUTES);
      await caches.default.put(ROUTES_KEY, new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json' },
      }), { ttl: 86400 });
      ROUTE_L1.splice(0, batch.length);
      wrote = true;
    }
    if (!wrote) { /* both unavailable: keep batch for later */ }
  } catch (e) {
    // 保留 batch, 不能因一次 Cache API 暂时失败丢掉路由记录
    throw e;
  }
}

async function readRoutes(cfg) {
  try {
    await routeFlushChain;   // 等本 isolate 未完成的落盘先写完
    await flushRoutes(cfg);  // 把 L1 剩余累积写入
    if (cfg.env) {
      const controlled = await controlList(cfg.env, 'routes', MAX_ROUTES);
      if (controlled !== null) return controlled;
    }
    const r = await caches.default.get(ROUTES_KEY);
    if (!r) return [];
    const j = await r.json();
    return Array.isArray(j) ? j.slice(-MAX_ROUTES) : [];
  } catch (e) { return []; }
}

// ─────────────────────────── 事件日志 ───────────────────────────

const EVENTS_KEY = CACHE_ORIGIN + '/events';
const MAX_EVENTS = 200;
const EVENT_L1 = []; // isolate 内聚合
let eventFlushChain = Promise.resolve(); // 串行化同 isolate 落盘

// 记录一条管理/运行事件 (尽力而为: cache 环形缓冲, 跨 isolate 最后写者胜)
// 每推必落盘: 攒批 >=10 才 flush 会让低流量时的日志滞留本 isolate, 管理后台看不到
function pushEvent(cfg, type, detail) {
  EVENT_L1.push({ t: nowMs(), type, ...detail });
  eventFlushChain = eventFlushChain.then(() => flushEvents(cfg)).catch(() => {});
}

async function flushEvents(cfg) {
  if (EVENT_L1.length === 0) return;
  const batch = EVENT_L1.slice();
  let wrote = false;
  try {
    if (cfg.env) {
      const ok = await controlAppend(cfg.env, 'events', batch, MAX_EVENTS, 86400);
      if (ok) { EVENT_L1.splice(0, batch.length); wrote = true; }
    }
    if (!wrote) {
      let list = [];
      const r = await caches.default.get(EVENTS_KEY);
      if (r) { const j = await r.json(); if (Array.isArray(j)) list = j; }
      list = [...list, ...batch];
      if (list.length > MAX_EVENTS) list = list.slice(list.length - MAX_EVENTS);
      await caches.default.put(EVENTS_KEY, new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json' },
      }), { ttl: 86400 });
      EVENT_L1.splice(0, batch.length);
    }
  } catch (e) { /* 保留 batch, 稍后重试 */ }
}

async function readEvents(cfg) {
  try {
    await eventFlushChain;   // 等本 isolate 未完成的落盘先写完
    await flushEvents(cfg);  // 把 L1 剩余累积写进去
    if (cfg.env) {
      const controlled = await controlList(cfg.env, 'events', MAX_EVENTS);
      if (controlled !== null) return controlled;
    }
    const r = await caches.default.get(EVENTS_KEY);
    if (!r) return [];
    const j = await r.json();
    return Array.isArray(j) ? j.slice(-MAX_EVENTS) : [];
  } catch (e) { return []; }
}

// ─────────────────────────── 维护模式 ───────────────────────────

function maintKey(name, url) { return CACHE_ORIGIN + '/maint/' + encodeURIComponent(name) + '/' + hashKey(url); }

async function isMaintenance(name, url, cfg) {
  try {
    if (cfg && cfg.env) {
      const c = await controlGet(cfg.env, 'maint:' + name + '|' + hashKey(url));
      if (c !== undefined) return !!(c && c.on);
    }
    const r = await caches.default.get(maintKey(name, url));
    if (!r) return false;
    const j = await r.json();
    return !!(j && j.on);
  } catch (e) { return false; }
}

// 双通道写入维护状态: 独立 key (跨边缘最终一致) + 该 proxy 的 state 对象
// (每次路由都会读 state, 同边缘内立即生效; state 的 L1 缓存让同 isolate 即刻排除)。
async function setMaintenance(name, url, on, cfg) {
  try {
    const key = 'maint:' + name + '|' + hashKey(url);
    if (cfg.env) {
      const ok = on ? await controlPut(cfg.env, key, { on: true, at: nowMs() }, 86400)
                    : await controlDelete(cfg.env, key);
      if (ok) {
        const p = cfg.proxies.find(x => x.name === name && x.url === url);
        if (p) {
          const st = (l1Get(p.name, p.url)) || blankState(p);
          st.maint = on;
          st.maintChangedAt = nowMs();
          if (on) {
            st.status = 'down';
            st.reason = 'maintenance';
            st.detail = 'manual maintenance mode';
            await putState(st, cfg);
          } else {
            st.status = 'unknown';
            st.reason = '';
            st.detail = '';
            await putState(st, cfg);
            await doProbe(p, cfg);
          }
        }
        return;
      }
    }
    if (on) {
      await caches.default.put(maintKey(name, url), new Response(JSON.stringify({ on: true, at: nowMs() }), {
        headers: { 'Content-Type': 'application/json' },
      }), { ttl: 86400 });
    } else {
      await caches.default.delete(maintKey(name, url));
    }
  } catch (e) { /* 尽力而为 */ }
  // 同步到 state 对象 (若该 proxy 状态已存在)
  const p = cfg.proxies.find(x => x.name === name && x.url === url);
  if (p) {
    const st = (l1Get(p.name, p.url)) || blankState(p);
    st.maint = on;
    st.maintChangedAt = nowMs();
    if (on) {
      st.status = 'down'; // 维护中视作不可用
      st.reason = 'maintenance';
      st.detail = 'manual maintenance mode';
      await putState(st, cfg);
    } else {
      st.status = 'unknown'; // 恢复后立即重新探测, 尽快回到选路池
      st.reason = '';
      st.detail = '';
      await putState(st, cfg);
      await doProbe(p, cfg);
    }
    await putState(st, cfg);
  }
}

// ─────────────────────────── 运行时配置 ───────────────────────────

// 后台管理保存的运行时配置 (增删改代理 + 参数), 覆盖环境变量 (用户改动优先)。
// 存 caches.default, TTL 30 天; 每次请求加载时应用; 可"重置为环境变量"。
const RUNTIME_KEY = CACHE_ORIGIN + '/runtime-config';

async function getRuntimeConfig(env) {
  try {
    const controlled = await controlGet(env, 'runtime-config');
    if (controlled !== undefined) return controlled;
    const r = await caches.default.get(RUNTIME_KEY);
    if (!r) return null;
    const j = await r.json();
    return j && typeof j === 'object' ? j : null;
  } catch (e) { return null; }
}

async function setRuntimeConfig(env, rc) {
  const stored = await controlPut(env, 'runtime-config', rc, 2592000);
  if (stored) return;
  await caches.default.put(RUNTIME_KEY, new Response(JSON.stringify(rc), {
    headers: { 'Content-Type': 'application/json' },
  }), { ttl: 2592000 });
}

async function clearRuntimeConfig(env) {
  const deleted = await controlDelete(env, 'runtime-config');
  if (deleted) return;
  await caches.default.delete(RUNTIME_KEY);
}

// 环境变量为基础配置, 叠加运行时覆盖。返回新的 cfg。
// 重要: 运行时配置校验失败时降级忽略 (继续用环境变量), 绝不因脏数据让 worker 不可用。
async function applyRuntimeConfig(cfg) {
  const rc = await getRuntimeConfig(cfg.env);
  if (!rc) return cfg;
  cfg._runtime = rc;
  if (Array.isArray(rc.proxies) && rc.proxies.length > 0) {
    try {
      const seen = new Set();
      const seenUrls = new Set();
      cfg.proxies = rc.proxies.map((p, i) => {
        const url = String(p.url || '').replace(/\/+$/, '');
        if (!/^https?:\/\/[^/]+/.test(url)) throw new Error('proxy #' + (i + 1) + ': invalid url');
        if (!p.apiKey) throw new Error('proxy #' + (i + 1) + ': missing apiKey');
        const name = String(p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'p' + (i + 1);
        if (seen.has(name)) throw new Error('duplicate proxy name ' + name);
        seen.add(name);
        // 与 env 解析一致: 同一 URL 两个 name 会导致双倍探测、双倍消耗探测额度
        if (seenUrls.has(url)) throw new Error('proxy #' + (i + 1) + ': duplicate url ' + url);
        seenUrls.add(url);
        return { name, url, apiKey: String(p.apiKey) };
      });
      cfg.runtimeProxies = true;
    } catch (e) {
      // 降级: 忽略坏 proxies, 继续用环境变量; 记录错误供后台展示
      cfg._runtimeError = String(e.message);
      log(cfg, 'warn', 'runtime config proxies invalid, falling back to env', { err: String(e.message) });
    }
  }
  const s = rc.settings;
  if (s && typeof s === 'object') {
    if (typeof s.pinMode === 'string' && ['client', 'header', 'off'].includes(s.pinMode)) cfg.pinMode = s.pinMode;
    if (Number.isFinite(s.pinTtl) && s.pinTtl >= 60) cfg.pinTtl = Math.floor(s.pinTtl);
    if (Number.isFinite(s.stateTtl) && s.stateTtl >= 60) cfg.stateTtl = Math.floor(s.stateTtl);
    if (Number.isFinite(s.depletedProbe) && s.depletedProbe >= 60) cfg.depletedProbe = Math.floor(s.depletedProbe);
    if (Number.isFinite(s.downProbe) && s.downProbe >= 30) cfg.downProbe = Math.floor(s.downProbe);
    if (Number.isFinite(s.probeTimeout) && s.probeTimeout >= 500) cfg.probeTimeout = Math.floor(s.probeTimeout);
    if (Number.isFinite(s.chatTimeout) && s.chatTimeout >= 1000) cfg.chatTimeout = Math.floor(s.chatTimeout);
    if (Number.isFinite(s.maxAttempts) && s.maxAttempts >= 1 && s.maxAttempts <= 6) cfg.maxAttempts = Math.floor(s.maxAttempts);
  }
  return cfg;
}

// ─────────────────────────── 网关自身端点 ───────────────────────────

async function handleGatewayHealth(cfg) {
  // 触发所有过期项探测, 返回全景
  const states = await Promise.all(cfg.proxies.map(p => ensureFresh(p, cfg, {})));
  const tokens = states.map(st => ({
    name: st.name,
    url: st.url,
    status: st.status,
    reason: st.reason,
    detail: st.detail,
    score: st.score,
    usage_pct: st.usagePct,
    daily_limit: st.dailyLimit || null,
    messages_24h: st.messages24h || null,
    risk: st.risk || null,
    cooldown_until: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
    reset_at: st.resetAt ? new Date(st.resetAt).toISOString() : null,
    retry_after_s: st.retryAfter || null,
    next_probe: st.nextProbe ? new Date(st.nextProbe).toISOString() : null,
    last_ok: st.lastOk ? new Date(st.lastOk).toISOString() : null,
    last_error: st.lastError ? new Date(st.lastError).toISOString() : null,
    consecutive_errors: st.consecutiveErrors,
    quota: Object.fromEntries(Object.entries(st.quota || {}).map(([m, q]) => [
      m, { limit: q.limit, recent_count: q.recentCount, reset_at: q.resetAt ? new Date(q.resetAt).toISOString() : null, period: q.period },
    ])),
  }));
  const okCount = states.filter(s => s.status === 'ok').length;
  return new Response(JSON.stringify({
    status: okCount > 0 ? 'ok' : (states.length ? 'degraded' : 'no_proxies'),
    mode: cfg.pinMode,
    proxies_total: cfg.proxies.length,
    proxies_ok: okCount,
    proxies: tokens,
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ─────────────────────────── 管理 API ───────────────────────────

function maskKey(k) {
  if (!k) return '—';
  if (k.length <= 6) return k[0] + '***';
  return k.slice(0, 3) + '…' + k.slice(-3);
}

// 汇总 overview: 各 proxy 状态 + 统计 + 维护状态 + 事件
async function adminOverview(cfg) {
  const states = await Promise.all(cfg.proxies.map(p => ensureFresh(p, cfg, {})));
  const maint = await Promise.all(cfg.proxies.map(p => isMaintenance(p.name, p.url, cfg)));
  const proxies = states.map((st, i) => {
    const isMaint = !!maint[i] || !!st.maint;
    return {
    name: st.name,
    url: st.url,
    status: isMaint ? 'maint' : st.status,
    maint: isMaint,
    reason: st.reason || '',
    detail: st.detail || '',
    score: st.score,
    usage_pct: st.usagePct,
    daily_limit: st.dailyLimit || null,
    messages_24h: st.messages24h || null,
    risk: st.risk || null,
    cooldown_until: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
    reset_at: st.resetAt ? new Date(st.resetAt).toISOString() : null,
    retry_after_s: st.retryAfter || null,
    next_probe: st.nextProbe ? new Date(st.nextProbe).toISOString() : null,
    last_ok: st.lastOk ? new Date(st.lastOk).toISOString() : null,
    last_error: st.lastError ? new Date(st.lastError).toISOString() : null,
    consecutive_errors: st.consecutiveErrors,
    requestsOk: st.requestsOk || 0,
    requestsFail: st.requestsFail || 0,
    quota: Object.fromEntries(Object.entries(st.quota || {}).map(([m, q]) => [
      m, { limit: q.limit, recent_count: q.recentCount, reset_at: q.resetAt ? new Date(q.resetAt).toISOString() : null, period: q.period },
    ])),
    };
  });
  const stats = {
    total: proxies.length,
    ok: proxies.filter(p => !p.maint && p.status === 'ok').length,
    depleted: proxies.filter(p => !p.maint && p.status === 'depleted').length,
    down: proxies.filter(p => !p.maint && (p.status === 'down' || p.status === 'bad_config')).length,
    requestsOk: proxies.reduce((a, p) => a + p.requestsOk, 0),
    requestsFail: proxies.reduce((a, p) => a + p.requestsFail, 0),
  };
  const events = await readEvents(cfg);
  const routes = await readRoutes(cfg);
  return new Response(JSON.stringify({ status: 'ok', stats, proxies, events, routes, timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function adminConfig(cfg) {
  const rc = cfg._runtime || null;
  return new Response(JSON.stringify({
    config: {
      // 生效配置 (含运行时覆盖后的结果); proxies 带完整 apiKey (管理后台可见, 供编辑回填)
      proxies: cfg.proxies.map(p => ({ name: p.name, url: p.url, apiKey: p.apiKey })),
      pin_mode: cfg.pinMode,
      pin_ttl: cfg.pinTtl,
      state_ttl: cfg.stateTtl,
      depleted_probe: cfg.depletedProbe,
      down_probe: cfg.downProbe,
      probe_timeout: cfg.probeTimeout,
      chat_timeout: cfg.chatTimeout,
      max_attempts: cfg.maxAttempts,
      admin_uses_api_key: !cfg.adminKeyConfigured, // ADMIN_KEY 未配置时管理后台复用 API_KEY
      api_key_masked: cfg.clientKeys.map(maskKey).join(', '),
      admin_key_masked: cfg.adminKeyConfigured ? maskKey(cfg.adminKeys[0]) : null,
      proxy_keys_masked: cfg.proxies.map(p => maskKey(p.apiKey)).join(', '),
      // 来源标记
      runtime_managed: !!cfg.runtimeProxies,   // 代理列表来自后台运行时配置
      has_runtime_config: !!rc,                // 是否存在后台保存的运行时配置
      runtime_error: cfg._runtimeError || null, // 运行时代理校验失败时的降级原因 (供设置页提示)
    },
  }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

// 保存运行时配置 (代理增删改 + 参数修改)。立即生效 (下次请求); cache 跨边缘传播有短暂延迟。
async function adminSaveConfig(req, cfg) {
  let body = {};
  try { body = await req.json(); } catch (e) { return errorResponse(400, 'invalid_config', 'invalid JSON body', {}); }
  // 读-改-写合并: 后台"保存代理"与"保存参数"是两个独立表单, 各只 POST 自己的字段。
  // 若整体替换会把另一部分清掉 (先存代理、再只改一个参数 → 代理列表静默回退环境变量)。
  const rc = { ...((await getRuntimeConfig(cfg.env)) || {}) };
  if (body.proxies !== undefined) {
    if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
      return errorResponse(400, 'invalid_config', 'proxies must be a non-empty array of {name?,url,apiKey}', {});
    }
    const seen = new Set();
    const seenUrls = new Set();
    for (let i = 0; i < body.proxies.length; i++) {
      const p = body.proxies[i];
      const url = String(p.url || '').replace(/\/+$/, '');
      if (!/^https?:\/\/[^/]+/.test(url)) return errorResponse(400, 'invalid_config', 'proxy #' + (i + 1) + ': invalid url', {});
      if (!p.apiKey) return errorResponse(400, 'invalid_config', 'proxy #' + (i + 1) + ': missing apiKey', {});
      const name = String(p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'p' + (i + 1);
      if (seen.has(name)) return errorResponse(400, 'invalid_config', 'duplicate proxy name: ' + name, {});
      seen.add(name);
      if (seenUrls.has(url)) return errorResponse(400, 'invalid_config', 'proxy #' + (i + 1) + ': duplicate url: ' + url, {});
      seenUrls.add(url);
    }
    rc.proxies = body.proxies.map((p, i) => ({
      name: String(p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'p' + (i + 1),
      url: String(p.url).replace(/\/+$/, ''),
      apiKey: String(p.apiKey),
    }));
  }
  if (body.settings !== undefined) {
    if (typeof body.settings !== 'object' || body.settings === null) {
      return errorResponse(400, 'invalid_config', 'settings must be an object', {});
    }
    const s = body.settings;
    if (s.pinMode !== undefined && !['client', 'header', 'off'].includes(s.pinMode)) return errorResponse(400, 'invalid_config', 'pinMode must be client|header|off', {});
    for (const [k, min] of [['pinTtl', 60], ['stateTtl', 60], ['depletedProbe', 60], ['downProbe', 30], ['probeTimeout', 500], ['chatTimeout', 1000]]) {
      if (s[k] !== undefined && (!Number.isFinite(s[k]) || s[k] < min)) return errorResponse(400, 'invalid_config', k + ' must be >= ' + min, {});
    }
    if (s.maxAttempts !== undefined && (!Number.isFinite(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 6)) return errorResponse(400, 'invalid_config', 'maxAttempts must be 1-6', {});
    // 读-改-写合并 (与 proxies 同一策略): 只覆盖请求里出现的字段, 绝不整体替换。
    // 否则一次只传 {pinMode} 的部分保存会静默丢掉之前保存的 maxAttempts 等其它参数。
    const merged = { ...((rc.settings && typeof rc.settings === 'object') ? rc.settings : {}) };
    if (s.pinMode !== undefined) merged.pinMode = s.pinMode;
    if (s.pinTtl !== undefined) merged.pinTtl = Math.floor(s.pinTtl);
    if (s.stateTtl !== undefined) merged.stateTtl = Math.floor(s.stateTtl);
    if (s.depletedProbe !== undefined) merged.depletedProbe = Math.floor(s.depletedProbe);
    if (s.downProbe !== undefined) merged.downProbe = Math.floor(s.downProbe);
    if (s.probeTimeout !== undefined) merged.probeTimeout = Math.floor(s.probeTimeout);
    if (s.chatTimeout !== undefined) merged.chatTimeout = Math.floor(s.chatTimeout);
    if (s.maxAttempts !== undefined) merged.maxAttempts = Math.floor(s.maxAttempts);
    rc.settings = merged;
  }
  if (!rc.proxies && !rc.settings) return errorResponse(400, 'invalid_config', 'nothing to save (provide proxies and/or settings)', {});
  await setRuntimeConfig(cfg.env, rc);
  pushEvent(cfg, 'admin_action', {
    action: 'save_config',
    proxies: rc.proxies ? rc.proxies.length : null,
    settings: rc.settings ? Object.keys(rc.settings).join(',') : null,
  });
  return new Response(JSON.stringify({ saved: true, note: '运行时配置已保存并立即生效 (跨边缘传播可能延迟几秒)' }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// 清除运行时配置, 回到环境变量
async function adminResetConfig(cfg) {
  await clearRuntimeConfig(cfg.env);
  pushEvent(cfg, 'admin_action', { action: 'reset_config' });
  return new Response(JSON.stringify({ reset: true, note: '已清除运行时配置, 恢复为环境变量' }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// 强制探测: 全部或单个 proxy (绕过 nextProbe 节流)
async function adminProbe(req, cfg) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const targets = body.name ? cfg.proxies.filter(p => p.name === body.name) : cfg.proxies;
  if (!targets.length) return errorResponse(404, 'not_found', 'no such proxy: ' + body.name, {});
  const results = await Promise.all(targets.map(async p => {
    const st = await doProbe(p, cfg);
    pushEvent(cfg, 'admin_action', { action: 'probe', name: p.name, result: st.status });
    return { name: p.name, status: st.status, detail: st.detail };
  }));
  return new Response(JSON.stringify({ results, total: results.length }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function adminMaintenance(req, cfg) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const p = cfg.proxies.find(x => x.name === body.name);
  if (!p) return errorResponse(404, 'not_found', 'no such proxy: ' + body.name, {});
  const on = !!body.on;
  await setMaintenance(p.name, p.url, on, cfg);
  pushEvent(cfg, 'maintenance', { name: p.name, on });
  return new Response(JSON.stringify({ name: p.name, maintenance: on }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// 解除钉住: 按客户端 sticky key 清除 pin
async function adminPin(req, cfg) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const key = String(body.key || '').trim();
  if (!key) return errorResponse(400, 'invalid_request', 'key is required', {});
  // 当前模式用单前缀; PIN_MODE=off 无活动命名空间, 清除时同时覆盖 c:/h:,
  // 让"清除"在模式切换后仍能清掉旧模式遗留的 pin (否则旧 pin 只能等 TTL 过期)
  const prefixes = cfg.pinMode === 'off' ? ['c:', 'h:'] : [(cfg.pinMode === 'header' ? 'h:' : 'c:')];
  for (const pre of prefixes) {
    try { await caches.default.delete(pinKey(pre + key)); } catch (e) {}
  }
  pushEvent(cfg, 'admin_action', { action: 'clear_pin', key });
  return new Response(JSON.stringify({ cleared: true, key }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// 当前会话的钉住状态 + 全局最近路由事实 (按最近命中排序, 不依赖管理会话身份)
async function adminPinStatus(req, cfg) {
  const sticky = stickyKeyFor(req, cfg);
  let pinned = null;
  if (sticky) pinned = await getPin(sticky, cfg);
  // 最近路由事实: 优先读持久化的 last-used 记录 (TTL 1h, 不随状态过期丢失),
  // fallback 到状态里的 lastUsed。
  const recent = [];
  for (const p of cfg.proxies) {
    let lu = null;
    const key = 'lastused:' + p.name + '|' + hashKey(p.url);
    try {
      if (cfg.env) {
        const c = await controlGet(cfg.env, key);
        if (c !== undefined) {
          if (c.at > 0) lu = { at: c.at, requestsOk: c.requestsOk || 0 };
        } else {
          const r = await caches.default.get(lastUsedKey(p.name, p.url));
          if (r) { const j = await r.json(); if (j && j.at > 0) lu = { at: j.at, requestsOk: j.requestsOk || 0 }; }
        }
      } else {
        const r = await caches.default.get(lastUsedKey(p.name, p.url));
        if (r) { const j = await r.json(); if (j && j.at > 0) lu = { at: j.at, requestsOk: j.requestsOk || 0 }; }
      }
    } catch (e) {}
    if (lu) {
      recent.push({ name: p.name, lastUsed: lu.at, requestsOk: lu.requestsOk });
    } else {
      const st = await getState(p, cfg);
      if (st && st.lastUsed > 0) recent.push({ name: p.name, lastUsed: st.lastUsed, requestsOk: st.requestsOk || 0 });
    }
  }
  recent.sort((a, b) => b.lastUsed - a.lastUsed);
  return new Response(JSON.stringify({
    pin_mode: cfg.pinMode,
    sticky_key: sticky,
    pinned_proxy: pinned,
    recent_proxies: recent.slice(0, 5),
  }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

// smoke test: 走完整路由链路发一条真实请求, 返回人类可读结果
async function adminSmoke(req, cfg) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const model = String(body.model || '').trim() || 'freebuff-1';
  const prompt = String(body.prompt || 'ping').slice(0, 500);
  const stream = !!body.stream;
  const chatBody = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream });
  const inner = new Request('https://gateway.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (req._gatewayKey || 'smoke') },
    body: chatBody,
  });
  inner._gatewayKey = req._gatewayKey || '';
  const started = nowMs();
  try {
    // Smoke 必须复用常规路由的 sticky 语义: 同一管理会话持续命中同一常驻代理,
    // 避免每次 ping 重新轮询、无意义消耗不同代理额度。
    // req._gatewayKey 由 adminAuthorized 设置: ADMIN_KEY 独立时使用独立的管理会话 pin;
    // 未配置 ADMIN_KEY 时它就是 API_KEY, 与客户端常规路由完全一致。
    const resp = await routeRequest(inner, cfg, new TextEncoder().encode(chatBody), { noSticky: false });
    // 读响应 (有界 256KB, smoke 是测试请求), 解析成人类可读内容
    let raw = '';
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        for (let i = 0; i < 4096; i++) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          raw += new TextDecoder().decode(value, { stream: true });
          if (raw.length > 256 * 1024) break;
        }
      } catch (e) {}
      try { await reader.cancel(); } catch (e) {}
    }
    const ct = resp.headers.get('content-type') || '';
    let content = '', error = '';
    if (ct.includes('event-stream')) {
      // SSE: 拼接 delta content
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) content += delta.content;
          if (j.error) { error = j.error.code || 'upstream_error'; }
        } catch (e) {}
      }
    } else {
      try {
        const j = JSON.parse(raw);
        if (j.error) error = (j.error.code || 'error') + ': ' + String(j.error.message || '').slice(0, 200);
        else if (j.choices && j.choices[0] && j.choices[0].message) content = j.choices[0].message.content || '';
      } catch (e) {
        if (raw.trim()) error = '非 JSON 响应: ' + raw.slice(0, 160);
      }
    }
    const result = {
      status: resp.status,
      proxy: resp.headers.get('x-gateway-proxy') || null,
      attempts: Number(resp.headers.get('x-gateway-attempts')) || 1,
      ms: nowMs() - started,
      ok: resp.status >= 200 && resp.status < 300,
      content: content.slice(0, 2000),
      error: error,
    };
    pushEvent(cfg, 'smoke', { model, status: result.status, proxy: result.proxy, ms: result.ms, ok: result.ok });
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, status: 502, error: '网关内部错误: ' + e.message, ms: nowMs() - started }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
}

// ─────────────────────────── 鉴权 ───────────────────────────

function authorized(req, cfg) {
  if (cfg.clientKeys.length === 0) return true; // REQUIRE_GATEWAY_KEY=false 显式开放
  let key = '';
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) key = m[1].trim();
  if (!key) key = (req.headers.get('x-api-key') || '').trim();
  if (!key) return false;
  req._gatewayKey = key;
  return cfg.clientKeys.includes(key);
}

// 管理 API 鉴权: ADMIN_KEY 优先, 否则复用 API_KEY
function adminAuthorized(req, cfg) {
  if (cfg.adminKeys.length === 0) return true;
  let key = '';
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) key = m[1].trim();
  if (!key) key = (req.headers.get('x-api-key') || '').trim();
  if (!key) return false;
  req._gatewayKey = key;
  return cfg.adminKeys.includes(key);
}

// ─────────────────────────── 入口 ───────────────────────────

export { GatewayControl };

export default {
  async fetch(request, env, ctx) {
    // Compatibility context: all config/control helpers can use the current
    // request env without changing every legacy helper signature.
    globalThis.__GW_ENV = env;
    const url = new URL(request.url);
    let cfg;
    try {
      cfg = parseEnv(env);
      cfg.env = env; // controls compatibility layer can detect optional binding
      cfg = await applyRuntimeConfig(cfg);
    }
    catch (e) {
      // 诊断辅助: 回显"当前运行时实际收到的环境变量名" (只列名不列值, 不含系统注入的)
      const relevant = Object.keys(env).filter(k => /^(PROXIES|GATEWAY_API_KEYS|API_KEY|ADMIN_KEY|PIN_MODE|STATE_TTL|DEPLETED_PROBE|DOWN_PROBE|PROBE_TIMEOUT|MAX_ATTEMPTS|LOG_LEVEL|REQUIRE_GATEWAY_KEY)/.test(k)).sort();
      const errBody = {
        error: { message: 'gateway config error: ' + e.message, code: 'config_error' },
        received_env_keys: relevant,
        hint: 'If you set these in the Cloudflare dashboard: runtime variables must go under Settings → Variables & Secrets (NOT Settings → Build → build variables), and you must trigger a new deploy after adding them.',
      };
      // 死锁防护: 配置异常时管理页面与"清除运行时配置"仍必须可用,
      // 否则用户无法进入后台修复 (此前坏运行时配置会让 /admin 也 500 → 页面空白)。
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        return new Response(ADMIN_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() },
        });
      }
      if (url.pathname === '/admin/api/config/reset' && request.method === 'POST') {
        try { await clearRuntimeConfig(env); } catch (e2) {}
        return new Response(JSON.stringify({ reset: true, note: '已清除运行时配置, 请重新加载页面' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify(errBody), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 网关自身端点 (公开)
    if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
      return handleGatewayHealth(cfg);
    }

    // 管理后台 (版本仅经 X-GW-Build 响应头暴露, 不在页面显示)
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-GW-Build': GW_BUILD, ...corsHeaders() },
      });
    }
    if (url.pathname.startsWith('/admin/api/')) {
      if (!adminAuthorized(request, cfg)) {
        return errorResponse(401, 'invalid_api_key', 'Invalid admin key. Send it as Authorization: Bearer <ADMIN_KEY or API_KEY>.', {});
      }
      const apiPath = url.pathname.slice('/admin/api'.length);
      switch (request.method + ' ' + apiPath) {
        case 'GET /overview': return adminOverview(cfg);
        case 'GET /config': return adminConfig(cfg);
        case 'GET /models': return handleModels(request, cfg);
        case 'POST /config': return adminSaveConfig(request, cfg);
        case 'POST /config/reset': return adminResetConfig(cfg);
        case 'POST /probe': return adminProbe(request, cfg);
        case 'POST /maintenance': return adminMaintenance(request, cfg);
        case 'POST /pin': return adminPin(request, cfg);
        case 'GET /pin': return adminPinStatus(request, cfg);
        case 'POST /smoke': return adminSmoke(request, cfg);
        default: return errorResponse(404, 'not_found', 'unknown admin api: ' + apiPath, {});
      }
    }

    // 其余全部要求网关 key
    if (!authorized(request, cfg)) {
      return errorResponse(401, 'invalid_api_key', 'Invalid gateway API key. Send it as Authorization: Bearer <API_KEY> or X-API-Key.', {});
    }

    // 请求体缓冲 (为 failover 重放; 限制 32MB, 与 proxy 一致)。
    // json/text 缓冲为可重放的 ArrayBuffer; 其余类型 (multipart/octet-stream/ndjson 等)
    // 原样透传 request.body 流 —— 之前这里留 null 会让 proxy 收到一个空 body 的 POST,
    // 客户端数据被静默丢弃 (README 声称"原样转发但无法重放"但代码根本没转发)。
    // 流不可重放: 首次尝试失败后不再 failover (与文档取舍一致)。
    let body = null;
    let bodyNoReplay = false;
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json') || ct.includes('text/')) {
        try {
          const buf = await request.arrayBuffer();
          if (buf.byteLength > 32 * 1024 * 1024) {
            return errorResponse(413, 'content_too_large', 'request body exceeds the 32MB limit', {});
          }
          body = buf.byteLength ? buf : null;
        } catch (e) {
          return errorResponse(400, 'invalid_request', 'failed to read request body: ' + e.message, {});
        }
      } else if (request.body) {
        // 流式 body 无法预读判大小: 有 content-length 时做廉价预检 (拒绝明显超限),
        // 与 json/text 缓冲路径的 32MB 限制一致; 无长度 (chunked) 时只能依赖边缘/上游限制
        // —— 为了判大小而缓冲会破坏"原样透传"语义 (权衡已写入 README)。
        const cl = Number(request.headers.get('content-length'));
        if (Number.isFinite(cl) && cl > 32 * 1024 * 1024) {
          return errorResponse(413, 'content_too_large', 'request body exceeds the 32MB limit', {});
        }
        body = request.body;   // 原样透传 (只尝试一次, 不重放)
        bodyNoReplay = true;
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return handleModels(request, cfg);
    }

    return routeRequest(request, cfg, body, {
      noReplay: bodyNoReplay,
      waitUntil: ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null,
    });
  },
};
