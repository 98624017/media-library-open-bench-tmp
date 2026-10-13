import assert from 'node:assert/strict'
import {
  setTimeout as delay,
  setImmediate as immediate
} from 'node:timers/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export const round = (value) => Math.round(value * 100) / 100

export function median(values) {
  assert(values.length > 0)
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export async function pool(items, concurrency, worker) {
  assert(Number.isInteger(concurrency) && concurrency > 0)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        await worker(items[index], index)
      }
    })
  )
}

/** Setup and post-operation observation are excluded from wall/cpu time. */
export async function measure(operation) {
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  await delay(20)
  let lastHeartbeat = performance.now()
  let maxHeartbeatGap = 0
  let peakRss = process.memoryUsage.rss()
  const rssStart = peakRss
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxHeartbeatGap = Math.max(maxHeartbeatGap, now - lastHeartbeat)
    lastHeartbeat = now
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }, 5)
  const cpuStart = process.cpuUsage()
  const startedAt = performance.now()
  try {
    const value = await operation()
    const wallMs = performance.now() - startedAt
    const cpu = process.cpuUsage(cpuStart)
    const rssEnd = process.memoryUsage.rss()
    peakRss = Math.max(peakRss, rssEnd)
    // A sync operation may finish before the first heartbeat; let it observe that gap.
    await immediate()
    await delay(15)
    const lifetimePeak = process.resourceUsage().maxRSS
    return {
      value,
      metrics: {
        wallMs: round(wallMs),
        cpuUserMs: round(cpu.user / 1000),
        cpuSystemMs: round(cpu.system / 1000),
        maxHeartbeatGapMs: round(maxHeartbeatGap),
        eventLoopDelayMaxMs: round(histogram.max / 1e6),
        rssStartBytes: rssStart,
        rssEndBytes: rssEnd,
        rssObservedPeakBytes: peakRss,
        processLifetimePeakRssBytes:
          lifetimePeak > 0 ? lifetimePeak * 1024 : null
      }
    }
  } finally {
    clearInterval(heartbeat)
    histogram.disable()
  }
}

export async function assertMeasurementWorks() {
  const measured = await measure(() => {
    const deadline = performance.now() + 45
    while (performance.now() < deadline) {
      // Deliberate stall checks that the observer catches a synchronous workload.
    }
    return 'observed'
  })
  assert.equal(measured.value, 'observed')
  assert(measured.metrics.wallMs >= 40)
  assert(measured.metrics.maxHeartbeatGapMs >= 35)
  return measured.metrics
}
