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

export function openRecords(file, { fold }) {
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
  const reconcile = (paths, rows, io) => {
    // Baseline reconciles every requested path with a synchronous stat.
    for (const path of paths) {
      try {
        ;(io?.statSync ?? statSync)(path)
      } catch {
        /* missing files are tolerated */
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
    close() {
      db.close()
    }
  }
}
