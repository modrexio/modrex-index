import Database from 'better-sqlite3'

const APP_DB = 'C:/Users/oleh/AppData/Roaming/Modrex/mod-index.db'
const query = process.argv[2]
if (!query) { console.log('Usage: node lookup-mod.mjs <mod name or remote_id>'); process.exit(1) }

const db = new Database(APP_DB, { readonly: true })

const isId = /^\d+$/.test(query)
const mods = isId
    ? db.prepare('SELECT * FROM mods WHERE remote_id = ?').all(Number(query))
    : db.prepare("SELECT * FROM mods WHERE name LIKE ?").all(`%${query}%`)

if (mods.length === 0) {
    console.log('Not found in index.')
} else {
    for (const mod of mods) {
        const files = db.prepare('SELECT sha256, remote_id, version FROM files WHERE mod_id = ?').all(mod.id)
        console.log(`\n"${mod.name}" (remote_id=${mod.remote_id})`)
        console.log(`  ${files.length} pak hash(es) indexed:`)
        files.forEach(f => console.log(`    sha256=${f.sha256.slice(0,16)}… file_id=${f.remote_id} v${f.version}`))
    }
}

db.close()
