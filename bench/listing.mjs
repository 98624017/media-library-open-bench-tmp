import { createHash } from 'node:crypto'
import path from 'node:path'

const { basename, dirname, extname, isAbsolute, join, relative, resolve, normalize } = path
const isWin = process.platform === 'win32'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const EXPORT_DIR = 'layer-exports'
export const GROUP_FOLDERS = (process.env.BENCH_GROUP_FOLDERS ?? 'group-a,group-b,group-c,group-d').split(',')
const BATCH_RE = /^batch-\d+$/
const VISIBLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.txt'])
const READ_BATCH = 32
export const ASSOCIATION_BATCH = 500

const visibleFile = (name) => !name.startsWith('.') && VISIBLE.has(extname(name).toLowerCase())
const groupFolder = (name) => GROUP_FOLDERS.includes(name) || BATCH_RE.test(name)

export function pathKey(filePath) {
  const value = resolve(filePath)
  return isWin ? value.toLowerCase() : value
}

function compareEntries(left, right) {
  const byName = left.name.localeCompare(right.name, undefined, { numeric: true })
  void byName
  const byTime = (left.createdAt ?? left.modifiedAt) - (right.createdAt ?? right.modifiedAt)
  if (byTime !== 0) return -byTime
  return pathKey(left.path).localeCompare(pathKey(right.path))
}

function finish(entries, rootPath, pageSize, cheapSort, timings) {
  const start = performance.now()
  const sorted = cheapSort
    ? entries.sort((left, right) => {
        const byTime = (right.createdAt ?? right.modifiedAt) - (left.createdAt ?? left.modifiedAt)
        if (byTime !== 0) return byTime
        const a = pathKey(left.path)
        const b = pathKey(right.path)
        return a < b ? -1 : a > b ? 1 : 0
      })
    : entries.sort(compareEntries)
  const revision = createHash('sha256').update(JSON.stringify([rootPath, rootPath]))
  for (const entry of sorted) revision.update('\n').update(JSON.stringify(entry))
  const paths = createHash('sha256')
  for (const key of sorted.map((entry) => pathKey(entry.path)).sort()) paths.update(key).update('\n')
  const result = {
    total: sorted.length,
    revision: revision.digest('hex'),
    pathsDigest: paths.digest('hex'),
    page: sorted.slice(0, pageSize)
  }
  if (timings) timings.finishMs = performance.now() - start
  return result
}

/**
 * Baseline: every directory and file is re-validated against the allowed roots with
 * synchronous exists/realpath pairs, and the library root is re-resolved per directory.
 */
