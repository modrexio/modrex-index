#!/usr/bin/env npx tsx
/**
 * Builds the PD3 mod hash index from modworkshop directly into SQLite.
 *
 * Run:   npm run build-index
 * Output: index.db
 *
 * Resumable — already-indexed fileIds are skipped on re-run.
 * Streams each download directly into SHA256 (no temp files).
 * Downloads CONCURRENCY files in parallel to cut total runtime.
 */

import Database, { type Database as DB } from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { join } from 'path'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

const BASE = 'https://api.modworkshop.net'
const GAME_ID = 853
const USER_AGENT = 'modrex-indexer/1.0'
const DB_PATH = join(import.meta.dirname, 'index.db')
const CONCURRENCY = parseInt(
    process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '5'
)
const API_DELAY_MS = 200

// --- types ---

interface Mod {
    id: number
    name: string
    has_download: boolean
    bumped_at: string
    download: { id: number; version: string; download_url: string; type: string } | null
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
    UNIQUE(mod_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);

CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

// --- db setup ---

function openDb(): { db: DB; sourceId: number } {
    const db = new Database(DB_PATH)
    db.exec(SCHEMA)

    db.prepare('INSERT OR IGNORE INTO games (name, slug) VALUES (?, ?)').run('PAYDAY 3', 'pd3')
    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get('pd3') as { id: number }

    db.prepare(
        'INSERT OR IGNORE INTO sources (game_id, name, base_url, game_ref) VALUES (?, ?, ?, ?)'
    ).run(game.id, 'modworkshop', BASE, String(GAME_ID))
    const source = db.prepare('SELECT id FROM sources WHERE name = ?').get('modworkshop') as {
        id: number
    }

    return { db, sourceId: source.id }
}

function getIndexedFileIds(db: DB): Set<number> {
    const rows = db.prepare('SELECT remote_id FROM files').all() as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

// --- API ---

async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${BASE}${path}`)
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, String(v))
        }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(30_000),
        })
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

async function listModsSince(since: Date | null): Promise<Mod[]> {
    const threshold = since ? new Date(since.getTime() - SINCE_BUFFER_MS) : null
    const mods: Mod[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<Mod>>(`/games/${GAME_ID}/mods`, {
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
        if (page <= lastPage) await delay(API_DELAY_MS)
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
        if (page <= lastPage) await delay(API_DELAY_MS)
    } while (page <= lastPage)
    return files
}

// --- download + extraction ---

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
    if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc &&
        buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c)
        return '7z'
    return 'pak'
}

// Returns SHA256(s) of all .pak content in buf, extracting archives as needed.
function extractPakHashes(buf: Buffer): string[] {
    const fmt = detectFormat(buf)

    if (fmt === 'zip') {
        try {
            const zip = new AdmZip(buf)
            return zip
                .getEntries()
                .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.pak'))
                .map((e) => createHash('sha256').update(e.getData()).digest('hex'))
        } catch {
            return []
        }
    }

    if (fmt === '7z') {
        const tmp = mkdtempSync(join(tmpdir(), 'modrex-idx-'))
        try {
            const archive = join(tmp, 'archive.7z')
            writeFileSync(archive, buf)
            execFileSync('7z', ['e', archive, '-o' + tmp, '*.pak', '-r', '-y'], { stdio: 'ignore' })
            return readdirSync(tmp)
                .filter((f) => f.toLowerCase().endsWith('.pak'))
                .map((f) => createHash('sha256').update(readFileSync(join(tmp, f))).digest('hex'))
        } catch {
            return []
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    }

    return [createHash('sha256').update(buf).digest('hex')]
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
    const { db, sourceId } = openDb()
    const indexedFileIds = getIndexedFileIds(db)
    console.log(`  ${indexedFileIds.size} files already indexed`)

    const lastRunRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_run_at') as
        | { value: string }
        | undefined
    const lastRunAt = lastRunRow ? new Date(lastRunRow.value) : null
    console.log(lastRunAt ? `  Last run: ${lastRunAt.toISOString()} — incremental update\n` : '  No previous run — full index build\n')

    const insertMod = db.prepare(
        'INSERT OR IGNORE INTO mods (source_id, remote_id, name, url) VALUES (?, ?, ?, ?)'
    )
    const getModId = db.prepare('SELECT id FROM mods WHERE source_id = ? AND remote_id = ?')
    const insertContent = db.prepare('INSERT OR IGNORE INTO file_contents (sha256) VALUES (?)')
    const insertFile = db.prepare(
        'INSERT OR IGNORE INTO files (mod_id, sha256, remote_id, version, indexed_at) VALUES (?, ?, ?, ?, ?)'
    )

    const runStartedAt = new Date()
    console.log('Fetching mod list...')
    const mods = await listModsSince(lastRunAt)
    console.log(`  ${mods.length} mods to process\n`)

    const errors: string[] = []
    let done = 0
    let newFiles = 0

    const tasks: Task[] = mods.map((mod) => async () => {
        if (!mod.has_download) return
        let files: ModFile[] = []
        try {
            await delay(API_DELAY_MS)
            files = await listModFiles(mod.id)
        } catch (e) {
            errors.push(`mod ${mod.id}: failed to list files — ${e}`)
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`
        insertMod.run(sourceId, mod.id, mod.name, modUrl)
        const { id: modId } = getModId.get(sourceId, mod.id) as { id: number }

        for (const file of files) {
            if (!shouldDownload(file.type)) continue

            if (indexedFileIds.has(file.id)) {
                if (!lastRunAt || new Date(file.updated_at) < new Date(lastRunAt.getTime() - SINCE_BUFFER_MS)) {
                    continue
                }
            }

            try {
                await delay(API_DELAY_MS)
                const buf = await downloadBuffer(file.download_url)
                const hashes = extractPakHashes(buf)
                if (hashes.length === 0) continue
                db.transaction(() => {
                    for (const sha256 of hashes) {
                        insertContent.run(sha256)
                        const { changes } = insertFile.run(modId, sha256, file.id, file.version, new Date().toISOString())
                        if (changes > 0) newFiles++
                    }
                })()
                indexedFileIds.add(file.id)
            } catch (e) {
                errors.push(`mod ${mod.id} file ${file.id}: ${e}`)
            }
        }

        done++
        if (done % 50 === 0) {
            const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
            console.log(`  [${done}/${mods.length} mods processed — ${total} files indexed]`)
        }
    })

    console.log(`Processing ${mods.length} mods with ${CONCURRENCY} concurrent workers...\n`)
    await runPool(tasks, CONCURRENCY)

    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'last_run_at',
        runStartedAt.toISOString()
    )

    const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
    console.log(`\nDone. ${total} files in index.db (${newFiles} new this run)`)

    if (errors.length > 0) {
        console.log(`\n${errors.length} errors:`)
        errors.forEach((e) => console.log(`  - ${e}`))
    }

    db.close()

    if (newFiles === 0) {
        console.log('No new files — skipping upload.')
        process.exit(2)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
