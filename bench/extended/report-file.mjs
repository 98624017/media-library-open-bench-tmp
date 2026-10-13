import { rename, writeFile } from 'node:fs/promises'

// Keep the previous complete checkpoint intact if a timeout kills the next write.
export async function saveReport(path, report) {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(report, null, 2))
  await rename(temporary, path)
}
