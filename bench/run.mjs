import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createIo, summarizeIo } from './io.mjs'
import { GROUP_FOLDERS, listBaseline, listLean, listProjectExports } from './listing.mjs'
import { assetJson, openRecords } from './records.mjs'
import { measureColdLoad, measureThumbnails } from './thumbs.mjs'

const args = process.argv.slice(2)
const quick = args.includes('--quick')
const label = args.find((arg) => arg.startsWith('--label='))?.slice(8) ?? `${process.platform}-local`
const only = args.find((arg) => arg.startsWith('--only='))?.slice(7).split(',')
const enabled = (part) => !only || only.includes(part)
const isWin = process.platform === 'win32'
const round = (value) => Math.round(value * 10) / 10
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const SAMPLE_CAP_MS = 45_000

/** `name=path;name=path`; defaults to the OS temp directory. */
const roots = (process.env.BENCH_ROOTS ?? `local=${os.tmpdir()}`)
  .split(';')
  .filter(Boolean)
  .map((item) => ({ name: item.slice(0, item.indexOf('=')), base: item.slice(item.indexOf('=') + 1) }))

async function pool(items, limit, worker) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++])
    })
  )
}

const dateName = (index) => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10)

/** Builds a library tree. Returns the real paths of the files that should be listed. */
async function buildLibrary(base, { dates, filesPerDate = 0, emptyGroupFolder = false, projects = 0, loose = 2 }) {
  const root = await fsp.mkdtemp(join(base, 'lib-'))
  const output = join(root, 'outputs')
  const directories = []
  const files = []
  for (let i = 0; i < dates; i += 1) {
    const date = join(output, dateName(i))
    directories.push(date)
    if (emptyGroupFolder || filesPerDate > 0) directories.push(join(date, GROUP_FOLDERS[0]))
    for (let f = 0; f < filesPerDate; f += 1) {
      files.push(f % 2 === 0 ? join(date, `img-${f}.png`) : join(date, GROUP_FOLDERS[0], `img-${f}.png`))
    }
  }
  const lastDate = join(output, dateName(Math.max(dates, 1) - 1))
  if (dates === 0) directories.push(lastDate)
  for (let f = 0; f < loose; f += 1) files.push(join(lastDate, `final-${f}.png`))
  const projectRoot = join(output, 'projects')
  directories.push(projectRoot)
  const projectFiles = []
  for (let p = 0; p < projects; p += 1) {
    const id = `project-${String(p).padStart(4, '0')}`
    directories.push(join(projectRoot, id, 'exports'))
    projectFiles.push([
      join(projectRoot, id, 'project.json'),
      JSON.stringify({
        projectId: id,
        title: `Project ${p}`,
        layers: Array.from({ length: 60 }, (_, n) => ({ id: n, name: `layer-${n}`, box: [0, 0, 512, 512], note: 'n'.repeat(240) }))
      })
    ])
    files.push(join(projectRoot, id, 'exports', 'export.png'))
  }
  await pool(directories, 32, (dir) => fsp.mkdir(dir, { recursive: true }))
  await pool(files, 64, (file) => fsp.writeFile(file, 'placeholder: listing never decodes image bytes'))
  await pool(projectFiles, 32, ([file, body]) => fsp.writeFile(file, body))
  const realOutput = await fsp.realpath(output)
  return {
    root,
    output: realOutput,
    projectRoots: [join(realOutput, 'projects'), join(root, 'app-data', 'projects')],
    files: files.map((file) => join(realOutput, file.slice(output.length + 1)))
  }
}

async function sample(run, samples = 3) {
  const times = []
  let last
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now()
    last = await run()
    times.push(round(performance.now() - start))
    if (times[0] > SAMPLE_CAP_MS) break
  }
  return { firstMs: times[0], medianMs: median(times), samples: times, last }
}

