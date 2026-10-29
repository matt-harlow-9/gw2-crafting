// Small hand-made GameData for building/checking the UI (?mock). Prices are copper.
const items = new Map();
const prices = new Map();
const recipes = [];

function item(id, name, rarity = 'Basic', flags = []) {
  items.set(id, { id, name, icon: '', rarity, flags });
}
function price(id, buyPrice, sellPrice, buyQuantity, sellQuantity) {
  prices.set(id, { buyPrice, sellPrice, buyQuantity, sellQuantity });
}

// Raw materials
const mats = [
  [101, 'Copper Ore', 'Basic', 8, 10, 52000, 61000],
  [102, 'Iron Ore', 'Basic', 18, 22, 41000, 39000],
  [103, 'Mithril Ore', 'Fine', 40, 48, 30000, 28000],
  [104, 'Elder Wood Log', 'Fine', 63, 70, 22000, 25000],
  [105, 'Silk Scrap', 'Basic', 9, 12, 70000, 64000],
  [106, 'Linen Scrap', 'Basic', 6, 8, 80000, 75000],
  [107, 'Ruby Orb', 'Masterwork', 230, 260, 9000, 7000],
  [108, 'Lump of Coal', 'Basic', 5, 7, 90000, 91000],
  [109, 'Vial of Thick Blood', 'Fine', 31, 36, 18000, 17000],
  [110, 'Gossamer Scrap', 'Fine', 120, 140, 4000, 3500],
];
for (const [id, n, r, b, s, bq, sq] of mats) { item(id, n, r); price(id, b, s, bq, sq); }

// Intermediates (craftable AND tradable)
item(201, 'Iron Ingot', 'Basic'); price(201, 70, 85, 15000, 14000);
item(202, 'Mithril Ingot', 'Fine'); price(202, 210, 240, 9000, 8500);
item(203, 'Bolt of Silk', 'Fine'); price(203, 120, 150, 6000, 6500);
item(204, 'Bolt of Gossamer', 'Masterwork'); price(204, 1100, 1250, 1200, 1500);
item(205, 'Elder Wood Plank', 'Fine'); price(205, 190, 230, 8000, 7600);
recipes.push(
  { id: 1201, outputItemId: 201, outputCount: 1, disciplines: ['Weaponsmith', 'Armorsmith', 'Jeweler'], minRating: 25, ingredients: [{ type: 'Item', id: 102, count: 3 }, { type: 'Item', id: 108, count: 1 }], flags: ['AutoLearned'] },
  { id: 1202, outputItemId: 202, outputCount: 1, disciplines: ['Weaponsmith', 'Armorsmith'], minRating: 150, ingredients: [{ type: 'Item', id: 103, count: 2 }, { type: 'Item', id: 108, count: 1 }], flags: ['AutoLearned'] },
  { id: 1203, outputItemId: 203, outputCount: 1, disciplines: ['Tailor', 'Leatherworker'], minRating: 75, ingredients: [{ type: 'Item', id: 105, count: 3 }], flags: ['AutoLearned'] },
  { id: 1204, outputItemId: 204, outputCount: 1, disciplines: ['Tailor'], minRating: 400, ingredients: [{ type: 'Item', id: 110, count: 5 }], flags: ['AutoLearned'] },
  { id: 1205, outputItemId: 205, outputCount: 1, disciplines: ['Artificer', 'Huntsman', 'Weaponsmith'], minRating: 150, ingredients: [{ type: 'Item', id: 104, count: 3 }], flags: ['AutoLearned'] },
);

