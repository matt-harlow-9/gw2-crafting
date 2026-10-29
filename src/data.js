// Data layer: GW2 API access, mapping to contract shapes, caching.
import { cacheGet, cacheSet } from './cache.js';

const BASE = 'https://api.guildwars2.com/v2';
const CHUNK = 200;
const DAY = 24 * 60 * 60 * 1000;
export const STATIC_TTL_MS = 7 * DAY;
export const PRICE_TTL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 110;   // ~545 requests/minute, under the 600/min limit
const CONCURRENCY = 4;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };

function getFetch(opts) {
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('No fetch implementation available');
  return f;
}

// Shared request-start spacing so concurrent workers stay under the rate limit.
function makeLimiter(opts) {
  const interval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const sleep = opts.sleepImpl || defaultSleep;
  let nextSlot = 0;
  return async () => {
    if (interval <= 0) return;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + interval;
    if (at > now) await sleep(at - now);
  };
}

function makeClient(opts) {
  const f = getFetch(opts);
  const sleep = opts.sleepImpl || defaultSleep;
  const limit = makeLimiter(opts);
  const retries = opts.retries ?? 4;
  const backoff = opts.backoffMs ?? 1000;

  /** GET json. Returns parsed body. 404 on an ids= request => []. 206 is accepted. */
  async function getJSON(path, { key, signal, label } = {}) {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      await limit();
      checkAbort(signal);
      const init = { signal };
      if (key) init.headers = { Authorization: 'Bearer ' + key };
      let res;
      try {
        res = await f(BASE + path, init);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (attempt < retries) { await sleep(backoff * (attempt + 1)); continue; }
        throw new Error(`${label || path} failed: ${err.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(backoff * (attempt + 1));
        continue;
      }
      if (res.status === 404 && !key && path.includes('ids=')) return [];
      if (!res.ok && res.status !== 206) {
        let msg = res.statusText || '';
        try { msg = (await res.json()).text || msg; } catch { /* ignore */ }
        throw new Error(`${label || path} failed: ${res.status}${msg ? ' ' + msg : ''}`);
      }
      return res.json();
    }
  }

  /** Bulk fetch ids in chunks of 200. Returns flat array of results. */
  async function bulk(endpoint, ids, { extra = '', signal, onProgress } = {}) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const out = [];
    let next = 0, done = 0;
    onProgress?.(0, chunks.length);
    async function worker() {
      while (next < chunks.length) {
        const c = chunks[next++];
        const body = await getJSON(`${endpoint}?ids=${c.join(',')}${extra}`, { signal });
        if (Array.isArray(body)) for (const x of body) out.push(x);
        onProgress?.(++done, chunks.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    return out;
  }

  return { getJSON, bulk };
}

// ---------- Mapping ----------
export function mapRecipe(r) {
  if (r == null || r.output_item_id == null) return null;   // guild upgrade outputs etc.
  const ingredients = (r.ingredients || []).map((g) => (
    g.item_id != null && g.type == null
      ? { type: 'Item', id: g.item_id, count: g.count }       // tolerate the old schema
      : { type: g.type || 'Item', id: g.id, count: g.count }
  ));
  return {
    id: r.id,
    outputItemId: r.output_item_id,
    outputCount: r.output_item_count || 1,
    disciplines: r.disciplines || [],
    minRating: r.min_rating || 0,
    ingredients,
    flags: r.flags || [],
  };
}

export function mapItem(i) {
  return { id: i.id, name: i.name, icon: i.icon, rarity: i.rarity, flags: i.flags || [] };
}

export function mapPrice(p) {
  return {
    buyPrice: p.buys?.unit_price || 0,
    sellPrice: p.sells?.unit_price || 0,
    buyQuantity: p.buys?.quantity || 0,
    sellQuantity: p.sells?.quantity || 0,
  };
}

function itemIdsOf(recipes) {
  const ids = new Set();
  for (const r of recipes) {
    ids.add(r.outputItemId);
    for (const g of r.ingredients) if (g.type === 'Item') ids.add(g.id);
  }
  return [...ids].sort((a, b) => a - b);
}

// ---------- Cache wrappers (never let a cache failure break loading) ----------
const KEY_RECIPES = 'recipes:v1';
const KEY_ITEMS = 'items:v1';
const KEY_PRICES = 'prices:v1';

async function cget(opts, key) {
  try { return await (opts.cache?.cacheGet || cacheGet)(key); } catch { return undefined; }
}
async function cset(opts, key, value, ttl) {
  try { await (opts.cache?.cacheSet || cacheSet)(key, value, ttl); } catch { /* ignore */ }
}

async function fetchPrices(client, ids, signal, onProgress) {
  const rows = await client.bulk('/commerce/prices', ids, { signal, onProgress });
  return new Map(rows.map((p) => [p.id, mapPrice(p)]));
}

// ---------- Public API ----------
export async function loadGameData(opts = {}) {
  const { onProgress, signal } = opts;
  const client = makeClient(opts);
  const prog = (stage) => (done, total) => onProgress?.({ stage, done, total });

  // Recipes
  let recipes = await cget(opts, KEY_RECIPES);
  if (!recipes) {
    prog('recipes')(0, 1);
    const ids = await client.getJSON('/recipes', { signal, label: '/recipes' });
    const raw = await client.bulk('/recipes', ids, { extra: '&v=latest', signal, onProgress: prog('recipes') });
    recipes = raw.map(mapRecipe).filter(Boolean).sort((a, b) => a.id - b.id);
    await cset(opts, KEY_RECIPES, recipes, STATIC_TTL_MS);
  } else {
    prog('recipes')(1, 1);
  }
  checkAbort(signal);

  // Items
  const itemIds = itemIdsOf(recipes);
  let itemList = await cget(opts, KEY_ITEMS);
  if (!itemList) {
    const raw = await client.bulk('/items', itemIds, { signal, onProgress: prog('items') });
    itemList = raw.map(mapItem).sort((a, b) => a.id - b.id);
    await cset(opts, KEY_ITEMS, itemList, STATIC_TTL_MS);
  } else {
    prog('items')(1, 1);
  }
  const items = new Map(itemList.map((i) => [i.id, i]));
  checkAbort(signal);

  // Prices
  let prices;
  const cachedPrices = await cget(opts, KEY_PRICES);
  if (cachedPrices) {
    prices = new Map(cachedPrices);
    prog('prices')(1, 1);
  } else {
    prices = await fetchPrices(client, itemIds, signal, prog('prices'));
    await cset(opts, KEY_PRICES, [...prices], PRICE_TTL_MS);
  }

  return { recipes, items, prices };
}

export async function refreshPrices(opts = {}) {
  const { signal } = opts;
  const client = makeClient(opts);
  let itemList = await cget(opts, KEY_ITEMS);
  let ids;
  if (itemList) {
    ids = itemList.map((i) => i.id);
  } else {
    const recipes = await cget(opts, KEY_RECIPES);
    if (!recipes) throw new Error('refreshPrices: game data not loaded yet; call loadGameData first');
    ids = itemIdsOf(recipes);
  }
  const prices = await fetchPrices(client, ids, signal);
  await cset(opts, KEY_PRICES, [...prices], PRICE_TTL_MS);
  return prices;
}

export async function loadOwnedMaterials(apiKey, opts = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('API key is required');
  const { signal } = opts;
  const client = makeClient(opts);
  const owned = new Map();
  const add = (id, n) => { if (id != null && n > 0) owned.set(id, (owned.get(id) || 0) + n); };

  for (const ep of ['account/materials', 'account/bank', 'account/inventory']) {
    let body;
    try {
      body = await client.getJSON('/' + ep, { key: apiKey, signal, label: ep });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // err.message already names the endpoint; make sure the key never leaks.
      throw new Error(String(err.message).split(apiKey).join('***'));
    }
    if (!Array.isArray(body)) throw new Error(`${ep} failed: unexpected response`);
    for (const slot of body) if (slot) add(slot.id, slot.count);
  }
  return owned;
}
