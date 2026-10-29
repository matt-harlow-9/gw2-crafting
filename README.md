# GW2 Crafting Profit Finder

A static web app that ranks Guild Wars 2 crafting recipes by profit, using live Trading Post
prices from the public [GW2 API](https://wiki.guildwars2.com/wiki/API:Main). No backend and no
build step. Everything runs in your browser.

## What it does

- Resolves each recipe's full ingredient tree and, for every sub-ingredient, uses the cheaper of
  buying it and crafting it.
- Computes craft cost, net sell price after the 15% Trading Post fee (5% listing, 10% sale),
  profit, margin and volume.
- Sorts and filters by discipline, minimum volume, profitability and unlock requirements.
- Optional: paste a GW2 API key (scopes: `account`, `inventories`) to treat materials you own as
  free. The key is kept in page memory only. It is never saved or sent anywhere except the
  official GW2 API.

Volume is the smaller of the buy-order and sell-listing quantities on the Trading Post right now.
It is not trade velocity.

## Run it

```
python3 -m http.server 8000
```

Open http://localhost:8000. The first load downloads recipes and items (about a minute), then
caches them in the browser for 7 days. Prices are cached for 5 minutes. Add `?mock` to the URL to
use built-in sample data.

## Tests

```
node --test
```

Set `LIVE=1` to also run the live API smoke test.

## Layout

| Path | Role |
|---|---|
| `src/data.js`, `src/cache.js` | GW2 API access and caching |
| `src/pricing.js` | Pricing and craft-versus-buy logic (pure functions) |
| `src/app.js`, `index.html`, `style.css` | UI |
| `src/mock.js` | Sample data for `?mock` |
| `docs/CONTRACT.md` | Interface contract between the layers |

Not affiliated with ArenaNet. Guild Wars 2 is a trademark of ArenaNet, LLC.
