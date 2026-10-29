import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameData, refreshPrices, loadOwnedMaterials, loadSalesVelocity, mapRecipe } from '../src/data.js';
import { cacheGet, cacheSet, _setBackend } from '../src/cache.js';

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body,
});

function memCache() {
  const m = new Map();
  return {
    cacheGet: async (k) => { const e = m.get(k); return e && e.exp > Date.now() ? e.v : undefined; },
    cacheSet: async (k, v, ttl) => { m.set(k, { v, exp: Date.now() + ttl }); },
    m,
  };
}

// Fake API: N recipes; recipe i makes item 1000+i from item 1 (x2) and currency 2.
function fakeApi(n = 450, log = []) {
  const recipeIds = Array.from({ length: n }, (_, i) => i + 1);
  const fn = async (url, init) => {
    log.push({ url, init });
    const u = new URL(url);
    const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number);
    const p = u.pathname.replace('/v2', '');
    if (p === '/recipes' && !u.searchParams.has('ids')) return json(recipeIds);
    if (p === '/recipes') {
      assert.equal(u.searchParams.get('v'), 'latest');
      assert.ok(ids.length <= 200);
      return json(ids.map((id) => id === 3
        ? { id, type: 'GuildConsumable', output_upgrade_id: 5, ingredients: [] }  // no output item
        : { id, output_item_id: 1000 + id, output_item_count: id % 2 ? 1 : 5, disciplines: ['Cook'], min_rating: 10,
            flags: ['AutoLearned'],
            ingredients: [{ type: 'Item', id: 1, count: 2 }, { type: 'Currency', id: 2, count: 3 }] }));
    }
    if (p === '/items') {
      assert.ok(ids.length <= 200);
      return json(ids.map((id) => ({ id, name: 'I' + id, icon: 'x', rarity: 'Fine', flags: ['NoSell'], type: 'Food' })));
    }
    if (p === '/commerce/prices') {
      assert.ok(ids.length <= 200);
      const found = ids.filter((id) => id % 3 !== 0);
      const body = found.map((id) => ({ id, buys: { unit_price: 10, quantity: 4 }, sells: { unit_price: 20, quantity: 7 } }));
      if (!found.length) return json({ text: 'all ids provided are invalid' }, 404);
      return json(body, found.length < ids.length ? 206 : 200);
    }
    return json({ text: 'no such endpoint' }, 404);
  };
  return fn;
}
const fast = { minIntervalMs: 0, sleepImpl: async () => {} };

test('loadGameData maps recipes, batches at 200, handles 206/404, reports progress', async () => {
  const log = [];
  const progress = [];
  const gd = await loadGameData({ fetchImpl: fakeApi(450, log), cache: memCache(), onProgress: (p) => progress.push(p), ...fast });

  assert.equal(gd.recipes.length, 449);            // recipe 3 has no output item
  const r = gd.recipes.find((x) => x.id === 2);
  assert.deepEqual(r, {
    id: 2, outputItemId: 1002, outputCount: 5, disciplines: ['Cook'], minRating: 10,
    ingredients: [{ type: 'Item', id: 1, count: 2 }, { type: 'Currency', id: 2, count: 3 }], flags: ['AutoLearned'],
  });
  assert.equal(gd.recipes.find((x) => x.id === 1).outputCount, 1);

  // 450 recipe ids -> 3 bulk calls (200,200,50)
  const rc = log.filter((l) => l.url.includes('/recipes?ids='));
  assert.equal(rc.length, 3);
  assert.deepEqual(rc.map((l) => new URL(l.url).searchParams.get('ids').split(',').length).sort((a, b) => a - b), [50, 200, 200]);

  // items: only Item-type ingredients + outputs (currency 2 excluded)
  assert.ok(gd.items.has(1) && gd.items.has(1001) && !gd.items.has(2));
  assert.deepEqual(gd.items.get(1), { id: 1, name: 'I1', icon: 'x', rarity: 'Fine', flags: ['NoSell'] });
  assert.equal(gd.items.size, 1 + 449);

  // prices: 206 partial results kept; ids divisible by 3 missing
  assert.deepEqual(gd.prices.get(1), { buyPrice: 10, sellPrice: 20, buyQuantity: 4, sellQuantity: 7 });
  assert.ok(!gd.prices.has(1005)); // 1005 % 3 === 0 -> not tradable
  assert.ok(gd.prices.has(1001));

  const stages = new Set(progress.map((p) => p.stage));
  assert.deepEqual([...stages].sort(), ['items', 'prices', 'recipes']);
  const lastItems = progress.filter((p) => p.stage === 'items').pop();
  assert.equal(lastItems.done, lastItems.total);
});

