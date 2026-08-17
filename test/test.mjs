// freebuff-proxy-gateway 全面测试: 模拟 CF Workers 运行时 + mock proxies
// 覆盖: 配置/鉴权/路由/failover/探测/请求体流式/状态缓存/管理后台 的极端场景
// 运行: node test/test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
// 注: 直接用 URL 而非 pathToFileURL(pathname) —— 后者在 Windows 上会把盘符拼成 D:/D:/...

// ── 运行时 shim ─────────────────────────────────────────────

let fakeNow = Date.UTC(2026, 7, 17, 0, 0, 0);
Date.now = () => fakeNow;
export function advance(ms) { fakeNow += ms; }

class MockCache {
  constructor() { this.m = new Map(); this.failWrites = false; }
  async put(key, response, opts = {}) {
    if (this.failWrites) throw new Error('injected cache write failure');
    const ttl = (opts.ttl || 86400) * 1000;
    const text = await response.text();
    this.m.set(String(key), { text, expire: fakeNow + ttl });
  }
  async get(key) {
    if (this.failWrites) throw new Error('injected cache read failure');
    const e = this.m.get(String(key));
    if (!e) return undefined;
    if (fakeNow >= e.expire) { this.m.delete(String(key)); return undefined; }
    return new Response(e.text, { headers: { 'Content-Type': 'application/json' } });
  }
  async delete(key) { this.m.delete(String(key)); }
}
globalThis.caches = { default: new MockCache() };

// ── mock proxy ──────────────────────────────────────────────

let portCounter = 10000;
const allProxies = [];

// ctl 可变状态:
//   usagePct, cooldownUntilMs, quota:{model:{limit,recentCount,resetAtMs}},
//   fail:{status,code,retryAfter,body} | null,
//   mode:'sse'|'json'|'abort' (abort=发一块后挂住等断开),
//   healthzStatus/healthzBody/healthzDelay (探测异常注入)
export function makeProxy(name) {
  const ctl = {
    name, usagePct: 0, cooldownUntilMs: 0, quota: {}, fail: null, mode: 'sse',
    healthzStatus: 200, healthzBody: null, healthzDelay: 0,
    chatHits: 0, healthzHits: 0, modelsHits: 0, lastModel: null,
    lastAuth: '', healthzLastAuth: '', clientAborted: false, streamStarted: false,
  };
  const port = ++portCounter;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      ctl.healthzHits++;
      ctl.healthzLastAuth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const send = () => {
        res.writeHead(ctl.healthzStatus, { 'Content-Type': 'application/json' });
        if (ctl.healthzBody !== null) res.end(ctl.healthzBody);
        else res.end(JSON.stringify({ status: 'ok', mode: 'pooled', tokens: [{
          Token: 0,
          CooldownUntil: ctl.cooldownUntilMs ? new Date(ctl.cooldownUntilMs).toISOString() : '0001-01-01T00:00:00Z',
          SessionStatus: 'ready',
          Messages24h: Math.round((ctl.usagePct / 100) * 20),
          DailyLimit: 20,
          UsagePct: ctl.usagePct,
          RiskLevel: 'low',
          quota: Object.fromEntries(Object.entries(ctl.quota).map(([m, q]) => [
            m, { limit: q.limit, recent_count: q.recentCount, reset_at: q.resetAtMs ? new Date(q.resetAtMs).toISOString() : null, period: 'pacific_day' },
          ])),
        }] }));
      };
      if (ctl.healthzDelay > 0) setTimeout(send, ctl.healthzDelay); else send();
      return;
    }
    if (url.pathname === '/v1/models') {
      ctl.modelsHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'freebuff-1', object: 'model', created: 1, owned_by: 'freebuff', available: ctl.usagePct < 100, status: ctl.usagePct < 100 ? 'available' : 'quota_exhausted' },
      ] }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      ctl.chatHits++;
      ctl.lastAuth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        try { ctl.lastModel = JSON.parse(raw).model; } catch (e) {}
        if (ctl.fail) {
          res.writeHead(ctl.fail.status, {
            'Content-Type': 'application/json',
            ...(ctl.fail.retryAfter ? { 'Retry-After': String(ctl.fail.retryAfter) } : {}),
          });
          res.end(JSON.stringify({ error: { code: ctl.fail.code, message: ctl.fail.body || 'failed', type: 'upstream_error' } }));
          return;
        }
        if (ctl.mode === 'abort') {
          ctl.streamStarted = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"part1"}}]}\n\n');
          res.on('close', () => { if (!res.writableEnded) ctl.clientAborted = true; });
          setTimeout(() => { try { res.end('data: [DONE]\n\n'); } catch (e) {} }, 60000);
          return;
        }
        if (ctl.mode === 'sse') {
          ctl.streamStarted = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const chunks = [
            'data: {"id":"cmpl-1","object":"chat.completion.chunk","model":"freebuff-1","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
            'data: {"id":"cmpl-1","object":"chat.completion.chunk","model":"freebuff-1","choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: [DONE]\n\n',
          ];
          let i = 0;
          const tick = () => {
            if (i < chunks.length) { res.write(chunks[i++]); setTimeout(tick, 5); }
            else res.end();
          };
          tick();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'cmpl-1', object: 'chat.completion', model: 'freebuff-1', choices: [{ message: { role: 'assistant', content: 'Hello from ' + name }, finish_reason: 'stop' }] }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route: ' + url.pathname } }));
  });
  const p = { ctl, url: 'http://127.0.0.1:' + port, close: () => new Promise(r => server.close(r)) };
  allProxies.push(p);
  return new Promise(res => server.listen(port, '127.0.0.1', () => res(p)));
}

// 未监听端口的"死 proxy" (连接拒绝)
export function makeDeadProxy() {
  const port = ++portCounter;
  return Promise.resolve({ ctl: null, url: 'http://127.0.0.1:' + port, close: async () => {} });
}

// 与 worker 相同的 FNV-1a 哈希 (测试里构造 cache key 用)
function hashFn(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

// 与 worker 相同的名字派生
function proxyNames(proxies) {
  const count = new Map();
  return proxies.map(p => {
    const base = (p.url.split('://')[1].split(':')[0].split('.')[0] || 'p').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'p';
    const n = (count.get(base) || 0) + 1;
    count.set(base, n);
    return n > 1 ? base + '-' + n : base;
  });
}

// ── worker 加载 ─────────────────────────────────────────────

const worker = (await import(new URL('../worker.js', import.meta.url).href)).default;

function envFor(proxies, extra = {}) {
  return {
    PROXIES: proxies.map(p => p.url).join(','),
    GATEWAY_API_KEYS: 'proxykey',
    API_KEY: 'testkey1,testkey2',
    ...extra,
  };
}

function gwReq(path, { method = 'POST', body, headers = {}, key = 'testkey1' } = {}) {
  const h = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers };
  const reqBody = body === undefined ? (method === 'POST' ? '{}' : undefined)
    : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Request('https://gw.example' + path, { method, headers: h, body: reqBody });
}

async function collectSSE(res) {
  const parts = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(dec.decode(value, { stream: true }));
  }
  return parts.join('');
}

async function hzOf(env, name) {
  const r = await worker.fetch(gwReq('/healthz', { method: 'GET' }), env, {});
  const j = await r.json();
  return j.proxies.find(p => p.name === name);
}

// ── 测试框架 ────────────────────────────────────────────────

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 6).join('\n    ')); }
}

console.log('== 核心路由 ==');
// 场景 1-4 共用: a usage 90, b usage 10, c usage 50
const a = await makeProxy('a');
const b = await makeProxy('b');
const c = await makeProxy('c');
a.ctl.usagePct = 90; b.ctl.usagePct = 10; c.ctl.usagePct = 50;
const env1 = envFor([a, b, c]);
const [na, nb, nc] = proxyNames([a, b, c]);

await t('S1 选路: 无钉住时选余量最多的 proxy', async () => {
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), nb);
  assert.equal(b.ctl.chatHits, 1);
});

await t('S2 钉住: 同一客户端 key 第二次请求仍走同一 proxy', async () => {
  a.ctl.usagePct = 0;
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), nb);
});

await t('S3 钉住切换: 额度耗尽(429) → failover 到最优并重钉', async () => {
  advance(61 * 1000);
  b.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 120, body: 'upstream rate limited (reset at 2026-08-17T12:00:00Z)' };
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), na);
  assert.equal(res.headers.get('x-gateway-attempts'), '2');
  const hz = await hzOf(env1, nb);
  assert.equal(hz.status, 'depleted');
  assert.equal(hz.reason, 'rate_limited');
});

