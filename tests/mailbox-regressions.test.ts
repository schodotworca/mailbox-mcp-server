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
    expect(connection.search).toHaveBeenCalledWith(Object.fromEntries(Object.entries(options).map(([k,v]) => [k,v.toISOString().slice(0,10)])), {uid: true});
    expect(connection.fetch).toHaveBeenCalledWith([209,104], expect.anything(), {uid:true});
  });
  it('uses a stable six-calendar-month default with month-end clamping', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T10:00:00Z'));
    const {service, connection} = fixture();
    await service.searchEmails({});
    vi.setSystemTime(new Date('2026-08-31T11:00:00Z'));
    await service.searchEmails({});
    expect(connection.search).toHaveBeenCalledTimes(1);
    expect(connection.search).toHaveBeenCalledWith({since: '2026-02-28'}, {uid: true});
  });
  it('treats offline before as exclusive', () => {
    const offline = Object.create(OfflineService.prototype);
    const boundary = new Date('2026-01-01');
    expect(offline.filterOfflineResults([{date: boundary}], {before: boundary})).toEqual([]);
  });
});

describe('real ParsedMail addresses', () => {
  it('reads From, repeated To, groups and Cc from actual MIME parsing', async () => {
    const {simpleParser} = await import('mailparser');
    const parsed = await simpleParser(Buffer.from([
      'From: =?UTF-8?Q?Za=C5=BC=C3=B3=C5=82=C4=87?= <sender@example.com>',
      'To: Team: Alice <alice@example.com>, Bob <bob@example.com>;',
      'To: Carol <carol@example.com>', 'Cc: copy@example.com',
      'Subject: address regression', '', 'Body'
    ].join('\r\n')));
    const {service} = fixture();
    const message = (service as any).parseFullEmailMessage(parsed, {uid: 123, flags: []}, 'INBOX');
    expect(message.from).toEqual([{name:'Zażółć', address:'sender@example.com'}]);
    expect(message.to.map(a => a.address)).toEqual(['alice@example.com','bob@example.com','carol@example.com']);
    expect(message.cc.map(a => a.address)).toEqual(['copy@example.com']);
    expect(message.bcc).toEqual([]);
  });
});

describe('IMAP failures are not missing mail', () => {
  it('propagates pool acquisition timeout when there is no cached mail', async () => {
    const {service} = fixture();
    (service as any).pool.acquireForFolder.mockRejectedValue(new Error('Connection acquire timeout after 100ms'));
    await expect(service.getEmail(123)).rejects.toThrow('acquire timeout');
  });
  it('propagates search connection failures instead of reporting an empty range', async () => {
    const {service, connection} = fixture();
    connection.search.mockRejectedValue(new Error('Connection closed'));
    await expect(service.searchEmails({before:new Date('2099-01-01')})).rejects.toThrow('Connection closed');
  });
  it('closes a timed-out fetch and never caches not-found', async () => {
    vi.useFakeTimers();
    const {service, connection, cache, wrapper} = fixture();
    const close = vi.fn(); Object.assign(connection, {close});
    connection.fetch.mockReturnValue({next: () => new Promise(() => {}), [Symbol.asyncIterator]() { return this; }});
    const operation = expect(service.getEmail(123)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10001); await operation;
    expect(close).toHaveBeenCalledTimes(1);
    expect(wrapper.isHealthy).toBe(false);
    expect(cache.set).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('wire-level date search compilation', () => {
  it.each([[[]], [['WITHIN']]])('uses absolute date commands with capabilities %j', async capabilities => {
    const {createRequire} = await import('node:module');
    const {searchCompiler} = createRequire(import.meta.url)('imapflow/lib/search-compiler.js');
    const {service} = fixture();
    const criteria = (service as any).buildSearchCriteria({since:new Date('2020-01-01'),before:new Date('2099-01-01')});
    const wire = searchCompiler({capabilities:new Set(capabilities),enabled:new Set()},criteria).map(x=>x.value);
    expect(wire).toEqual(['SINCE','01-Jan-2020','BEFORE','01-Jan-2099']);
  });
  it('does not shift an explicit before day when an ISO time is supplied', async () => {
    const {createRequire} = await import('node:module');
    const {searchCompiler} = createRequire(import.meta.url)('imapflow/lib/search-compiler.js');
    const {service} = fixture();
    const criteria = (service as any).buildSearchCriteria({before:new Date('2026-09-26T12:00:00Z')});
    expect(searchCompiler({capabilities:new Set(),enabled:new Set()},criteria).map(x=>x.value)).toEqual(['BEFORE','26-Sep-2026']);
  });
});
