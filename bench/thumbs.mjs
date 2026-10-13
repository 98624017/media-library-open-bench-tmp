import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const round = (value) => Math.round(value * 10) / 10

/** Time to load the native image library in a fresh process. The first sample is the coldest. */
export function measureColdLoad(samples = 4) {
  const script =
    "const s=performance.now();const sharp=require('sharp');const l=performance.now()-s;" +
    "if(process.platform==='win32')sharp.cache(false);const t=performance.now();" +
    "sharp({create:{width:64,height:64,channels:3,background:'#888'}}).jpeg().toBuffer()" +
    '.then(()=>console.log(JSON.stringify({load:l,first:performance.now()-t})))'
  const results = []
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now()
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    const wall = performance.now() - start
    try {
      const parsed = JSON.parse(child.stdout.trim())
      results.push({
        processMs: round(wall),
        loadMs: round(parsed.load),
        firstOpMs: round(parsed.first)
      })
    } catch {
      results.push({ processMs: round(wall), error: (child.stderr || '').slice(0, 200) })
    }
  }
  return results
}

export async function measureThumbnails(dir) {
  const { default: sharp } = await import('sharp')
  if (process.platform === 'win32') sharp.cache(false)
  const width = 4096
  const height = 4096
  // Mildly compressible content: smooth gradient plus deterministic noise.
  const raw = Buffer.alloc(width * height * 3)
  let seed = 12345
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    raw[i] = ((i / 3 / width) & 0xff) ^ ((seed >> 16) & 0x1f)
  }
  const source = sharp(raw, { raw: { width, height, channels: 3 } })
  const files = {
    jpeg: [join(dir, 'a.jpg'), join(dir, 'b.jpg')],
    png: [join(dir, 'a.png'), join(dir, 'b.png')]
  }
  await source.clone().jpeg({ quality: 92 }).toFile(files.jpeg[0])
  await source.clone().negate().jpeg({ quality: 92 }).toFile(files.jpeg[1])
  await source.clone().png({ compressionLevel: 6 }).toFile(files.png[0])
  await source.clone().negate().png({ compressionLevel: 6 }).toFile(files.png[1])
  const thumbnail = async (file) => {
    if (!existsSync(file)) return null
    const buffer = await sharp(file)
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
    return `data:image/jpeg;base64,${buffer.toString('base64')}`.length
  }
  const out = {
    cachePolicy: process.platform === 'win32' ? 'disabled' : 'default',
    versions: sharp.versions
  }
  for (const [format, pair] of Object.entries(files)) {
    const runs = []
    for (let i = 0; i < 4; i += 1) {
      const start = performance.now()
      await Promise.all(pair.map(thumbnail))
      runs.push(round(performance.now() - start))
    }
    out[format] = { twoImagesMs: runs }
  }
  return out
}
