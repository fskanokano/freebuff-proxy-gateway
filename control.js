// Strongly-consistent control plane for freebuff-proxy-gateway.
// Durable Objects are globally unique, single-threaded, and persistent;
// this is intentionally used for pins, maintenance, runtime config, and
// logs instead of relying on caches.default (which is data-center local).
export class GatewayControl {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage || {};
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
        return json({ ok: true, length: list.length });
      }
      if (request.method === 'GET' && url.pathname === '/list') {
        const item = await this.storage.get(key);
        const value = item && item.expiresAt > Date.now() && Array.isArray(item.value) ? item.value : [];
        return json({ found: value.length > 0, value: value.slice(-Math.max(1, Math.min(1000, Number(url.searchParams.get('max') || 200)))) });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: String(error && error.message || error) }, 500);
    }
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
