import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Path identity used for matching. `fold` mirrors case-insensitive volumes. */
export function makePathKey(fold) {
  return fold ? (value) => win32.normalize(value).toLowerCase() : (value) => value
}

const PROMPT = 'p'.repeat(200)
const PARAMS = JSON.stringify({ note: 'x'.repeat(560) })

export function assetJson(localPath, index) {
  return {
    assetKey: `image:${index}`,
    mediaType: 'image',
    localPath,
    status: 'ready',
    remoteUrl: `https://cdn.example.invalid/${'u'.repeat(96)}/${index}.png`,
    width: 2048,
    height: 2048,
    bytes: 3_456_789,
    label: `result ${index}`
  }
}

/** 53-bit non-cryptographic hash; collisions only add candidates that SQL re-verifies. */
function hashKey(value) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b + code, 0x85ebca6b) ^ (b >>> 13)
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) >>> 11)
}

export function openRecords(file, { fold }) {
  let memoryIndex = new Map()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL')
  const pathKey = makePathKey(fold)
  if (fold) {
    db.function('path_key', { deterministic: true }, (value) =>
      typeof value === 'string' ? pathKey(value) : null
    )
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
      prompt TEXT, params_json TEXT, created_at INTEGER NOT NULL, assets_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC);
  `)
  const insert = db.prepare(
    `INSERT INTO records (id, kind, status, model, prompt, params_json, created_at, assets_json)
     VALUES (?, 'image', 'completed', 'bench', ?, ?, ?, ?)`
  )
  const expression = "json_extract(asset.value, '$.localPath')"
  const matching = fold ? `path_key(${expression})` : expression
  const mapRow = (row) => {
    const asset = JSON.parse(row.result_asset_json)
    JSON.parse(row.assets_json)
    return { recordId: row.id, createdAt: row.created_at, path: asset.localPath, status: asset.status }
  }
  const reconcile = (paths, rows, io, verifiedPresent = false) => {
    // Baseline reconciles every requested path with a synchronous stat. A caller that has
    // just verified each file passes verifiedPresent and skips it.
    if (!verifiedPresent) {
      for (const path of paths) {
        try {
          ;(io?.statSync ?? statSync)(path)
        } catch {
          /* missing files are tolerated */
        }
      }
    }
    return rows.map(mapRow)
  }
  return {
    db,
    pathKey,
    insertMany(rows) {
      db.exec('BEGIN')
      for (const row of rows) insert.run(row.id, PROMPT, PARAMS, row.createdAt, JSON.stringify(row.assets))
      db.exec('COMMIT')
    },
    /** Baseline: expand every asset of every record and compare its path. */
    findByScan(paths, io) {
      const keys = [...new Set(paths.map(pathKey))]
      const rows = db
        .prepare(
          `SELECT h.*, asset.value AS result_asset_json
           FROM records h
           JOIN json_each(CASE WHEN json_valid(h.assets_json) THEN h.assets_json ELSE '[]' END) asset
           WHERE ${matching} IN (${keys.map(() => '?').join(',')})
           ORDER BY h.created_at DESC, h.id ASC, CAST(asset.key AS INTEGER) ASC`
        )
        .all(...keys)
      return reconcile(paths, rows, io)
    },
    /** Candidate: a maintained path index. Returns build cost for the one-time backfill. */
    buildPathIndex() {
      const start = performance.now()
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_paths (
          path_key TEXT NOT NULL, record_id TEXT NOT NULL, asset_idx INTEGER NOT NULL,
          PRIMARY KEY (path_key, record_id, asset_idx)
        ) WITHOUT ROWID;
        DELETE FROM asset_paths;
      `)
      db.exec(
        `INSERT OR IGNORE INTO asset_paths
         SELECT ${matching}, h.id, CAST(asset.key AS INTEGER)
         FROM records h
         JOIN json_each(CASE WHEN json_valid(h.assets_json) THEN h.assets_json ELSE '[]' END) asset
         WHERE ${expression} IS NOT NULL`
      )
      return performance.now() - start
    },
    findByIndex(paths, io) {
      const keys = [...new Set(paths.map(pathKey))]
      const rows = db
        .prepare(
          `SELECT h.*, json_extract(h.assets_json, '$[' || p.asset_idx || ']') AS result_asset_json
           FROM asset_paths p JOIN records h ON h.id = p.record_id
           WHERE p.path_key IN (${keys.map(() => '?').join(',')})
           ORDER BY h.created_at DESC, h.id ASC, p.asset_idx ASC`
        )
        .all(...keys)
      return reconcile(paths, rows, io)
    },
    /**
     * Candidate without schema change: an in-memory hash of path identity to row ids, built by
     * one scan and reused until the connection observes a write.
     */
    buildMemoryIndex() {
      const start = performance.now()
      const before = process.memoryUsage().heapUsed
      const index = new Map()
      const rows = db.prepare('SELECT id, assets_json FROM records WHERE assets_json IS NOT NULL').iterate()
      for (const row of rows) {
        let parsed
        try {
          parsed = JSON.parse(row.assets_json)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue
        for (const asset of Object.values(parsed)) {
          if (typeof asset?.localPath !== 'string') continue
          const hash = hashKey(pathKey(asset.localPath))
          const current = index.get(hash)
          if (current === undefined) index.set(hash, row.id)
          else if (typeof current === 'string') {
            if (current !== row.id) index.set(hash, [current, row.id])
          } else if (!current.includes(row.id)) current.push(row.id)
        }
      }
      memoryIndex = index
      return {
        ms: performance.now() - start,
        heapMb: (process.memoryUsage().heapUsed - before) / 1048576,
        entries: index.size
      }
    },
    findByMemoryIndex(paths, io, verifiedPresent = false) {
      const keys = [...new Set(paths.map(pathKey))]
      const rowIds = new Set()
      for (const key of keys) {
        const hit = memoryIndex.get(hashKey(key))
        if (hit === undefined) continue
        if (typeof hit === 'string') rowIds.add(hit)
        else for (const id of hit) rowIds.add(id)
      }
      if (rowIds.size === 0) return reconcile(paths, [], io, verifiedPresent)
      const rows = db
        .prepare(
          `SELECT h.*, asset.value AS result_asset_json
           FROM records h
           JOIN json_each(CASE WHEN json_valid(h.assets_json) THEN h.assets_json ELSE '[]' END) asset
           WHERE h.id IN (SELECT value FROM json_each(?))
             AND ${matching} IN (SELECT value FROM json_each(?))
           ORDER BY h.created_at DESC, h.id ASC, CAST(asset.key AS INTEGER) ASC`
        )
        .all(JSON.stringify([...rowIds]), JSON.stringify(keys))
      return reconcile(paths, rows, io, verifiedPresent)
    },
    close() {
      db.close()
    }
  }
}
