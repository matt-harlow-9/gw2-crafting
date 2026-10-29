// Tiny async key/value cache with TTL. IndexedDB when available, otherwise in-memory.
const DB_NAME = 'gw2-crafting-cache';
const STORE = 'kv';

const memory = new Map();
let backendOverride = null;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) return resolve(null);
      const rq = idb.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const wrap = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

async function rawGet(key) {
  if (backendOverride) return backendOverride.get(key);
  const db = await openDb();
  if (db) {
    try { return await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(key)); } catch { /* fall through */ }
  }
  return memory.get(key);
}

async function rawSet(key, entry) {
  if (backendOverride) return backendOverride.set(key, entry);
  const db = await openDb();
  if (db) {
    try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, key)); return; } catch { /* fall through */ }
  }
  memory.set(key, entry);
}

/** Returns the stored value, or undefined if missing or expired. */
export async function cacheGet(key) {
  const e = await rawGet(key);
  if (!e || typeof e.expires !== 'number' || e.expires <= Date.now()) return undefined;
  return e.value;
}

/** Stores value for ttlMs milliseconds. */
export async function cacheSet(key, value, ttlMs) {
  await rawSet(key, { value, expires: Date.now() + ttlMs });
}

/** Test hook: replace the storage backend with { get(key), set(key, entry) } (null restores default). */
export function _setBackend(backend) { backendOverride = backend; }
/** Clear the in-memory fallback. */
export function _clearMemory() { memory.clear(); }
