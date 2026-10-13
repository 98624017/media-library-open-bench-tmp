// Synthetic probe: can a directory handle be flushed on this platform, and with which open flags?
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const roots = [...new Set([tmpdir(), process.env.RUNNER_TEMP, process.env.APPDATA, homedir()].filter(Boolean))]
console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`)

for (const root of roots) {
  const dir = await mkdtemp(join(root, 'dirsync-'))
  if (process.platform === 'win32') {
    try {
      const drive = dir.slice(0, 2)
      const info = execSync(`fsutil fsinfo volumeinfo ${drive}`, { encoding: 'utf8' })
      console.log(`root=${root} fs=${/File System Name\s*:\s*(\S+)/.exec(info)?.[1] ?? 'unknown'}`)
    } catch (error) {
      console.log(`root=${root} fs=unknown (${error.message.split('\n')[0]})`)
    }
  } else console.log(`root=${root}`)

  for (const flags of ['r', 'r+']) {
    let handle
    try {
      handle = await open(dir, flags)
    } catch (error) {
      console.log(`  open(${flags}) -> ${error.code}`)
      continue
    }
    try {
      // Mirror the pattern under study: temp file -> rename -> flush the containing directory.
      await writeFile(join(dir, 'a.tmp'), 'x')
      await rename(join(dir, 'a.tmp'), join(dir, `a-${flags.length}.json`))
      for (const [name, call] of [['sync', () => handle.sync()], ['datasync', () => handle.datasync()]]) {
        try {
          const started = performance.now()
          await call()
          console.log(`  open(${flags}) ok, ${name} ok in ${(performance.now() - started).toFixed(2)}ms`)
        } catch (error) {
          console.log(`  open(${flags}) ok, ${name} -> ${error.code}`)
        }
      }
    } finally {
      await handle.close()
    }
  }
  await rm(dir, { recursive: true, force: true })
}
