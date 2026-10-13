import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createIo } from './io.mjs'
import { listBaseline, listTight } from './listing.mjs'
import { assetJson, openRecords } from './records.mjs'

const DATE = '2026-10-13'
const describeName = (name) => ({
  name,
  codepoints: Array.from(
    name,
    (character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`
  ),
  nfc: name.normalize('NFC'),
  nfd: name.normalize('NFD')
})

async function pathObservation(path, expectedPath) {
  try {
    const [info, expected, canonical] = await Promise.all([
      fsp.stat(path),
      fsp.stat(expectedPath),
      fsp.realpath(path)
    ])
    return {
      exists: true,
      canonical,
      sameFile: info.dev === expected.dev && info.ino === expected.ino
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    return { exists: false, error: error.code }
  }
}

async function associateObservation(label, root, storedPath, scope = 'selected-root') {
  const presence = await pathObservation(storedPath, storedPath)
  if (!presence.exists)
    return { label, scope, storedPath, presence, listing: 'not attempted: stored path missing' }
  const records = openRecords(':memory:', { fold: process.platform === 'win32' })
  try {
    records.insertMany([
      { id: 'fixture-record', createdAt: 1_700_000_000_000, assets: [assetJson(storedPath, 0)] }
    ])
    records.buildPathIndex()
    records.buildMemoryIndex()
    const discovered = await listTight(root, [], createIo())
    assert.equal(discovered.total, 1, `${label}: fixture must list exactly one regular file`)
    const discoveredPath = discovered.page[0].path
    const lookupMatches = {}
    const listingAssociated = {}
    for (const [variant, lookup] of [
      ['sqlScan', (paths) => records.findByScan(paths)],
      ['sqlIndex', (paths) => records.findByIndex(paths)],
      ['memory', (paths) => records.findByMemoryIndex(paths, undefined, true)]
    ]) {
      lookupMatches[variant] = lookup([discoveredPath]).length
      const result = await listTight(root, [], createIo(), { associate: lookup })
      listingAssociated[variant] = result.page.filter(
        (entry) => entry.recordId === 'fixture-record'
      ).length
    }
    return {
      label,
      scope,
      storedPath,
      listedRoot: root,
      discoveredPath,
      presence,
      sameFile: (await pathObservation(storedPath, discoveredPath)).sameFile,
      exactPathEqual: storedPath === discoveredPath,
      pathKeyEqual: records.pathKey(storedPath) === records.pathKey(discoveredPath),
      lookupMatches,
      listingAssociated
    }
  } finally {
    records.close()
  }
}

/** Observations of filesystem identity and actual parameter association, not compatibility claims. */
export async function probePathIdentity(base) {
  const ownedDirectories = []
  const fixture = await fsp.mkdtemp(join(base, 'paths-'))
  ownedDirectories.push(fixture)
  const observations = []
  const createFile = async (container, name = 'ASCII.png') => {
    const root = join(container, 'LibraryCase')
    await fsp.mkdir(join(root, DATE), { recursive: true })
    const canonicalRoot = await fsp.realpath(root)
    const file = join(canonicalRoot, DATE, name)
    await fsp.writeFile(file, 'synthetic path identity fixture')
    return { root, file }
  }
  try {
    const ascii = await createFile(fixture)
    const canonicalFile = await fsp.realpath(ascii.file)
    const control = await associateObservation('canonical-ascii-control', ascii.root, canonicalFile)
    assert.deepEqual(control.lookupMatches, { sqlScan: 1, sqlIndex: 1, memory: 1 })
    assert.deepEqual(control.listingAssociated, { sqlScan: 1, sqlIndex: 1, memory: 1 })
    observations.push(control)

    const aliasRoot = join(fixture, 'root-alias')
    await fsp.symlink(ascii.root, aliasRoot, 'dir')
    observations.push(
      await associateObservation(
        'configured-root-symlink-alias',
        aliasRoot,
        join(aliasRoot, DATE, 'ASCII.png')
      )
    )

    const caseRoot = join(dirname(ascii.root), 'librarycase')
    observations.push(
      await associateObservation(
        'mixed-case-directory-spelling',
        caseRoot,
        join(caseRoot, DATE, 'ASCII.png')
      )
    )

    for (const [form, name] of [
      ['NFC', 'caf\u00e9.png'],
      ['NFD', 'cafe\u0301.png']
    ]) {
      const unicode = await createFile(join(fixture, `unicode-${form}`), name)
      const readdirNames = (await fsp.readdir(dirname(unicode.file))).map(describeName)
      const alternateName = name.normalize(form === 'NFC' ? 'NFD' : 'NFC')
      const alternatePath = join(dirname(unicode.file), alternateName)
      const alternate = await pathObservation(alternatePath, unicode.file)
      observations.push({
        ...(await associateObservation(`unicode-created-${form}`, unicode.root, unicode.file)),
        createdName: describeName(name),
        readdirNames,
        alternateName: describeName(alternateName),
        alternate
      })
      if (alternate.exists && alternate.sameFile) {
        observations.push(
          await associateObservation(
            `unicode-alternate-stored-${form}`,
            unicode.root,
            alternatePath
          )
        )
      }
    }

    const tied = await createFile(join(fixture, 'sorting'), 'a_.png')
    const second = await createFile(join(fixture, 'sorting'), 'a-.png')
    await Promise.all(
      [tied.file, second.file].map((file) => fsp.utimes(file, 1_700_000_000, 1_700_000_000))
    )
    const beforeOrder = await listBaseline(tied.root, [], createIo())
    const afterOrder = await listTight(tied.root, [], createIo())
    assert.deepEqual(
      afterOrder.page.map((entry) => entry.path),
      beforeOrder.page.map((entry) => entry.path),
      'equal-time ordering must retain localeCompare semantics'
    )
    observations.push({
      label: 'equal-time-sorting-control',
      order: afterOrder.page.map((entry) => entry.name)
    })

    const outside = await createFile(join(fixture, 'outside'))
    const fileLink = join(dirname(ascii.file), 'linked.png')
    const directoryLink = join(ascii.root, '2026-10-14')
    await fsp.symlink(outside.file, fileLink, 'file')
    await fsp.symlink(dirname(outside.file), directoryLink, 'dir')
    const safeListing = await listTight(ascii.root, [], createIo())
    assert.equal(safeListing.total, 1, 'child file and directory symlinks must be skipped')
    assert.equal(safeListing.page[0].path, canonicalFile)
    observations.push({
      label: 'child-symlink-rejection-control',
      listedTotal: safeListing.total,
      discoveredPath: canonicalFile
    })

    if (process.platform === 'darwin') {
      for (const temporaryBase of ['/var/tmp', '/tmp']) {
        const systemFixture = await fsp.mkdtemp(join(temporaryBase, 'paths-'))
        ownedDirectories.push(systemFixture)
        const system = await createFile(systemFixture)
        const rawFile = join(system.root, DATE, 'ASCII.png')
        observations.push(
          await associateObservation(
            `system-alias-${temporaryBase}`,
            system.root,
            rawFile,
            'system-temp'
          )
        )
        const privateRoot = `/private${system.root}`
        const privateFile = join(privateRoot, DATE, 'ASCII.png')
        observations.push(
          await associateObservation(
            `system-canonical-${temporaryBase}`,
            privateRoot,
            privateFile,
            'system-temp'
          )
        )
      }
    }
    return { platform: process.platform, base, observations }
  } finally {
    for (const directory of ownedDirectories)
      await fsp.rm(directory, { recursive: true, force: true })
  }
}
