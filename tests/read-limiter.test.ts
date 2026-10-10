import { describe, expect, it, vi } from "vitest";
import { ReadLimiter, ReadQueueError } from "../src/utils/ReadLimiter.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describe("bounded email reads", () => {
  it("finishes three slow reads in FIFO order without timing out the third", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReadLimiter(); const order: number[] = [];
      const read = (id: number) => limiter.run(async () => {
        order.push(id); await new Promise(resolve => setTimeout(resolve, 10000)); return id;
      });
      const reads = [read(1), read(2), read(3)];
      await expect(read(4)).rejects.toMatchObject({code:"EMAIL_READ_BUSY"});
      await vi.advanceTimersByTimeAsync(30000);
      expect(await Promise.all(reads)).toEqual([1,2,3]);
      expect(order).toEqual([1,2,3]);
    } finally { vi.useRealTimers(); }
  });
  it("runs one at a time and rejects overload before invoking the reader", async () => {
    const limiter = new ReadLimiter(1);
    const first = deferred(); const read = vi.fn(async () => 42);
    const a = limiter.run(() => first.promise);
    const b = limiter.run(read);
    await expect(limiter.run(read)).rejects.toThrow("queue full");
    expect(read).not.toHaveBeenCalled();
    first.resolve(); await a;
    await expect(b).resolves.toBe(42);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("never executes a timed-out queued read later", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReadLimiter(1, 100); const first = deferred();
      const a = limiter.run(() => first.promise); const read = vi.fn(async () => 1);
      const failure = expect(limiter.run(read)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(101); await failure;
      first.resolve(); await a;
      expect(read).not.toHaveBeenCalled();
      await expect(limiter.run(read)).resolves.toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it("releases the slot on failure and rejects waiters on shutdown", async () => {
    const limiter = new ReadLimiter();
    await expect(limiter.run(async () => { throw new Error("IMAP failed"); })).rejects.toThrow("IMAP failed");
    const first = deferred(); const a = limiter.run(() => first.promise);
    const read = vi.fn(async () => 1); const b = limiter.run(read);
    limiter.close();
    await expect(b).rejects.toThrow("shutting down");
    first.resolve(); await a;
    await expect(limiter.run(read)).rejects.toThrow("shutting down");
    expect(read).not.toHaveBeenCalled();
  });
});