async function microCosts(base) {
  const count = quick ? 200 : 1000
  const lib = await buildLibrary(base, { dates: count, loose: 0 })
  try {
    const dirs = Array.from({ length: count }, (_, i) => join(lib.output, dateName(i)))
    const perCall = async (name, run) => {
      const start = performance.now()
      await run()
      return [name, Math.round(((performance.now() - start) / count) * 1000)]
    }
    const rows = []
    rows.push(await perCall('existsSync', () => dirs.forEach((dir) => fs.existsSync(dir))))
    rows.push(await perCall('statSync', () => dirs.forEach((dir) => fs.statSync(dir))))
    rows.push(await perCall('realpathSync.native', () => dirs.forEach((dir) => fs.realpathSync.native(dir))))
    rows.push(await perCall('await lstat', async () => { for (const dir of dirs) await fsp.lstat(dir) }))
    rows.push(await perCall('await stat', async () => { for (const dir of dirs) await fsp.stat(dir) }))
    rows.push(await perCall('await realpath', async () => { for (const dir of dirs) await fsp.realpath(dir) }))
    rows.push(await perCall('await readdir (empty)', async () => { for (const dir of dirs) await fsp.readdir(dir, { withFileTypes: true }) }))
    rows.push(await perCall('lstat x32 parallel', () => pool(dirs, 32, (dir) => fsp.lstat(dir))))
    return Object.fromEntries(rows)
  } finally {
    await fsp.rm(lib.root, { recursive: true, force: true })
  }
}

async function listingGrid(base) {
  const grid = quick
    ? [{ dates: 30, projects: 0 }, { dates: 60, projects: 5 }]
    : [
        { dates: 30, projects: 0 },
        { dates: 30, projects: 10 },
        { dates: 365, projects: 0 },
        { dates: 365, projects: 10 },
        { dates: 365, projects: 50 },
        { dates: 1460, projects: 0 },
        { dates: 1460, projects: 10 },
        { dates: 1460, projects: 50 },
        { dates: 180, filesPerDate: 20, projects: 0 },
        { dates: 180, filesPerDate: 20, projects: 10 },
        { dates: 700, filesPerDate: 30, projects: 0 },
        { dates: 700, filesPerDate: 30, projects: 30 }
      ]
  const rows = []
  for (const shape of grid) {
    const lib = await buildLibrary(base, shape)
    try {
      const extra = await listProjectExports(lib.projectRoots, createIo())
      const measure = async (list) => {
        let io
        const result = await sample(async () => {
          io = createIo()
          return list(lib.output, extra, io)
        })
        return { ...result, io: summarizeIo(io), total: result.last.total, digest: result.last.pathsDigest }
      }
      const baseline = await measure(listBaseline)
      const lean = await measure(listLean)
      if (baseline.total !== lean.total || baseline.digest !== lean.digest)
        throw new Error(`Listing variants disagree for ${JSON.stringify(shape)}`)
      if (baseline.total !== lib.files.length)
        throw new Error(`Expected ${lib.files.length} files, listed ${baseline.total}`)
      rows.push({
        dates: shape.dates,
        files: lib.files.length,
        projects: shape.projects,
        baselineFirstMs: baseline.firstMs,
        baselineMedianMs: baseline.medianMs,
        baselineBlockedMs: baseline.io.blockedMs,
        baselineSyncCalls: baseline.io.syncCalls,
        baselineAsyncCalls: baseline.io.asyncCalls,
        leanFirstMs: lean.firstMs,
        leanMedianMs: lean.medianMs,
        leanSyncCalls: lean.io.syncCalls,
        leanAsyncCalls: lean.io.asyncCalls
      })
      console.log('listing', JSON.stringify(rows.at(-1)))
    } finally {
      await fsp.rm(lib.root, { recursive: true, force: true })
    }
  }
  return rows
}

function seedUnrelated(records, count, assetsPerRecord, base) {
  const chunk = 2000
  for (let offset = 0; offset < count; offset += chunk) {
    records.insertMany(
      Array.from({ length: Math.min(chunk, count - offset) }, (_, n) => {
        const i = offset + n
        return {
          id: `unrelated-${i}`,
          createdAt: 1_600_000_000_000 + i,
          assets: Array.from({ length: assetsPerRecord }, (_, a) =>
            assetJson(join(base, 'removed', dateName(i % 900), `gone-${i}-${a}.png`), a)
          )
        }
      })
    )
  }
}

