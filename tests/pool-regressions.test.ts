import {afterEach, expect, it, vi} from 'vitest';
import {ConnectionPool} from '../src/services/ConnectionPool.js';
import {ImapConnectionPool} from '../src/services/ImapConnectionPool.js';
const config = {minConnections:0,maxConnections:1,acquireTimeoutMs:100,idleTimeoutMs:10000,maxRetries:0,retryDelayMs:1,healthCheckIntervalMs:60000};
class Pool extends ConnectionPool<object> {
  async createConnection() {return {};}
  async validateConnection() {return true;}
  async destroyConnection() {}
}
afterEach(() => vi.useRealTimers());
it('immediately frees an unhealthy slot even without waiting requests', async () => {
  const pool = new Pool(config);
  try {
    const wrapper = await pool.acquire(); wrapper.isHealthy = false;
    await pool.release(wrapper);
    expect(pool.getMetrics().totalConnections).toBe(0);
    const next = await pool.acquire(); expect(next.id).not.toBe(wrapper.id);
  } finally {await pool.destroy();}
});
it('reports zero waiting requests after a queued timeout', async () => {
  vi.useFakeTimers(); const pool = new Pool(config);
  try {
    await pool.acquire();
    const result = expect(pool.acquire()).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(101); await result;
    expect(pool.getMetrics().waitingRequests).toBe(0);
  } finally {await pool.destroy();}
});
it('bounds logout when IMAP is stuck', async () => {
  vi.useFakeTimers();
  const pool = new ImapConnectionPool({...config,connectionConfig:{host:'example.com',port:993,secure:true,user:'u',password:'p'}});
  const connection = {usable:true, logout:vi.fn(() => new Promise(() => {})), close:vi.fn()};
  const done = pool.destroyConnection(connection as any);
  await vi.advanceTimersByTimeAsync(1001); await done;
  expect(connection.close).toHaveBeenCalledTimes(1);
  await pool.destroy();
});
it('does not exceed the pool limit during simultaneous connection creation', async () => {
  vi.useFakeTimers(); const pool = new Pool(config);
  try {
    const first = pool.acquire();
    const second = expect(pool.acquire()).rejects.toThrow('timeout');
    await first; await vi.advanceTimersByTimeAsync(101); await second;
    expect(pool.getMetrics().totalConnections).toBe(1);
  } finally {await pool.destroy();}
});
it('never leases the same idle connection to two callers', async () => {
  vi.useFakeTimers(); const pool = new Pool(config);
  try {
    const original = await pool.acquire(); await pool.release(original);
    const first = pool.acquire();
    const second = expect(pool.acquire()).rejects.toThrow('timeout');
    await first; await vi.advanceTimersByTimeAsync(101); await second;
    expect(pool.getMetrics().activeConnections).toBe(1);
  } finally {await pool.destroy();}
});
it('makes health-check-created minimum connections available to callers', async () => {
  vi.useFakeTimers(); const pool = new Pool({...config,minConnections:1,healthCheckIntervalMs:10});
  try {
    await vi.advanceTimersByTimeAsync(11);
    expect(pool.getMetrics().idleConnections).toBe(1);
    expect(pool.getMetrics().activeConnections).toBe(0);
    const wrapper = await pool.acquire(); expect(wrapper).toBeDefined();
  } finally {await pool.destroy();}
});
it('hands a health-checked idle slot to a caller queued during validation', async () => {
  const pool = new Pool(config);
  try {
    const wrapper = await pool.acquire(); await pool.release(wrapper);
    let finish!: (value:boolean)=>void;
    vi.spyOn(pool,'validateConnection').mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const health = (pool as any).performHealthCheck();
    const acquire = pool.acquire();
    finish(true); await health;
    expect((await acquire).id).toBe(wrapper.id);
  } finally {await pool.destroy();}
});
it('releases a connection whose queued caller timed out during validation', async () => {
  vi.useFakeTimers(); const pool = new Pool(config);
  try {
    const wrapper = await pool.acquire();
    const waiting = expect(pool.acquire()).rejects.toThrow('timeout');
    let finish!: (value:boolean)=>void;
    vi.spyOn(pool,'validateConnection').mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const release = pool.release(wrapper);
    await vi.advanceTimersByTimeAsync(101); await waiting;
    finish(true); await release;
    expect(pool.getMetrics().activeConnections).toBe(0);
    expect(pool.getMetrics().idleConnections).toBe(1);
  } finally {await pool.destroy();}
});
