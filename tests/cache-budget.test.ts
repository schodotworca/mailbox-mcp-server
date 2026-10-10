import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/services/LocalCache.js";
const config = { email: { searchTtl: 100, messageTtl: 100, threadTtl: 100 }, calendar: { eventsTtl: 100, freeBusyTtl: 100 }, maxSize: 100, cleanupInterval: 10000, maxBytes: 1500, staleRetentionMs: 1000 };
describe("cache memory safeguards", () => {
  it("evicts by bytes even below the entry limit, including replacements", () => {
    const cache = new MemoryCache(config);
    try {
      for (let i = 0; i < 20; i++) cache.set(String(i), "x".repeat(200));
      expect(cache.size()).toBeLessThan(20);
      expect(cache.getStats().memoryUsage).toBeLessThanOrEqual(1500);
      cache.set("19", "x".repeat(1000));
      expect(cache.get("19")).toBeNull();
      expect(cache.getStats().memoryUsage).toBeLessThanOrEqual(1500);
    } finally { cache.destroy(); }
  });
  it("counts binary storage and handles cycles without serializing", () => {
    const cache = new MemoryCache(config);
    try {
      cache.set("buffer", Buffer.alloc(2000));
      expect(cache.has("buffer")).toBe(false);
      const circular: { self?: unknown } = {}; circular.self = circular;
      cache.set("cycle", circular);
      expect(cache.get("cycle")).toBe(circular);
    } finally { cache.destroy(); }
  });
  it("enforces stale retention on access even before cleanup", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache(config);
    try {
      cache.set("mail", "body", 100);
      vi.advanceTimersByTime(200);
      expect(cache.getStale("mail")).toBe("body");
      vi.advanceTimersByTime(1000);
      expect(cache.getStale("mail")).toBeNull();
    } finally { cache.destroy(); vi.useRealTimers(); }
  });
});
