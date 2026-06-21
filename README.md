# modrex-index

SHA256 hash index of mods on [modworkshop](https://modworkshop.net) for PAYDAY 3, PAYDAY 2, PAYDAY: The Heist, and Crime Boss: Rockay City, used by [modrex](https://github.com/modrexio/modrex) to identify manually placed mod files.

## How it works

A GitHub Actions workflow, triggered manually, downloads mod files from modworkshop for all four games, hashes the relevant content (`.pak`/`.ucas`/`.utoc` for PD3/Crime Boss, `.lua` for UE4SS sub-mods, a marker file for PD2/PDTH), and stores the results in `index.db` (SQLite). The database is published as a [GitHub Release asset](https://github.com/modrexio/modrex-index/releases/tag/latest-index) — never committed to git. The workflow also publishes `index-stats.json` so the website can refresh its recognized-mod count without downloading the database.

The app downloads `index.db` on first launch (cached for 1 hour) and queries it with sql.js to match a file's SHA256 against a mod name, version, and modworkshop IDs.

## Running locally

```bash
pnpm install
pnpm build-index
pnpm build-index -- --concurrency=10
```
