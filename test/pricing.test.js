import test from 'node:test';
import assert from 'node:assert/strict';
import { netSellPrice, computeRows, computeRowsWithExclusions, getIngredientTree } from '../src/pricing.js';

const P = (buy, sell, bq = 10, sq = 10) => ({ buyPrice: buy, sellPrice: sell, buyQuantity: bq, sellQuantity: sq });
const R = (id, out, ings, extra = {}) => ({
  id, outputItemId: out, outputCount: 1, disciplines: ['Weaponsmith'], minRating: 1,
  ingredients: ings.map(([i, c, type = 'Item']) => ({ type, id: i, count: c })), flags: ['AutoLearned'], ...extra,
});
function gd(recipes, prices, ids = []) {
  const all = new Set(ids);
  for (const r of recipes) { all.add(r.outputItemId); r.ingredients.forEach((i) => all.add(i.id)); }
  const items = new Map([...all].map((id) => [id, { id, name: `I${id}`, icon: '', rarity: 'Fine', flags: [] }]));
  return { recipes, items, prices: new Map(Object.entries(prices).map(([k, v]) => [Number(k), v])) };
}
const opt = { ingredientPricing: 'buyOrder', hideUnlockRequired: false };

test('netSellPrice fee rounding', () => {
  assert.equal(netSellPrice(0), 0);
  assert.equal(netSellPrice(1), -1); // 1 - 1 - 1
  assert.equal(netSellPrice(2), 0);
  assert.equal(netSellPrice(10), 8);
  assert.equal(netSellPrice(11), 11 - 1 - 2);
  assert.equal(netSellPrice(100), 85);
  assert.equal(netSellPrice(101), 101 - 6 - 11);
});

test('single recipe, buyOrder vs instantBuy', () => {
  const d = gd([R(1, 10, [[20, 2]])], { 10: P(0, 1000), 20: P(100, 150) });
  const a = computeRows(d, opt)[0];
  assert.equal(a.craftCost, 200);
  assert.equal(a.netSellPrice, 850);
  assert.equal(a.profit, 650);
  assert.equal(a.margin, 650 / 200);
  assert.equal(a.grossSellPrice, 1000);
  const b = computeRows(d, { ...opt, ingredientPricing: 'instantBuy' })[0];
  assert.equal(b.craftCost, 300);
});

test('outputCount divides cost per unit', () => {
  const d = gd([R(1, 10, [[20, 3]], { outputCount: 3 })], { 10: P(0, 500), 20: P(100, 100) });
  assert.equal(computeRows(d, opt)[0].craftCost, 100);
});

test('multi-level: craft sub-ingredient when cheaper, buy when not', () => {
  const recipes = [R(1, 10, [[20, 1]]), R(2, 20, [[30, 2]])];
  let d = gd(recipes, { 10: P(0, 1000), 20: P(500, 600), 30: P(50, 60) });
  let row = computeRows(d, opt).find((r) => r.recipeId === 1);
  assert.equal(row.craftCost, 100); // craft 20 for 100 instead of buy 500
  let tree = getIngredientTree(d, 1, opt);
  assert.equal(tree.children[0].mode, 'craft');
  assert.equal(tree.children[0].children[0].mode, 'buy');
  assert.equal(tree.children[0].children[0].count, 2);
  assert.equal(tree.totalCost, 100);
  d = gd(recipes, { 10: P(0, 1000), 20: P(50, 60), 30: P(50, 60) });
  row = computeRows(d, opt).find((r) => r.recipeId === 1);
  assert.equal(row.craftCost, 50);
  tree = getIngredientTree(d, 1, opt);
  assert.equal(tree.children[0].mode, 'buy');
  assert.equal(tree.children[0].children.length, 0);
});

test('untradable intermediate is crafted', () => {
  const d = gd([R(1, 10, [[20, 1]]), R(2, 20, [[30, 1]])], { 10: P(0, 1000), 30: P(10, 10) });
  const rows = computeRows(d, opt);
  assert.equal(rows.length, 1); // recipe 2 output has no price
  assert.equal(rows[0].craftCost, 10);
});

