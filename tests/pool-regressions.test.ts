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
