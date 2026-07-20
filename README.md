# modrex-index

SHA256 hash index of mods on [modworkshop](https://modworkshop.net) for PAYDAY 3, PAYDAY 2, PAYDAY: The Heist, Crime Boss: Rockay City, and RAID: World War II, used by [modrex](https://github.com/modrexio/modrex) to identify manually placed mod files.

## How it works

A GitHub Actions workflow, triggered manually, downloads mod files from modworkshop for all five games, hashes the relevant content (`.pak`/`.ucas`/`.utoc` for PD3/Crime Boss, `.lua` for UE4SS sub-mods, a marker file for PD2/PDTH/RAID, and the first resolved asset for PDTH `.pdmod` files), and stores the results in `index.db` (SQLite). The database is published as a [GitHub Release asset](https://github.com/modrexio/modrex-index/releases/tag/latest-index) — never committed to git. The workflow also publishes `index-stats.json` so the website can refresh its recognized-mod count without downloading the database.

The app downloads `index.db` on first launch (cached for 1 hour) and queries it with sql.js to match a file's SHA256 against a mod name, version, and modworkshop IDs.

Full rebuilds are checkpointed by game in GitHub Actions because the complete build
is longer than a hosted job can run. Intermediate SQLite databases are stored only
as short-lived workflow artifacts; the public release is updated after all five
games complete and the final databases pass integrity checks.

## Running locally

```bash
pnpm install
pnpm build-index
pnpm build-index -- --concurrency=10
pnpm test:staged-rebuild
```