// Final products
const out = [
  // [id, name, rarity, disciplines, rating, ingredients, outputCount, flags, buy, sell, bq, sq]
  [301, 'Iron Sword', 'Fine', ['Weaponsmith'], 25, [[201, 3], [101, 2]], 1, ['AutoLearned'], 380, 450, 1200, 900],
  [302, 'Mithril Greatsword', 'Masterwork', ['Weaponsmith'], 175, [[202, 5], [205, 2]], 1, ['AutoLearned'], 2400, 2900, 450, 380],
  [303, 'Silk Pants Lining', 'Fine', ['Tailor'], 75, [[203, 4], [106, 2]], 1, ['AutoLearned'], 560, 700, 800, 700],
  [304, 'Gossamer Insignia', 'Exotic', ['Tailor', 'Armorsmith'], 400, [[204, 3], [107, 1]], 1, ['LearnedFromItem'], 5600, 6800, 150, 220],
  [305, 'Elder Wood Shortbow', 'Fine', ['Huntsman'], 150, [[205, 4], [104, 1]], 1, ['AutoLearned'], 1000, 1300, 700, 650],
  [306, 'Iron Dagger Blades (x5)', 'Basic', ['Weaponsmith'], 25, [[201, 2], [102, 5]], 5, ['AutoLearned'], 140, 180, 20000, 18000],
  [307, 'Ruby Jewel', 'Masterwork', ['Jeweler'], 200, [[107, 2], [101, 6]], 1, ['AutoLearned'], 620, 820, 950, 1300],
  [308, 'Linen Wrap', 'Basic', ['Tailor', 'Leatherworker'], 0, [[106, 6]], 1, ['AutoLearned'], 30, 42, 15000, 17000],
  [309, 'Blood Tonic', 'Fine', ['Chef'], 100, [[109, 3], [108, 2]], 1, ['AutoLearned'], 90, 130, 4000, 5200],
  [310, 'Coal Fired Bread', 'Basic', ['Chef'], 25, [[108, 4], [106, 1]], 1, ['AutoLearned'], 20, 24, 600, 9000],
  [311, 'Mithril Hauberk Plate', 'Rare', ['Armorsmith'], 300, [[202, 8], [201, 4], [203, 2]], 1, ['LearnedFromItem'], 3600, 4400, 80, 140],
  [312, 'Silk Gloves Panel', 'Fine', ['Leatherworker', 'Tailor'], 150, [[203, 2], [105, 4]], 1, ['AutoLearned'], 280, 330, 2000, 1800],
  [313, 'Elder Wood Staff Head', 'Masterwork', ['Artificer'], 225, [[205, 3], [107, 1]], 1, ['AutoLearned'], 860, 1050, 400, 520],
  [314, 'Cheap Copper Bolt', 'Basic', ['Weaponsmith'], 0, [[101, 2]], 1, ['AutoLearned'], 12, 16, 1000, 800],
  [315, 'Gossamer Thread Spool', 'Rare', ['Tailor'], 400, [[110, 8], [204, 1]], 2, ['AutoLearned'], 1000, 1300, 0, 3],
];
for (const [id, name, rarity, disc, rating, ing, cnt, flags, b, s, bq, sq] of out) {
  item(id, name, rarity); price(id, b, s, bq, sq);
  recipes.push({
    id: 1000 + id, outputItemId: id, outputCount: cnt, disciplines: disc, minRating: rating,
    ingredients: ing.map(([i, c]) => ({ type: 'Item', id: i, count: c })), flags,
  });
}
// Excluded: needs a Currency ingredient
item(399, 'Karma Trinket', 'Fine'); price(399, 100, 200, 100, 100);
recipes.push({ id: 1399, outputItemId: 399, outputCount: 1, disciplines: ['Jeweler'], minRating: 10,
  ingredients: [{ type: 'Currency', id: 2, count: 500 }, { type: 'Item', id: 101, count: 1 }], flags: ['AutoLearned'] });
// Excluded: untradable ingredient with no recipe
item(398, 'Bound Relic', 'Rare', ['AccountBound']);
item(397, 'Relic Charm', 'Rare'); price(397, 100, 300, 100, 100);
recipes.push({ id: 1398, outputItemId: 397, outputCount: 1, disciplines: ['Artificer'], minRating: 10,
  ingredients: [{ type: 'Item', id: 398, count: 1 }], flags: ['AutoLearned'] });

export const mockGameData = { recipes, items, prices };
