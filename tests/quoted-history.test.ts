import {describe,it,expect,vi} from "vitest";
import {appendQuotedHistory} from "../src/utils/quotedHistory.js";
import {handleEmailTool} from "../src/tools/emailTools.js";
import type {EmailMessage} from "../src/types/email.types.js";
const original: EmailMessage = {id:'id',uid:1,folder:'INBOX',flags:[],subject:'Test',date:new Date('2026-10-09T10:00:00Z'),from:[{address:'client@example.com'}],to:[],bcc:[{address:'hidden@example.com'}],text:'Original\n> Previous history'};
describe('automatic quoted history', () => {
  it('preserves the reply and quotes existing history exactly once without BCC', () => {
    const result = appendQuotedHistory({text:'New reply'},original);
    expect(result.text).toContain('New reply\n\n----- Original message -----');
    expect(result.text).toContain('> Original\n> > Previous history');
    expect(result.text?.match(/Previous history/g)).toHaveLength(1);
    expect(result.text).not.toContain('hidden@example.com');
  });
  it('escapes original content in HTML and supports HTML-only replies', () => {
    const result = appendQuotedHistory({html:'<p>Reply</p>'},{...original,text:'<img src="remote"> & test'});
    expect(result.html).toContain('&lt;img');
    expect(result.html).not.toContain('<img');
    expect(result.text).toBeUndefined();
  });
  it('marks incomplete and oversized histories', () => {
    expect(appendQuotedHistory({text:'Reply'},{...original,contentStatus:'partial'}).text).toContain('Incomplete quoted history');
    const result = appendQuotedHistory({text:'Reply'},{...original,text:'x'.repeat(100000)});
    expect(result.text).toContain('Incomplete quoted history');
    expect(result.text!.length).toBeLessThan(65000);
  });
  it('fails before SMTP when original cannot be read', async () => {
    const smtp = {sendEmail:vi.fn()};
    const service = {getEmail:vi.fn().mockResolvedValue(null)};
    const result = await handleEmailTool('send_email',{to:[{address:'recipient@example.com'}],subject:'Re: Test',text:'Reply',quoteOriginal:{uid:1}},service as any,smtp as any);
    expect(result.isError).toBe(true);
    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(() => appendQuotedHistory({text:'Reply'},{...original,contentStatus:'unavailable'})).toThrow('unavailable');
  });
  it('appends server-side before SMTP and archives the exact returned bytes', async () => {
    const raw = Buffer.from('compiled MIME');
    const smtp = {sendEmail:vi.fn().mockResolvedValue({success:true,delivery:'accepted',rawMessage:raw,messageId:'new-id'})};
    const service = {getEmail:vi.fn().mockResolvedValue(original),saveSentCopy:vi.fn().mockResolvedValue({success:true})};
    const result = await handleEmailTool('send_email',{to:[{address:'recipient@example.com'}],subject:'Re: Test',text:'Reply',quoteOriginal:{uid:1}},service as any,smtp as any);
    expect(result.isError).not.toBe(true);
    expect(service.getEmail).toHaveBeenCalledWith(1,'INBOX');
    expect(smtp.sendEmail).toHaveBeenCalledOnce();
    expect(smtp.sendEmail.mock.calls[0][0].text).toContain('Original message');
    expect(service.saveSentCopy).toHaveBeenCalledWith(raw);
  });
});
