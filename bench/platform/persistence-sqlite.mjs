import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { measure, round } from './metrics.mjs'
import { documentFor } from './persistence-store.mjs'

const PAGE_SIZE = 50

function createDatabase(path, rowCount) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
    body_json TEXT NOT NULL CHECK(json_valid(body_json)), created_at INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO documents VALUES (?, 0, ?, ?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let id = 1; id <= rowCount; id++)
      insert.run(id, JSON.stringify(documentFor(id)), id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return db
}

function databaseMetadata(db, rowCount, updates) {
  return {
    rowCount,
    updates,
    documentBytes: Buffer.byteLength(JSON.stringify(documentFor(1))),
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
    walAutocheckpoint: db.prepare('PRAGMA wal_autocheckpoint').get()
      .wal_autocheckpoint,
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get()
      .version,
    setupExcluded: true,
    serializationIncluded: true,
    databaseCache: 'warm-after-generated-setup',
    tableModel: 'generic integer primary key; json_valid constraint retained',
    pageModel:
      'unfiltered synthetic table; application visibility predicates and expression indexes excluded'
  }
}

export async function runSqliteBench(directoryPath, quick, samples, publish) {
  const updates = quick ? 5 : 30
  for (const rowCount of quick ? [100, 1000] : [2000, 20000]) {
    for (const workload of ['writes', 'document-scan', 'page']) {
      const variants =
        workload === 'writes'
          ? ['autocommit', 'hypothetical-independent-group']
          : workload === 'document-scan'
            ? ['all-then-json', 'iterate-then-json']
            : ['prepare-per-row', 'reuse-get-statement']
      for (let sample = 0; sample < samples; sample++) {
        const order = sample % 2 ? [...variants].reverse() : variants
        for (const variant of order) {
          const db = createDatabase(
            join(
              directoryPath,
              `${workload}-${rowCount}-${variant}-${sample}.db`
            ),
            rowCount
          )
          try {
            const metadata = databaseMetadata(db, rowCount, updates)
            const measured = await measure(() => {
              if (workload === 'writes') {
                const grouped = variant !== 'autocommit'
                if (grouped) db.exec('BEGIN IMMEDIATE')
                try {
                  for (let id = 1; id <= updates; id++) {
                    const current = db
                      .prepare('SELECT * FROM documents WHERE id = ?')
                      .get(id)
                    const next = JSON.parse(
                      JSON.stringify({
                        ...JSON.parse(current.body_json),
                        revision: 1
                      })
                    )
                    const result = db
                      .prepare(
                        'UPDATE documents SET revision = 1, body_json = ? WHERE id = ? AND revision = 0'
                      )
                      .run(JSON.stringify(next), id)
                    assert.equal(result.changes, 1)
                  }
                  if (grouped) db.exec('COMMIT')
                } catch (error) {
                  if (grouped) db.exec('ROLLBACK')
                  throw error
                }
                return updates
              }
              if (workload === 'document-scan') {
                const statement = db.prepare(
                  'SELECT body_json FROM documents ORDER BY id'
                )
                return variant === 'all-then-json'
                  ? statement
                      .all()
                      .map(({ body_json }) => JSON.parse(body_json))
                  : Array.from(statement.iterate(), ({ body_json }) =>
                      JSON.parse(body_json)
                    )
              }
              const ids = db
                .prepare(
                  'SELECT id FROM documents ORDER BY created_at DESC, id DESC LIMIT ?'
                )
                .all(PAGE_SIZE)
              const get =
                variant === 'reuse-get-statement'
                  ? db.prepare('SELECT body_json FROM documents WHERE id = ?')
                  : null
              return ids.map(({ id }) =>
                JSON.parse(
                  (
                    get ??
                    db.prepare('SELECT body_json FROM documents WHERE id = ?')
                  ).get(id).body_json
                )
              )
            })
            let checks
            if (workload === 'writes') {
              assert.equal(
                db
                  .prepare(
                    'SELECT count(*) AS count FROM documents WHERE revision = 1'
                  )
                  .get().count,
                updates
              )
              for (const row of db
                .prepare('SELECT * FROM documents WHERE revision = 1')
                .all()) {
                assert.deepEqual(
                  JSON.parse(row.body_json),
                  documentFor(row.id, 1)
                )
              }
              checks = {
                updatedRows: updates,
                jsonMatchesRevision: true,
                paidActions: 0
              }
            } else {
              const documents = measured.value
              const expected =
                workload === 'document-scan' ? rowCount : PAGE_SIZE
              assert.equal(documents.length, expected)
              assert.equal(
                documents[0].id,
                workload === 'document-scan' ? 1 : rowCount
              )
              assert.equal(
                documents.at(-1).id,
                workload === 'document-scan'
                  ? rowCount
                  : rowCount - PAGE_SIZE + 1
              )
              for (const document of documents)
                assert.deepEqual(document, documentFor(document.id))
              checks = {
                decodedRows: expected,
                completeDocuments: true,
                ordered: true
              }
            }
            await publish({
              scenario: `sqlite-${workload}-${rowCount}`,
              variant,
              sample,
              fixtureMetadata: {
                ...metadata,
                groupingSemantics:
                  workload === 'writes'
                    ? 'independent synthetic rows; acknowledgment after commit only'
                    : null,
                productValidationExcluded: true,
                outputScope:
                  workload === 'page'
                    ? 'first 50 complete documents'
                    : 'all selected complete documents'
              },
              metrics: {
                ...measured.metrics,
                operationsPerSecond: round(
                  ((workload === 'writes' ? updates : measured.value.length) *
                    1000) /
                    measured.metrics.wallMs
                )
              },
              checks
            })
          } finally {
            db.close()
          }
        }
      }
    }
  }
}