test('404 on an all-invalid price batch yields an empty list, not an error', async () => {
  const api = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/recipes') && !u.searchParams.has('ids')) return json([1]);
    if (u.pathname.endsWith('/recipes')) return json([{ id: 1, output_item_id: 9, ingredients: [{ type: 'Item', id: 8, count: 1 }] }]);
    if (u.pathname.endsWith('/items')) return json([{ id: 9, name: 'a', icon: '', rarity: 'Basic' }, { id: 8, name: 'b', icon: '', rarity: 'Basic' }]);
    return json({ text: 'all ids provided are invalid' }, 404);
  };
  const gd = await loadGameData({ fetchImpl: api, cache: memCache(), ...fast });
  assert.equal(gd.prices.size, 0);
  assert.equal(gd.recipes[0].outputCount, 1);
  assert.deepEqual(gd.items.get(9).flags, []);
});

test('mapRecipe tolerates the old ingredient schema and skips non-item outputs', () => {
  assert.deepEqual(mapRecipe({ id: 1, output_item_id: 5, ingredients: [{ item_id: 7, count: 2 }] }).ingredients,
    [{ type: 'Item', id: 7, count: 2 }]);
  assert.equal(mapRecipe({ id: 2, output_upgrade_id: 4 }), null);
});

test('recipes and items are cached; prices expire after TTL and refetch', async () => {
  const log = [];
  const cache = memCache();
  const api = fakeApi(10, log);
  await loadGameData({ fetchImpl: api, cache, ...fast });
  const first = log.length;
  await loadGameData({ fetchImpl: api, cache, ...fast });
  assert.equal(log.length, first, 'second load fully served from cache');

  // expire only prices
  cache.m.get('prices:v1').exp = Date.now() - 1;
  await loadGameData({ fetchImpl: api, cache, ...fast });
  const added = log.slice(first);
  assert.ok(added.length > 0 && added.every((l) => l.url.includes('/commerce/prices')));
});

test('refreshPrices refetches only prices for cached item ids; errors without cache', async () => {
  const log = [];
  const cache = memCache();
  const api = fakeApi(10, log);
  await assert.rejects(refreshPrices({ fetchImpl: api, cache, ...fast }), /loadGameData/);
  await loadGameData({ fetchImpl: api, cache, ...fast });
  const n = log.length;
  const prices = await refreshPrices({ fetchImpl: api, cache, ...fast });
  const added = log.slice(n);
  assert.ok(added.length >= 1 && added.every((l) => l.url.includes('/commerce/prices')));
  assert.ok(prices instanceof Map && prices.has(1));
});

test('429 is retried; abort signal stops loading', async () => {
  let calls = 0;
  const api = async (url) => {
    calls++;
    if (calls === 1) return json({}, 429);
    return json([]);
  };
  const gd = await loadGameData({ fetchImpl: api, cache: memCache(), ...fast, backoffMs: 0 });
  assert.equal(gd.recipes.length, 0);
  assert.ok(calls >= 2);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(loadGameData({ fetchImpl: fakeApi(5), cache: memCache(), signal: ac.signal, ...fast }), { name: 'AbortError' });
});

test('loadOwnedMaterials sums materials, bank and shared inventory, skipping null slots', async () => {
  const seen = [];
  const api = async (url, init) => {
    seen.push({ url, init });
    if (new URL(url).pathname.endsWith('/account/materials')) return json([{ id: 1, category: 5, count: 10 }, { id: 2, count: 0 }]);
    if (new URL(url).pathname.endsWith('/account/bank')) return json([null, { id: 1, count: 5 }, null, { id: 3, count: 1 }]);
    if (new URL(url).pathname.endsWith('/account/inventory')) return json([{ id: 1, count: 2 }, null]);
    return json({}, 404);
  };
  const owned = await loadOwnedMaterials('KEY-123', { fetchImpl: api, ...fast });
  assert.equal(owned.get(1), 17);
  assert.equal(owned.get(3), 1);
  assert.ok(!owned.has(2));
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => new URL(s.url).searchParams.get('access_token') === 'KEY-123'));
  // no custom headers at all => simple request => no CORS preflight
  assert.ok(seen.every((s) => s.init.headers === undefined && !('Authorization' in s.init)));
});

test('access_token is URL-encoded', async () => {
  let u;
  const api = async (url) => { u = url; return json([]); };
  await loadOwnedMaterials('a b&c=d', { fetchImpl: api, ...fast });
  assert.equal(new URL(u).searchParams.get('access_token'), 'a b&c=d');
});