async function recordLookup(base) {
  const sizes = quick
    ? [[1000, 4]]
    : [[1000, 4], [10000, 4], [50000, 4], [10000, 20], [30000, 20]]
  const rows = []
  for (const [count, assetsPerRecord] of sizes) {
    const dir = await fsp.mkdtemp(join(base, 'db-'))
    const file = join(dir, 'records.db')
    try {
      const lib = await buildLibrary(dir, { dates: 1 })
      const folded = openRecords(file, { fold: true })
      folded.insertMany([{ id: 'visible', createdAt: 1_700_000_000_000, assets: lib.files.map(assetJson) }])
      seedUnrelated(folded, count, assetsPerRecord, dir)
      folded.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const sizeBefore = fs.statSync(file).size
      const plain = openRecords(file, { fold: false })
      const time = async (run) => {
        const result = await sample(async () => run(), 5)
        if (result.last.length !== 2) throw new Error(`Expected 2 matches, got ${result.last.length}`)
        return result
      }
      const scanFolded = await time(() => folded.findByScan(lib.files))
      const scanPlain = await time(() => plain.findByScan(lib.files))
      const buildMs = folded.buildPathIndex()
      folded.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const sizeAfter = fs.statSync(file).size
      const indexed = await time(() => folded.findByIndex(lib.files))
      rows.push({
        records: count,
        assets: count * assetsPerRecord,
        dbMb: round(sizeBefore / 1048576),
        scanFoldedFirstMs: scanFolded.firstMs,
        scanFoldedMedianMs: scanFolded.medianMs,
        scanPlainMedianMs: scanPlain.medianMs,
        indexBuildMs: round(buildMs),
        indexExtraMb: round((sizeAfter - sizeBefore) / 1048576),
        indexedFirstMs: indexed.firstMs,
        indexedMedianMs: indexed.medianMs
      })
      console.log('records', JSON.stringify(rows.at(-1)))
      plain.close()
      folded.close()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
  return rows
}

async function profiles(base) {
  const shapes = quick
    ? [{ name: 'new-user', dates: 1 }, { name: 'small', dates: 20, filesPerDate: 4, projects: 3, unrelated: [500, 4] }]
    : [
        { name: 'new-user (2 files)', dates: 1 },
        { name: 'cleaned 1y (2 files left)', dates: 365, emptyGroupFolder: true, projects: 10, unrelated: [5000, 4] },
        { name: 'cleaned 3y + projects (2 files left)', dates: 1000, emptyGroupFolder: true, projects: 50, unrelated: [20000, 4] },
        { name: 'active 6mo (3.6k files)', dates: 180, filesPerDate: 20, projects: 10 },
        { name: 'heavy 2y (21k files)', dates: 700, filesPerDate: 30, projects: 30 }
      ]
  const rows = []
  for (const shape of shapes) {
    const lib = await buildLibrary(base, { projects: 0, ...shape })
    const file = join(lib.root, 'records.db')
    try {
      const records = openRecords(file, { fold: isWin })
      const perRecord = 4
      const owned = []
      for (let offset = 0; offset < lib.files.length; offset += perRecord) {
        owned.push({
          id: `owned-${offset}`,
          createdAt: 1_700_000_000_000 + offset,
          assets: lib.files.slice(offset, offset + perRecord).map(assetJson)
        })
      }
      records.insertMany(owned)
      if (shape.unrelated) seedUnrelated(records, shape.unrelated[0], shape.unrelated[1], lib.root)
      const indexBuildMs = records.buildPathIndex()
      const run = (variant) => async () => {
        const io = createIo()
        const timings = {}
        let associationMs = 0
        const startProjects = performance.now()
        const extra = await listProjectExports(lib.projectRoots, io, { parallel: variant === 'baseline' ? 1 : 8 })
        const projectsMs = performance.now() - startProjects
        const associate = (paths) => {
          const start = performance.now()
          const matches = variant === 'baseline' ? records.findByScan(paths, io) : records.findByIndex(paths, io)
          const elapsed = performance.now() - start
          associationMs += elapsed
          io.blocked(elapsed)
          return matches
        }
        const result = await (variant === 'baseline' ? listBaseline : listLean)(lib.output, extra, io, { associate, timings })
        if (result.page.some((entry) => !entry.recordId)) throw new Error('Unassociated entry on first page')
        return { result, projectsMs, associationMs, finishMs: timings.finishMs, io: summarizeIo(io) }
      }
      const measured = {}
      for (const variant of ['baseline', 'candidate']) {
        const result = await sample(run(variant))
        const stages = result.last
        measured[variant] = {
          firstMs: result.firstMs,
          medianMs: result.medianMs,
          projectsMs: round(stages.projectsMs),
          associationMs: round(stages.associationMs),
          sortHashMs: round(stages.finishMs),
          blockedMs: stages.io.blockedMs,
          syncCalls: stages.io.syncCalls,
          asyncCalls: stages.io.asyncCalls,
          total: stages.result.total,
          digest: stages.result.pathsDigest
        }
      }
      if (measured.baseline.digest !== measured.candidate.digest || measured.baseline.total !== lib.files.length)
        throw new Error(`Profile variants disagree: ${shape.name}`)
      rows.push({ profile: shape.name, files: lib.files.length, indexBuildMs: round(indexBuildMs), ...flatten(measured) })
      console.log('profile', JSON.stringify(rows.at(-1)))
      records.close()
    } finally {
      await fsp.rm(lib.root, { recursive: true, force: true })
    }
  }
  return rows
}

function flatten(measured) {
  const out = {}
  for (const [variant, values] of Object.entries(measured)) {
    for (const [key, value] of Object.entries(values)) {
      if (key !== 'digest' && key !== 'total') out[`${variant}.${key}`] = value
    }
  }
  return out
}

function environment() {
  const powershell = (command) => {
    if (!isWin) return null
    const child = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
    return (child.stdout || child.stderr || '').trim().slice(0, 600)
  }
  const sqlite = new DatabaseSync(':memory:')
  const sqliteVersion = sqlite.prepare('select sqlite_version() as v').get().v
  sqlite.close()
  return {
    label,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGb: round(os.totalmem() / 2 ** 30),
    node: process.version,
    sqlite: sqliteVersion,
    defender: powershell(
      'Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,OnAccessProtectionEnabled,IoavProtectionEnabled | ConvertTo-Json -Compress'
    ),
    defenderExclusions: powershell('(Get-MpPreference).ExclusionPath -join ";"')
  }
}

function table(rows) {
  if (!rows?.length) return '_no rows_\n'
  const keys = Object.keys(rows[0])
  return [
    `| ${keys.join(' | ')} |`,
    `| ${keys.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${keys.map((key) => row[key]).join(' | ')} |`)
  ].join('\n') + '\n'
}

const report = { env: environment(), roots: {} }
console.log('env', JSON.stringify(report.env))
for (const root of roots) {
  await fsp.mkdir(root.base, { recursive: true })
  const section = {}
  console.log(`--- root ${root.name}: ${root.base}`)
  if (enabled('micro')) section.microUsPerCall = await microCosts(root.base)
  if (enabled('micro')) console.log('micro', JSON.stringify(section.microUsPerCall))
  if (enabled('listing')) section.listing = await listingGrid(root.base)
  if (enabled('profiles')) section.profiles = await profiles(root.base)
  report.roots[root.name] = section
}
if (enabled('records')) report.records = await recordLookup(roots[0].base)
if (enabled('thumbs')) {
  report.imageColdLoad = measureColdLoad()
  const dir = await fsp.mkdtemp(join(roots[0].base, 'img-'))
  try {
    report.thumbnails = await measureThumbnails(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
  console.log('thumbs', JSON.stringify({ cold: report.imageColdLoad, thumbnails: report.thumbnails }))
}

let markdown = `## ${label}\n\n\`\`\`json\n${JSON.stringify(report.env, null, 2)}\n\`\`\`\n\n`
for (const [name, section] of Object.entries(report.roots)) {
  markdown += `### Root: ${name}\n\n`
  if (section.microUsPerCall)
    markdown += `Per-call cost (microseconds)\n\n${table([section.microUsPerCall])}\n`
  if (section.listing) markdown += `Listing only (no record association)\n\n${table(section.listing)}\n`
  if (section.profiles) markdown += `End-to-end profiles\n\n${table(section.profiles)}\n`
}
if (report.records) markdown += `### Record lookup for two paths\n\n${table(report.records)}\n`
if (report.imageColdLoad) markdown += `### Image library cold load\n\n${table(report.imageColdLoad)}\n`
if (report.thumbnails)
  markdown += `### Two 4096x4096 thumbnails\n\n\`\`\`json\n${JSON.stringify(report.thumbnails)}\n\`\`\`\n`
await fsp.mkdir('results', { recursive: true })
await fsp.writeFile(join('results', `${label}.json`), JSON.stringify(report, null, 2))
await fsp.writeFile(join('results', `${label}.md`), markdown)
if (process.env.GITHUB_STEP_SUMMARY) await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
console.log(`wrote results/${label}.json`)
