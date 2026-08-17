// 本地预览: 提供 /admin (真实 ADMIN_HTML) + mock 管理 API, 方便浏览器查看 UI 效果
// 运行: node preview.mjs  →  浏览器打开 http://127.0.0.1:8788/admin
import http from 'node:http';
import { ADMIN_HTML } from './admin.js';

const now = Date.now();
const iso = ms => ms ? new Date(ms).toISOString() : null;

const fakeOverview = {
  status: 'ok',
  stats: { total: 3, ok: 2, depleted: 1, down: 0, requestsOk: 1284, requestsFail: 23 },
  proxies: [
    {
      name: 'proxy-a', url: 'https://proxy-a.workers.dev', status: 'ok', maint: false,
      reason: '', detail: 'ok (usagePct=35) (probe 12ms)', score: 35, usage_pct: 35, risk: 'low',
      cooldown_until: null, reset_at: iso(now + 7 * 3600e3), retry_after_s: null,
      next_probe: iso(now + 42e3), last_ok: iso(now - 18e3), last_error: null,
      consecutive_errors: 0, requestsOk: 812, requestsFail: 4,
      quota: { 'freebuff-1': { limit: 100, recent_count: 35, reset_at: iso(now + 7 * 3600e3), period: 'pacific_day' } },
    },
    {
      name: 'proxy-b', url: 'https://proxy-b.vercel.app', status: 'ok', maint: false,
      reason: '', detail: 'ok (usagePct=12) (probe 8ms)', score: 12, usage_pct: 12, risk: 'low',
      cooldown_until: null, reset_at: iso(now + 7 * 3600e3), retry_after_s: null,
      next_probe: iso(now + 51e3), last_ok: iso(now - 9e3), last_error: null,
      consecutive_errors: 0, requestsOk: 420, requestsFail: 2,
      quota: { 'freebuff-1': { limit: 100, recent_count: 12, reset_at: iso(now + 7 * 3600e3), period: 'pacific_day' } },
    },
    {
      name: 'proxy-c', url: 'https://proxy-c.runsite.app', status: 'depleted', maint: false,
      reason: 'rate_limited', detail: 'rate_limited from proxy (retryAfter=120s)', score: 100, usage_pct: 100, risk: 'high',
      cooldown_until: null, reset_at: iso(now + 2 * 3600e3), retry_after_s: 120,
      next_probe: iso(now + 2 * 3600e3 + 10e3), last_ok: iso(now - 40 * 60e3), last_error: iso(now - 90e3),
      consecutive_errors: 3, requestsOk: 52, requestsFail: 17,
      quota: { 'freebuff-1': { limit: 100, recent_count: 100, reset_at: iso(now + 2 * 3600e3), period: 'pacific_day' } },
    },
  ],
  events: [
    { t: now - 90e3, type: 'failover', name: 'proxy-c', from: 'ok', to: 'depleted', code: 'rate_limited', status: 429 },
    { t: now - 95e3, type: 'status_change', name: 'proxy-c', from: 'ok', to: 'depleted', reason: 'rate_limited', detail: 'ok' },
    { t: now - 6 * 60e3, type: 'probe_failed', name: 'proxy-a', status: 'unknown', err: 'healthz HTTP 503' },
    { t: now - 12 * 60e3, type: 'maintenance', name: 'proxy-b', on: false },
    { t: now - 25 * 60e3, type: 'admin_action', action: 'probe', name: 'proxy-a', result: 'ok' },
    { t: now - 30 * 60e3, type: 'smoke', model: 'freebuff-1', status: 200, proxy: 'proxy-b', ms: 1843 },
    { t: now - 60 * 60e3, type: 'status_change', name: 'proxy-b', from: 'unknown', to: 'ok', reason: '', detail: 'ok (usagePct=12)' },
  ],
  timestamp: new Date().toISOString(),
};

const fakeConfig = {
  config: {
    proxies: ['proxy-a @ https://proxy-a.workers.dev', 'proxy-b @ https://proxy-b.vercel.app', 'proxy-c @ https://proxy-c.runsite.app'],
    pin_mode: 'client', pin_ttl: 3600, state_ttl: 60, depleted_probe: 300, down_probe: 120,
    probe_timeout: 3000, max_attempts: 3,
    admin_uses_api_key: true, admin_key_masked: null,
    api_key_masked: 'cli…789, cli…012', proxy_keys_masked: 'gw…111, gw…222, gw…333',
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return;
  }
  if (url.pathname === '/admin/api/overview') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fakeOverview));
    return;
  }
  if (url.pathname === '/admin/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fakeConfig));
    return;
  }
  if (url.pathname === '/admin/api/probe' || url.pathname === '/admin/api/maintenance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/admin/api/smoke') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 200, ok: true, proxy: 'proxy-b', attempts: 1, ms: 1843, content: '你好！这是一个来自 freebuff-1 的测试回复。', error: '' }));
    return;
  }
  if (url.pathname === '/admin/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'freebuff-1', object: 'model', created: 1, owned_by: 'freebuff', available: true, status: 'available' },
      { id: 'freebuff-1-mini', object: 'model', created: 1, owned_by: 'freebuff', available: true, status: 'available' },
    ] }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(8788, '127.0.0.1', () => console.log('preview: http://127.0.0.1:8788/admin'));