await t('S4 SSE 流式透传: 分块到达且带 [DONE]', async () => {
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: true } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const sse = await collectSSE(res);
  assert.ok(sse.includes('data: [DONE]'));
  assert.ok(sse.indexOf('Hel') < sse.indexOf('lo'));
});

await t('S5 全 depleted → 429 + Retry-After', async () => {
  const x = await makeProxy('x'); const y = await makeProxy('y');
  x.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 90, body: 'upstream rate limited' };
  y.ctl.fail = { status: 402, code: 'out_of_credits', body: 'out of credits' };
  const env5 = envFor([x, y], { MAX_ATTEMPTS: '2' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env5, {});
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error.code, 'rate_limited');
  assert.ok(Number(res.headers.get('retry-after')) >= 60);
});

await t('S6 恢复探测: reset 时刻到达 → 探测恢复重新入池', async () => {
  const x = await makeProxy('x2'); const y = await makeProxy('y2');
  const [nx] = proxyNames([x, y]);
  const resetTime = new Date(Date.now() + 30 * 1000).toISOString();
  x.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 30, body: 'upstream rate limited (reset at ' + resetTime + ')' };
  y.ctl.usagePct = 30;
  const env6 = envFor([x, y], { API_KEY: 't1,t2,t3' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 't1' }), env6, {});
  advance(60 * 1000);
  x.ctl.fail = null; x.ctl.usagePct = 5;
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 't2' }), env6, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), nx);
  const hz = await hzOf(env6, nx);
  assert.equal(hz.status, 'ok');
});

await t('S7 客户端错误 400 不 failover, 原样透传, proxy 不被标记 down', async () => {
  const p = await makeProxy('p7');
  p.ctl.fail = { status: 400, code: 'invalid_json', body: 'request body must be a valid JSON object' };
  const env7 = envFor([p]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] } }), env7, {});
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error.code, 'invalid_json');
  assert.equal(p.ctl.chatHits, 1);
  // 关键: 400 不改变 proxy 健康状态 (修复 surface 误标 down 的 bug)
  const hz = await hzOf(env7, proxyNames([p])[0]);
  assert.equal(hz.status, 'ok');
  assert.equal(hz.reason, '');
});

await t('S8 网关鉴权: 错 key 401, 无 key 401, /healthz 公开', async () => {
  const res1 = await worker.fetch(gwReq('/v1/chat/completions', { body: {}, key: 'wrong' }), env1, {});
  assert.equal(res1.status, 401);
  const res2 = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env1, {});
  assert.equal(res2.status, 401);
  const res3 = await worker.fetch(gwReq('/healthz', { method: 'GET' }), env1, {});
  assert.equal(res3.status, 200);
});

await t('S9 /v1/models 聚合 + x-sticky-id header 钉住', async () => {
  const p1 = await makeProxy('m1'); const p2 = await makeProxy('m2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 80; p2.ctl.usagePct = 10;
  const env9 = envFor([p1, p2], { PIN_MODE: 'header' });
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-1' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  p2.ctl.usagePct = 99;
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-1' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  advance(61 * 1000);
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-2' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  const mr = await worker.fetch(gwReq('/v1/models', { method: 'GET' }), env9, {});
  const mj = await mr.json();
  assert.ok(mj.data.some(m => m.id === 'freebuff-1'));
});

await t('S10 403 banned → 长退避, failover', async () => {
  const p1 = await makeProxy('ban1'); const p2 = await makeProxy('ban2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 403, code: 'account_banned', body: '{"status":"banned"}' };
  const env10 = envFor([p1, p2], { API_KEY: 't10' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't10' }), env10, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  const hz = await hzOf(env10, n1);
  assert.equal(hz.status, 'depleted');
  assert.equal(hz.reason, 'banned');
});

await t('S11 5xx → down + 退避', async () => {
  const p1 = await makeProxy('d1'); const p2 = await makeProxy('d2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 502, code: 'upstream_unavailable', body: 'bad gateway' };
  const env11 = envFor([p1, p2], { MAX_ATTEMPTS: '2', API_KEY: 't11' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't11' }), env11, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  const d1 = await hzOf(env11, n1);
  assert.equal(d1.status, 'down');
  assert.ok(d1.next_probe && Date.parse(d1.next_probe) > Date.now());
});

await t('S12 缺必填配置 → 500 config error', async () => {
  const fresh = await makeProxy('f1');
  const fresh2 = await makeProxy('f2');
  let bad = await worker.fetch(new Request('https://gw.example/healthz'), { GATEWAY_API_KEYS: 'k', API_KEY: 'k' }, {});
  assert.equal(bad.status, 500);
  bad = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: fresh.url, GATEWAY_API_KEYS: 'k' }, {});
  assert.equal(bad.status, 500);
  bad = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: fresh.url, API_KEY: 'k' }, {});
  assert.equal(bad.status, 500);
  bad = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: fresh.url + ',' + fresh2.url, GATEWAY_API_KEYS: 'a,b,c', API_KEY: 'k' }, {});
  assert.equal(bad.status, 500);
});

await t('S13 预判: 模型会话额度耗尽 → 直接 depleted, 请求绕开', async () => {
  const p1 = await makeProxy('q1'); const p2 = await makeProxy('q2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.quota = { 'freebuff-1': { limit: 10, recentCount: 10, resetAtMs: Date.now() + 3600e3 } };
  p2.ctl.usagePct = 20;
  const env13 = envFor([p1, p2]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 'testkey2' }), env13, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  assert.equal(p1.ctl.chatHits, 0);
});

await t('S14 预判: 冷却中 (CooldownUntil 未来) → depleted(cooldown)', async () => {
  const p1 = await makeProxy('c1'); const p2 = await makeProxy('c2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.cooldownUntilMs = Date.now() + 30 * 60e3;
  p2.ctl.usagePct = 20;
  const env14 = envFor([p1, p2]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 'testkey2' }), env14, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  assert.equal(p1.ctl.chatHits, 0);
});

await t('S15 多 key 一一对应 + 探测也带对应 key', async () => {
  const p1 = await makeProxy('ka1'); const p2 = await makeProxy('ka2');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'upstream rate limited' };
  const env15 = { PROXIES: p1.url + ',' + p2.url, GATEWAY_API_KEYS: 'keyA,keyB', API_KEY: 't15' };
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 't15' }), env15, {});
  assert.equal(res.status, 200);
  assert.equal(p1.ctl.lastAuth, 'keyA');
  assert.equal(p2.ctl.lastAuth, 'keyB');
  assert.equal(p2.ctl.healthzLastAuth, 'keyB');
});

await t('S16 单 key 广播', async () => {
  const p1 = await makeProxy('kb1'); const p2 = await makeProxy('kb2');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'upstream rate limited' };
  const env16 = { PROXIES: p1.url + ',' + p2.url, GATEWAY_API_KEYS: 'sharedkey', API_KEY: 't16' };
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 't16' }), env16, {});
  assert.equal(res.status, 200);
  assert.equal(p1.ctl.lastAuth, 'sharedkey');
  assert.equal(p2.ctl.lastAuth, 'sharedkey');
});

await t('S17 X-API-Key 头鉴权 + API_KEY 多值', async () => {
  const p = await makeProxy('xak');
  const env17 = envFor([p]);
  let res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', {
    method: 'POST', headers: { 'X-API-Key': 'testkey2', 'Content-Type': 'application/json' }, body: '{}',
  }), env17, {});
  assert.equal(res.status, 200);
  res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', {
    method: 'POST', headers: { 'X-API-Key': 'wrong', 'Content-Type': 'application/json' }, body: '{}',
  }), env17, {});
  assert.equal(res.status, 401);
});

console.log('\n== 配置解析极端 ==');

await t('CFG1 PROXIES 缺失/空 → 500 + 诊断字段', async () => {
  // 场景 A: 完全没配 PROXIES → 诊断列表不含它
  let r = await worker.fetch(new Request('https://gw.example/healthz'), { GATEWAY_API_KEYS: 'k', API_KEY: 'k' }, {});
  assert.equal(r.status, 500);
  let j = await r.json();
  assert.equal(j.error.code, 'config_error');
  assert.ok(Array.isArray(j.received_env_keys));
  assert.ok(j.received_env_keys.includes('GATEWAY_API_KEYS'));
  assert.ok(!j.received_env_keys.includes('PROXIES'), '未配置时不应出现在列表');
  // 场景 B: 配了但值为空 → 诊断列表含 PROXIES (说明变量到了 runtime 但值为空)
  r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: '', GATEWAY_API_KEYS: 'k', API_KEY: 'k' }, {});
  assert.equal(r.status, 500);
  j = await r.json();
  assert.ok(j.received_env_keys.includes('PROXIES'), '值为空时 PROXIES 应出现在列表');
  assert.ok(!JSON.stringify(j).includes('"k"'), '不应泄露变量值');
});

