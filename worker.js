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

// ─────────────────────────── 配置解析 ───────────────────────────

const DEFAULTS = {
  PIN_MODE: 'client',            // client | header | off
  PIN_TTL_SECONDS: 3600,         // 钉住有效期 (成功请求后刷新)
  STATE_TTL_SECONDS: 60,         // ok 状态 /healthz 刷新间隔 (cache TTL 下限 60s)
  DEPLETED_PROBE_SECONDS: 300,   // depleted 探测最大退避
  DOWN_PROBE_SECONDS: 120,       // down 探测基础退避
  PROBE_TIMEOUT_MS: 3000,        // healthz 探测超时
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
  cfg.adminKeys = splitList(env.ADMIN_KEY).length ? splitList(env.ADMIN_KEY) : clientKeys;

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
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // unix s or ms
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function nowMs() { return Date.now(); }

const CACHE_ORIGIN = 'https://cf-quota-gateway.invalid';
// 状态 key 掺入 url 哈希: 同名不同 URL 的 proxy 状态互不串扰 (重配 url 后旧状态作废)
function stateKey(name, url) { return CACHE_ORIGIN + '/state/' + encodeURIComponent(name) + '/' + hashKey(url); }
function pinKey(sticky) { return CACHE_ORIGIN + '/pin/' + hashKey(sticky); }

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
  } else if (h.usagePct >= 100) {
    st.status = 'depleted';
    st.reason = 'daily_cap';
    st.detail = 'daily message cap reached (usagePct=' + h.usagePct + ')';
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
    } else {
      st.status = 'ok';
      st.reason = '';
      st.detail = 'ok (usagePct=' + h.usagePct + ')';
    }
  }
  st.nextProbe = 0; // 探测后由调度者重新安排
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
    delete st._prev;
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
        ? Math.max(10 * 1000, resetSoon - now)
        : (st.backoff || cfg.depletedProbe) * 1000;
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
    const r = await caches.default.get(pinKey(sticky));
    if (!r) return null;
    const j = await r.json();
    return j && j.proxy ? j.proxy : null;
  } catch (e) { return null; }
}

