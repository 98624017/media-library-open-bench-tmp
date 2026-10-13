const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, shell } = require('electron')

const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
const policy = option('policy')
const reportPath = option('report')
const userData = option('user-data')
const width = option('quick') === 'true' ? 256 : 2048
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function main() {
  assert(reportPath, 'Missing report path')
  assert(
    userData && path.isAbsolute(userData),
    'Missing isolated user-data path'
  )
  assert(
    path.basename(path.dirname(userData)).startsWith('native-electron-policy-')
  )
  app.setPath('userData', userData)
  await app.whenReady()
  const sharp = require('sharp')
  const { setCachePolicy } = await import('./images.mjs')
  const { measure } = await import('./metrics.mjs')
  const root = await fs.mkdtemp(
    path.join(path.dirname(userData), 'native-cache-policy-')
  )
  const report = {
    completed: false,
    policy,
    runtime: process.versions,
    platform: process.platform,
    arch: process.arch,
    sharp: sharp.versions,
    isolatedUserData: true,
    rows: []
  }
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  const preview = (input) =>
    sharp(input)
      .rotate()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
  try {
    sharp.cache(false)
    const oldBytes = await sharp({
      create: { width, height: width, channels: 3, background: '#bb3344' }
    })
      .jpeg({ quality: 92 })
      .toBuffer()
    const newBytes = await sharp({
      create: { width, height: width, channels: 3, background: '#33bb44' }
    })
      .jpeg({ quality: 92 })
      .toBuffer()
    const expectedOld = digest(await preview(oldBytes))
    const expectedNew = digest(await preview(newBytes))
    assert.notEqual(expectedOld, expectedNew)
    for (const action of [
      'rename',
      'unlink',
      'trash',
      'overwrite',
      'replace'
    ]) {
      sharp.cache(false)
      const source = path.join(root, `generated ${action} é.jpg`)
      const renamed = path.join(root, `renamed ${action}.jpg`)
      const replacement = path.join(root, `replacement ${action}.jpg`)
      await fs.writeFile(source, oldBytes)
      if (action === 'replace') await fs.writeFile(replacement, newBytes)
      const configuredCache = setCachePolicy(sharp, policy)
      let warmOutput
      for (let repeat = 0; repeat < 3; repeat++)
        warmOutput = await preview(source)
      assert.equal(digest(warmOutput), expectedOld)
      const cacheBeforeAction = sharp.cache()
      const { value, metrics } = await measure(async () => {
        try {
          if (action === 'rename') await fs.rename(source, renamed)
          if (action === 'unlink') await fs.unlink(source)
          if (action === 'trash') await shell.trashItem(source)
          if (action === 'overwrite') await fs.writeFile(source, newBytes)
          if (action === 'replace') await fs.rename(replacement, source)
          return { succeeded: true }
        } catch (error) {
          return {
            succeeded: false,
            errorCode: error.code ?? null,
            error: error.message
          }
        }
      })
      let freshOutput = null
      let freshOutputError = null
      if (value.succeeded && ['overwrite', 'replace'].includes(action)) {
        assert.equal(digest(await fs.readFile(source)), digest(newBytes))
        try {
          freshOutput = digest(await preview(source)) === expectedNew
        } catch (error) {
          freshOutput = false
          freshOutputError = error.message
        }
      }
      const sourceExists = await fs.stat(source).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false
          throw error
        }
      )
      if (value.succeeded && ['rename', 'unlink', 'trash'].includes(action))
        assert.equal(sourceExists, false)
      if (value.succeeded && action === 'rename')
        assert.equal(digest(await fs.readFile(renamed)), digest(oldBytes))
      const safetyPassed = value.succeeded && freshOutput !== false
      const row = {
        suite: 'native-cache',
        scenario: action,
        variant: policy,
        sample: 0,
        nativeApi:
          action === 'trash'
            ? 'Electron shell.trashItem'
            : `node:fs/promises.${action === 'overwrite' ? 'writeFile' : action === 'replace' ? 'rename' : action}`,
        cache: configuredCache,
        cacheBeforeAction,
        sourceWidth: width,
        metrics,
        checks: {
          ...value,
          sourceExists,
          freshOutput,
          freshOutputError,
          safetyPassed
        }
      }
      report.rows.push(row)
      await save()
      if (policy === 'disabled')
        assert(safetyPassed, `Control file action failed: ${action}`)
    }
    report.completed = true
    await save()
  } finally {
    sharp.cache(false)
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
  }
}

main().then(
  () => app.exit(0),
  async (error) => {
    if (reportPath) {
      const existing = await fs
        .readFile(reportPath, 'utf8')
        .then(JSON.parse, () => ({}))
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          { ...existing, completed: false, error: error.stack },
          null,
          2
        )
      )
    }
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  }
)
