// cf-quota-gateway 本地测试: 模拟 CF Workers 运行时 (caches/fetch/Date) + mock proxies
// 运行: node test/test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// ── 运行时 shim ─────────────────────────────────────────────

// 可前进的假时钟 (worker.js 动态调用 Date.now(), 打补丁即可)
// 基准固定在 2026-08-17T00:00:00Z, 方便测试里构造 reset 时刻
let fakeNow = Date.UTC(2026, 7, 17, 0, 0, 0);
Date.now = () => fakeNow;
export function advance(ms) { fakeNow += ms; }

// 模拟 caches.default (Map + TTL)
class MockCache {
  constructor() { this.m = new Map(); }
  async put(key, response, opts = {}) {
    const ttl = (opts.ttl || 86400) * 1000;
    const text = await response.text();
    this.m.set(String(key), { text, expire: fakeNow + ttl });
  }
  async get(key) {
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

// proxyCtl 可变状态:
//   usagePct, cooldownUntilMs, quota: {model:{limit,recentCount,resetAtMs}},
//   fail: {status, code, retryAfter, body} | null (chat 时返回该错误)
//   mode: 'sse' | 'json'
export function makeProxy(name) {
  const ctl = {
    name, usagePct: 0, cooldownUntilMs: 0, quota: {}, fail: null, mode: 'sse',
    chatHits: 0, healthzHits: 0, modelsHits: 0, lastModel: null,
  };
  const port = ++portCounter;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      ctl.healthzHits++;
      const tokens = [{
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
      }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'pooled', tokens }));
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
        if (ctl.mode === 'sse') {
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

// ── worker 加载 ─────────────────────────────────────────────

const worker = (await import(pathToFileURL(new URL('../worker.js', import.meta.url).pathname).href)).default;

function envFor(proxies, extra = {}) {
  return {
    PROXIES: JSON.stringify(proxies.map((p, i) => ({ name: p.ctl.name, url: p.url, apiKey: 'proxykey-' + i }))),
    GATEWAY_API_KEYS: 'testkey1,testkey2',
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

// ── 测试 ────────────────────────────────────────────────────

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 5).join('\n    ')); }
}

// 场景 1-4 共用: a usage 90, b usage 10, c usage 50
const a = await makeProxy('a');
const b = await makeProxy('b');
const c = await makeProxy('c');
a.ctl.usagePct = 90; b.ctl.usagePct = 10; c.ctl.usagePct = 50;
const env1 = envFor([a, b, c]);

await t('S1 选路: 无钉住时选余量最多的 proxy (b, usage=10)', async () => {
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'b');
  assert.equal(b.ctl.chatHits, 1);
});

await t('S2 钉住: 同一客户端 key 第二次请求仍走 b (即使 a 余量现在更多)', async () => {
  a.ctl.usagePct = 0;
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'b');
  assert.equal(b.ctl.chatHits, 2);
});

await t('S3 钉住切换: b 额度耗尽(429) → failover 到余量最多的 a 并重钉', async () => {
  advance(61 * 1000); // 让 a 的状态过期重新探测 (S2 里 a.usage 已改为 0 → score 0 成为最优)
  b.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 120, body: 'upstream rate limited (reset at 2026-08-17T12:00:00Z)' };
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'a');
  assert.equal(res.headers.get('x-gateway-attempts'), '2');
  // 钉住已迁移到 a
  const res2 = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env1, {});
  assert.equal(res2.headers.get('x-gateway-proxy'), 'a');
  // b 被标记 depleted
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env1, {})).json();
  const bst = hz.proxies.find(p => p.name === 'b');
  assert.equal(bst.status, 'depleted');
  assert.equal(bst.reason, 'rate_limited');
});

await t('S4 SSE 流式透传: 分块到达且带 [DONE], 流式请求也走钉住', async () => {
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: true } }), env1, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('x-gateway-proxy'), 'a');
  const sse = await collectSSE(res);
  assert.ok(sse.includes('data: [DONE]'), 'missing [DONE]');
  assert.ok(sse.includes('"content":"Hel"'), 'missing first chunk');
  assert.ok(sse.includes('"content":"lo"'), 'missing second chunk');
  assert.ok(sse.indexOf('Hel') < sse.indexOf('lo'), 'chunk order wrong');
});

await t('S5 全 depleted → 网关 429 + Retry-After', async () => {
  const x = await makeProxy('x'); const y = await makeProxy('y');
  x.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 90, body: 'upstream rate limited' };
  y.ctl.fail = { status: 402, code: 'out_of_credits', body: 'out of credits' };
  const env5 = envFor([x, y], { MAX_ATTEMPTS: '2' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env5, {});
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error.code, 'rate_limited');
  assert.ok(Number(res.headers.get('retry-after')) >= 60, 'retry-after should be >= 60s, got ' + res.headers.get('retry-after'));
});

await t('S6 恢复探测: depleted proxy 的 reset 时刻到达 → 探测 healthz 恢复后重新入池', async () => {
  const x = await makeProxy('x2'); const y = await makeProxy('y2');
  const resetTime = new Date(Date.now() + 30 * 1000).toISOString(); // 当前假时钟 + 30s
  x.ctl.fail = { status: 429, code: 'rate_limited', retryAfter: 30, body: 'upstream rate limited (reset at ' + resetTime + ')' };
  y.ctl.usagePct = 30;
  const env6 = envFor([x, y]);
  await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false } }), env6, {});
  let hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env6, {})).json();
  assert.equal(hz.proxies.find(p => p.name === 'x2').status, 'depleted');
  // 快进到 reset 之后 (reset=00:00:30Z, nextProbe=00:00:40Z)
  advance(60 * 1000);
  x.ctl.fail = null; x.ctl.usagePct = 5; // 恢复
  // 用新的客户端 key (未被钉住): 应重新探测到 x2 恢复并选它 (usage 5 < 30)
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 'testkey2' }), env6, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'x2');
  hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env6, {})).json();
  assert.equal(hz.proxies.find(p => p.name === 'x2').status, 'ok');
});