async function setPin(sticky, proxyName, cfg) {
  try {
    const resp = new Response(JSON.stringify({ proxy: proxyName, at: nowMs() }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await caches.default.put(pinKey(sticky), resp, { ttl: cfg.pinTtl });
  } catch (e) { log(cfg, 'debug', 'pin put failed', { err: String(e) }); }
}

// ─────────────────────────── 选路 ───────────────────────────

// 候选排序: 全部尝试顺序 (首个尝试尽量是钉住/最优, 后续为 failover 候选)
async function buildCandidates(cfg, model, sticky) {
  const states = await Promise.all(cfg.proxies.map(p => ensureFresh(p, cfg, { model })));
  // 维护模式: 排除维护中的 proxy (视作不可用)。用 index 关联, 不在状态对象上打标记
  const maint = await Promise.all(cfg.proxies.map(p => isMaintenance(p.name, p.url)));
  const usable = (s, i) => !maint[i];
  const ok = states.filter((s, i) => usable(s, i) && s.status === 'ok');
  const unknown = states.filter((s, i) => usable(s, i) && s.status === 'unknown');
  const depleted = states.filter((s, i) => usable(s, i) && s.status === 'depleted');
  const down = states.filter((s, i) => usable(s, i) && (s.status === 'down' || s.status === 'bad_config'));

  let order = [];
  // 1) 钉住
  if (sticky) {
    const pinned = await getPin(sticky, cfg);
    if (pinned) {
      const idx = states.findIndex(s => s.name === pinned);
      const st = idx >= 0 ? states[idx] : null;
      if (st && usable(st, idx) && (st.status === 'ok' || st.status === 'unknown')) order.push(st);
      else if (st) log(cfg, 'debug', 'pin stale, dropping', { pin: pinned, status: st.status, maint: maint[idx] });
    }
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
  let retryAfterS = headerRetryAfter ? parseInt(headerRetryAfter, 10) : 0;
  let reset = 0;
  if (text) {
    // proxy 的 RateLimitError message: "reset at 2026-08-18T07:00:00Z" / "retry after 30s"
    // (RFC3339 可能带毫秒: 2026-08-18T07:00:00.123Z)
    const mReset = text.match(/reset at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+(?:\.\d+)?(?:Z|[+-][0-9:]+))/i);
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
  st.updatedAt = now; // 带内失败 = 新鲜的状态信号
  switch (kind) {
    case 'quota':
      st.status = 'depleted';
      st.reason = extra.code === 'out_of_credits' ? 'out_of_credits' : 'rate_limited';
      st.retryAfter = extra.retryAfterS || 0;
      if (extra.reset) st.resetAt = extra.reset;
      st.detail = extra.code + ' from proxy (retryAfter=' + (extra.retryAfterS || '?') + 's)';
      // 恢复探测: resetAt+10s (若已知), 否则退避
      if (extra.reset) {
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
  if (body !== null) init.body = body;
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key, X-Sticky-Id',
    'Access-Control-Expose-Headers': 'X-Gateway-Proxy, Retry-After',
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
    return { passthrough: true, resp: s.resp, text: s.text };
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

async function routeRequest(req, cfg, body) {
  const url = new URL(req.url);
  const model = extractModel(req, body);
  const sticky = stickyKeyFor(req, cfg);
  const isChat = req.method === 'POST' && (url.pathname === '/v1/chat/completions');

  const { order, states } = await buildCandidates(cfg, model, sticky);
  if (order.length === 0) {
    return errorResponse(502, 'upstream_unavailable', 'no proxies configured', {});
  }

  const attempts = [];
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  const max = Math.min(cfg.maxAttempts, order.length);
  for (let i = 0; i < max; i++) {
    const st = order[i];
    // 转发一律用配置里的 url/apiKey (st.url 只是展示信息, 避免跨实例串状态)
    const pc = cfg.proxies.find(p => p.name === st.name);
    if (!pc) continue;
    const target = pc.url + url.pathname + url.search;
    const started = nowMs();
    let resp;
    try {
      resp = await forward(req, target, pc, cfg, body, ac.signal);
    } catch (e) {
      // 网络层错误
      await recordFailure(st, 'down', cfg, { status: 0, text: String(e.message || e) });
      attempts.push({ name: st.name, kind: 'down', text: String(e.message || e) });
      log(cfg, 'warn', 'upstream fetch failed', { name: st.name, err: String(e.message || e) });
      if (ac.signal.aborted) return errorResponse(499, 'client_closed', 'client disconnected', {});
      continue;
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
      if (sticky) await setPin(sticky, st.name, cfg);
      attempts.push(cl);
      log(cfg, 'debug', 'relayed', { name: st.name, status: cl.resp.status, ms: cl.ms, sticky: !!sticky });

      // 2xx: 直通响应 (流式/JSON 都原样透传 body)
      const h = passthroughHeaders(cl.resp, st.name);
      for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
      h.set('x-gateway-attempts', String(attempts.length));
      if (isChat && sticky) h.set('x-gateway-pin', st.name);
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
  if (agg.passthrough) {
    const h = passthroughHeaders(agg.resp, attempts[0].name);
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
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + p.apiKey },
    });
    if (res.status !== 200) throw new Error(p.name + ': /v1/models HTTP ' + res.status);
    const j = await res.json();
    return { name: p.name, ok: st.status === 'ok', data: Array.isArray(j.data) ? j.data : [] };
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

// ─────────────────────────── 事件日志 ───────────────────────────

const EVENTS_KEY = CACHE_ORIGIN + '/events';
const MAX_EVENTS = 200;
const EVENT_L1 = []; // isolate 内聚合, 攒够批量 flush

// 记录一条管理/运行事件 (尽力而为: L1 聚合 + cache 环形缓冲, 跨 isolate 最后写者胜)
function pushEvent(cfg, type, detail) {
  EVENT_L1.push({ t: nowMs(), type, ...detail });
  if (EVENT_L1.length >= 10) {
    // 不阻塞主流程
    flushEvents(cfg).catch(() => {});
  }
}

async function flushEvents(cfg) {
  if (EVENT_L1.length === 0) return;
  const batch = EVENT_L1.splice(0);
  try {
    let list = [];
    const r = await caches.default.get(EVENTS_KEY);
    if (r) { const j = await r.json(); if (Array.isArray(j)) list = j; }
    list = [...list, ...batch];
    if (list.length > MAX_EVENTS) list = list.slice(list.length - MAX_EVENTS);
    await caches.default.put(EVENTS_KEY, new Response(JSON.stringify(list), {
      headers: { 'Content-Type': 'application/json' },
    }), { ttl: 86400 });
  } catch (e) { /* 尽力而为 */ }
}

async function readEvents() {
  try {
    await flushEvents({}); // 先把 L1 累积写进去
    const r = await caches.default.get(EVENTS_KEY);
    if (!r) return [];
    const j = await r.json();
    return Array.isArray(j) ? j.slice(-MAX_EVENTS) : [];
  } catch (e) { return []; }
}

// ─────────────────────────── 维护模式 ───────────────────────────

function maintKey(name, url) { return CACHE_ORIGIN + '/maint/' + encodeURIComponent(name) + '/' + hashKey(url); }

async function isMaintenance(name, url) {
  try {
    const r = await caches.default.get(maintKey(name, url));
    if (!r) return false;
    const j = await r.json();
    return !!(j && j.on);
  } catch (e) { return false; }
}

async function setMaintenance(name, url, on) {
  try {
    if (on) {
      await caches.default.put(maintKey(name, url), new Response(JSON.stringify({ on: true, at: nowMs() }), {
        headers: { 'Content-Type': 'application/json' },
      }), { ttl: 86400 });
    } else {
      await caches.default.delete(maintKey(name, url));
    }
  } catch (e) { /* 尽力而为 */ }
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
  const maint = await Promise.all(cfg.proxies.map(p => isMaintenance(p.name, p.url)));
  const proxies = states.map((st, i) => ({
    name: st.name,
    url: st.url,
    status: maint[i] ? 'maint' : st.status,
    maint: !!maint[i],
    reason: st.reason || '',
    detail: st.detail || '',
    score: st.score,
    usage_pct: st.usagePct,
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
  }));
  const stats = {
    total: proxies.length,
    ok: proxies.filter(p => !p.maint && p.status === 'ok').length,
    depleted: proxies.filter(p => !p.maint && p.status === 'depleted').length,
    down: proxies.filter(p => !p.maint && (p.status === 'down' || p.status === 'bad_config')).length,
    requestsOk: proxies.reduce((a, p) => a + p.requestsOk, 0),
    requestsFail: proxies.reduce((a, p) => a + p.requestsFail, 0),
  };
  const events = await readEvents();
  return new Response(JSON.stringify({ status: 'ok', stats, proxies, events, timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function adminConfig(cfg) {
  return new Response(JSON.stringify({
    config: {
      proxies: cfg.proxies.map(p => p.name + ' @ ' + p.url),
      pin_mode: cfg.pinMode,
      pin_ttl: cfg.pinTtl,
      state_ttl: cfg.stateTtl,
      depleted_probe: cfg.depletedProbe,
      down_probe: cfg.downProbe,
      probe_timeout: cfg.probeTimeout,
      max_attempts: cfg.maxAttempts,
      admin_key_masked: maskKey(cfg.adminKeys[0]),
      api_key_masked: cfg.clientKeys.map(maskKey).join(', '),
      proxy_keys_masked: cfg.proxies.map(p => maskKey(p.apiKey)).join(', '),
    },
  }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
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
  await setMaintenance(p.name, p.url, on);
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
  const sticky = (cfg.pinMode === 'header' ? 'h:' : 'c:') + key;
  try {
    await caches.default.delete(pinKey(sticky));
  } catch (e) {}
  pushEvent(cfg, 'admin_action', { action: 'clear_pin', key });
  return new Response(JSON.stringify({ cleared: true, key }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// smoke test: 走完整路由链路发一条真实请求
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
  const started = nowMs();
  try {
    const resp = await routeRequest(inner, cfg, new TextEncoder().encode(chatBody));
    let preview = '';
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        for (let i = 0; i < 6; i++) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          preview += new TextDecoder().decode(value, { stream: true });
          if (preview.length > 2048) break;
        }
      } catch (e) { preview += '\n[read interrupted: ' + e.message + ']'; }
      try { await reader.cancel(); } catch (e) {}
    }
    const result = {
      status: resp.status,
      proxy: resp.headers.get('x-gateway-proxy') || null,
      attempts: Number(resp.headers.get('x-gateway-attempts')) || 1,
      ms: nowMs() - started,
      preview: preview.slice(0, 2048),
    };
    pushEvent(cfg, 'smoke', { model, status: result.status, proxy: result.proxy, ms: result.ms });
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, status: 502, ms: nowMs() - started }), {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let cfg;
    try { cfg = parseEnv(env); }
    catch (e) {
      // 诊断辅助: 回显"当前运行时实际收到的环境变量名" (只列名不列值, 不含系统注入的), 
      // 方便定位"配置了但没生效"的问题 (常见于把变量配到了 Build settings 而非
      // Settings → Variables & Secrets, 或添加后未触发重新部署)。
      const relevant = Object.keys(env).filter(k => /^(PROXIES|GATEWAY_API_KEYS|API_KEY|ADMIN_KEY|PIN_MODE|STATE_TTL|DEPLETED_PROBE|DOWN_PROBE|PROBE_TIMEOUT|MAX_ATTEMPTS|LOG_LEVEL|REQUIRE_GATEWAY_KEY)/.test(k)).sort();
      return new Response(JSON.stringify({
        error: { message: 'gateway config error: ' + e.message, code: 'config_error' },
        received_env_keys: relevant,
        hint: 'If you set these in the Cloudflare dashboard: runtime variables must go under Settings → Variables & Secrets (NOT Settings → Build → build variables), and you must trigger a new deploy after adding them.',
      }), {
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

    // 管理后台
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
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
        case 'POST /probe': return adminProbe(request, cfg);
        case 'POST /maintenance': return adminMaintenance(request, cfg);
        case 'POST /pin': return adminPin(request, cfg);
        case 'POST /smoke': return adminSmoke(request, cfg);
        default: return errorResponse(404, 'not_found', 'unknown admin api: ' + apiPath, {});
      }
    }

    // 其余全部要求网关 key
    if (!authorized(request, cfg)) {
      return errorResponse(401, 'invalid_api_key', 'Invalid gateway API key. Send it as Authorization: Bearer <API_KEY> or X-API-Key.', {});
    }

    // 请求体缓冲 (为 failover 重放; 限制 32MB, 与 proxy 一致)
    let body = null;
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
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return handleModels(request, cfg);
    }

    return routeRequest(request, cfg, body);
  },
};
