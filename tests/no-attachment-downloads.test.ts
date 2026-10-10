import { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { EmailService } from "../src/services/EmailService.js";
import { selectMailBody } from "../src/utils/mailBody.js";

function fixture(bodyStructure: any, body = Buffer.from('Hello'), mime = 'Content-Type: text/plain; charset=utf-8\r\n') {
  const selected = selectMailBody(bodyStructure);
  const root = selected === bodyStructure;
  const part = selected?.part || '1';
  const connection = {
    fetch: vi.fn(async function* () {
      yield {uid:72, flags:[], bodyStructure, headers:Buffer.from('From: Alice <alice@example.com>\r\nTo: Bob <bob@example.com>\r\nSubject: Test\r\nMessage-ID: <original@example.com>\r\n\r\n')};
    }),
    fetchOne: vi.fn().mockResolvedValue({uid:72, headers:root ? Buffer.from(mime) : undefined, bodyParts:new Map(root ? [['text',body]] : [[`${part}.mime`,Buffer.from(mime)],[part,body]])}),
    close:vi.fn()
  };
  const wrapper = {connection,isHealthy:true};
  const cache = {get:vi.fn(),getStale:vi.fn(),set:vi.fn()};
  const service = Object.assign(Object.create(EmailService.prototype), {
    pool:{acquireForFolder:vi.fn().mockResolvedValue(wrapper),releaseFromFolder:vi.fn()},
    logger:{error:vi.fn(),warning:vi.fn()},cache
  }) as EmailService;
  return {service,connection,cache};
}

describe('text-only IMAP reads', () => {
  it('drains the real ImapFlow iterator before requesting body content', async () => {
    const {service,connection} = fixture({type:'text/plain',part:'1'});
    let acknowledged = false;
    const client = {
      mailbox: {}, isClosed: false, socket: {destroyed:false},
      resolveRange: async (range: string) => range,
      run: vi.fn((_command, _range, _query, options) => new Promise<void>(resolve => {
        options.onUntaggedFetch({uid:72,flags:[],bodyStructure:{type:'text/plain',part:'1'},headers:Buffer.from('Subject: Test\r\n')}, () => {
          acknowledged = true;
          resolve();
        });
      })),
    };
    connection.fetch.mockImplementation((...args) => ImapFlow.prototype.fetch.apply(client, args));
    const originalBody = connection.fetchOne.getMockImplementation()!;
    connection.fetchOne.mockImplementation((...args) => {
      expect(acknowledged).toBe(true);
      return originalBody(...args);
    });
    expect((await service.getEmail(72))?.text?.trim()).toBe('Hello');
    expect(connection.fetchOne.mock.calls[0][1].bodyParts.map(p => p.key)).toEqual(['HEADER', 'TEXT']);
  });
  it('fetches only body text despite a 100 MB PDF, images and attached message', async () => {
    const {service,connection} = fixture({type:'multipart/mixed',childNodes:[
      {type:'multipart/alternative',part:'1',childNodes:[
        {type:'text/plain',part:'1.1',size:5},
        {type:'text/html',part:'1.2',size:50}
      ]},
      {type:'application/pdf',part:'2',size:100*1024*1024,disposition:'attachment',dispositionParameters:{filename:'plan.pdf'}},
      {type:'image/png',part:'3',size:500000,id:'logo'},
      {type:'message/rfc822',part:'4',childNodes:[{type:'text/plain',part:'4.1'}]}
    ]});
    const mail = await service.getEmail(72);
    expect(mail?.text?.trim()).toBe('Hello');
    expect(mail?.from[0].address).toBe('alice@example.com');
    expect(mail?.to[0].address).toBe('bob@example.com');
    expect(mail?.id).toBe('<original@example.com>');
    expect(mail?.attachments?.[0].filename).toBe('plan.pdf');
    const metadataQuery = connection.fetch.mock.calls[0][1];
    expect(metadataQuery).not.toHaveProperty('source');
    expect(metadataQuery.bodyStructure).toBe(true);
    expect(connection.fetchOne).toHaveBeenCalledExactlyOnceWith('72', {bodyParts:[
      {key:'1.1.MIME',maxLength:16385}, {key:'1.1',maxLength:1048577}
    ]}, {uid:true});
  });
  it('reads HTML-only mail without downloading or embedding its inline image', async () => {
    const html = '<p>Witaj</p><img src="cid:logo">';
    const {service,connection} = fixture({type:'multipart/related',childNodes:[
      {type:'text/html',part:'1'}, {type:'image/png',part:'2',id:'logo',disposition:'inline'}
    ]},Buffer.from(html),'Content-Type: text/html; charset=utf-8\r\n');
    const mail = await service.getEmail(72);
    expect(mail?.html).toBe(html);
    expect(mail?.text).toContain('Witaj');
    expect(mail?.html).not.toContain('data:');
    expect(connection.fetchOne.mock.calls[0][1].bodyParts.map(p=>p.key)).toEqual(['1.MIME','1']);
  });
  it.each(['base64','quoted-printable'])('decodes %s and legacy charset without fetching full MIME', async encoding => {
    const bytes = Buffer.from([0x63,0x61,0x66,0xe9]);
    const encoded = encoding === 'base64' ? bytes.toString('base64') : 'caf=E9';
    const {service} = fixture({type:'text/plain'},Buffer.from(encoded),`Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: ${encoding}\r\n`);
    expect((await service.getEmail(72))?.text?.trim()).toBe('café');
  });
  it.each([
    {type:'text/plain',disposition:'attachment'},
    {type:'text/html',parameters:{name:'file.html'}},
    {type:'multipart/mixed',disposition:'attachment',childNodes:[{type:'text/plain',part:'1'}]},
    {type:'message/rfc822',childNodes:[{type:'text/plain',part:'1'}]}
  ])('never reads attached text or nested message: %j', async structure => {
    const {service,connection} = fixture(structure);
    const mail = await service.getEmail(72);
    expect(mail?.subject).toBe('Test');
    expect(mail?.contentStatus).toBe('unavailable');
    expect(mail?.contentWarning).toContain('does not mean the message is empty');
    expect(connection.fetchOne).not.toHaveBeenCalled();
  });
  it('rejects missing structure rather than falling back to full download', async () => {
    const {service,connection} = fixture({type:'text/plain'});
    connection.fetch.mockImplementation(async function* () {yield {uid:72,headers:Buffer.from('Subject: Test\r\n')};});
    await expect(service.getEmail(72)).rejects.toThrow('full-message download is disabled');
    expect(connection.fetchOne).not.toHaveBeenCalled();
  });
  it('returns a clearly marked bounded excerpt for oversized text', async () => {
    const {service,connection} = fixture({type:'text/plain',size:2000000},Buffer.alloc(1048577, 'a'));
    const mail = await service.getEmail(72);
    expect(mail?.contentStatus).toBe('partial');
    expect(mail?.contentWarning).toContain('Do not treat this excerpt as the complete message');
    expect(mail?.text?.length).toBeLessThanOrEqual(1048576);
    expect(connection.fetchOne.mock.calls[0][1].bodyParts[1].maxLength).toBe(1048577);
  });
  it('detects truncation even when the advertised body size is wrong', async () => {
    const {service} = fixture({type:'text/plain',size:1},Buffer.alloc(1048577, 'a'));
    expect((await service.getEmail(72))?.contentStatus).toBe('partial');
  });
  it('decodes a body using structure metadata when MIME headers exceed the limit', async () => {
    const {service} = fixture({type:'text/plain',parameters:{charset:'iso-8859-1'},encoding:'quoted-printable'},
      Buffer.from('caf=E9'), 'X-Large: ' + 'a'.repeat(17000));
    const mail = await service.getEmail(72);
    expect(mail?.text?.trim()).toBe('café');
    expect(mail?.subject).toBe('Test');
    expect(mail?.contentWarning).toContain('reconstructed');
  });
  it.each(['base64','quoted-printable'])('decodes a bounded %s prefix', async encoding => {
    const body = encoding === 'base64' ? Buffer.from(Buffer.alloc(900000, 'a').toString('base64')) : Buffer.from('a'.repeat(1048575) + '=E9');
    const {service} = fixture({type:'text/plain',encoding}, body.subarray(0,1048577),
      `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n`);
    const mail = await service.getEmail(72);
    expect(mail?.contentStatus).toBe('partial');
    expect(mail?.text).toMatch(/^a+\n?$/);
  });
  it('finds inline text after explicit attachments without downloading their content', async () => {
    const {service,connection} = fixture({type:'multipart/mixed',childNodes:[
      {type:'application/pdf',part:'1',disposition:'attachment',dispositionParameters:{filename:'plan.pdf'}},
      {type:'text/plain',part:'2'}
    ]});
    const mail = await service.getEmail(72);
    expect(mail?.text?.trim()).toBe('Hello');
    expect(connection.fetchOne.mock.calls[0][1].bodyParts.map(p=>p.key)).toEqual(['2.MIME','2']);
  });
  it('selects the related root designated by Content-ID', () => {
    const root = {type:'text/html',part:'2',id:'<root>'};
    expect(selectMailBody({type:'multipart/related',parameters:{start:'<root>'},childNodes:[{type:'image/png',part:'1'},root]})).toBe(root);
  });
});