export async function listBaseline(rootDir, extraDirs, io, { associate, pageSize = 48, timings } = {}) {
  const resolvePath = (value) => {
    const resolved = resolve(value)
    if (io.existsSync(resolved)) return normalize(io.realpathSyncNative(resolved))
    const parent = dirname(resolved)
    return parent === resolved ? normalize(resolved) : join(resolvePath(parent), basename(resolved))
  }
  const fold = (value) => (isWin ? value.toLowerCase() : value)
  const isPathInside = (parent, target) => {
    const rel = relative(fold(resolvePath(parent)), fold(resolvePath(target)))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  const relativeParts = (root, target) => {
    if (!isPathInside(root, target)) return null
    const value = relative(root, target)
    if (!value) return []
    const parts = value.split(/[\\/]/)
    return parts.some((part) => !part || part === '.' || part === '..') ? null : parts
  }
  const isExtraDir = (dir) => extraDirs.some((extra) => pathKey(extra.path) === pathKey(dir))
  const isAllowedDirectory = (root, dir) => {
    if (isExtraDir(dir)) return true
    const parts = relativeParts(root, dir)
    if (!parts) return false
    if (parts.length === 0) return true
    if (parts.length === 1) return DATE_RE.test(parts[0]) || parts[0] === EXPORT_DIR
    if (parts.length === 2 && DATE_RE.test(parts[0])) return groupFolder(parts[1])
    return false
  }
  const resolveDirectory = async (root, requested) => {
    const rootPath = await io.realpath(resolve(root))
    let current = requested ? resolve(requested) : rootPath
    if ((await io.lstat(current)).isSymbolicLink()) throw new Error('symlink')
    current = await io.realpath(current)
    if (!isAllowedDirectory(rootPath, current)) throw new Error(`denied ${current}`)
    if (!(await io.stat(current)).isDirectory()) throw new Error('not a directory')
    return { rootPath, path: current }
  }
  const validateFile = async (root, requested) => {
    const absolute = resolve(requested)
    if ((await io.lstat(absolute)).isSymbolicLink()) throw new Error('symlink')
    const real = resolvePath(absolute)
    if (!io.existsSync(real)) throw new Error('missing')
    if (![root, ...extraDirs.map((extra) => extra.path)].some((allowed) => isPathInside(allowed, real)))
      throw new Error('denied')
    if (!visibleFile(basename(real)) || !isAllowedDirectory(root, dirname(real)))
      throw new Error('denied')
    if (!(await io.stat(real)).isFile()) throw new Error('not a file')
    return real
  }
  const entryFromPath = async (root, filePath, name = basename(filePath)) => {
    const info = await io.lstat(filePath)
    if (info.isSymbolicLink()) return null
    const directory = info.isDirectory()
    return {
      path: directory ? filePath : await validateFile(root, filePath),
      name,
      directory,
      size: directory ? 0 : info.size,
      modifiedAt: info.mtimeMs
    }
  }
  const readEntries = async (root, current) => {
    const parts = relativeParts(root, current) ?? []
    const dirents = await io.readdir(current, { withFileTypes: true })
    const candidates = []
    const extraOwner = isExtraDir(current)
    if (parts.length === 0 && !extraOwner) {
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
        if (DATE_RE.test(dirent.name) || dirent.name === EXPORT_DIR)
          candidates.push({ path: join(current, dirent.name) })
      }
      for (const extra of extraDirs) {
        if (isPathInside(root, extra.path) && basename(extra.path) === EXPORT_DIR) continue
        candidates.push({ path: extra.path, name: extra.label })
      }
    } else {
      const inDate = !extraOwner && parts.length === 1 && DATE_RE.test(parts[0])
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const entryPath = join(current, dirent.name)
        if (dirent.isFile()) {
          if (visibleFile(dirent.name)) candidates.push({ path: entryPath })
        } else if (dirent.isDirectory() && inDate && groupFolder(dirent.name)) {
          candidates.push({ path: entryPath })
        }
      }
      if (inDate) {
        for (const extra of extraDirs) {
          if (isPathInside(current, extra.path)) candidates.push({ path: extra.path, name: extra.label })
        }
      }
    }
    const results = []
    for (let offset = 0; offset < candidates.length; offset += READ_BATCH) {
      const batch = await Promise.all(
        candidates
          .slice(offset, offset + READ_BATCH)
          .map((candidate) => entryFromPath(root, candidate.path, candidate.name))
      )
      results.push(...batch.filter(Boolean))
    }
    return results
  }
  const visited = new Set()
  const discovered = []
  const discover = async (root, directory) => {
    const resolved = await resolveDirectory(root, directory)
    const key = pathKey(resolved.path)
    if (visited.has(key)) return
    visited.add(key)
    for (const entry of await readEntries(root, resolved.path)) {
      if (entry.directory) await discover(root, entry.path)
      else discovered.push(entry)
    }
  }

  const top = await resolveDirectory(rootDir, undefined)
  await discover(top.rootPath, top.path)
  const unique = new Map()
  for (const entry of discovered) if (!unique.has(pathKey(entry.path))) unique.set(pathKey(entry.path), entry)
  let entries = [...unique.values()]
  if (associate) {
    const matches = new Map()
    for (let offset = 0; offset < entries.length; offset += ASSOCIATION_BATCH) {
      const paths = entries.slice(offset, offset + ASSOCIATION_BATCH).map((entry) => entry.path)
      for (const match of associate(paths)) if (!matches.has(pathKey(match.path))) matches.set(pathKey(match.path), match)
    }
    entries = entries.map((entry) => {
      const match = matches.get(pathKey(entry.path))
      return match ? { ...entry, createdAt: match.createdAt, recordId: match.recordId } : entry
    })
  }
  return finish(entries, top.rootPath, pageSize, false, timings)
}

