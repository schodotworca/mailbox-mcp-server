import { withCacheFallback } from "../src/utils/cacheFallback.js";
import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/services/LocalCache.js";
const config = { email: { searchTtl: 100, messageTtl: 100, threadTtl: 100 }, calendar: { eventsTtl: 100, freeBusyTtl: 100 }, maxSize: 100, cleanupInterval: 10000, maxBytes: 1500, staleRetentionMs: 1000 };
describe("cache memory safeguards", () => {
  it("retains expired data through get/has for fallback, then expires it permanently", async () => {
    vi.useFakeTimers();
    const cache = new MemoryCache(config);
    try {
      cache.set("mail", "cached body", 100);
      vi.advanceTimersByTime(101);
      expect(cache.has("mail")).toBe(false);
      const options = {cache, cacheKey:"mail", fetch:vi.fn().mockRejectedValue(new Error("connection lost")), defaultValue:null,
        throwWhenUnavailable:true, logger:{error:vi.fn(),warning:vi.fn()} as any, operation:"test",service:"test"};
      expect(await withCacheFallback(options)).toBe("cached body");
      vi.advanceTimersByTime(1000);
      await expect(withCacheFallback(options)).rejects.toThrow("connection lost");
      expect(cache.size()).toBe(0);
    } finally { cache.destroy(); vi.useRealTimers(); }
  });
  it("never extends freshness when the same search is repeatedly read", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache(config);
    try {
      cache.set("search:today", ["old mail"], 100);
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(10);
        expect(cache.get("search:today")).toEqual(["old mail"]);
      }
      vi.advanceTimersByTime(21);
      expect(cache.get("search:today")).toBeNull();
    } finally { cache.destroy(); vi.useRealTimers(); }
  });
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
