// Pricing core: pure functions, no I/O. All prices are integer copper (internal
// per-unit costs may be fractional when outputCount > 1; rows round them).

export const TP_LISTING_FEE = 0.05;
export const TP_SALE_FEE = 0.10;

export function netSellPrice(sellPrice) {
  if (!(sellPrice > 0)) return 0;
  return (
    sellPrice -
    Math.max(1, Math.ceil(sellPrice * TP_LISTING_FEE)) -
    Math.max(1, Math.ceil(sellPrice * TP_SALE_FEE))
  );
}

const INF = Infinity;

// Shared engine: memoised per item (not per recipe), with cycle guards.
function createEngine(gameData, options = {}) {
  const instant = options.ingredientPricing === 'instantBuy';
  const hideLocked = !!options.hideUnlockRequired;
  const owned = options.owned instanceof Map ? options.owned : null;
  const { prices } = gameData;

  const byOutput = new Map();
  for (const r of gameData.recipes) {
    if (hideLocked && !(r.flags || []).includes('AutoLearned')) continue;
    let a = byOutput.get(r.outputItemId);
    if (!a) byOutput.set(r.outputItemId, (a = []));
    a.push(r);
  }

  const memo = new Map();
  const stackIdx = new Map(); // item id -> stack index
  let depth = 0;
  let low = INF; // lowest stack index hit by a cycle guard during current computation

  function buyCost(id) {
    const p = prices.get(id);
    if (!p) return INF;
    if (instant) return p.sellPrice > 0 ? p.sellPrice : INF;
    // buyOrder: highest buy order; fall back to the sell listing if no orders exist.
    if (p.buyPrice > 0) return p.buyPrice;
    return p.sellPrice > 0 ? p.sellPrice : INF;
  }

  function ownedCount(id) {
    return owned ? owned.get(id) || 0 : 0;
  }

  // Cost of `n` units of ingredient item `id`, with owned units free.
  // Returns { cost, usesOwned } with cost INF if unresolvable.
  function ingredientCost(id, n) {
    const k = Math.min(ownedCount(id), n);
    const rest = n - k;
    if (rest <= 0) return { cost: 0, usesOwned: k > 0 };
    const u = unit(id);
    if (u.cost === INF) return { cost: INF, usesOwned: false };
    return { cost: rest * u.cost, usesOwned: k > 0 || (u.choice === 'craft' && u.usesOwned) };
  }

  function recipeCost(r) {
    let total = 0;
    let usesOwned = false;
    for (const ing of r.ingredients) {
      if (ing.type !== 'Item') return { cost: INF, usesOwned: false };
      const c = ingredientCost(ing.id, ing.count);
      if (c.cost === INF) return { cost: INF, usesOwned: false };
      total += c.cost;
      usesOwned = usesOwned || c.usesOwned;
    }
    const out = r.outputCount || 1;
    return { cost: total / out, usesOwned };
  }

  // Best per-unit acquisition for an item: cheaper of buying and crafting.
  function unit(id) {
    const m = memo.get(id);
    if (m) return m;
    if (stackIdx.has(id)) {
      low = Math.min(low, stackIdx.get(id));
      return UNRESOLVED;
    }
    const myIdx = depth;
    stackIdx.set(id, myIdx);
    depth++;
    const saveLow = low;
    low = INF;

    const buy = buyCost(id);
    let craft = INF;
    let recipe = null;
    let craftOwned = false;
    for (const r of byOutput.get(id) || []) {
      const c = recipeCost(r);
      if (c.cost < craft) {
        craft = c.cost;
        recipe = r;
        craftOwned = c.usesOwned;
      }
    }

    depth--;
    stackIdx.delete(id);
    const myLow = low;
    let res;
    if (craft < buy) res = { cost: craft, choice: 'craft', recipe, usesOwned: craftOwned, buy, craft };
    else if (buy < INF) res = { cost: buy, choice: 'buy', recipe: null, usesOwned: false, buy, craft };
    else res = UNRESOLVED;

    if (myLow >= myIdx) {
      // Independent of any ancestor on the stack: safe to memoise.
      memo.set(id, res);
      low = saveLow;
    } else {
      low = Math.min(saveLow, myLow);
    }
    return res;
  }

  // Cost of one craft of recipe r, with its output item on the stack (cycle guard).
  function topLevelCost(r) {
    stackIdx.set(r.outputItemId, 0);
    depth = 1;
    low = INF;
    try {
      return recipeCost(r);
    } finally {
      stackIdx.delete(r.outputItemId);
      depth = 0;
      low = INF;
    }
  }

  return { unit, ingredientCost, topLevelCost, ownedCount };
}