/**
 * Candidate: resolve the root and the extra directories once, trust non-symlink directory
 * entries beneath an already-resolved parent, and read file metadata with one lstat.
 */
export async function listLean(rootDir, extraDirs, io, { associate, pageSize = 48, timings } = {}) {
  const rootPath = await io.realpath(resolve(rootDir))
  const files = []
  const visited = new Set()
  const readFiles = async (directory, dirents) => {
    const names = dirents.filter((d) => d.isFile() && !d.isSymbolicLink() && visibleFile(d.name))
    for (let offset = 0; offset < names.length; offset += READ_BATCH) {
      const batch = await Promise.all(
        names.slice(offset, offset + READ_BATCH).map(async (dirent) => {
          const filePath = join(directory, dirent.name)
          const info = await io.lstat(filePath).catch(() => null)
          if (!info || !info.isFile()) return null
          return { path: filePath, name: dirent.name, directory: false, size: info.size, modifiedAt: info.mtimeMs }
        })
      )
      files.push(...batch.filter(Boolean))
    }
  }
  const walkLeaf = async (directory) => {
    const key = pathKey(directory)
    if (visited.has(key)) return
    visited.add(key)
    const dirents = await io.readdir(directory, { withFileTypes: true }).catch(() => null)
    if (dirents) await readFiles(directory, dirents)
    return dirents
  }
  const rootDirents = await io.readdir(rootPath, { withFileTypes: true })
  visited.add(pathKey(rootPath))
  for (const dirent of rootDirents) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
    const directory = join(rootPath, dirent.name)
    if (dirent.name === EXPORT_DIR) {
      await walkLeaf(directory)
    } else if (DATE_RE.test(dirent.name)) {
      const dirents = await walkLeaf(directory)
      for (const child of dirents ?? []) {
        if (child.isDirectory() && !child.isSymbolicLink() && groupFolder(child.name))
          await walkLeaf(join(directory, child.name))
      }
    }
  }
  for (const extra of extraDirs) {
    // Registered directories may live outside the root: resolve each exactly once.
    const real = await io.realpath(extra.path).catch(() => null)
    if (real) await walkLeaf(real)
  }
  let entries = files
  if (associate) {
    const matches = new Map()
    for (let offset = 0; offset < entries.length; offset += ASSOCIATION_BATCH) {
      const paths = entries.slice(offset, offset + ASSOCIATION_BATCH).map((entry) => entry.path)
      for (const match of associate(paths)) if (!matches.has(pathKey(match.path))) matches.set(pathKey(match.path), match)
    }
    entries = entries.map((entry) => {
      const match = matches.get(pathKey(entry.path))
      return match ? { ...entry, createdAt: match.createdAt, recordId: match.recordId } : entry
    })
  }
  return finish(entries, rootPath, pageSize, true, timings)
}

/** Sequential discovery of registered project export directories (baseline behaviour). */
export async function listProjectExports(projectRoots, io, { parallel = 1 } = {}) {
  const results = []
  for (const root of projectRoots) {
    let dirents
    try {
      const info = await io.lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      dirents = await io.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    const projects = dirents.filter((d) => d.isDirectory() && !d.isSymbolicLink())
    const inspect = async (dirent) => {
      const projectDir = join(root, dirent.name)
      try {
        const project = JSON.parse(await io.readFile(join(projectDir, 'project.json'), 'utf8'))
        if (project.projectId !== dirent.name) return null
        const exportDir = join(projectDir, 'exports')
        const info = await io.lstat(exportDir)
        if (!info.isDirectory() || info.isSymbolicLink()) return null
        const files = await io.readdir(exportDir, { withFileTypes: true })
        if (!files.some((f) => f.isFile() && ['.psd', '.png'].includes(extname(f.name).toLowerCase())))
          return null
        return { path: exportDir, label: `${project.title} export` }
      } catch {
        return null
      }
    }
    for (let offset = 0; offset < projects.length; offset += parallel) {
      const batch = await Promise.all(projects.slice(offset, offset + parallel).map(inspect))
      results.push(...batch.filter(Boolean))
    }
  }
  return results
}
