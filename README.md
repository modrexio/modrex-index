# pd3-mod-index

SHA256 hash index of all PAYDAY 3 mods on [modworkshop](https://modworkshop.net), used by [pd3-mod-manager](https://github.com/ShulhaOleh/pd3-mod-manager) to identify manually placed `.pak` files.

## How it works

A GitHub Actions workflow runs hourly, downloads all PD3 mod files from modworkshop, hashes each `.pak`, and stores the results in `index.db` (SQLite). The database is published as a [GitHub Release asset](https://github.com/ShulhaOleh/pd3-mod-index/releases/tag/latest-index) — never committed to git.

The app downloads `index.db` on first launch (cached for 1 hour) and queries it with sql.js to match a file's SHA256 against a mod name, version, and modworkshop IDs.

## Running locally

```bash
pnpm install
pnpm run build-index
pnpm run build-index -- --concurrency=10
```
