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
