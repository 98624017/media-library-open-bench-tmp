import { constants as fsConstants } from 'node:fs'
import { execFileSync, fork } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT = 'pending-tasks.json'
const SNAPSHOT_TEMP = `${SNAPSHOT}.tmp`
const JOURNAL = 'pending-tasks.journal'
const JOURNAL_TEMP = `${JOURNAL}.tmp`
const MUTATION = JSON.stringify({ seq: 1 }) + '\n'
const STAGES = [
  'journal-sync',
  'snapshot-temp-sync',
  'snapshot-rename',
  'snapshot-dir-sync',
  'journal-temp-sync',
  'journal-rename',
  'journal-dir-sync',
]
const FLAGS = {
  O_RDONLY: fsConstants.O_RDONLY,
  O_RDWR: fsConstants.O_RDWR,
}

function codeOf(error) {
  return typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown'
}

async function syncedWrite(file, contents) {
  const handle = await open(file, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory, flagName) {
  const handle = await open(directory, FLAGS[flagName])
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function directoryFlagProbe(root) {
  const probeDirectory = await mkdtemp(join(root, 'flags-'))
  const results = []
  try {
    await syncedWrite(join(probeDirectory, 'marker.tmp'), 'x')
    await rename(join(probeDirectory, 'marker.tmp'), join(probeDirectory, 'marker'))
    for (const [name, flags] of Object.entries(FLAGS)) {
      try {
        const handle = await open(probeDirectory, flags)
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        results.push({ name, ok: true })
      } catch (error) {
        results.push({ name, ok: false, code: codeOf(error) })
      }
    }
  } finally {
    await rm(probeDirectory, { recursive: true, force: true })
  }

  for (const result of results) {
    console.log(
      `dirsync flag=${result.name} result=${result.ok ? 'ok' : `not-tested code=${result.code}`}`,
    )
  }
  const preferred = process.platform === 'win32' ? 'O_RDWR' : 'O_RDONLY'
  const preferredResult = results.find((result) => result.name === preferred)
  const selected = results.find((result) => result.name === preferred && result.ok)
    ?? results.find((result) => result.ok)
  console.log(`dirsync selected=${selected?.name ?? 'none'}`)
  return { name: selected?.name, preferredOk: preferredResult?.ok === true }
}

function filesystemName(root) {
  if (process.platform !== 'win32') return 'not-applicable'
  try {
    const drive = parse(root).root.slice(0, 2)
    const output = execFileSync('fsutil', ['fsinfo', 'volumeinfo', drive], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.match(/File System Name\s*:\s*([^\r\n]+)/i)?.[1]?.trim() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function initializeCase(directory) {
  await mkdir(directory, { recursive: true })
  await syncedWrite(join(directory, SNAPSHOT), JSON.stringify({ seq: 0 }) + '\n')
  await syncedWrite(join(directory, JOURNAL), '')
}

async function recoverSequence(directory) {
  const snapshot = JSON.parse(await readFile(join(directory, SNAPSHOT), 'utf8'))
  if (!Number.isInteger(snapshot.seq)) throw new Error('invalid-snapshot')
  const journal = await readFile(join(directory, JOURNAL), 'utf8')
  let sequence = snapshot.seq
  for (const line of journal.split('\n')) {
    if (!line) continue
    const record = JSON.parse(line)
    if (!Number.isInteger(record.seq)) throw new Error('invalid-journal')
    sequence = Math.max(sequence, record.seq)
  }
  return sequence
}

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('ipc-unavailable'))
      return
    }
    process.send(message, (error) => (error ? reject(error) : resolve()))
  })
}

async function rendezvous(stage) {
  await send({ kind: 'ready', stage })
  await new Promise(() => {})
}

async function notTested(stage, error) {
  await send({
    kind: 'not-tested',
    stage,
    code: codeOf(error),
    reason: 'directory-fsync-unavailable',
  })
}