const UNRESOLVED = Object.freeze({
  cost: INF, choice: 'none', recipe: null, usesOwned: false, buy: INF, craft: INF,
});

export function computeRowsWithExclusions(gameData, options = {}) {
  const eng = createEngine(gameData, options);
  const hideLocked = !!options.hideUnlockRequired;
  const rows = [];
  let excluded = 0;
  for (const r of gameData.recipes) {
    if (hideLocked && !(r.flags || []).includes('AutoLearned')) continue;
    const price = gameData.prices.get(r.outputItemId);
    if (!price || !(price.sellPrice > 0)) continue; // output not tradable / not listed
    const c = eng.topLevelCost(r);
    if (c.cost === INF) {
      excluded++;
      continue;
    }
    const item = gameData.items.get(r.outputItemId) || {};
    const craftCost = Math.round(c.cost);
    const net = netSellPrice(price.sellPrice);
    const profit = net - craftCost;
    rows.push({
      recipeId: r.id,
      itemId: r.outputItemId,
      name: item.name ?? `Item ${r.outputItemId}`,
      icon: item.icon ?? '',
      rarity: item.rarity ?? '',
      disciplines: r.disciplines || [],
      minRating: r.minRating || 0,
      craftCost,
      grossSellPrice: price.sellPrice,
      netSellPrice: net,
      profit,
      margin: craftCost === 0 ? 0 : profit / craftCost,
      buyQuantity: price.buyQuantity || 0,
      sellQuantity: price.sellQuantity || 0,
      usesOwned: c.usesOwned,
    });
  }
  return { rows, excluded };
}

export function computeRows(gameData, options = {}) {
  return computeRowsWithExclusions(gameData, options).rows;
}

// Ingredient tree for one recipe. Root count is the recipe's outputCount; child counts are
// total units needed. Sub-crafts use amortised counts (ingredient count * needed / outputCount),
// which may be fractional when a sub-recipe yields more than one unit.
export function getIngredientTree(gameData, recipeId, options = {}) {
  const recipe = gameData.recipes.find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`Unknown recipe ${recipeId}`);
  const eng = createEngine(gameData, options);
  const info = (id) => gameData.items.get(id) || {};

  function buildItem(id, n, guard) {
    const it = info(id);
    const node = { itemId: id, name: it.name ?? `Item ${id}`, icon: it.icon ?? '', count: n,
      mode: 'buy', unitCost: 0, totalCost: 0, children: [] };
    const have = eng.ownedCount(id);
    const k = Math.min(have, n);
    const rest = n - k;
    if (rest <= 0) {
      node.mode = 'owned';
      return node;
    }
    const u = eng.unit(id);
    if (u.choice === 'craft' && !guard.has(id)) {
      node.mode = 'craft';
      node.children = buildChildren(u.recipe, rest, new Set(guard).add(id));
    } else if (u.choice === 'none') {
      node.mode = 'buy';
      node.totalCost = INF;
    } else {
      node.mode = 'buy';
    }
    if (node.totalCost !== INF) node.totalCost = rest * (u.choice === 'none' ? 0 : u.cost);
    node.unitCost = node.totalCost / n;
    return node;
  }

  function buildChildren(r, needed, guard) {
    const out = r.outputCount || 1;
    const factor = needed / out;
    return r.ingredients.map((ing) => buildItem(ing.id, ing.count * factor, guard));
  }

  const out = recipe.outputCount || 1;
  const children = buildChildren(recipe, out, new Set([recipe.outputItemId]));
  const totalCost = children.reduce((s, c) => s + c.totalCost, 0);
  const it = info(recipe.outputItemId);
  return {
    itemId: recipe.outputItemId,
    name: it.name ?? `Item ${recipe.outputItemId}`,
    icon: it.icon ?? '',
    count: out,
    mode: 'craft',
    unitCost: totalCost / out,
    totalCost,
    children,
  };
}
