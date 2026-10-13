import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import test from 'node:test'
import { supervisorReceipt } from './launch.mjs'
import { runWithDeadline } from './termination.mjs'

const execute = promisify(execFile)

async function alive(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !/^[ZX]/.test(raw.split(') ').at(-1))
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execute('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 1000 })
      return !stdout.trim().startsWith('Z')
    } catch (error) {
      if (error.code !== 1) throw error
      try {
        process.kill(pid, 0)
      } catch (missing) {
        if (missing.code === 'ESRCH') return false
        throw missing
      }
      throw error
    }
  }
  return true
}

async function assertStopped(pid) {
  const deadline = performance.now() + 1500
  while (await alive(pid)) {
    assert(performance.now() < deadline, 'Owned fixture descendant survived supervisor cleanup')
    await delay(20)
  }
}

const stdio = ['ignore', 'pipe', 'pipe']

test('supervisor receipt only accepts a successful exit with completed cleanup', () => {
  const context = { suite: 'video', label: 'fixture', sourceRevision: '1'.repeat(40) }
  assert.equal(supervisorReceipt(context).completed, false)
  assert.equal(
    supervisorReceipt(context, { reason: 'exit', code: 0, registered: [] }).completed,
    true
  )
  for (const result of [
    { reason: 'exit', code: 1 },
    { reason: 'deadline' },
    { reason: 'spawn-error' }
  ]) {
    const receipt = supervisorReceipt(context, result)
    assert.equal(receipt.completed, false)
    assert.equal(receipt.exitCode, 1)
  }
  const failedCleanup = supervisorReceipt(
    context,
    { reason: 'exit', code: 0 },
    new Error('cleanup failed')
  )
  assert.equal(failedCleanup.completed, false)
  assert.equal(failedCleanup.reason, 'supervisor-error')
  assert.equal(failedCleanup.error.message, 'cleanup failed')
  assert.equal(failedCleanup.exitCode, 1)
})

test('supervisor reports natural exit and launch failure separately', async () => {
  const normal = await runWithDeadline(process.execPath, ['-e', 'process.exit(0)'], {
    stdio,
    deadlineMs: 3000
  })
  assert.equal(normal.reason, 'exit')
  assert.equal(normal.code, 0)
  const failure = await runWithDeadline(
    fileURLToPath(new URL('./missing-owned-command', import.meta.url)),
    [],
    {
      stdio,
      deadlineMs: 3000
    }
  )
  assert.equal(failure.reason, 'spawn-error')
  assert.equal(failure.errorCode, 'ENOENT')
})

test('deadline stops same-group descendants and waits for tree cleanup', async () => {
  const code =
    'const {spawn}=require("node:child_process");const leaf=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(leaf.pid));setInterval(()=>{},1000)'
  const result = await runWithDeadline(process.execPath, ['-e', code], {
    stdio,
    deadlineMs: 1000,
    cleanupMs: 5000
  })
  assert.equal(result.reason, 'deadline')
  const pid = Number(result.stdout)
  assert(Number.isInteger(pid) && pid > 0)
  await assertStopped(pid)
})

test('deadline also reclaims separately registered detached groups', async () => {
  const module = pathToFileURL(fileURLToPath(new URL('./termination.mjs', import.meta.url))).href
  const code = `import {spawn} from 'node:child_process';import {registerOwnedGroup} from ${JSON.stringify(module)};const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore'});await registerOwnedGroup(leaf.pid);process.stdout.write(String(leaf.pid));setInterval(()=>{},1000)`
  const result = await runWithDeadline(process.execPath, ['--input-type=module', '-e', code], {
    stdio,
    deadlineMs: 1200,
    cleanupMs: 5000
  })
  assert.equal(result.reason, 'deadline')
  const pid = Number(result.stdout)
  assert.equal(result.registered.length, 1)
  assert.equal(result.registered[0].pid, pid)
  await assertStopped(pid)
})

test('natural exit with a registered leftover fails after reclaiming that group', async () => {
  const module = pathToFileURL(fileURLToPath(new URL('./termination.mjs', import.meta.url))).href
  const code = `import {spawn} from 'node:child_process';import {registerOwnedGroup} from ${JSON.stringify(module)};const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore'});await registerOwnedGroup(leaf.pid);process.stdout.write(String(leaf.pid));leaf.unref()`
  let failure
  try {
    await runWithDeadline(process.execPath, ['--input-type=module', '-e', code], {
      stdio,
      deadlineMs: 3000
    })
  } catch (error) {
    failure = error
  }
  assert(failure)
  assert.match(failure.message, /Natural exit left registered/)
  await assertStopped(Number(failure.stdout))
})

