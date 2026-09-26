import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../src/services/EmailService.js";
import { OfflineService } from "../src/services/OfflineService.js";

function fixture() {
  const entries = new Map();
  const cache = { get: vi.fn(k => entries.get(k)), getStale: vi.fn(), set: vi.fn((k,v) => entries.set(k,v)) };
  const connection = { search: vi.fn().mockResolvedValue([104, 209]), fetch: vi.fn(function* (ids, _query, options) {
    // Sequence numbers shifted after an EXPUNGE; only UID addressing is stable.
    if (!options?.uid) return;
    for (const uid of ids) yield {uid, envelope: {subject: String(uid), date: new Date('2026-09-20')}, flags: []};
  }) };
  const wrapper = { connection, isHealthy: true };
  const service = Object.assign(Object.create(EmailService.prototype), {
    cache, pool: { acquireForFolder: vi.fn().mockResolvedValue(wrapper), releaseFromFolder: vi.fn() },
    logger: {error: vi.fn(), warning: vi.fn()}
  }) as EmailService;
  return {service, connection, cache, wrapper};
}
afterEach(() => vi.useRealTimers());
describe('date search and UID regressions', () => {
  it.each([
    {since: new Date('2020-01-01'), before: new Date('2020-02-01')},
    {before: new Date('2099-01-01')},
    {before: new Date('2020-01-01')}
  ])('preserves explicit date criteria and fetches stable UIDs: %j', async options => {
    const {service, connection} = fixture();
    expect((await service.searchEmails(options)).map(m => m.uid)).toEqual([209,104]);
    expect(connection.search).toHaveBeenCalledWith(options, {uid: true});
    expect(connection.fetch).toHaveBeenCalledWith([209,104], expect.anything(), {uid:true});
  });
  it('uses a stable six-calendar-month default with month-end clamping', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T10:00:00Z'));
    const {service, connection} = fixture();
    await service.searchEmails({});
    vi.setSystemTime(new Date('2026-08-31T11:00:00Z'));
    await service.searchEmails({});
    expect(connection.search).toHaveBeenCalledTimes(1);
    expect(connection.search).toHaveBeenCalledWith({since: new Date('2026-02-28T00:00:00Z')}, {uid: true});
  });
  it('treats offline before as exclusive', () => {
    const offline = Object.create(OfflineService.prototype);
    const boundary = new Date('2026-01-01');
    expect(offline.filterOfflineResults([{date: boundary}], {before: boundary})).toEqual([]);
  });
});
