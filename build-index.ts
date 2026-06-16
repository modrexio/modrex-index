#!/usr/bin/env npx tsx
/**
 * Builds the PD3 + PD2 mod hash index from modworkshop directly into SQLite.
 *
 * Run:   pnpm build-index
 * Output: index.db
 *
 * Resumable — already-indexed fileIds are skipped on re-run.
 * PD3: streams each download directly into SHA256 (no temp files for .pak extraction).
 * PD2: uses HTTP Range requests on ZIP archives to fetch only the marker file
 *      (mod.txt / main.xml / first alphabetical file) without downloading the full archive.
 *      RAR and 7z archives under 50 MB are fully downloaded and extracted via the 7z CLI.
 * Downloads CONCURRENCY files in parallel to cut total runtime.
 */

import Database, { type Database as DB } from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { inflateRawSync } from 'zlib'
import { join } from 'path'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

const BASE = 'https://api.modworkshop.net'
const PD3_GAME_ID = 853
const PD2_GAME_ID = 1
const USER_AGENT = 'modrex-indexer/1.0'
const DB_PATH = join(import.meta.dirname, 'index.db')
// Faster than full_rebuild when adding a new format: only unindexed files are downloaded.
const BACKFILL = process.argv.includes('--backfill')
// Patches only the version column on existing rows from the listings — no downloads, no
// extraction. Lets a stale-version index be corrected in minutes instead of a full backfill.
const REPAIR_VERSIONS = process.argv.includes('--repair-versions')
const CONCURRENCY = parseInt(
    process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? (BACKFILL ? '10' : '5')
)
// modworkshop meters api.modworkshop.net at 90 req/min per IP (x-ratelimit-limit header).
// We reserve one slot every ~706 ms (~85/min) so all workers share a single safe pace and
// never trip a 429. storage.modworkshop.net is unmetered and bypasses this throttle.
const API_RATE_PER_MIN = 85
const API_MIN_INTERVAL_MS = Math.ceil(60_000 / API_RATE_PER_MIN)
let apiNextSlot = 0
// RAR and 7z archives larger than this are skipped for PD2: they have no efficient marker
// extraction (unlike ZIP's Range trick), so the whole archive must be downloaded. The cap bounds
// per-file CI cost; downloads are incremental so raising it drains the newly-eligible backlog
// over successive hourly runs. 50 MB covers most asset/background packs (e.g. menu backgrounds).
const PD2_MAX_FULL_DOWNLOAD_BYTES = 50 * 1_024 * 1_024

// --- types ---

interface Mod {
    id: number
    name: string
    version: string
    has_download: boolean
    bumped_at: string
    // The listing carries the primary download inline — no per-mod /files call needed.
    // download_type is 'file' (hosted), 'link' (external), or null (none).
    download_id: number | null
    download_type: string | null
}

interface ModFile {
    id: number
    version: string
    download_url: string
    type: string
    updated_at: string
}

interface Paginated<T> {
    data: T[]
    meta: { current_page: number; last_page: number }
}

