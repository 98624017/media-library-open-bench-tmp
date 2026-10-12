import fs from 'node:fs'
import fsp from 'node:fs/promises'

/** Counted filesystem facade. Synchronous calls are timed: they block the event loop. */
export function createIo() {
  const counts = Object.create(null)
  const state = { syncMs: 0 }
  const count = (key) => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  const sync =
    (key, fn) =>
    (...args) => {
      count(key)
      const start = performance.now()
      try {
        return fn(...args)
      } finally {
        state.syncMs += performance.now() - start
      }
    }
  const promised =
    (key, fn) =>
    (...args) => {
      count(key)
      return fn(...args)
    }
  return {
    counts,
    state,
    blocked(ms) {
      state.syncMs += ms
    },
    existsSync: sync('existsSync', fs.existsSync),
    realpathSyncNative: sync('realpathSync.native', fs.realpathSync.native),
    statSync: sync('statSync', fs.statSync),
    lstat: promised('lstat', fsp.lstat),
    stat: promised('stat', fsp.stat),
    realpath: promised('realpath', fsp.realpath),
    readdir: promised('readdir', fsp.readdir),
    readFile: promised('readFile', fsp.readFile)
  }
}

export function summarizeIo(io) {
  const syncCalls =
    (io.counts.existsSync ?? 0) + (io.counts['realpathSync.native'] ?? 0) + (io.counts.statSync ?? 0)
  const asyncCalls = Object.entries(io.counts)
    .filter(([key]) => !key.endsWith('Sync') && key !== 'realpathSync.native')
    .reduce((sum, [, value]) => sum + value, 0)
  return { syncCalls, asyncCalls, blockedMs: Math.round(io.state.syncMs * 10) / 10 }
}