test('loadOwnedMaterials errors name the endpoint, are readable, and never leak the key', async () => {
  const KEY = 'KEY-123';
  const cases = [
    [() => json({ text: 'Invalid access token ' + KEY }, 401), /account\/materials: invalid or insufficient key.*401/],
    [() => json({ text: 'requires scope inventories ' + KEY }, 403), /account\/materials: invalid or insufficient key.*403/],
    [() => json({ text: 'boom ' + KEY }, 500), /account\/materials failed: 500/],
    [(url) => { throw new TypeError('Load failed ' + url); }, /account\/materials: network or CORS error/],
  ];
  for (const [respond, re] of cases) {
    await assert.rejects(loadOwnedMaterials(KEY, { fetchImpl: async (url) => respond(url), retries: 0, ...fast }), (e) => {
      assert.match(e.message, re);
      assert.ok(!e.message.includes(KEY) && !e.message.includes('access_token'), e.message);
      return true;
    });
  }
  const api = async (url) => url.includes('/account/bank?') ? json({ text: 'x' }, 403) : json([]);
  await assert.rejects(loadOwnedMaterials(KEY, { fetchImpl: api, ...fast }), /account\/bank.*403/);
});

test('cache.js: get/set with TTL (memory fallback and injected backend)', async () => {
  await cacheSet('a', { x: 1 }, 10_000);
  assert.deepEqual(await cacheGet('a'), { x: 1 });
  await cacheSet('b', 1, -1);
  assert.equal(await cacheGet('b'), undefined);
  assert.equal(await cacheGet('missing'), undefined);

  const store = new Map();
  _setBackend({ get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } });
  await cacheSet('c', 5, 1000);
  assert.equal(store.get('c').value, 5);
  assert.equal(await cacheGet('c'), 5);
  _setBackend(null);
});

test('live smoke check against the real API (small sample)', { skip: !process.env.LIVE, timeout: 60000 }, async () => {
  // Wrap fetch so only a few recipes are loaded.
  const real = globalThis.fetch;
  const api = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v2/recipes' && !u.searchParams.has('ids')) return json([1, 2, 3, 4, 5, 7, 11]);
    return real(url, init);
  };
  const gd = await loadGameData({ fetchImpl: api, cache: memCache() });
  assert.ok(gd.recipes.length > 0);
  const r = gd.recipes[0];
  for (const k of ['id', 'outputItemId', 'outputCount', 'disciplines', 'minRating', 'ingredients', 'flags']) assert.ok(k in r, k);
  for (const g of r.ingredients) assert.ok(['Item', 'Currency', 'GuildUpgrade'].includes(g.type));
  for (const rec of gd.recipes) assert.ok(gd.items.has(rec.outputItemId));
  const it = gd.items.values().next().value;
  assert.equal(typeof it.name, 'string');
  assert.ok(Array.isArray(it.flags));
  console.log('live:', gd.recipes.length, 'recipes', gd.items.size, 'items', gd.prices.size, 'prices');
  console.log(JSON.stringify(r), JSON.stringify(it), JSON.stringify([...gd.prices][0]));
  const p = [...gd.prices.values()][0];
  if (p) for (const k of ['buyPrice', 'sellPrice', 'buyQuantity', 'sellQuantity']) assert.equal(typeof p[k], 'number');
});

test('loadSalesVelocity maps sell-side fields and caches', async () => {
  const body = [{ id: 5, '1d_sell_sold': 10, '7d_sell_sold': 70, '1d_buy_sold': 99 }, { id: 6, '1d_sell_sold': 0, '7d_sell_sold': 0 }];
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.match(url, /datawars2/); return json(body); };
  const cache = memCache();
  const m = await loadSalesVelocity({ fetchImpl, cache });
  assert.deepEqual(m.get(5), { sold1d: 10, sold7d: 70 });
  assert.deepEqual(m.get(6), { sold1d: 0, sold7d: 0 });
  const again = await loadSalesVelocity({ fetchImpl: async () => { throw new Error('no'); }, cache });
  assert.equal(calls, 1);
  assert.equal(again.size, 2);
});

test('loadSalesVelocity returns an empty Map on any failure', async () => {
  const cache = memCache();
  for (const fetchImpl of [
    async () => json({}, 500),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
    async () => json({ not: 'an array' }),
  ]) {
    const m = await loadSalesVelocity({ fetchImpl, cache });
    assert.ok(m instanceof Map);
    assert.equal(m.size, 0);
  }
});