// --- schema ---

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sources (
    id       INTEGER PRIMARY KEY,
    game_id  INTEGER NOT NULL REFERENCES games(id),
    name     TEXT NOT NULL,
    base_url TEXT NOT NULL,
    game_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mods (
    id        INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    remote_id INTEGER NOT NULL,
    name      TEXT NOT NULL,
    url       TEXT NOT NULL,
    UNIQUE(source_id, remote_id)
);

CREATE TABLE IF NOT EXISTS file_contents (
    sha256 TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY,
    mod_id     INTEGER NOT NULL REFERENCES mods(id),
    sha256     TEXT NOT NULL REFERENCES file_contents(sha256),
    remote_id  INTEGER NOT NULL,
    version    TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    entry_name TEXT NOT NULL DEFAULT '',
    UNIQUE(mod_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);

CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

// --- db setup ---

function openDb(): { db: DB; pd3SourceId: number; pd2SourceId: number } {
    const db = new Database(DB_PATH)
    db.exec(SCHEMA)

    // CI builds are incremental over the previous release's db — CREATE TABLE IF
    // NOT EXISTS won't add columns to it, so migrate explicitly.
    const fileColumns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
    if (!fileColumns.some((c) => c.name === 'entry_name')) {
        db.exec("ALTER TABLE files ADD COLUMN entry_name TEXT NOT NULL DEFAULT ''")
    }

    const upsertGame = db.prepare('INSERT OR IGNORE INTO games (name, slug) VALUES (?, ?)')
    const getGame = db.prepare('SELECT id FROM games WHERE slug = ?')
    const upsertSource = db.prepare(
        'INSERT OR IGNORE INTO sources (game_id, name, base_url, game_ref) VALUES (?, ?, ?, ?)'
    )
    const getSource = db.prepare('SELECT id FROM sources WHERE game_id = ? AND name = ?')

    upsertGame.run('PAYDAY 3', 'pd3')
    const pd3Game = getGame.get('pd3') as { id: number }
    upsertSource.run(pd3Game.id, 'modworkshop', BASE, String(PD3_GAME_ID))
    const pd3Source = getSource.get(pd3Game.id, 'modworkshop') as { id: number }

    upsertGame.run('PAYDAY 2', 'pd2')
    const pd2Game = getGame.get('pd2') as { id: number }
    upsertSource.run(pd2Game.id, 'modworkshop', BASE, String(PD2_GAME_ID))
    const pd2Source = getSource.get(pd2Game.id, 'modworkshop') as { id: number }

    return { db, pd3SourceId: pd3Source.id, pd2SourceId: pd2Source.id }
}

// Scope indexed file IDs to a specific source so PD2 and PD3 remote_ids never collide.
function getIndexedFileIds(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            'SELECT f.remote_id FROM files f JOIN mods m ON m.id = f.mod_id WHERE m.source_id = ?'
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

function getFileIdsMissingNames(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            "SELECT DISTINCT f.remote_id FROM files f JOIN mods m ON m.id = f.mod_id WHERE m.source_id = ? AND f.entry_name = ''"
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

// Remote mod IDs that already have at least one indexed file. Used to skip the
// /files fallback for mods whose listing carries no download_id on re-runs.
function getIndexedModIds(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            'SELECT DISTINCT m.remote_id FROM mods m JOIN files f ON f.mod_id = m.id WHERE m.source_id = ?'
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

// --- API ---

// Reserve the next api.modworkshop.net slot, spacing calls to stay under the 90/min cap.
async function apiThrottle(): Promise<void> {
    const now = Date.now()
    const slot = Math.max(now, apiNextSlot)
    apiNextSlot = slot + API_MIN_INTERVAL_MS
    if (slot > now) await delay(slot - now)
}

async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${BASE}${path}`)
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, String(v))
        }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        await apiThrottle()
        let res: Response
        try {
            res = await fetch(url, {
                headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(30_000),
            })
        } catch (e) {
            if (attempt < 4) {
                const wait = 2_000 * 2 ** attempt
                console.warn(`  [network error] ${path} — retrying in ${wait}ms`)
                await delay(wait)
                continue
            }
            throw e
        }
        if (res.status === 429) {
            const wait = 2_000 * 2 ** attempt
            console.warn(`  [429] ${path} — retrying in ${wait}ms`)
            await delay(wait)
            continue
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
        return res.json() as T
    }
    throw new Error(`API 429: ${path} (gave up after retries)`)
}

// 10-minute overlap so mods bumped during the previous run aren't missed
const SINCE_BUFFER_MS = 10 * 60 * 1000

async function listModsSince(gameId: number, since: Date | null): Promise<Mod[]> {
    const threshold = since ? new Date(since.getTime() - SINCE_BUFFER_MS) : null
    const mods: Mod[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<Mod>>(`/games/${gameId}/mods`, {
            limit: 50,
            page,
            sort: 'bumped_at',
        })
        lastPage = result.meta.last_page
        const batch = result.data

        if (threshold) {
            mods.push(...batch.filter((m) => new Date(m.bumped_at) >= threshold))
            if (batch.length > 0 && new Date(batch[batch.length - 1].bumped_at) < threshold) break
        } else {
            mods.push(...batch)
        }

        console.log(`  page ${page}/${lastPage} (${mods.length} mods)`)
        page++
    } while (page <= lastPage)
    return mods
}

async function listModFiles(modId: number): Promise<ModFile[]> {
    const files: ModFile[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<ModFile>>(`/mods/${modId}/files`, {
            limit: 50,
            page,
        })
        lastPage = result.meta.last_page
        files.push(...result.data)

        page++
    } while (page <= lastPage)
    return files
}

// --- PD3 download + extraction ---

async function downloadBuffer(downloadUrl: string): Promise<Buffer> {
    const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`download ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
}

function detectFormat(buf: Buffer): 'zip' | '7z' | 'pak' {
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
        return 'zip'
    if (
        buf.length >= 6 &&
        buf[0] === 0x37 &&
        buf[1] === 0x7a &&
        buf[2] === 0xbc &&
        buf[3] === 0xaf &&
        buf[4] === 0x27 &&
        buf[5] === 0x1c
    )
        return '7z'
    return 'pak'
}

interface PakEntry {
    sha256: string
    entryName: string
}

// Returns SHA256 + in-archive path of all .pak content in buf, extracting
// archives as needed. fallbackName names the buffer itself for bare .pak files.
function extractPakEntries(buf: Buffer, fallbackName: string): PakEntry[] {
    const fmt = detectFormat(buf)

    if (fmt === 'zip') {
        try {
            const zip = new AdmZip(buf)
            return zip
                .getEntries()
                .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.pak'))
                .map((e) => ({
                    sha256: createHash('sha256').update(e.getData()).digest('hex'),
                    entryName: e.entryName.replace(/\\/g, '/'),
                }))
        } catch {
            return []
        }
    }

    if (fmt === '7z') {
        const tmp = mkdtempSync(join(tmpdir(), 'modrex-idx-'))
        try {
            const archive = join(tmp, 'archive.7z')
            const out = join(tmp, 'out')
            writeFileSync(archive, buf)
            // x (not e) keeps directory structure so entry paths survive
            execFileSync('7z', ['x', archive, '-o' + out, '*.pak', '-r', '-y'], {
                stdio: 'ignore',
            })
            return (readdirSync(out, { recursive: true }) as string[])
                .filter((f) => f.toLowerCase().endsWith('.pak'))
                .map((f) => ({
                    sha256: createHash('sha256').update(readFileSync(join(out, f))).digest('hex'),
                    entryName: f.replace(/\\/g, '/'),
                }))
        } catch {
            return []
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    }

    return [
        {
            sha256: createHash('sha256').update(buf).digest('hex'),
            entryName: fallbackName,
        },
    ]
}

// --- PD2 ZIP Range extraction ---

interface CdEntry {
    name: string
    localOffset: number
    compressedSize: number
    compressionMethod: number
}

async function headContentLength(url: string): Promise<number | null> {
    const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
    })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    const n = len ? parseInt(len, 10) : 0
    return n > 0 ? n : null
}

async function rangeGet(url: string, start: number, end: number): Promise<Buffer> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(60_000),
        redirect: 'follow',
    })
    // 200 means the server ignored Range and returned everything (still usable)
    if (res.status !== 206 && res.status !== 200) throw new Error(`rangeGet ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
}

function findEocd(buf: Buffer): { cdOffset: number; cdSize: number } | null {
    for (let i = buf.length - 22; i >= 0; i--) {
        if (
            buf[i] === 0x50 &&
            buf[i + 1] === 0x4b &&
            buf[i + 2] === 0x05 &&
            buf[i + 3] === 0x06
        ) {
            const cdSize = buf.readUInt32LE(i + 12)
            const cdOffset = buf.readUInt32LE(i + 16)
            // 0xFFFFFFFF means ZIP64 — we don't support that
            if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null
            return { cdOffset, cdSize }
        }
    }
    return null
}

function parseCd(cd: Buffer): CdEntry[] {
    const entries: CdEntry[] = []
    let pos = 0
    while (pos + 46 <= cd.length) {
        if (cd.readUInt32LE(pos) !== 0x02014b50) break
        const compressionMethod = cd.readUInt16LE(pos + 10)
        const compressedSize = cd.readUInt32LE(pos + 20)
        const fnLen = cd.readUInt16LE(pos + 28)
        const exLen = cd.readUInt16LE(pos + 30)
        const cmtLen = cd.readUInt16LE(pos + 32)
        const localOffset = cd.readUInt32LE(pos + 42)
        const name = cd.slice(pos + 46, pos + 46 + fnLen).toString('utf8')
        entries.push({ name, localOffset, compressedSize, compressionMethod })
        pos += 46 + fnLen + exLen + cmtLen
    }
    return entries
}

function selectMarkerPath(paths: string[]): string | null {
    const files = paths.filter((p) => !p.endsWith('/'))
    if (files.length === 0) return null

    const depth = (p: string) => p.split('/').length - 1

    const modTxt = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'mod.txt' || l.endsWith('/mod.txt')) && depth(p) <= 1
    })
    if (modTxt) return modTxt

    const mainXml = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'main.xml' || l.endsWith('/main.xml')) && depth(p) <= 1
    })
    if (mainXml) return mainXml

    // single top-level folder means wrapper — sort relative to it to match first_file_in_dir
    const sorted = [...files].sort((a, b) => a.localeCompare(b))
    const roots = [...new Set(files.map((p) => p.split('/')[0]))]
    if (roots.length === 1 && roots[0] !== '') {
        const prefix = roots[0] + '/'
        const rel = sorted
            .filter((p) => p.startsWith(prefix))
            .map((p) => ({ path: p, rel: p.slice(prefix.length) }))
            .sort((a, b) => a.rel.localeCompare(b.rel))
        return rel[0]?.path ?? null
    }

    return sorted[0] ?? null
}

// Typically fetches only ~100 KB regardless of archive size.
async function extractPd2FromZip(url: string, knownSize: number | null): Promise<PakEntry | null> {
    const size = knownSize ?? (await headContentLength(url))
    if (!size || size < 22) return null

    // EOCD is within the last 65535 + 22 bytes (max ZIP comment size + EOCD fixed size)
    const tailStart = Math.max(0, size - 65_557)
    const tail = await rangeGet(url, tailStart, size - 1)

    const eocd = findEocd(tail)
    if (!eocd) return null

    const { cdOffset, cdSize } = eocd
    const cd = await rangeGet(url, cdOffset, cdOffset + cdSize - 1)
    const entries = parseCd(cd)

    const chosen = selectMarkerPath(entries.map((e) => e.name))
    const marker = chosen ? (entries.find((e) => e.name === chosen) ?? null) : null
    if (!marker) return null

    // Files stored with a data descriptor (bit 3 of flags) may report compressedSize=0
    // in the Central Directory; we can't range those without reading the data descriptor.
    if (marker.compressedSize === 0) return null

    const localHeader = await rangeGet(url, marker.localOffset, marker.localOffset + 29)
    if (localHeader.readUInt32LE(0) !== 0x04034b50) return null
    const lfnLen = localHeader.readUInt16LE(26)
    const lexLen = localHeader.readUInt16LE(28)
    const dataStart = marker.localOffset + 30 + lfnLen + lexLen

    const compressed = await rangeGet(url, dataStart, dataStart + marker.compressedSize - 1)

    let content: Buffer
    if (marker.compressionMethod === 0) {
        content = compressed
    } else if (marker.compressionMethod === 8) {
        try {
            content = inflateRawSync(compressed)
        } catch {
            return null
        }
    } else {
        return null
    }

    return {
        sha256: createHash('sha256').update(content).digest('hex'),
        entryName: marker.name,
    }
}

// p7zip-full required for RAR support on Ubuntu CI runners.
async function extractPd2FromFull(url: string, type: string): Promise<PakEntry | null> {
    const buf = await downloadBuffer(url)
    const ext = type === 'rar' ? '.rar' : '.7z'
    const tmp = mkdtempSync(join(tmpdir(), 'modrex-pd2-'))
    try {
        const archive = join(tmp, 'archive' + ext)
        const outDir = join(tmp, 'out')
        writeFileSync(archive, buf)
        try {
            execFileSync('7z', ['x', archive, '-o' + outDir, '-y'], { stdio: 'ignore' })
        } catch {
            return null
        }

        // readdirSync(recursive) lists directories too, and they carry no trailing
        // slash — stat each so selectMarkerPath never picks a dir (readFileSync EISDIR).
        const allFiles = (readdirSync(outDir, { recursive: true }) as string[])
            .filter((f) => {
                try {
                    return statSync(join(outDir, f)).isFile()
                } catch {
                    return false
                }
            })
            .map((f) => f.replace(/\\/g, '/'))

        const chosen = selectMarkerPath(allFiles)
        if (!chosen) return null

        const content = readFileSync(join(outDir, chosen))
        return {
            sha256: createHash('sha256').update(content).digest('hex'),
            entryName: chosen,
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

// Resolves a listing download_id to its CDN URL (+ size) with a single throttled api
// hit; the 302 follows through to unmetered storage.modworkshop.net for the actual bytes.
async function resolveDownload(
    downloadId: number
): Promise<{ url: string; size: number | null } | null> {
    await apiThrottle()
    const res = await fetch(`${BASE}/files/${downloadId}/download`, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
    })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    const size = len ? parseInt(len, 10) : 0
    // res.url is the final storage URL after the redirect.
    return { url: res.url, size: size > 0 ? size : null }
}

// url is a resolved storage.modworkshop.net URL; archive format comes from its extension.
async function extractPd2Entries(url: string, size: number | null): Promise<PakEntry[]> {
    const path = url.split('?')[0].toLowerCase()

    if (path.endsWith('.rar') || path.endsWith('.7z')) {
        const sz = size ?? (await headContentLength(url))
        if (sz === null || sz > PD2_MAX_FULL_DOWNLOAD_BYTES) return []
        const entry = await extractPd2FromFull(url, path.endsWith('.rar') ? 'rar' : '7z')
        return entry ? [entry] : []
    }

    // zip — also the fallback for unknown extensions (findEocd returns null on non-zip)
    const entry = await extractPd2FromZip(url, size)
    return entry ? [entry] : []
}

// --- concurrency pool ---

type Task = () => Promise<void>

async function runPool(tasks: Task[], concurrency: number): Promise<void> {
    const queue = [...tasks]
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (queue.length > 0) {
            const task = queue.shift()!
            await task()
        }
    })
    await Promise.all(workers)
}

// --- helpers ---

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

function shouldDownload(type: string): boolean {
    const t = type.toLowerCase()
    return (
        t.includes('pak') ||
        t.includes('zip') ||
        t.includes('7z') ||
        t === 'application/octet-stream' ||
        t === 'application/zip' ||
        t === ''
    )
}

// --- main ---

async function main(): Promise<void> {
    console.log('Opening database...')
    const { db, pd3SourceId, pd2SourceId } = openDb()
    const indexedPd3FileIds = getIndexedFileIds(db, pd3SourceId)
    const indexedPd2FileIds = getIndexedFileIds(db, pd2SourceId)
    const indexedPd2ModIds = getIndexedModIds(db, pd2SourceId)
    const missingNamePd3FileIds = BACKFILL ? getFileIdsMissingNames(db, pd3SourceId) : new Set<number>()
    const missingNamePd2FileIds = BACKFILL ? getFileIdsMissingNames(db, pd2SourceId) : new Set<number>()
    console.log(
        `  ${indexedPd3FileIds.size} PD3 files + ${indexedPd2FileIds.size} PD2 files already indexed`
    )
    if (BACKFILL && (missingNamePd3FileIds.size > 0 || missingNamePd2FileIds.size > 0)) {
        console.log(
            `  ${missingNamePd3FileIds.size} PD3 + ${missingNamePd2FileIds.size} PD2 files missing entry names — will re-download`
        )
    }

    const lastRunRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_run_at') as
        | { value: string }
        | undefined
    const lastRunAt = lastRunRow ? new Date(lastRunRow.value) : null

    if (BACKFILL) {
        console.log('  Backfill mode — scanning all mods, skipping already-indexed files\n')
    } else {
        console.log(
            lastRunAt
                ? `  Last run: ${lastRunAt.toISOString()} — incremental update\n`
                : '  No previous run — full index build\n'
        )
    }

    const insertMod = db.prepare(
        'INSERT OR IGNORE INTO mods (source_id, remote_id, name, url) VALUES (?, ?, ?, ?)'
    )
    const getModId = db.prepare('SELECT id FROM mods WHERE source_id = ? AND remote_id = ?')
    const insertContent = db.prepare('INSERT OR IGNORE INTO file_contents (sha256) VALUES (?)')
    const insertFile = db.prepare(
        'INSERT OR IGNORE INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const fillEntryName = db.prepare(
        "UPDATE files SET entry_name = ? WHERE mod_id = ? AND sha256 = ? AND entry_name = ''"
    )

    const runStartedAt = new Date()
    const errors: string[] = []
    let newFiles = 0
    let filledNames = 0

    // Fetch both mod lists before building tasks so closures can reference both lengths.
    // Repair scans every mod (since = null) so it can correct any stale version.
    const since = BACKFILL || REPAIR_VERSIONS ? null : lastRunAt
    console.log('Fetching PD3 mod list...')
    const pd3Mods = await listModsSince(PD3_GAME_ID, since)
    console.log(`  ${pd3Mods.length} PD3 mods to process\n`)

    console.log('Fetching PD2 mod list...')
    const pd2Mods = await listModsSince(PD2_GAME_ID, since)
    console.log(`  ${pd2Mods.length} PD2 mods to process\n`)

    // Version-only repair: rewrite the version column on already-indexed files from the
    // listing's mod.version, then exit. No downloads — turns a 3-hour backfill into minutes.
    if (REPAIR_VERSIONS) {
        const updateVer = db.prepare(
            'UPDATE files SET version = ? WHERE mod_id = ? AND version != ?'
        )
        let fixed = 0
        const repair = (mods: Mod[], sourceId: number) =>
            db.transaction(() => {
                for (const mod of mods) {
                    if (!mod.version) continue
                    const m = getModId.get(sourceId, mod.id) as { id: number } | undefined
                    if (m) fixed += updateVer.run(mod.version, m.id, mod.version).changes
                }
            })()
        repair(pd3Mods, pd3SourceId)
        repair(pd2Mods, pd2SourceId)
        console.log(`\nVersion repair: rewrote ${fixed} file version(s).`)
        db.close()
        process.exit(fixed > 0 ? 0 : 2)
    }

    let donePd3 = 0
    let donePd2 = 0

    // --- PD3 tasks ---

    const pd3Tasks: Task[] = pd3Mods.map((mod) => async () => {
        if (!mod.has_download) {
            donePd3++
            return
        }
        // Primary download already indexed: skip the per-mod /files call. A real file
        // update gets a new download_id (so it won't be in the set and is re-fetched);
        // an unchanged mod costs zero API calls instead of a throttled /files request.
        if (
            mod.download_id != null &&
            indexedPd3FileIds.has(mod.download_id) &&
            !missingNamePd3FileIds.has(mod.download_id)
        ) {
            donePd3++
            return
        }
        let files: ModFile[] = []
        try {
            files = await listModFiles(mod.id)
        } catch (e) {
            errors.push(`pd3 mod ${mod.id}: failed to list files — ${e}`)
            donePd3++
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`
        insertMod.run(pd3SourceId, mod.id, mod.name, modUrl)
        const { id: modId } = getModId.get(pd3SourceId, mod.id) as { id: number }

        if (BACKFILL && mod.version) {
            db.prepare('UPDATE files SET version = ? WHERE mod_id = ? AND version != ?').run(
                mod.version,
                modId,
                mod.version
            )
        }

        for (const file of files) {
            if (!shouldDownload(file.type)) continue

            if (
                indexedPd3FileIds.has(file.id) &&
                !missingNamePd3FileIds.has(file.id) &&
                (!lastRunAt ||
                    new Date(file.updated_at) <
                        new Date(lastRunAt.getTime() - SINCE_BUFFER_MS))
            ) {
                continue
            }

            try {
                const buf = await downloadBuffer(file.download_url)
                const fallbackName = decodeURIComponent(
                    new URL(file.download_url).pathname.split('/').pop() ?? ''
                )
                const entries = extractPakEntries(buf, fallbackName)
                if (entries.length === 0) continue
                db.transaction(() => {
                    for (const { sha256, entryName } of entries) {
                        insertContent.run(sha256)
                        const { changes } = insertFile.run(
                            modId,
                            sha256,
                            file.id,
                            mod.version,
                            new Date().toISOString(),
                            entryName
                        )
                        if (changes > 0) newFiles++
                        else if (fillEntryName.run(entryName, modId, sha256).changes > 0)
                            filledNames++
                    }
                })()
                indexedPd3FileIds.add(file.id)
                missingNamePd3FileIds.delete(file.id)
            } catch (e) {
                errors.push(`pd3 mod ${mod.id} file ${file.id}: ${e}`)
            }
        }

        donePd3++
        if (donePd3 % 50 === 0) {
            const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
            console.log(
                `  [PD3: ${donePd3}/${pd3Mods.length} — PD2: ${donePd2}/${pd2Mods.length} — ${total} files indexed]`
            )
        }
    })

    // --- PD2 tasks ---

    // Writes one PD2 file's entries into the DB. Returns true if anything was stored.
    const storePd2 = (modId: number, fileId: number, version: string, entries: PakEntry[]) => {
        if (entries.length === 0) return
        db.transaction(() => {
            for (const { sha256, entryName } of entries) {
                insertContent.run(sha256)
                const { changes } = insertFile.run(
                    modId,
                    sha256,
                    fileId,
                    version,
                    new Date().toISOString(),
                    entryName
                )
                if (changes > 0) newFiles++
                else if (fillEntryName.run(entryName, modId, sha256).changes > 0) filledNames++
            }
        })()
        indexedPd2FileIds.add(fileId)
        missingNamePd2FileIds.delete(fileId)
    }

    const pd2Tasks: Task[] = pd2Mods.map((mod) => async () => {
        if (!mod.has_download) {
            donePd2++
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`

        // Fast path: the listing surfaced a hosted primary download. download_id is the
        // file's remote_id, so already-indexed files cost zero API calls.
        if (mod.download_type === 'file' && mod.download_id != null) {
            const fileId = mod.download_id
            if (indexedPd2FileIds.has(fileId) && !missingNamePd2FileIds.has(fileId)) {
                donePd2++
                return
            }
            try {
                const resolved = await resolveDownload(fileId)
                if (resolved) {
                    insertMod.run(pd2SourceId, mod.id, mod.name, modUrl)
                    const { id: modId } = getModId.get(pd2SourceId, mod.id) as { id: number }
                    storePd2(modId, fileId, mod.version, await extractPd2Entries(resolved.url, resolved.size))
                }
            } catch (e) {
                errors.push(`pd2 mod ${mod.id} file ${fileId}: ${e}`)
            }
        } else if (!indexedPd2ModIds.has(mod.id)) {
            // Fallback: has_download but the listing carried no download_id (download_type
            // null/link). The /files endpoint still lists the real archive(s).
            let files: ModFile[] = []
            try {
                files = await listModFiles(mod.id)
            } catch (e) {
                errors.push(`pd2 mod ${mod.id}: failed to list files — ${e}`)
                donePd2++
                return
            }
            if (files.length > 0) {
                insertMod.run(pd2SourceId, mod.id, mod.name, modUrl)
                const { id: modId } = getModId.get(pd2SourceId, mod.id) as { id: number }
                for (const file of files) {
                    if (indexedPd2FileIds.has(file.id) && !missingNamePd2FileIds.has(file.id)) {
                        continue
                    }
                    try {
                        // file.download_url is already a storage URL — extract directly.
                        // Use the mod-level version (the per-file one is usually blank for PD2);
                        // modrex-main compares installs against the mod version for updates.
                        storePd2(
                            modId,
                            file.id,
                            file.version || mod.version,
                            await extractPd2Entries(file.download_url, null)
                        )
                    } catch (e) {
                        errors.push(`pd2 mod ${mod.id} file ${file.id}: ${e}`)
                    }
                }
            }
        }

        donePd2++
        if (donePd2 % 200 === 0) {
            const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
            console.log(
                `  [PD3: ${donePd3}/${pd3Mods.length} — PD2: ${donePd2}/${pd2Mods.length} — ${total} files indexed]`
            )
        }
    })

    console.log(
        `Processing ${pd3Mods.length} PD3 + ${pd2Mods.length} PD2 mods with ${CONCURRENCY} workers...\n`
    )
    await runPool([...pd3Tasks, ...pd2Tasks], CONCURRENCY)

    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'last_run_at',
        runStartedAt.toISOString()
    )

    const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
    console.log(
        `\nDone. ${total} files in index.db (${newFiles} new, ${filledNames} names filled this run)`
    )

    if (errors.length > 0) {
        console.log(`\n${errors.length} errors:`)
        errors.forEach((e) => console.log(`  - ${e}`))
    }

    db.close()

    if (newFiles === 0 && filledNames === 0) {
        console.log('No new files — skipping upload.')
        process.exit(2)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