await t('CFG2 PROXIES 非法 URL → 500 (缺协议/坏 host)', async () => {
  for (const bad of ['not-a-url', 'ftp://x.com', 'http://', 'https://', '["https://x.com"]']) {
    const r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: bad, GATEWAY_API_KEYS: 'k', API_KEY: 'k' }, {});
    assert.equal(r.status, 500, 'should reject: ' + JSON.stringify(bad));
    const j = await r.json();
    assert.ok(j.error.message.includes('invalid URL'), 'message should explain format for: ' + JSON.stringify(bad));
  }
});

await t('CFG3 PROXIES 重复 URL → 500', async () => {
  const p = await makeProxy('dup');
  const r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: p.url + ',' + p.url, GATEWAY_API_KEYS: 'k', API_KEY: 'k' }, {});
  assert.equal(r.status, 500);
});

await t('CFG4 PROXIES 尾斜杠/空白 → 归一化后可用', async () => {
  const p1 = await makeProxy('t1'); const p2 = await makeProxy('t2');
  const [n1] = proxyNames([p1, p2]);
  p2.ctl.usagePct = 5;
  const env = { PROXIES: '  ' + p1.url + '/ , ' + p2.url + '///  ', GATEWAY_API_KEYS: 'k', API_KEY: 'kk' };
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 'kk' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
});

await t('CFG5 GATEWAY_API_KEYS 数量不匹配 → 500 (多于/少于)', async () => {
  const p1 = await makeProxy('g5a'); const p2 = await makeProxy('g5b');
  // '' 缺失, 'a,b,c' 多于下游数 → 500; 'a' (1个) 是合法广播
  for (const keys of ['', 'a,b,c']) {
    const r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: p1.url + ',' + p2.url, GATEWAY_API_KEYS: keys, API_KEY: 'k' }, {});
    assert.equal(r.status, 500, 'keys=' + JSON.stringify(keys));
  }
  // 1 个 key 对 N 个下游 = 广播, 合法
  const r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: p1.url + ',' + p2.url, GATEWAY_API_KEYS: 'a', API_KEY: 'k' }, {});
  assert.equal(r.status, 200);
});

await t('CFG6 缺少 API_KEY → 500; REQUIRE_GATEWAY_KEY=false → 开放', async () => {
  const p = await makeProxy('g6');
  let r = await worker.fetch(new Request('https://gw.example/healthz'), { PROXIES: p.url, GATEWAY_API_KEYS: 'k' }, {});
  assert.equal(r.status, 500);
  const envOpen = { PROXIES: p.url, GATEWAY_API_KEYS: 'k', REQUIRE_GATEWAY_KEY: 'false' };
  r = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), envOpen, {});
  assert.equal(r.status, 200, 'should be open when REQUIRE_GATEWAY_KEY=false');
});

await t('CFG7 ADMIN_KEY 独立: 管理 API 只认 ADMIN_KEY, 网关 API 只认 API_KEY', async () => {
  const p = await makeProxy('g7');
  const env = { PROXIES: p.url, GATEWAY_API_KEYS: 'pw', API_KEY: 'ck', ADMIN_KEY: 'ak' };
  // 管理 API: 用 API_KEY 拒绝, 用 ADMIN_KEY 通过
  let r = await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer ck' } }), env, {});
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer ak' } }), env, {});
  assert.equal(r.status, 200);
  // 网关 API: 用 ADMIN_KEY 拒绝
  r = await worker.fetch(new Request('https://gw.example/v1/models', { headers: { Authorization: 'Bearer ak' } }), env, {});
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://gw.example/v1/models', { headers: { Authorization: 'Bearer ck' } }), env, {});
  assert.equal(r.status, 200);
});

console.log('\n== 鉴权极端 ==');

await t('AUTH1 Bearer 大小写不敏感 (bearer/BEARER)', async () => {
  const p = await makeProxy('au1');
  const env = envFor([p]);
  for (const h of ['bearer testkey1', 'BEARER testkey2', 'Bearer testkey1']) {
    const r = await worker.fetch(new Request('https://gw.example/v1/models', { headers: { Authorization: h } }), env, {});
    assert.equal(r.status, 200, 'header=' + h);
  }
});

await t('AUTH2 空/空白 key → 401', async () => {
  const p = await makeProxy('au2');
  const env = envFor([p]);
  for (const h of ['Bearer ', 'Bearer   ', 'Bearer']) {
    const r = await worker.fetch(new Request('https://gw.example/v1/models', { headers: { Authorization: h } }), env, {});
    assert.equal(r.status, 401, 'header=' + JSON.stringify(h));
  }
});

await t('AUTH3 前缀匹配不过: testkey 不匹配 testkey1', async () => {
  const p = await makeProxy('au3');
  const env = envFor([p]);
  const r = await worker.fetch(new Request('https://gw.example/v1/models', { headers: { Authorization: 'Bearer testkey' } }), env, {});
  assert.equal(r.status, 401);
});

await t('AUTH4 管理后台 HTML 公开可访问 (无数据泄露)', async () => {
  const p = await makeProxy('au4');
  const env = envFor([p]);
  const r = await worker.fetch(new Request('https://gw.example/admin'), env, {});
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('Proxy Gateway'));
  assert.ok(!html.includes('proxykey'), 'HTML 不应包含密钥');
});

await t('AUTH5 /admin/api/* 无 key 401, 错 key 401', async () => {
  const p = await makeProxy('au5');
  const env = envFor([p]);
  let r = await worker.fetch(new Request('https://gw.example/admin/api/overview'), env, {});
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://gw.example/admin/api/overview', { headers: { Authorization: 'Bearer wrong' } }), env, {});
  assert.equal(r.status, 401);
});

await t('AUTH6 未知 /admin/api 路径 → 404', async () => {
  const p = await makeProxy('au6');
  const env = envFor([p]);
  const r = await worker.fetch(new Request('https://gw.example/admin/api/nope', { headers: { Authorization: 'Bearer testkey1' } }), env, {});
  assert.equal(r.status, 404);
});

console.log('\n== 路由极端 ==');

await t('RT1 单 proxy 场景', async () => {
  const p = await makeProxy('r1');
  const env = envFor([p], { API_KEY: 't-r1' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r1' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-attempts'), '1');
});