test('cycles are guarded', () => {
  // 10 <- 20 <- 10, with 20 also buyable
  const d = gd([R(1, 10, [[20, 1]]), R(2, 20, [[10, 1]])], { 10: P(0, 1000), 20: P(100, 120) });
  const rows = computeRows(d, opt);
  assert.equal(rows.find((r) => r.recipeId === 1).craftCost, 100);
  // pure cycle with no market price on the loop: excluded, no hang
  const d2 = gd([R(1, 10, [[20, 1]]), R(2, 20, [[10, 1]])], { 10: P(0, 1000) });
  const r2 = computeRowsWithExclusions(d2, opt);
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.excluded, 1);
  assert.doesNotThrow(() => getIngredientTree(d, 1, opt));
});

test('owned materials cost 0 and set usesOwned', () => {
  const d = gd([R(1, 10, [[20, 2], [30, 1]])], { 10: P(0, 1000), 20: P(100, 100), 30: P(50, 50) });
  const base = computeRows(d, opt)[0];
  assert.equal(base.usesOwned, false);
  const r = computeRows(d, { ...opt, owned: new Map([[20, 1]]) })[0];
  assert.equal(r.craftCost, 150);
  assert.equal(r.usesOwned, true);
  const tree = getIngredientTree(d, 1, { ...opt, owned: new Map([[30, 5]]) });
  assert.equal(tree.children.find((c) => c.itemId === 30).mode, 'owned');
  assert.equal(tree.totalCost, 200);
});

test('owned stockpile can flip craft-vs-buy', () => {
  // item 20 buys for 100; crafting needs 2x item 30 (60 each = 120) -> buy. Own 2 of 30 -> craft for 0.
  const recipes = [R(1, 10, [[20, 1]]), R(2, 20, [[30, 2]])];
  const d = gd(recipes, { 10: P(0, 1000), 20: P(100, 110), 30: P(60, 60) });
  const noOwn = computeRows(d, opt).find((r) => r.recipeId === 1);
  assert.equal(noOwn.craftCost, 100);
  assert.equal(noOwn.usesOwned, false);
  const own = { ...opt, owned: new Map([[30, 2]]) };
  const w = computeRows(d, own).find((r) => r.recipeId === 1);
  assert.equal(w.craftCost, 0);
  assert.equal(w.usesOwned, true);
  assert.equal(w.margin, 0);
  const tree = getIngredientTree(d, 1, own);
  assert.equal(tree.children[0].mode, 'craft');
  assert.equal(tree.children[0].children[0].mode, 'owned');
});

test('exclusions are counted', () => {
  const d = gd([
    R(1, 10, [[20, 1]]),
    R(2, 10, [[99, 1]]), // 99 no price, no recipe
    R(3, 10, [[5, 100, 'Currency']]),
    R(4, 10, [[7, 1, 'GuildUpgrade']]),
    R(5, 77, [[20, 1]]), // output not tradable: not counted
  ], { 10: P(0, 1000), 20: P(10, 10) });
  const { rows, excluded } = computeRowsWithExclusions(d, opt);
  assert.equal(rows.length, 1);
  assert.equal(excluded, 3);
});

test('hideUnlockRequired drops recipes lacking AutoLearned', () => {
  const d = gd([R(1, 10, [[20, 1]], { flags: ['LearnedFromItem'] }), R(2, 11, [[20, 1]])],
    { 10: P(0, 1000), 11: P(0, 1000), 20: P(10, 10) });
  assert.equal(computeRows(d, opt).length, 2);
  const rows = computeRows(d, { ...opt, hideUnlockRequired: true });
  assert.deepEqual(rows.map((r) => r.recipeId), [2]);
});

test('outputCount > 1 in the tree', () => {
  const d = gd([R(1, 10, [[20, 1]]), R(2, 20, [[30, 2]], { outputCount: 2 })],
    { 10: P(0, 1000), 20: P(500, 500), 30: P(10, 10) });
  const t = getIngredientTree(d, 1, opt);
  assert.equal(t.children[0].mode, 'craft');
  assert.equal(t.children[0].children[0].count, 1);
  assert.equal(t.totalCost, 10);
});

test('performance on a large synthetic dataset', () => {
  const recipes = [];
  const prices = {};
  for (let i = 1; i <= 14000; i++) {
    recipes.push(R(i, 100000 + i, [[100000 + Math.max(1, i - 1), 2], [1, 3]]));
    prices[100000 + i] = P(10, 1000);
  }
  prices[1] = P(5, 5);
  const t = Date.now();
  const { rows } = computeRowsWithExclusions(gd(recipes, prices), opt);
  assert.equal(rows.length, 13999); // recipe 1 is self-referential and unresolvable
  assert.ok(Date.now() - t < 5000);
});