async function childMain(directory, stage, flagName) {
  try {
    const journalHandle = await open(join(directory, JOURNAL), 'a')
    try {
      await journalHandle.write(MUTATION, 'utf8')
      await journalHandle.sync()
    } finally {
      await journalHandle.close()
    }
    if (stage === 'journal-sync') return rendezvous(stage)

    await syncedWrite(join(directory, SNAPSHOT_TEMP), JSON.stringify({ seq: 1 }) + '\n')
    if (stage === 'snapshot-temp-sync') return rendezvous(stage)

    await rename(join(directory, SNAPSHOT_TEMP), join(directory, SNAPSHOT))
    if (stage === 'snapshot-rename') return rendezvous(stage)

    try {
      await syncDirectory(directory, flagName)
    } catch (error) {
      await notTested(stage, error)
      return
    }
    if (stage === 'snapshot-dir-sync') return rendezvous(stage)

    await syncedWrite(join(directory, JOURNAL_TEMP), '')
    if (stage === 'journal-temp-sync') return rendezvous(stage)

    await rename(join(directory, JOURNAL_TEMP), join(directory, JOURNAL))
    if (stage === 'journal-rename') return rendezvous(stage)

    try {
      await syncDirectory(directory, flagName)
    } catch (error) {
      await notTested(stage, error)
      return
    }
    return rendezvous(stage)
  } catch (error) {
    await send({ kind: 'error', stage, code: codeOf(error) }).catch(() => {})
    process.exitCode = 1
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('child-exit-timeout')), 10_000)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const onError = (error) => finish(error)
    child.once('exit', onExit)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
}

function waitForRendezvous(child, stage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rendezvous-timeout')), 10_000)
    const cleanup = () => {
      clearTimeout(timer)
      child.removeAllListeners('message')
      child.removeAllListeners('exit')
      child.removeAllListeners('error')
    }
    child.on('message', (message) => {
      if (message?.stage !== stage) return
      cleanup()
      resolve(message)
    })
    child.once('exit', () => {
      cleanup()
      reject(new Error('child-exited-before-rendezvous'))
    })
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
  })
}

async function crashCase(root, stage, flagName) {
  const directory = await mkdtemp(join(root, 'crash-'))
  let child
  try {
    await initializeCase(directory)
    child = fork(fileURLToPath(import.meta.url), ['--child', directory, stage, flagName ?? 'none'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const message = await waitForRendezvous(child, stage)
    if (message.kind === 'not-tested') {
      await waitForExit(child)
      console.log(`crash stage=${stage} result=not-tested reason=${message.reason} code=${message.code}`)
      return 'not-tested'
    }
    if (message.kind !== 'ready') throw new Error('unexpected-rendezvous')
    if (!child.kill('SIGKILL')) throw new Error('sigkill-failed')
    await waitForExit(child)
    const recovered = await recoverSequence(directory)
    if (recovered !== 1) throw new Error(`recovery-seq-${recovered}`)
    console.log(`crash stage=${stage} rendezvous=ready reopen=ok recovered-seq=${recovered}`)
    return 'ok'
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child).catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
}

async function runProbe(root) {
  await mkdir(root, { recursive: true })
  console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`)
  console.log(`filesystem=${process.env.PROBE_VOLUME_FS ?? filesystemName(root)}`)
  const directoryProbe = await directoryFlagProbe(root)
  const selectedFlag = directoryProbe.name
  let notTestedCount = directoryProbe.preferredOk ? 0 : 1
  for (const stage of STAGES) {
    if (!selectedFlag && stage.endsWith('dir-sync')) {
      console.log(`crash stage=${stage} result=not-tested reason=directory-fsync-unavailable code=none`)
      notTestedCount += 1
      continue
    }
    if (!selectedFlag && STAGES.indexOf(stage) > STAGES.indexOf('snapshot-dir-sync')) {
      console.log(`crash stage=${stage} result=not-tested reason=directory-fsync-unavailable code=none`)
      notTestedCount += 1
      continue
    }
    const result = await crashCase(root, stage, selectedFlag)
    if (result === 'not-tested') notTestedCount += 1
  }
  const overall = notTestedCount === 0 ? 'ok' : 'not-tested'
  console.log(`summary crash-recovery=${overall} not-tested=${notTestedCount}`)
}

async function main() {
  if (process.argv[2] === '--child') {
    await childMain(process.argv[3], process.argv[4], process.argv[5])
    return
  }
  const externalRoot = process.env.PROBE_ROOT
  const root = externalRoot ?? await mkdtemp(join(tmpdir(), 'dirsync-crash-probe-'))
  try {
    await runProbe(root)
  } finally {
    if (!externalRoot) await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`fatal code=${codeOf(error)}`)
  process.exitCode = 1
})