await t('S7 客户端错误 400 不 failover, 原样透传', async () => {
  const p = await makeProxy('p7');
  p.ctl.fail = { status: 400, code: 'invalid_json', body: 'request body must be a valid JSON object' };
  const env7 = envFor([p]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] } }), env7, {});
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error.code, 'invalid_json');
  assert.equal(p.ctl.chatHits, 1); // 只尝试一次
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
  p1.ctl.usagePct = 80; p2.ctl.usagePct = 10;
  const env9 = envFor([p1, p2], { PIN_MODE: 'header' });
  // 首次: 选 p2
  let res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-1' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), 'm2');
  // p2 变差后仍钉住 (pin 优先于余量)
  p2.ctl.usagePct = 99;
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-1' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), 'm2');
  // 状态过期后重新探测: 另一个会话没被钉住, 选余量更多的 m1
  advance(61 * 1000);
  res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] }, headers: { 'X-Sticky-Id': 'conv-2' } }), env9, {});
  assert.equal(res.headers.get('x-gateway-proxy'), 'm1');
  // models 聚合
  const mr = await worker.fetch(gwReq('/v1/models', { method: 'GET' }), env9, {});
  assert.equal(mr.status, 200);
  const mj = await mr.json();
  assert.ok(Array.isArray(mj.data) && mj.data.some(m => m.id === 'freebuff-1'));
});

await t('S10 403 banned → 长退避标记, failover 到别的 proxy', async () => {
  const p1 = await makeProxy('ban1'); const p2 = await makeProxy('ban2');
  p1.ctl.fail = { status: 403, code: 'account_banned', body: '{"status":"banned"}' };
  const env10 = envFor([p1, p2]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] } }), env10, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'ban2');
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env10, {})).json();
  assert.equal(hz.proxies.find(p => p.name === 'ban1').status, 'depleted');
  assert.equal(hz.proxies.find(p => p.name === 'ban1').reason, 'banned');
});

await t('S11 5xx → down + 退避, 不反复打挂掉的 proxy', async () => {
  const p1 = await makeProxy('d1'); const p2 = await makeProxy('d2');
  p1.ctl.fail = { status: 502, code: 'upstream_unavailable', body: 'bad gateway' };
  const env11 = envFor([p1, p2], { MAX_ATTEMPTS: '2' });
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [] } }), env11, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'd2');
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env11, {})).json();
  const d1 = hz.proxies.find(p => p.name === 'd1');
  assert.equal(d1.status, 'down');
  assert.ok(d1.next_probe && Date.parse(d1.next_probe) > Date.now());
});

await t('S12 网关 /healthz 全景 + 未配置 PROXIES 时 500', async () => {
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env1, {})).json();
  assert.equal(hz.proxies_total, 3);
  const fresh = await makeProxy('f1');
  const env12 = envFor([fresh]);
  const hz2 = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env12, {})).json();
  assert.ok(hz2.proxies.every(p => p.status === 'ok'));
  const bad = await worker.fetch(new Request('https://gw.example/healthz'), { GATEWAY_API_KEYS: 'k' }, {});
  assert.equal(bad.status, 500);
});

await t('S13 预判: healthz 显示模型会话额度耗尽 → 该 proxy 直接标记 depleted, 请求绕开它', async () => {
  const p1 = await makeProxy('q1'); const p2 = await makeProxy('q2');
  // q1: 模型会话额度 recent>=limit, 但日常用量 0 (proxy 自己还没报 429)
  p1.ctl.quota = { 'freebuff-1': { limit: 10, recentCount: 10, resetAtMs: Date.now() + 3600e3 } };
  p2.ctl.usagePct = 20;
  const env13 = envFor([p1, p2]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 'testkey2' }), env13, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'q2');
  assert.equal(p1.ctl.chatHits, 0, 'q1 不应收到任何 chat 请求');
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env13, {})).json();
  assert.equal(hz.proxies.find(p => p.name === 'q1').status, 'depleted');
  assert.equal(hz.proxies.find(p => p.name === 'q1').reason, 'model_quota');
});

await t('S14 预判: healthz 显示 proxy 冷却中 (CooldownUntil 未来) → 标记 depleted(cooldown)', async () => {
  const p1 = await makeProxy('c1'); const p2 = await makeProxy('c2');
  p1.ctl.cooldownUntilMs = Date.now() + 30 * 60e3; // 冷却 30 分钟
  p2.ctl.usagePct = 20;
  const env14 = envFor([p1, p2]);
  const res = await worker.fetch(gwReq('/v1/chat/completions', { body: { model: 'freebuff-1', messages: [], stream: false }, key: 'testkey2' }), env14, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-proxy'), 'c2');
  assert.equal(p1.ctl.chatHits, 0);
  const hz = await (await worker.fetch(gwReq('/healthz', { method: 'GET' }), env14, {})).json();
  assert.equal(hz.proxies.find(p => p.name === 'c1').status, 'depleted');
  assert.equal(hz.proxies.find(p => p.name === 'c1').reason, 'cooldown');
});

// 收尾
for (const m of allProxies) await m.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