function orphanFixture({ detachedLeaf }) {
  const module = pathToFileURL(fileURLToPath(new URL('./termination.mjs', import.meta.url))).href
  const leaf = `
    import {registerOwnedGroup} from ${JSON.stringify(module)};
    if (${detachedLeaf}) await registerOwnedGroup(process.pid);
    process.send({pid:process.pid,registered:${detachedLeaf}});
    process.disconnect();
    setInterval(()=>{},1000);
  `
  const leader = `
    const assert=require('node:assert/strict');
    const {spawn}=require('node:child_process');
    const leaf=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf)}],{
      detached:${detachedLeaf},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']
    });
    leaf.once('error',error=>{throw error});
    leaf.once('message',message=>{
      assert.equal(message.pid,leaf.pid);
      assert.equal(message.registered,${detachedLeaf});
      leaf.unref();
      process.stdout.write(JSON.stringify(message),()=>process.exit(0));
    });
  `
  return `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    import {registerOwnedGroup} from ${JSON.stringify(module)};
    const leader=spawn(process.execPath,['-e',${JSON.stringify(leader)}],{
      detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']
    });
    let body='';
    leader.stdout.on('data',chunk=>{body+=chunk});
    leader.stderr.on('data',chunk=>process.stderr.write(chunk));
    const closed=new Promise((resolve,reject)=>{
      leader.once('error',reject);
      leader.once('close',(code,signal)=>resolve({code,signal}));
    });
    await registerOwnedGroup(leader.pid);
    const exit=await closed;
    assert.equal(exit.code,0);
    const ready=JSON.parse(body);
    process.kill(ready.pid,0);
    process.stdout.write(JSON.stringify({leaderPid:leader.pid,leafPid:ready.pid,
      leafRegistered:ready.registered,leaderExited:true,leafAliveAfterLeaderExit:true}));
    setInterval(()=>{},1000);
  `
}

async function checkOrphanCleanup(detachedLeaf) {
  const code = orphanFixture({ detachedLeaf })
  const result = await runWithDeadline(process.execPath, ['--input-type=module', '-e', code], {
    stdio,
    deadlineMs: 3000,
    cleanupMs: 5000
  })
  assert.equal(result.reason, 'deadline')
  const readiness = JSON.parse(result.stdout)
  assert.equal(readiness.leaderExited, true)
  assert.equal(readiness.leafAliveAfterLeaderExit, true)
  assert.equal(readiness.leafRegistered, detachedLeaf)
  assert.equal(result.registered.length, detachedLeaf ? 2 : 1)
  const cleanedPids = result.registered.map((group) => group.pid)
  assert(cleanedPids.includes(readiness.leaderPid))
  if (detachedLeaf) assert(cleanedPids.includes(readiness.leafPid))
  await assertStopped(readiness.leaderPid)
  await assertStopped(readiness.leafPid)
}

test('registered ownership survives group leader exit until its leaf is stopped', async () => {
  // libuv's Windows job kills non-detached children when their parent exits.
  await checkOrphanCleanup(process.platform === 'win32')
})

test('independently registered detached leaf survives leader exit and is reclaimed', async () => {
  await checkOrphanCleanup(true)
})

test('wrong-nonce registration is rejected without preventing owned main-group cleanup', async () => {
  const code =
    'const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const {join}=require("node:path");const leaf=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(join(process.env.BENCH_OWNED_GROUP_REGISTRY,`${leaf.pid}.json`),JSON.stringify({pid:leaf.pid,kind:"detached-process-group",nonce:"wrong"}));process.stdout.write(String(leaf.pid));setInterval(()=>{},1000)'
  let failure
  try {
    await runWithDeadline(process.execPath, ['-e', code], {
      stdio,
      deadlineMs: 1000,
      cleanupMs: 5000
    })
  } catch (error) {
    failure = error
  }
  assert(failure)
  assert.match(failure.message, /another supervisor/)
  await assertStopped(Number(failure.stdout))
})