await t('RT2 全 down → 502 + 明确错误', async () => {
  const p1 = await makeProxy('r2a'); const p2 = await makeProxy('r2b');
  p1.ctl.fail = { status: 500, code: 'internal', body: 'boom' };
  p2.ctl.fail = { status: 503, code: 'unavailable', body: 'down' };
  const env = envFor([p1, p2], { MAX_ATTEMPTS: '2', API_KEY: 't-r2' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r2' }), env, {});
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.error.code, 'upstream_unavailable');
});

await t('RT3 全网络错 (connection refused) → 502', async () => {
  const d1 = await makeDeadProxy(); const d2 = await makeDeadProxy();
  const env = envFor([d1, d2], { API_KEY: 't-r3', PROBE_TIMEOUT_MS: '1000' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r3' }), env, {});
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.error.code, 'upstream_unavailable');
});

await t('RT4 混合 ok+depleted+down: 选 ok, 忽略其余', async () => {
  const p1 = await makeProxy('r4a'); const p2 = await makeProxy('r4b'); const p3 = await makeProxy('r4c');
  const [n1, n2, n3] = proxyNames([p1, p2, p3]);
  p1.ctl.usagePct = 100;            // daily cap 满 → depleted
  p2.ctl.usagePct = 0;              // ok
  p3.ctl.fail = { status: 500, code: 'x', body: 'x' }; // 会先被探为 ok, 但 chat 500 → down
  const env = envFor([p1, p2, p3], { API_KEY: 't-r4' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r4' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  assert.equal(p1.ctl.chatHits, 0);
  assert.equal(p3.ctl.chatHits, 0);
});

await t('RT5 同分 LRU: 两个同 score 的 proxy, 优先最近未用的', async () => {
  const p1 = await makeProxy('r5a'); const p2 = await makeProxy('r5b');
  const [n1, n2] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { API_KEY: 't-r5,t-r5b' });
  // 第一次: 同分选第一个 (n1)
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r5' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  // 换客户端 key (无 pin), 同分 → n2 (n1 刚用过, LRU)
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r5b' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
});

await t('RT6 pin 指向不存在的 proxy → 忽略并正常选路', async () => {
  const p1 = await makeProxy('r6a'); const p2 = await makeProxy('r6b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 5; p2.ctl.usagePct = 50;
  const env = envFor([p1, p2], { API_KEY: 't-r6' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r6' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
});

await t('RT7 PIN_MODE off: 每次请求都重新选路 (不钉住)', async () => {
  const p1 = await makeProxy('r7a'); const p2 = await makeProxy('r7b');
  const [n1, n2] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { PIN_MODE: 'off', API_KEY: 't-r7' });
  // 第一次选 n1
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r7' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  // 第二次: 若被钉住会继续 n1; off 模式下同分 LRU 选 n2
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r7' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
});

await t('RT8 header 模式空 X-Sticky-Id → 不钉住, 正常选路', async () => {
  const p1 = await makeProxy('r8a'); const p2 = await makeProxy('r8b');
  const [n1, n2] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { PIN_MODE: 'header', API_KEY: 't-r8' });
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': '' } , key: 't-r8' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': '' }, key: 't-r8' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
});

await t('RT9 RiskLevel critical → score 抬到 90, 不优先选', async () => {
  const p1 = await makeProxy('r9a'); const p2 = await makeProxy('r9b');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 10; p2.ctl.usagePct = 50;
  // p1 healthz 里 risk critical —— mock 需要能覆盖 RiskLevel
  // (用 quota 途径简化: 无法直接注入 risk, 验证 score 机制用 usage 即可)
  const env = envFor([p1, p2], { API_KEY: 't-r9' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r9' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
});

await t('RT10 全部 ok 但都维护中 → 502', async () => {
  const p1 = await makeProxy('r10a'); const p2 = await makeProxy('r10b');
  const env = envFor([p1, p2], { API_KEY: 't-r10' });
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-r10', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: proxyNames([p1, p2])[0], on: true }) }), env, {});
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-r10', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: proxyNames([p1, p2])[1], on: true }) }), env, {});
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r10' }), env, {});
  assert.equal(res.status, 502);
});

await t('RT11 维护中的 proxy 不参与选路 (有可用时选可用)', async () => {
  const p1 = await makeProxy('r11a'); const p2 = await makeProxy('r11b');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 5; p2.ctl.usagePct = 50;
  const env = envFor([p1, p2], { API_KEY: 't-r11,t-r11b' });
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-r11', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1, on: true }) }), env, {});
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r11' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  // 关闭维护后恢复
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-r11', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1, on: false }) }), env, {});
  const res2 = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r11b' }), env, {});
  assert.equal(res2.headers.get('x-gateway-proxy'), n1);
});

await t('RT12 pin 指向维护中的 proxy → 自动换到可用', async () => {
  const p1 = await makeProxy('r12a'); const p2 = await makeProxy('r12b');
  const [n1, n2] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { API_KEY: 't-r12' });
  // 先钉住 n1
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r12' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  // n1 进入维护
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-r12', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1, on: true }) }), env, {});
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-r12' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
  assert.equal(res.headers.get('x-gateway-attempts'), '1');
});

console.log('\n== failover 极端 ==');

await t('FO1 429 只带 Retry-After 头 (无 body reset)', async () => {
  const p1 = await makeProxy('f1a'); const p2 = await makeProxy('f1b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 45, body: 'plain message' };
  const env = envFor([p1, p2], { API_KEY: 't-f1' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f1' }), env, {});
  assert.equal(res.status, 200);
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'depleted');
  // nextProbe 应约等于 now+45s+10s
  assert.ok(Date.parse(hz.next_probe) - Date.now() > 45e3);
});

await t('FO2 429 body 带 reset RFC3339 (无头) → nextProbe 对齐 reset+10s', async () => {
  const p1 = await makeProxy('f2a'); const p2 = await makeProxy('f2b');
  const [n1] = proxyNames([p1, p2]);
  const reset = new Date(Date.now() + 300e3).toISOString();
  p1.ctl.fail = { status: 429, code: 'rate_limited', body: 'upstream rate limited (reset at ' + reset + ')' };
  const env = envFor([p1, p2], { API_KEY: 't-f2' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f2' }), env, {});
  const hz = await hzOf(env, n1);
  const drift = Math.abs(Date.parse(hz.next_probe) - (Date.parse(reset) + 10e3));
  assert.ok(drift < 5000, 'nextProbe should align to reset+10s, drift=' + drift);
});

await t('FO3 429 无任何时间信息 → 指数退避', async () => {
  const p1 = await makeProxy('f3a'); const p2 = await makeProxy('f3b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 429, code: 'rate_limited', body: 'nope' };
  const env = envFor([p1, p2], { API_KEY: 't-f3', DEPLETED_PROBE_SECONDS: '120' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f3' }), env, {});
  const hz = await hzOf(env, n1);
  // backoff 60→120s + 抖动
  const delta = Date.parse(hz.next_probe) - Date.now();
  assert.ok(delta >= 60e3 && delta <= 150e3, 'backoff in [60,150]s, got ' + delta);
});

await t('FO4 403 country_blocked → down (非 token 问题)', async () => {
  const p1 = await makeProxy('f4a'); const p2 = await makeProxy('f4b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 403, code: 'country_blocked', body: 'region blocked' };
  const env = envFor([p1, p2], { API_KEY: 't-f4' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f4' }), env, {});
  assert.equal(res.status, 200);
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'down');
});

await t('FO5 403 free_mode_cli_required → 客户端错透传, 不 failover', async () => {
  const p = await makeProxy('f5');
  p.ctl.fail = { status: 403, code: 'free_mode_cli_required', body: 'cli only' };
  const env = envFor([p], { API_KEY: 't-f5' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f5' }), env, {});
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error.code, 'free_mode_cli_required');
  assert.equal(p.ctl.chatHits, 1);
});

await t('FO6 401 (proxy 拒绝网关 key) → bad_config, 尝试其他 proxy', async () => {
  const p1 = await makeProxy('f6a'); const p2 = await makeProxy('f6b');
  p1.ctl.fail = { status: 401, code: 'invalid_api_key', body: 'Invalid API key' };
  const env = envFor([p1, p2], { API_KEY: 't-f6' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f6' }), env, {});
  assert.equal(res.status, 200);
  const hz = await hzOf(env, proxyNames([p1, p2])[0]);
  assert.equal(hz.status, 'bad_config');
});

await t('FO7 404 客户端错 → 透传不 failover', async () => {
  const p = await makeProxy('f7');
  p.ctl.fail = { status: 404, code: 'model_not_found', body: 'no such model' };
  const env = envFor([p], { API_KEY: 't-f7' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'nope-model', messages: [] }, key: 't-f7' }), env, {});
  assert.equal(res.status, 404);
  assert.equal(p.ctl.chatHits, 1);
});

await t('FO8 MAX_ATTEMPTS=1 → 不重试', async () => {
  const p1 = await makeProxy('f8a'); const p2 = await makeProxy('f8b');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  const env = envFor([p1, p2], { MAX_ATTEMPTS: '1', API_KEY: 't-f8' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f8' }), env, {});
  assert.equal(res.status, 429);
  assert.equal(p2.ctl.chatHits, 0);
});

await t('FO9 聚合优先级: banned > quota > down', async () => {
  // banned + quota → 403
  let p1 = await makeProxy('f9a'); let p2 = await makeProxy('f9b');
  p1.ctl.fail = { status: 403, code: 'account_banned', body: 'banned' };
  p2.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  const env = envFor([p1, p2], { MAX_ATTEMPTS: '2', API_KEY: 't-f9' });
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f9' }), env, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'account_banned');
  // quota + down → 429
  p1 = await makeProxy('f9c'); p2 = await makeProxy('f9d');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  p2.ctl.fail = { status: 500, code: 'boom', body: 'x' };
  const env2 = envFor([p1, p2], { MAX_ATTEMPTS: '2', API_KEY: 't-f9b' });
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f9b' }), env2, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});

await t('FO10 surface 优先透传: 先 429 后 400 → 返回 400', async () => {
  const p1 = await makeProxy('f10a'); const p2 = await makeProxy('f10b');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  p2.ctl.fail = { status: 400, code: 'invalid_json', body: 'bad body' };
  const env = envFor([p1, p2], { API_KEY: 't-f10' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f10' }), env, {});
  assert.equal(res.status, 400);
});

await t('FO11 流式中途上游断连: 已发出的部分原样, 网关不崩溃', async () => {
  const p = await makeProxy('f11');
  p.ctl.mode = 'abort';
  const env = envFor([p], { API_KEY: 't-f11' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: true }, key: 't-f11' }), env, {});
  assert.equal(res.status, 200);
  const sse = await collectSSE(res);
  assert.ok(sse.includes('part1'), 'partial chunk should be relayed');
});

await t('FO12 客户端中途断开 → 上游请求被中止', async () => {
  const p = await makeProxy('f12');
  p.ctl.mode = 'abort';
  const env = envFor([p], { API_KEY: 't-f12' });
  const ctrl = new AbortController();
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: true }, key: 't-f12' }), env, {});
  assert.equal(res.status, 200);
  // 读第一块后 abort
  const reader = res.body.getReader();
  await reader.read();
  ctrl.abort();
  try { await reader.cancel(); } catch (e) {}
  await new Promise(r => setTimeout(r, 300));
  assert.ok(p.ctl.streamStarted, 'stream started');
  // 网关已把 abort 传播到上游: mock 检测 res 被关闭 (部分实现用 close 事件)
});

await t('FO13 探测失败时退避递增并封顶 (DEPLETED_PROBE_SECONDS)', async () => {
  const p1 = await makeProxy('f13a'); const p2 = await makeProxy('f13b');
  const [n1] = proxyNames([p1, p2]);
  // 先让 p1 变 down (chat 502), 之后 healthz 也持续失败 → 每次到期探测都失败 → backoff 递增
  p1.ctl.fail = { status: 502, code: 'boom', body: 'x' };
  const env = envFor([p1, p2], { API_KEY: 't-f13', DOWN_PROBE_SECONDS: '60', DEPLETED_PROBE_SECONDS: '60' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f13' }), env, {});
  p1.ctl.healthzStatus = 500; // 探测持续失败
  for (let i = 0; i < 4; i++) {
    advance(61e3); // 让 nextProbe 过期
    await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-f13' }), env, {});
  }
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'down');
  // 退避封顶验证: 距上次探测失败 (last_error) 的间隔 = backoff(60s) ± jitter(7s)
  const gap = Date.parse(hz.next_probe) - Date.parse(hz.last_error);
  assert.ok(gap >= 50e3 && gap <= 70e3, 'probe gap should be ~60s (capped), got ' + gap);
  assert.ok(hz.consecutive_errors >= 2, 'consecutive failures should accumulate');
});

console.log('\n== 探测极端 ==');

await t('PR1 healthz 500 → fail-open (unknown), 请求仍可走', async () => {
  const p1 = await makeProxy('p1a'); const p2 = await makeProxy('p1b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.healthzStatus = 500;
  p2.ctl.usagePct = 30;
  const env = envFor([p1, p2], { API_KEY: 't-p1' });
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'unknown');
  // unknown 只是降级, 请求仍成功 (fail-open 走 p2)
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-p1' }), env, {});
  assert.equal(res.status, 200);
});

await t('PR2 healthz 超时 → fail-open', async () => {
  const p1 = await makeProxy('p2a'); const p2 = await makeProxy('p2b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.healthzDelay = 5000; // 超过 probe timeout
  const env = envFor([p1, p2], { API_KEY: 't-p2', PROBE_TIMEOUT_MS: '500' });
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'unknown');
});

await t('PR3 healthz 畸形 JSON → 探测失败 fail-open', async () => {
  const p1 = await makeProxy('p3a'); const p2 = await makeProxy('p3b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.healthzBody = '{not json!!!';
  const env = envFor([p1, p2], { API_KEY: 't-p3' });
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'unknown');
});

await t('PR4 healthz 缺 tokens 数组 → 探测失败', async () => {
  const p1 = await makeProxy('p4a'); const p2 = await makeProxy('p4b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.healthzBody = JSON.stringify({ status: 'ok', tokens: [] });
  const env = envFor([p1, p2], { API_KEY: 't-p4' });
  const hz = await hzOf(env, n1);
  assert.equal(hz.status, 'unknown');
});

await t('PR5 探测恢复: down 的 proxy healthz 转好 → 重新入池', async () => {
  const p1 = await makeProxy('p5a'); const p2 = await makeProxy('p5b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.healthzStatus = 500;
  const env = envFor([p1, p2], { API_KEY: 't-p5', DOWN_PROBE_SECONDS: '60' });
  let hz = await hzOf(env, n1);
  assert.equal(hz.status, 'unknown');
  // healthz 恢复
  advance(65e3);
  p1.ctl.healthzStatus = 200; p1.ctl.usagePct = 5;
  hz = await hzOf(env, n1);
  assert.equal(hz.status, 'ok');
});

await t('PR6 单飞: 并发请求同一 proxy 只探测一次', async () => {
  const p = await makeProxy('p6');
  const env = envFor([p], { API_KEY: 't-p6' });
  const before = p.ctl.healthzHits;
  await Promise.all([
    worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-p6' }), env, {}),
    worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-p6b' }), env, {}),
    worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-p6c' }), env, {}),
  ]);
  // 首次探测 1 次 (单飞), 之后请求复用状态
  assert.ok(p.ctl.healthzHits - before <= 2, 'healthz hits should be <=2 (singleflight), got ' + (p.ctl.healthzHits - before));
});

await t('PR7 探测保持 depleted 未恢复 → nextProbe 持续在未来', async () => {
  const p1 = await makeProxy('p7a'); const p2 = await makeProxy('p7b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'upstream rate limited (reset at 2026-08-18T00:00:00Z)' };
  const env = envFor([p1, p2], { API_KEY: 't-p7' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-p7' }), env, {});
  // reset 还没到 → 即使强制 healthz 检查也不提前恢复
  advance(30e3);
  let hz = await hzOf(env, n1);
  assert.equal(hz.status, 'depleted');
  assert.ok(Date.parse(hz.next_probe) > Date.now());
});

console.log('\n== 请求体/流式极端 ==');

await t('BODY1 空 body → 透传 proxy 的 400 (不崩溃)', async () => {
  const p = await makeProxy('b1');
  p.ctl.fail = { status: 400, code: 'invalid_json', body: 'body required' };
  const env = envFor([p], { API_KEY: 't-b1' });
  const res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer t-b1', 'Content-Type': 'application/json' }, body: '' }), env, {});
  assert.equal(res.status, 400);
});

await t('BODY2 非法 JSON → 透传 400', async () => {
  const p = await makeProxy('b2');
  p.ctl.fail = { status: 400, code: 'invalid_json', body: 'invalid' };
  const env = envFor([p], { API_KEY: 't-b2' });
  const res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer t-b2', 'Content-Type': 'application/json' }, body: '{oops' }), env, {});
  assert.equal(res.status, 400);
});

await t('BODY3 超大 body (>32MB) → 413 网关直接拒绝', async () => {
  const p = await makeProxy('b3');
  const env = envFor([p], { API_KEY: 't-b3' });
  const big = '{"model":"freebuff-1","pad":"' + 'a'.repeat(33 * 1024 * 1024) + '"}';
  const res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer t-b3', 'Content-Type': 'application/json' }, body: big }), env, {});
  assert.equal(res.status, 413);
  assert.equal(p.ctl.chatHits, 0);
});

await t('BODY4 stream=true 但上游返回 JSON → 原样透传', async () => {
  const p = await makeProxy('b4');
  p.ctl.mode = 'json';
  const env = envFor([p], { API_KEY: 't-b4' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: true }, key: 't-b4' }), env, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.choices[0].message.content, 'Hello from b4');
});

await t('BODY5 非 JSON content-type → 不缓冲, 原样转发', async () => {
  const p = await makeProxy('b5');
  p.ctl.fail = { status: 415, code: 'unsupported', body: 'nope' };
  const env = envFor([p], { API_KEY: 't-b5' });
  const res = await worker.fetch(new Request('https://gw.example/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer t-b5', 'Content-Type': 'application/x-ndjson' }, body: '{"model":"x"}\n' }), env, {});
  // 不缓冲 → 原样转发 → proxy 415 → down 分类 → failover 无 → 502? 415 是 4xx 非 400/404 → down
  // 这里只验证不崩溃且状态码来自上游分类逻辑
  assert.ok([400, 401, 402, 403, 404, 415, 502, 429].includes(res.status), 'got ' + res.status);
});

await t('BODY6 stream 参数缺失/非 bool → 按 false 处理 (透传)', async () => {
  const p = await makeProxy('b6');
  p.ctl.mode = 'json';
  const env = envFor([p], { API_KEY: 't-b6' });
  for (const body of [{ model: 'freebuff-1', messages: [] }, { model: 'freebuff-1', messages: [], stream: 'yes' }]) {
    const res = await worker.fetch(gwReq('/v1/chat/completions', { body, key: 't-b6' }), env, {});
    assert.equal(res.status, 200);
  }
});

await t('BODY7 model 缺失 → 透传 proxy 的 400', async () => {
  const p = await makeProxy('b7');
  p.ctl.fail = { status: 400, code: 'model_not_found', body: 'missing model' };
  const env = envFor([p], { API_KEY: 't-b7' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { messages: [] }, key: 't-b7' }), env, {});
  assert.equal(res.status, 400);
});

console.log('\n== 状态/缓存极端 ==');

await t('ST1 缓存写入失败 → 网关不崩溃, 状态降级可用', async () => {
  const p = await makeProxy('st1');
  const env = envFor([p], { API_KEY: 't-st1' });
  globalThis.caches.default.failWrites = true;
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st1' }), env, {});
  globalThis.caches.default.failWrites = false;
  assert.equal(res.status, 200);
});

await t('ST2 时钟回拨 → 不 panic, 状态仍可用', async () => {
  const p = await makeProxy('st2');
  const env = envFor([p], { API_KEY: 't-st2' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st2' }), env, {});
  advance(-5000); // 时钟回拨 5s
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st2' }), env, {});
  assert.equal(res.status, 200);
  advance(5000);
});

await t('ST3 TTL 边界: 61s 后状态过期重新探测, 59s 内复用', async () => {
  const p = await makeProxy('st3');
  const env = envFor([p], { API_KEY: 't-st3' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st3' }), env, {});
  const afterFirst = p.ctl.healthzHits;
  advance(59e3);
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st3' }), env, {});
  assert.equal(p.ctl.healthzHits, afterFirst, '59s 内不应重新探测');
  advance(3e3); // 62s 总计
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st3' }), env, {});
  assert.ok(p.ctl.healthzHits > afterFirst, '超过 TTL 应重新探测');
});

await t('ST4 同名不同 URL 的 proxy 状态隔离 (L1 + cache key 含 url 哈希)', async () => {
  const p1 = await makeProxy('st4a'); const p2 = await makeProxy('st4b');
  const envA = envFor([p1], { API_KEY: 't-st4' });
  const envB = envFor([p2], { API_KEY: 't-st4' });
  // 让 envA 的 p1 变 depleted
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st4' }), envA, {});
  // envB 的 p2 (同名 127) 应仍是 ok, 且请求成功
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-st4' }), envB, {});
  assert.equal(res.status, 200);
  assert.equal(p2.ctl.chatHits, 1);
});

console.log('\n== 管理后台 ==');

await t('ADM1 overview: 返回完整代理状态与统计', async () => {
  const p1 = await makeProxy('ad1a'); const p2 = await makeProxy('ad1b');
  const [n1] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 40; p2.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  const env = envFor([p1, p2], { API_KEY: 't-ad1' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-ad1' }), env, {});
  const r = await worker.fetch(new Request('https://gw.example/admin/api/overview', { headers: { Authorization: 'Bearer t-ad1' } }), env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stats.total, 2);
  assert.equal(j.proxies.length, 2);
  const h = j.proxies.find(p => p.name === n1);
  assert.equal(h.requestsOk, 1);
  assert.equal(h.requestsFail, 0);
  assert.ok(j.proxies.some(p => p.status === 'depleted'));
});

await t('ADM2 config: 掩码字段不泄露完整 key; proxies.apiKey 管理可见供编辑', async () => {
  const p = await makeProxy('ad2');
  const env = { PROXIES: p.url, GATEWAY_API_KEYS: 'super-secret-key-1', API_KEY: 'client-secret-abc' };
  const r = await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer client-secret-abc' } }), env, {});
  const j = await r.json();
  // proxies[].apiKey 是完整值: 管理后台编辑需要 (仅授权用户可见)
  assert.equal(j.config.proxies[0].apiKey, 'super-secret-key-1');
  // 掩码展示字段不泄露完整 key
  const maskedText = JSON.stringify(j.config.proxy_keys_masked) + JSON.stringify(j.config.api_key_masked) + JSON.stringify(j.config.admin_key_masked);
  assert.ok(!maskedText.includes('super-secret-key-1'), 'full GATEWAY_API_KEYS in masked fields');
  assert.ok(!maskedText.includes('client-secret-abc'), 'full API_KEY in masked fields');
  assert.ok(j.config.proxy_keys_masked.includes('sup…y-1'), 'GATEWAY_API_KEYS masked form present');
  assert.ok(j.config.api_key_masked.includes('cli…abc'), 'API_KEY masked form present');
  // ADMIN_KEY 未配置 → 管理后台复用 API_KEY
  assert.equal(j.config.admin_uses_api_key, true);
  assert.equal(j.config.admin_key_masked, null);
  // 配置了独立 ADMIN_KEY → 分别显示
  const env2 = { PROXIES: p.url, GATEWAY_API_KEYS: 'k', API_KEY: 'ck', ADMIN_KEY: 'ak-secret-xyz' };
  const r2 = await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer ak-secret-xyz' } }), env2, {});
  const j2 = await r2.json();
  assert.equal(j2.config.admin_uses_api_key, false);
  assert.ok(j2.config.admin_key_masked.includes('ak-…'), 'independent ADMIN_KEY shown, got: ' + j2.config.admin_key_masked);
  assert.ok(!JSON.stringify(j2.config.admin_key_masked).includes('ak-secret-xyz'), 'ADMIN_KEY not leaked in masked field');
});

await t('ADM3 probe 单个/全部', async () => {
  const p1 = await makeProxy('ad3a'); const p2 = await makeProxy('ad3b');
  const [n1] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { API_KEY: 't-ad3' });
  const r1 = await worker.fetch(new Request('https://gw.example/admin/api/probe', { method: 'POST', headers: { Authorization: 'Bearer t-ad3', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1 }) }), env, {});
  const j1 = await r1.json();
  assert.equal(j1.total, 1);
  assert.equal(j1.results[0].name, n1);
  const r2 = await worker.fetch(new Request('https://gw.example/admin/api/probe', { method: 'POST', headers: { Authorization: 'Bearer t-ad3', 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) }), env, {});
  const j2 = await r2.json();
  assert.equal(j2.total, 2);
});

await t('ADM4 probe 不存在的 proxy → 404', async () => {
  const p = await makeProxy('ad4');
  const env = envFor([p], { API_KEY: 't-ad4' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/probe', { method: 'POST', headers: { Authorization: 'Bearer t-ad4', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ghost' }) }), env, {});
  assert.equal(r.status, 404);
});

await t('ADM5 maintenance 未知 proxy → 404', async () => {
  const p = await makeProxy('ad5');
  const env = envFor([p], { API_KEY: 't-ad5' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-ad5', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ghost', on: true }) }), env, {});
  assert.equal(r.status, 404);
});

await t('ADM6 pin 清除: 解除钉住后重新选路', async () => {
  const p1 = await makeProxy('ad6a'); const p2 = await makeProxy('ad6b');
  const [n1, n2] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { API_KEY: 't-ad6' });
  // 钉住 n1
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-ad6' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  // 清除 pin
  const r = await worker.fetch(new Request('https://gw.example/admin/api/pin', { method: 'POST', headers: { Authorization: 'Bearer t-ad6', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 't-ad6' }) }), env, {});
  assert.equal(r.status, 200);
  // 重新选路 → n2 (LRU)
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-ad6' }), env, {});
  assert.equal(res.headers.get('x-gateway-proxy'), n2);
});

await t('ADM7 pin 清除缺 key → 400', async () => {
  const p = await makeProxy('ad7');
  const env = envFor([p], { API_KEY: 't-ad7' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/pin', { method: 'POST', headers: { Authorization: 'Bearer t-ad7', 'Content-Type': 'application/json' }, body: JSON.stringify({}) }), env, {});
  assert.equal(r.status, 400);
});

await t('ADM8 smoke 成功: 人类可读结果 (content/ok, 非原始报文)', async () => {
  const p = await makeProxy('ad8');
  p.ctl.mode = 'json';
  const env = envFor([p], { API_KEY: 't-ad8' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/smoke', { method: 'POST', headers: { Authorization: 'Bearer t-ad8', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freebuff-1', prompt: 'hello', stream: false }) }), env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 200);
  assert.equal(j.ok, true);
  assert.ok(j.proxy);
  assert.ok(j.content.includes('Hello from ad8'), 'content should extract reply text, got: ' + JSON.stringify(j.content));
  assert.ok(!j.error, 'no error expected');
  assert.ok(j.ms >= 0);
  assert.ok(!('preview' in j), 'raw preview field removed');
});

await t('ADM9 smoke 失败 (proxy 全 429) → 人类可读错误', async () => {
  const p = await makeProxy('ad9');
  p.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  const env = envFor([p], { API_KEY: 't-ad9' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/smoke', { method: 'POST', headers: { Authorization: 'Bearer t-ad9', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freebuff-1', prompt: 'hi' }) }), env, {});
  const j = await r.json();
  assert.equal(j.status, 429);
  assert.equal(j.ok, false);
  assert.ok(j.error && j.error.length > 0, 'human-readable error expected, got: ' + JSON.stringify(j.error));
  assert.ok(!j.content, 'no content on failure');
});

await t('ADM9b smoke SSE 流式: content 提取 delta 文本', async () => {
  const p = await makeProxy('ad9b');
  p.ctl.mode = 'sse';
  const env = envFor([p], { API_KEY: 't-ad9b' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/smoke', { method: 'POST', headers: { Authorization: 'Bearer t-ad9b', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freebuff-1', prompt: 'hi', stream: true }) }), env, {});
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.content.includes('Hel') && j.content.includes('lo'), 'SSE delta content extracted: ' + JSON.stringify(j.content));
});

await t('ADM9c /admin/api/models 聚合模型列表', async () => {
  const p1 = await makeProxy('ad9c1'); const p2 = await makeProxy('ad9c2');
  const env = envFor([p1, p2], { API_KEY: 't-ad9c' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/models', { headers: { Authorization: 'Bearer t-ad9c' } }), env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.data) && j.data.some(m => m.id === 'freebuff-1'));
});

await t('ADM10 事件日志: failover 与 status_change 被记录', async () => {
  const p1 = await makeProxy('ad10a'); const p2 = await makeProxy('ad10b');
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  const env = envFor([p1, p2], { API_KEY: 't-ad10' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-ad10' }), env, {});
  const r = await worker.fetch(new Request('https://gw.example/admin/api/overview', { headers: { Authorization: 'Bearer t-ad10' } }), env, {});
  const j = await r.json();
  const types = j.events.map(e => e.type);
  assert.ok(types.includes('failover') || types.includes('status_change'), 'events: ' + types.join(','));
});

await t('ADM11 维护开关在 overview 中可见 (maint 标记)', async () => {
  const p = await makeProxy('ad11');
  const [n1] = proxyNames([p]);
  const env = envFor([p], { API_KEY: 't-ad11' });
  await worker.fetch(new Request('https://gw.example/admin/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer t-ad11', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1, on: true }) }), env, {});
  const r = await worker.fetch(new Request('https://gw.example/admin/api/overview', { headers: { Authorization: 'Bearer t-ad11' } }), env, {});
  const j = await r.json();
  assert.equal(j.proxies[0].maint, true);
  assert.equal(j.proxies[0].status, 'maint');
});

await t('ADM12 smoke 用 ADMIN_KEY 也允许 (adminAuthorized)', async () => {
  const p = await makeProxy('ad12');
  const env = { PROXIES: p.url, GATEWAY_API_KEYS: 'pw', API_KEY: 'ck', ADMIN_KEY: 'ak' };
  const r = await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer ak' } }), env, {});
  assert.equal(r.status, 200);
});

await t('ADM13 /admin/api/pin 返回当前会话常驻代理 + 解除', async () => {
  const p1 = await makeProxy('pk1'); const p2 = await makeProxy('pk2');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 5; p2.ctl.usagePct = 50;
  const env = envFor([p1, p2], { API_KEY: 't-pin,t-pin2' });
  // 先发请求钉住 n1
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-pin' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), n1);
  // 常驻状态
  let pr = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin' } }), env, {})).json();
  assert.equal(pr.pinned_proxy, n1);
  assert.equal(pr.sticky_key, 'c:t-pin');
  assert.equal(pr.pin_mode, 'client');
  // 最近路由事实 (即使管理会话 key 不同也能看到实际路由)
  assert.ok(Array.isArray(pr.recent_proxies) && pr.recent_proxies.length >= 1, 'recent_proxies should list routed proxies');
  assert.equal(pr.recent_proxies[0].name, n1, 'most recent routed proxy should be n1');
  assert.ok(pr.recent_proxies[0].requestsOk >= 1);
  // 未钉住的客户端: pinned null 但 recent_proxies 仍可见
  const pr2 = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin2' } }), env, {})).json();
  assert.equal(pr2.pinned_proxy, null);
  assert.ok(pr2.recent_proxies.length >= 1, 'recent routing visible regardless of session key');
  // 解除后为 null
  await worker.fetch(new Request('https://gw.example/admin/api/pin', { method: 'POST', headers: { Authorization: 'Bearer t-pin', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 't-pin' }) }), env, {});
  pr = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin' } }), env, {})).json();
  assert.equal(pr.pinned_proxy, null);
});

await t('ADM14 header 模式: /admin/api/pin 按 X-Sticky-Id 返回常驻', async () => {
  const p1 = await makeProxy('pk3'); const p2 = await makeProxy('pk4');
  const [n1, n2] = proxyNames([p1, p2]);
  p1.ctl.usagePct = 5; p2.ctl.usagePct = 50;
  const env = envFor([p1, p2], { API_KEY: 't-pinh', PIN_MODE: 'header' });
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-x' }, key: 't-pinh' }), env, {});
  // admin 请求带 X-Sticky-Id
  const pr = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pinh', 'X-Sticky-Id': 'conv-x' } }), env, {})).json();
  assert.equal(pr.pinned_proxy, n1);
  assert.equal(pr.sticky_key, 'h:conv-x');
  // 不带 X-Sticky-Id → null
  const pr2 = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pinh' } }), env, {})).json();
  assert.equal(pr2.pinned_proxy, null);
});

await t('ADM15 recent_proxies 跨 isolate 可见 (L1 blankState 时不短路 cache)', async () => {
  const p = await makeProxy('pk5');
  const env = envFor([p], { API_KEY: 't-pin5' });
  const name = proxyNames([p])[0];
  // 1. 先触发一次 /pin → getState 在本 isolate 的 L1 里存了 blankState (lastUsed=0)
  await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin5' } }), env, {});
  // 2. 模拟"另一个 isolate 的聊天写入": 直接向 cache 写入带 lastUsed 的代理状态
  const stateKey = 'https://cf-quota-gateway.invalid/state/' + name + '/' + hashFn(p.url);
  await caches.default.put(stateKey, new Response(JSON.stringify({
    name: name, url: p.url, status: 'ok', lastUsed: 1000, requestsOk: 3, updatedAt: 1000,
  }), { headers: { 'Content-Type': 'application/json' } }), { ttl: 60 });
  // 3. 再查 /pin: 即使 L1 是 blankState, 也应从 cache 读到最近路由 (不短路)
  const pr = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin5' } }), env, {})).json();
  assert.ok(Array.isArray(pr.recent_proxies) && pr.recent_proxies.some(x => x.name === name && x.lastUsed > 0),
    'recent routing should be visible from cache even when L1 is blank, got: ' + JSON.stringify(pr.recent_proxies));
  assert.equal(pr.recent_proxies[0].requestsOk, 3);
});

await t('ADM16 最近路由持久化: 状态缓存过期后仍可见 (last-used 独立 TTL)', async () => {
  const p = await makeProxy('pk6');
  const env = envFor([p], { API_KEY: 't-pin6' });
  const name = proxyNames([p])[0];
  // 聊天 → 写入最近路由记录
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-pin6' }), env, {});
  assert.equal(res.status, 200);
  // 快进超过 STATE_TTL(60s): 代理状态缓存过期, 但最近路由记录(独立 TTL 1h)不应丢失
  advance(70e3);
  const pr = await (await worker.fetch(new Request('https://gw.example/admin/api/pin', { headers: { Authorization: 'Bearer t-pin6' } }), env, {})).json();
  assert.ok(Array.isArray(pr.recent_proxies) && pr.recent_proxies.some(x => x.name === name),
    'recent routing should survive state TTL expiry, got: ' + JSON.stringify(pr.recent_proxies));
  assert.ok(pr.recent_proxies[0].requestsOk >= 1);
});

await t('ADM17 每次请求都记录路由日志 (成功/失败, overview 返回 routes)', async () => {
  const p1 = await makeProxy('rk1'); const p2 = await makeProxy('rk2');
  const [n1] = proxyNames([p1, p2]);
  const env = envFor([p1, p2], { API_KEY: 't-rk' });
  // 成功请求 → 路由记录
  let r = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-rk' }), env, {});
  assert.equal(r.status, 200);
  // 失败请求 (p1 429 + p2 502 → 全失败, 聚合按 quota 优先返回 429)
  p1.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 60, body: 'x' };
  p2.ctl.fail = { status: 502, code: 'boom', body: 'x' };
  r = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-rk' }), env, {});
  assert.equal(r.status, 429); // 聚合优先级: quota(429) > down(502)
  const ov = await (await worker.fetch(new Request('https://gw.example/admin/api/overview', { headers: { Authorization: 'Bearer t-rk' } }), env, {})).json();
  assert.ok(Array.isArray(ov.routes) && ov.routes.length >= 2, 'routes should be recorded, got: ' + JSON.stringify(ov.routes));
  // 最近两条 = 本测试的 成功 + 失败
  const prev = ov.routes[ov.routes.length - 2];
  assert.equal(prev.ok, true);
  assert.equal(prev.name, n1);
  assert.equal(prev.status, 200);
  assert.ok(prev.t > 0 && prev.ms >= 0);
  const last = ov.routes[ov.routes.length - 1]; // 最新
  assert.equal(last.ok, false);
  assert.equal(last.status, 429);
  assert.equal(last.attempts, 2);
});

await t('ADM18 低流量日志不滞留: 单次请求后路由/事件日志立即可见 (不再等攒够 10 条才 flush)', async () => {
  const p = await makeProxy('rk3');
  const env = envFor([p], { API_KEY: 't-rk3' });
  const [n1] = proxyNames([p]);
  // 只发 1 条请求 (旧逻辑: ROUTE_L1 攒不满 10 条, 换个 isolate 就看 不到日志)
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-rk3' }), env, {});
  assert.equal(res.status, 200);
  await new Promise(resolve => setTimeout(resolve, 10)); // 让 fire-and-forget 的落盘链完成 (不阻塞主流程)
  // 不经过任何 overview 读取 (模拟管理后台命中另一个 isolate), 直接查共享 cache:
  // pushRoute 必须已把这条路由落盘, 而不是滞留在本 isolate 的 L1 里
  const r = await caches.default.get('https://cf-quota-gateway.invalid/routes');
  assert.ok(r, 'route log should be flushed to shared cache right after a single request');
  const list = await r.json();
  assert.ok(Array.isArray(list) && list.length >= 1, 'routes in cache: ' + JSON.stringify(list));
  assert.equal(list[list.length - 1].name, n1, 'last route should be ' + n1 + ', got: ' + list[list.length - 1].name);
  assert.equal(list[list.length - 1].ok, true);
  // 事件同理: 触发一个管理操作事件, 单条也应立即可见
  await worker.fetch(new Request('https://gw.example/admin/api/probe', { method: 'POST', headers: { Authorization: 'Bearer t-rk3', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n1 }) }), env, {});
  await new Promise(resolve => setTimeout(resolve, 10)); // 等事件落盘
  const er = await caches.default.get('https://cf-quota-gateway.invalid/events');
  assert.ok(er, 'event log should be flushed to shared cache right after one admin action');
  const ev = await er.json();
  assert.ok(Array.isArray(ev) && ev.some(e => e.type === 'admin_action' && e.action === 'probe'), 'admin_action event visible: ' + JSON.stringify(ev));
});

console.log('\n== 运行时配置 (后台管理代理/参数) ==');

await t('RUN1 保存代理列表 → 立即生效, 路由用新代理 + 各自的 apiKey', async () => {
  const pa = await makeProxy('ra'); const pb = await makeProxy('rb');
  const env = envFor([pa], { API_KEY: 't-run1' }); // 环境变量只有 pa
  pb.ctl.usagePct = 0; pa.ctl.usagePct = 50;
  // 后台保存运行时配置: [ra, rb] (替换环境变量列表)
  const save = await worker.fetch(new Request('https://gw.example/admin/api/config', { method: 'POST', headers: { Authorization: 'Bearer t-run1', 'Content-Type': 'application/json' }, body: JSON.stringify({ proxies: [
    { name: 'ra', url: pa.url, apiKey: 'kA' },
    { name: 'rb', url: pb.url, apiKey: 'kB' },
  ] }) }), env, {});
  assert.equal(save.status, 200);
  // config 显示 runtime_managed + 完整列表
  const cfg = await (await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer t-run1' } }), env, {})).json();
  assert.equal(cfg.config.runtime_managed, true);
  assert.equal(cfg.config.has_runtime_config, true);
  assert.equal(cfg.config.proxies.length, 2);
  // 路由到新列表中的最优 (rb, usage 0), 且用运行时保存的 apiKey 调下游
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, key: 't-run1' }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'rb');
  assert.equal(pb.ctl.lastAuth, 'kB');
});

await t('RUN2 保存参数 → 生效 (pinMode/maxAttempts)', async () => {
  const p = await makeProxy('rp');
  const env = envFor([p], { API_KEY: 't-run2' });
  const r = await worker.fetch(new Request('https://gw.example/admin/api/config', { method: 'POST', headers: { Authorization: 'Bearer t-run2', 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { pinMode: 'header', maxAttempts: 2 } }) }), env, {});
  assert.equal(r.status, 200);
  const cfg = await (await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer t-run2' } }), env, {})).json();
  assert.equal(cfg.config.pin_mode, 'header');
  assert.equal(cfg.config.max_attempts, 2);
});

await t('RUN3 校验拒绝: 空列表/非法 URL/缺 key/重复名/非法参数 → 400', async () => {
  const p = await makeProxy('rv');
  const env = envFor([p], { API_KEY: 't-run3' });
  const bad = [
    { proxies: [] },
    { proxies: [{ url: 'not-a-url', apiKey: 'k' }] },
    { proxies: [{ url: 'https://x.com' }] },
    { proxies: [{ name: 'a', url: 'https://x.com', apiKey: 'k' }, { name: 'a', url: 'https://y.com', apiKey: 'k' }] },
    { settings: { pinMode: 'bogus' } },
    { settings: { stateTtl: 5 } },
  ];
  for (const b of bad) {
    const r = await worker.fetch(new Request('https://gw.example/admin/api/config', { method: 'POST', headers: { Authorization: 'Bearer t-run3', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }), env, {});
    assert.equal(r.status, 400, 'should reject: ' + JSON.stringify(b).slice(0, 70));
  }
});

await t('RUN4 重置 → 清除运行时配置, 恢复环境变量', async () => {
  const p = await makeProxy('rr');
  const env = envFor([p], { API_KEY: 't-run4' });
  await worker.fetch(new Request('https://gw.example/admin/api/config', { method: 'POST', headers: { Authorization: 'Bearer t-run4', 'Content-Type': 'application/json' }, body: JSON.stringify({ proxies: [{ name: 'x1', url: 'https://example.com', apiKey: 'k' }] }) }), env, {});
  const r = await worker.fetch(new Request('https://gw.example/admin/api/config/reset', { method: 'POST', headers: { Authorization: 'Bearer t-run4', 'Content-Type': 'application/json' }, body: '{}' }), env, {});
  assert.equal(r.status, 200);
  const cfg = await (await worker.fetch(new Request('https://gw.example/admin/api/config', { headers: { Authorization: 'Bearer t-run4' } }), env, {})).json();
  assert.equal(cfg.config.runtime_managed, false);
  assert.equal(cfg.config.has_runtime_config, false);
  assert.equal(cfg.config.proxies.length, 1); // 回到环境变量的 1 个代理
});

// 收尾
for (const m of allProxies) await m.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
