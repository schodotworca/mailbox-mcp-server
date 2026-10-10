import type { LocalCache } from "../types/cache.types.js";

/** Process metrics only: RSS excludes the separate tunnel process. */
export class MemoryMonitor {
  private timer?: NodeJS.Timeout;
  private reporting = false;
  constructor(
    private cache: LocalCache,
    private report: (high: boolean, data: Record<string, number>) => Promise<void>,
    private memory = () => process.memoryUsage(),
    private intervalMs = 60000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
    this.timer.unref();
    void this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sample(): Promise<void> {
    if (this.reporting) return;
    this.reporting = true;
    try {
      const memory = this.memory();
      const cache = this.cache.getStats();
      await this.report(memory.rss >= 160 * 1024 * 1024, {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBufferBytes: memory.arrayBuffers,
        cacheEstimatedBytes: cache.memoryUsage,
        cacheEntries: cache.size,
      });
    } catch {
      // Telemetry must not interrupt mail handling or produce unhandled rejections.
    } finally { this.reporting = false; }
  }
}
