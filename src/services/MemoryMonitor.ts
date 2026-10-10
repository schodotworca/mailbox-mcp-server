import { readSystemMemory } from "../utils/systemMemory.js";
import type { LocalCache } from "../types/cache.types.js";

/** Report process, Linux VM and cgroup metrics separately. */
export class MemoryMonitor {
  private timer?: NodeJS.Timeout;
  private reporting = false;
  constructor(
    private cache: LocalCache,
    private report: (high: boolean, data: Record<string, number>) => Promise<void>,
    private memory = () => process.memoryUsage(),
    private intervalMs = 60000,
    private systemMemory: () => Promise<Record<string, number>> = readSystemMemory,
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
      const system = await this.systemMemory().catch(() => ({} as Record<string, number>));
      const machineHigh = system.machineTotalBytes > 0 && system.machineUsedBytes / system.machineTotalBytes >= 0.85;
      const cgroupHigh = system.cgroupLimitBytes > 0 && system.cgroupUsedBytes / system.cgroupLimitBytes >= 0.85;
      await this.report(memory.rss >= 160 * 1024 * 1024 || machineHigh || cgroupHigh, {
        ...system,
        systemMemoryAvailable: Object.keys(system).length > 0 ? 1 : 0,
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
