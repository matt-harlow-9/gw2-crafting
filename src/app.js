import { loadGameData, refreshPrices, loadOwnedMaterials, loadSalesVelocity } from './data.js';
import { computeRowsWithExclusions, getIngredientTree } from './pricing.js';
import { mockGameData } from './mock.js';

const USE_MOCK = new URLSearchParams(location.search).has('mock');
const ROW_H = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 54;
const $ = (id) => document.getElementById(id);

const state = {
  game: null,
  owned: null,
  pricing: 'buyOrder',
  hideUnlock: false,
  onlyProfit: false,
  discipline: '',
  minVol: 25,
  minSold: 10,
  velocity: null,   // Map once Datawars2 data arrives; empty on failure
  search: '',
  sort: { key: 'profit', dir: 'desc' },
  rows: [],      // all computed rows
  view: [],      // filtered + sorted
  excluded: 0,
  updated: null,
};

// ---------- formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat();

export function coin(copper, { signed = false } = {}) {
  const v = Math.round(copper || 0);
  const neg = v < 0;
  const a = Math.abs(v);
  const g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), c = a % 100;
  const parts = [];
  if (g) parts.push(`<span class="g">${nf.format(g)}g</span>`);
  if (g || s) parts.push(`<span class="s">${s}s</span>`);
  parts.push(`<span class="c">${c}c</span>`);
  // drop trailing zero units ("8,500g 0s 0c" -> "8,500g"), but keep a lone "0c"
  if (a >= 100) {
    if (!c) parts.pop();
    if (!c && !s && g) parts.pop();
  }
  const sign = neg ? '-' : signed && v > 0 ? '+' : '';
  return `${sign}${parts.join(' ')}`;
}
const pct = (m) => (m > 99.99 ? '>9,999%' : `${nf.format(+(m * 100).toFixed(1))}%`);
const volume = (r) => Math.min(r.buyQuantity, r.sellQuantity);
const rarityColor = (r) => `var(--r-${/^[A-Za-z]+$/.test(r) ? r : 'Basic'})`;

// ---------- columns ----------
const COLS = [
  { key: 'name', label: 'Item', get: (r) => r.name.toLowerCase(), dir: 'asc' },
  { key: 'discipline', label: 'Discipline', cls: 'hide-md', get: (r) => r.disciplines.join(', '), dir: 'asc' },
  { key: 'craftCost', label: 'Craft cost', cls: 'num hide-md', get: (r) => r.craftCost },
  { key: 'net', label: 'Net sell', cls: 'num hide-sm', get: (r) => r.netSellPrice },
  { key: 'profit', label: 'Profit', cls: 'num', get: (r) => r.profit },
  { key: 'margin', label: 'Margin', cls: 'num', get: (r) => r.margin },
  { key: 'volume', label: 'Volume', cls: 'num hide-sm', get: volume },
  { key: 'sold', label: 'Sold/day', cls: 'num hide-sm', get: (r) => r.soldPerDay ?? -1 },
];

function renderHead() {
  $('thead').innerHTML = COLS.map((c) => {
    const s = state.sort.key === c.key ? ` aria-sort="${state.sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<button type="button" class="${c.cls || ''}" data-key="${c.key}"${s}>${esc(c.label)}</button>`;
  }).join('');
}
$('thead').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-key]');
  if (!b) return;
  const col = COLS.find((c) => c.key === b.dataset.key);
  if (state.sort.key === col.key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key: col.key, dir: col.dir || 'desc' };
  renderHead();
  applyView();
});

// ---------- compute / filter / sort ----------
function options() {
  return { ingredientPricing: state.pricing, hideUnlockRequired: state.hideUnlock, owned: state.owned || undefined, velocity: state.velocity || undefined };
}

function recompute() {
  if (!state.game) return;
  const res = computeRowsWithExclusions(state.game, options());
  state.rows = res.rows;
  state.excluded = res.excluded;
  const discs = [...new Set(state.rows.flatMap((r) => r.disciplines))].sort();
  const sel = $('discipline');
  sel.innerHTML = '<option value="">All disciplines</option>' + discs.map((d) => `<option>${esc(d)}</option>`).join('');
  if (discs.includes(state.discipline)) sel.value = state.discipline; else state.discipline = '';
  $('excluded').textContent = `${nf.format(state.excluded)} recipes excluded (unpriceable ingredients)`;
  applyView();
}

