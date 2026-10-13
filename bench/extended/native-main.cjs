const { app } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const args = process.argv.slice(2)
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
app.setPath('userData', option('user-data'))
app.commandLine.appendSwitch('disable-gpu')
if (option('suite') === 'network') {
  // A reserved test alias lets PAC run without Chromium's implicit loopback bypass.
  app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP bench-origin.test 127.0.0.1, EXCLUDE localhost'
  )
}
// Closing the hidden fixture window must not interrupt the final evidence checkpoint.
// The coordinator exits explicitly with app.exit after saving success or failure.
app.on('before-quit', (event) => event.preventDefault())

const report = {
  completed: false,
  isolatedUserData: true,
  runtime: process.versions,
  platform: process.platform,
  arch: process.arch,
  rows: []
}
const save = async () => (await import('./report-file.mjs')).saveReport(option('output'), report)
app
  .whenReady()
  .then(async () => {
    await save()
    try {
      const suite = option('suite')
      if (!['ipc', 'network'].includes(suite)) throw new Error('Unknown native suite')
      const module = await import(pathToFileURL(join(__dirname, `${suite}.mjs`)))
      report.summary = await module.runBench({
        base: option('base'),
        quick: args.includes('--quick'),
        sampleCount: Number(option('samples')),
        electron: require('electron'),
        emit: async (row) => {
          report.rows.push(row)
          await save()
        }
      })
      report.completed = true
      await save()
      app.exit(0)
    } catch (error) {
      report.error = { name: error.name, message: error.message }
      await save()
      app.exit(1)
    }
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`)
    app.exit(1)
  })
