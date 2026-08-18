// Strongly-consistent control plane for freebuff-proxy-gateway.
// Durable Objects are globally unique, single-threaded, and persistent;
// this is intentionally used for pins, maintenance, runtime config, and
// logs instead of relying on caches.default (which is data-center local).

// 定时清理间隔: 定期删除已过期 key (pins / lastused / 日志等), 防止 Durable Object
// 被持久化日志与过期状态打满。DO 的 alarm 在实例空闲时也会唤醒执行 GC。
const GC_INTERVAL_MS = 60 * 60 * 1000; // 1 小时

export class GatewayControl {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage || {};
    this.env = env;
    this._alarmUntil = 0; // 内存缓存: 已排期的 alarm 时间, 避免每次写都查 storage
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    try {
      if (request.method === 'GET' && url.pathname === '/get') {
        const item = await this.storage.get(key);
        if (!item || (item.expiresAt && item.expiresAt <= Date.now())) {
          if (item) await this.storage.delete(key);
          return json({ found: false });
        }
        return json({ found: true, value: item.value });
      }
      if (request.method === 'PUT' && url.pathname === '/put') {
        const body = await request.json();
        const ttl = Math.max(1, Number(body.ttl || 86400));
        await this.storage.put(key, { value: body.value, expiresAt: Date.now() + ttl * 1000 });
        await this.ensureAlarm();
        return json({ ok: true });
      }
      if (request.method === 'DELETE' && url.pathname === '/delete') {
        await this.storage.delete(key);
        return json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/append') {
        const body = await request.json();
        const max = Math.max(1, Math.min(1000, Number(body.max || 200)));
        const ttl = Math.max(1, Number(body.ttl || 86400));
        const old = await this.storage.get(key);
        let list = old && old.expiresAt > Date.now() && Array.isArray(old.value) ? old.value : [];
        const incoming = Array.isArray(body.item) ? body.item : [body.item];
        list = [...list, ...incoming].slice(-max);
        await this.storage.put(key, { value: list, expiresAt: Date.now() + ttl * 1000 });
        await this.ensureAlarm();
        return json({ ok: true, length: list.length });
      }
      if (request.method === 'GET' && url.pathname === '/list') {
        const item = await this.storage.get(key);
        const value = item && item.expiresAt > Date.now() && Array.isArray(item.value) ? item.value : [];
        return json({ found: value.length > 0, value: value.slice(-Math.max(1, Math.min(1000, Number(url.searchParams.get('max') || 200)))) });
      }
      // 手动触发一次 GC (管理/测试用)
      if (request.method === 'POST' && url.pathname === '/gc') {
        const removed = await this.gc();
        return json({ ok: true, removed });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: String(error && error.message || error) }, 500);
    }
  }

  // Durable Object 定时清理: 删除所有已过期 key (TTL 到期但尚未被惰性回收的条目),
  // 并在结束时重新排期下一次 GC。alarm 由 Cloudflare 在到期时自动调用。
  async alarm() {
    try {
      await this.gc();
    } finally {
      try {
        await this.storage.setAlarm(Date.now() + GC_INTERVAL_MS);
        this._alarmUntil = Date.now() + GC_INTERVAL_MS;
      } catch (e) { /* 尽力而为 */ }
    }
  }

  // 确保 GC alarm 已排期。只在写操作后调用 (读热路径不额外开销);
  // 用实例内存缓存避免每次写都查 storage。
  async ensureAlarm() {
    const now = Date.now();
    if (this._alarmUntil > now) return;
    try {
      const existing = await this.storage.getAlarm();
      if (existing === null || existing === undefined || existing <= now) {
        const until = now + GC_INTERVAL_MS;
        await this.storage.setAlarm(until);
        this._alarmUntil = until;
      } else {
        this._alarmUntil = existing;
      }
    } catch (e) { /* 尽力而为: 无 alarm 支持的环境跳过 */ }
  }

  async gc() {
    const now = Date.now();
    let removed = 0;
    try {
      if (typeof this.storage.list !== 'function') return removed;
      const all = await this.storage.list();
      for (const [k, item] of all) {
        if (!item || (item.expiresAt && item.expiresAt <= now)) {
          try { await this.storage.delete(k); removed++; } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) { /* 尽力而为 */ }
    return removed;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