function applyView() {
  const q = state.search.trim().toLowerCase();
  let v = state.rows.filter((r) =>
    (!state.discipline || r.disciplines.includes(state.discipline)) &&
    volume(r) >= state.minVol &&
    (r.soldPerDay == null || r.soldPerDay >= state.minSold) &&
    (!state.onlyProfit || r.profit > 0) &&
    (!q || r.name.toLowerCase().includes(q)));
  const col = COLS.find((c) => c.key === state.sort.key);
  const m = state.sort.dir === 'asc' ? 1 : -1;
  v = v.map((r) => [col.get(r), r]);
  v.sort((a, b) => (a[0] < b[0] ? -m : a[0] > b[0] ? m : b[1].profit - a[1].profit));
  state.view = v.map((x) => x[1]);
  $('count').textContent = `${nf.format(state.view.length)} of ${nf.format(state.rows.length)} recipes`;
  $('velNote').hidden = !state.game || state.velocity === null || state.velocity.size > 0;
  $('empty').hidden = state.view.length > 0 || !state.game;
  $('scroller').scrollTop = 0;
  layout();
}

// ---------- virtual list ----------
let rowH = 54;
function layout() {
  rowH = ROW_H();
  $('spacer').style.height = state.view.length * rowH + 'px';
  paint();
}
function paint() {
  const sc = $('scroller');
  const first = Math.max(0, Math.floor(sc.scrollTop / rowH) - 4);
  const last = Math.min(state.view.length, Math.ceil((sc.scrollTop + sc.clientHeight) / rowH) + 4);
  const rows = $('rows');
  rows.style.transform = `translateY(${first * rowH}px)`;
  let html = '';
  for (let i = first; i < last; i++) html += rowHtml(state.view[i], i);
  rows.innerHTML = html;
}
function rowHtml(r, i) {
  const icon = r.icon ? `<img src="${esc(r.icon)}" alt="" loading="lazy" width="34" height="34">` : '<span class="ph"></span>';
  const owned = r.usesOwned ? '<span class="tag own">owned</span>' : '';
  return `<div class="row" role="row" tabindex="0" data-i="${i}">
    <div class="item">${icon}<div class="t"><div class="n" style="color:${rarityColor(r.rarity)}">${esc(r.name)}${owned}</div><div class="s">Rating ${r.minRating}</div></div></div>
    <div class="disc hide-md" title="${esc(r.disciplines.join(', '))}">${esc(r.disciplines.join(', '))}</div>
    <div class="num hide-md">${coin(r.craftCost)}</div>
    <div class="num hide-sm">${coin(r.netSellPrice)}<span class="m">gross ${coin(r.grossSellPrice)}</span></div>
    <div class="num ${r.profit >= 0 ? 'pos' : 'neg'}">${coin(r.profit, { signed: true })}</div>
    <div class="num ${r.margin >= 0 ? 'pos' : 'neg'}">${pct(r.margin)}</div>
    <div class="num hide-sm">${nf.format(volume(r))}<span class="m">${nf.format(r.buyQuantity)} buy / ${nf.format(r.sellQuantity)} sell</span></div>
    <div class="num hide-sm">${r.soldPerDay == null ? 'n/a' : nf.format(r.soldPerDay)}</div>
  </div>`;
}
let raf = 0;
$('scroller').addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }, { passive: true });
addEventListener('resize', () => { if (state.game) layout(); });

$('rows').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) openDetail(state.view[+r.dataset.i]); });
$('rows').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) { e.preventDefault(); openDetail(state.view[+e.target.dataset.i]); }
});

// ---------- detail ----------
function treeHtml(n) {
  const icon = n.icon ? `<img src="${esc(n.icon)}" alt="" width="20" height="20" style="vertical-align:middle;border-radius:4px"> ` : '';
  const tag = n.mode === 'craft' ? '<span class="tag craft">craft</span>' : n.mode === 'owned' ? '<span class="tag own">owned</span>' : '<span class="tag">buy</span>';
  const kids = n.children && n.children.length ? `<ul>${n.children.map(treeHtml).join('')}</ul>` : '';
  return `<li><div class="l"><span>${icon}${nf.format(n.count)} × ${esc(n.name)}${tag}</span><span class="num">${coin(n.totalCost)}<span class="m">${coin(n.unitCost)} each</span></span></div>${kids}</li>`;
}
function openDetail(r) {
  if (!r) return;
  $('dTitle').textContent = r.name;
  let tree = '';
  try {
    const t = getIngredientTree(state.game, r.recipeId, options());
    tree = `<h3>Ingredients</h3><ul class="tree">${treeHtml(t)}</ul>`;
  } catch (err) {
    tree = `<p class="err">Could not build the ingredient tree: ${esc(err.message)}</p>`;
  }
  $('dBody').innerHTML = `<div class="kv">
    <div><b>Craft cost / unit</b>${coin(r.craftCost)}</div>
    <div><b>Sell price</b>${coin(r.grossSellPrice)}</div>
    <div><b>After 15% fees</b>${coin(r.netSellPrice)}</div>
    <div><b>Profit</b><span class="${r.profit >= 0 ? 'pos' : 'neg'}">${coin(r.profit, { signed: true })}</span></div>
    <div><b>Margin</b>${pct(r.margin)}</div>
    <div><b>Demand / supply</b>${nf.format(r.buyQuantity)} / ${nf.format(r.sellQuantity)}</div>
    <div><b>Sold per day</b>${r.soldPerDay == null ? 'n/a' : nf.format(r.soldPerDay)}</div>
    <div><b>Disciplines</b>${esc(r.disciplines.join(', '))}</div>
    <div><b>Min rating</b>${r.minRating}</div></div>${tree}`;
  const d = $('detail');
  if (!d.open) d.showModal();
}
$('dClose').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });

// ---------- controls ----------
function setPricing(p) {
  state.pricing = p;
  $('pBuy').setAttribute('aria-pressed', p === 'buyOrder');
  $('pInstant').setAttribute('aria-pressed', p === 'instantBuy');
  recompute();
}
$('pBuy').onclick = () => setPricing('buyOrder');
$('pInstant').onclick = () => setPricing('instantBuy');
$('hideUnlock').onchange = (e) => { state.hideUnlock = e.target.checked; recompute(); };
$('onlyProfit').onchange = (e) => { state.onlyProfit = e.target.checked; applyView(); };
$('discipline').onchange = (e) => { state.discipline = e.target.value; applyView(); };
$('minSold').oninput = (e) => { state.minSold = Math.max(0, +e.target.value || 0); applyView(); };
$('minVol').oninput = (e) => { state.minVol = Math.max(0, +e.target.value || 0); applyView(); };
let st = 0;
$('search').oninput = (e) => { clearTimeout(st); st = setTimeout(() => { state.search = e.target.value; applyView(); }, 120); };

function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch {} }
$('theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  setTheme(cur === 'dark' ? 'light' : 'dark');
};

function stamp() {
  state.updated = new Date();
  $('updated').textContent = `Prices updated ${state.updated.toLocaleTimeString()}`;
}
$('refresh').onclick = async () => {
  const b = $('refresh'); b.disabled = true; b.textContent = 'Refreshing…';
  try {
    const p = USE_MOCK ? jitterPrices() : await refreshPrices();
    state.game.prices = p;
    stamp(); recompute();
  } catch (e) { $('updated').textContent = `Refresh failed: ${e.message}`; }
  b.disabled = false; b.textContent = 'Refresh prices';
};
function jitterPrices() {
  const out = new Map();
  for (const [id, p] of state.game.prices) {
    const f = () => 1 + (Math.random() - 0.5) * 0.1;
    out.set(id, { ...p, buyPrice: Math.round(p.buyPrice * f()), sellPrice: Math.round(p.sellPrice * f()) });
  }
  return out;
}

$('loadOwned').onclick = async () => {
  const input = $('apiKey'), key = input.value.trim(), status = $('ownedStatus');
  if (!key) { state.owned = null; status.textContent = 'Owned materials cleared.'; recompute(); return; }
  status.textContent = 'Loading…'; $('loadOwned').disabled = true;
  try {
    const owned = USE_MOCK ? new Map([[102, 20], [201, 2]]) : await loadOwnedMaterials(key);
    state.owned = owned;
    input.value = '';
    status.textContent = `Loaded ${nf.format(owned.size)} item types. Owned units now cost 0.`;
    recompute();
  } catch (e) { status.textContent = `Failed: ${e.message}`; }
  $('loadOwned').disabled = false;
};

// ---------- loading ----------
function onProgress({ stage, done, total }) {
  const el = document.querySelector(`.step[data-stage="${stage}"]`);
  if (!el) return;
  const p = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  el.querySelector('i').style.width = p + '%';
  el.querySelector('.lab span:last-child').textContent = total ? `${nf.format(done)} / ${nf.format(total)}` : '…';
  el.classList.toggle('ok', total > 0 && done >= total);
}
async function init() {
  $('loadErr').hidden = true; $('retry').hidden = true;
  $('loader').hidden = false;
  try {
    if (USE_MOCK) {
      $('mockBadge').hidden = false;
      for (const stage of ['recipes', 'items', 'prices']) { onProgress({ stage, done: 1, total: 2 }); await new Promise((r) => setTimeout(r, 80)); onProgress({ stage, done: 2, total: 2 }); }
      state.game = { ...mockGameData, prices: new Map(mockGameData.prices) };
    } else {
      state.game = await loadGameData({ onProgress });
    }
    stamp();
    $('loader').hidden = true;
    recompute();
    // Background: sales velocity must never block or break the first render.
    state.velocity = USE_MOCK ? new Map() : await loadSalesVelocity();
    recompute();
  } catch (e) {
    $('loadErr').textContent = `Could not load game data: ${e.message}`;
    $('loadErr').hidden = false; $('retry').hidden = false;
  }
}
$('retry').onclick = init;

renderHead();
init();
