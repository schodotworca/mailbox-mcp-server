import {describe, expect, it, vi} from 'vitest';
import {SmtpService} from '../src/services/SmtpService.js';
import {handleEmailTool} from '../src/tools/emailTools.js';
const composition = {to:[{address:'to@example.com'}], subject:'Test',text:'Line one\n\nLine two'};
function smtpFixture() {
  const sendMail = vi.fn().mockResolvedValue({accepted:['to@example.com'],rejected:[],messageId:'<id@example.com>'});
  const release = vi.fn();
  const service = Object.assign(Object.create(SmtpService.prototype), {
    pool:{acquire:vi.fn().mockResolvedValue({connection:{sendMail}}),release,connectionConfig:{user:'sender@example.com'}},
    logger:{error:vi.fn(),warning:vi.fn()}
  }) as SmtpService;
  return {service,sendMail,release};
}
describe('SMTP outcome isolation', () => {
  it('preserves SMTP acceptance when Sent throws', async () => {
    const {service,sendMail} = smtpFixture();
    const email = {saveSentCopy:vi.fn().mockRejectedValue(new Error('IMAP timeout'))};
    const result = await handleEmailTool('send_email',composition,email as any,service);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('accepted by the SMTP server');
    expect(result.content[0].text).toContain('Do not resend automatically');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('preserves acceptance if pool cleanup fails', async () => {
    const {service,sendMail,release} = smtpFixture(); release.mockRejectedValue(new Error('cleanup'));
    expect((await service.sendEmail(composition)).success).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('reports uncertain transport failures without retrying', async () => {
    const {service,sendMail} = smtpFixture(); sendMail.mockRejectedValue(new Error('socket timeout after DATA'));
    const result = await service.sendEmail(composition);
    expect(result.delivery).toBe('unknown');
    expect(result.message).toContain('Do not resend automatically');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('preserves partial acceptance and saves a copy once', async () => {
    const {service,sendMail} = smtpFixture(); sendMail.mockResolvedValue({accepted:['to@example.com'],rejected:['other@example.com'],messageId:'<id@example.com>'});
    const email = {saveSentCopy:vi.fn().mockResolvedValue({success:true})};
    const result = await handleEmailTool('send_email',composition,email as any,service);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('partially accepted');
    expect(email.saveSentCopy).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('identical SMTP and Sent MIME', () => {
  it('uses the same bytes and Message-ID with Bcc only in the envelope', async () => {
    const {simpleParser} = await import('mailparser');
    const {EmailService} = await import('../src/services/EmailService.js');
    const {service,sendMail} = smtpFixture();
    const draft = {...composition, text:'Line one\nLine two\n\nParagraph', bcc:[{address:'hidden@example.com'}], subject:'Zażółć gęślą', attachments:[{filename:'test.txt', content:Buffer.from('Zażółć'),contentType:'text/plain'}]};
    const result = await service.sendEmail(draft);
    const smtp = sendMail.mock.calls[0][0];
    expect(Buffer.isBuffer(smtp.raw)).toBe(true);
    expect(smtp.envelope.to).toContain('hidden@example.com');
    const append = vi.fn().mockResolvedValue({uid:42});
    const email = Object.assign(Object.create(EmailService.prototype), {
      pool: {acquire:vi.fn().mockResolvedValue({connection:{list:vi.fn().mockResolvedValue([{specialUse:'\\Sent',path:'Sent Messages'}]),append}}),release:vi.fn()},
      cache:{}, logger:{error:vi.fn()}
    });
    expect((await email.saveSentCopy(result.rawMessage)).success).toBe(true);
    expect(append.mock.calls[0][1]).toBe(smtp.raw);
    const parsed = await simpleParser(smtp.raw);
    expect(parsed.messageId).toBe(result.messageId);
    expect(parsed.from?.value[0].address).toBe('sender@example.com');
    expect(parsed.bcc).toBeUndefined();
    expect(smtp.raw.toString()).not.toMatch(/^bcc:/im);
    expect(smtp.raw.toString()).not.toContain('hidden@example.com');
    expect(parsed.subject).toBe(draft.subject);
    expect(parsed.text?.trim()).toBe(draft.text);
    expect(parsed.html).toContain('<br>');
    expect(parsed.attachments[0].content).toEqual(draft.attachments[0].content);
  });
});

it('Nodemailer transport emits precisely the compiled bytes', async () => {
  const nodemailer = await import('nodemailer');
  const {service,sendMail} = smtpFixture();
  const result = await service.sendEmail({...composition,bcc:[{address:'hidden@example.com'}]});
  const options = sendMail.mock.calls[0][0];
  const transport = nodemailer.default.createTransport({streamTransport:true,buffer:true,newline:'windows'});
  const info = await transport.sendMail(options);
  expect(info.message).toEqual(result.rawMessage);
  expect(info.envelope.to).toContain('hidden@example.com');
  transport.close();
});

it('does not archive or retry when all recipients are rejected', async () => {
  const {service,sendMail} = smtpFixture();
  sendMail.mockResolvedValue({accepted:[],rejected:['to@example.com']});
  const email = {saveSentCopy:vi.fn()};
  const result = await handleEmailTool('send_email',composition,email as any,service);
  expect(result.isError).toBe(true);
  expect(email.saveSentCopy).not.toHaveBeenCalled();
  expect(sendMail).toHaveBeenCalledTimes(1);
});

it('does not claim archival success when APPEND returns false', async () => {
  const {EmailService} = await import('../src/services/EmailService.js');
  const append = vi.fn().mockResolvedValue(false);
  const email = Object.assign(Object.create(EmailService.prototype), {
    pool:{acquire:vi.fn().mockResolvedValue({connection:{list:vi.fn().mockResolvedValue([{specialUse:'\\Sent',path:'Sent'}]),append}}),release:vi.fn()},
    cache:{},logger:{error:vi.fn()}
  });
  const result = await email.saveSentCopy(Buffer.from('From: a@example.com\r\n\r\nBody'));
  expect(result.success).toBe(false);
  expect(append).toHaveBeenCalledTimes(1);
});
