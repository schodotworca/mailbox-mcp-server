import { describe, expect, it, vi } from "vitest";
import { MemoryMonitor } from "../src/services/MemoryMonitor.js";
import type { LocalCache } from "../src/types/cache.types.js";
const cache = { getStats: () => ({ size: 2, memoryUsage: 512, entries: [{ key: "private-mail" }] }) } as unknown as LocalCache;
const memory = () => ({ rss: 170 * 1024 * 1024, heapUsed: 100, external: 200, arrayBuffers: 50, heapTotal: 500 });
describe("memory monitoring", () => {
  it("warns above threshold, logs only aggregate data, and stops its timer", async () => {
    vi.useFakeTimers();
    const report = vi.fn(async () => {}); const monitor = new MemoryMonitor(cache, report, memory, 100);
    try {
      monitor.start(); monitor.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(report).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenCalledWith(true, { rssBytes: 170 * 1024 * 1024, heapUsedBytes: 100, externalBytes: 200, arrayBufferBytes: 50, cacheEstimatedBytes: 512, cacheEntries: 2 });
      monitor.stop(); await vi.advanceTimersByTimeAsync(200);
      expect(report).toHaveBeenCalledTimes(2);
    } finally { monitor.stop(); vi.useRealTimers(); }
  });
  it("recovers from reporting failures without overlapping slow reports", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const report = vi.fn().mockRejectedValueOnce(new Error("logger unavailable")).mockImplementation(() => new Promise<void>(r => { finish = r; }));
    const monitor = new MemoryMonitor(cache, report, () => ({ ...memory(), rss: 1000 }), 100);
    try {
      monitor.start(); await vi.advanceTimersByTimeAsync(300);
      expect(report).toHaveBeenCalledTimes(2);
      expect(report.mock.calls[0][0]).toBe(false);
      finish(); await vi.advanceTimersByTimeAsync(100);
      expect(report).toHaveBeenCalledTimes(3);
      finish();
    } finally { monitor.stop(); vi.useRealTimers(); }
  });
});
