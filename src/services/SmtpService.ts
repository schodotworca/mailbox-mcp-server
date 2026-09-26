import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type {
  EmailComposition,
  EmailOperationResult,
  SmtpConnection,
} from "../types/email.types.js";
import {
  ConnectionError,
  EmailError,
  ErrorCode,
  type ErrorContext,
  ErrorUtils,
  ValidationError,
} from "../types/errors.js";
import { createLogger } from "./Logger.js";
import {
  SmtpConnectionPool,
  type SmtpConnectionWrapper,
  type SmtpPoolConfig,
} from "./SmtpConnectionPool.js";

export class SmtpService {
  private pool: SmtpConnectionPool;
  private logger = createLogger("SmtpService");

  constructor(
    connection: SmtpConnection,
    poolConfig: Omit<SmtpPoolConfig, "connectionConfig">,
  ) {
    this.pool = new SmtpConnectionPool({
      ...poolConfig,
      connectionConfig: connection,
    });
  }

    async sendEmail(
    composition: EmailComposition,
  ): Promise<EmailOperationResult> {
    let wrapper: SmtpConnectionWrapper | null = null;
    let sendAttempted = false;

    try {
      wrapper = await this.pool.acquire();
      const transporter = wrapper.connection;

      const normalizedText = composition.text
        ? composition.text.replace(/\r?\n/g, "\r\n")
        : undefined;

      const generatedHtml =
        !composition.html && normalizedText
          ? normalizedText
              .split(/\r\n\r\n+/)
              .map(paragraph => {
                const escaped = paragraph
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;")
                  .replace(/'/g, "&#039;")
                  .replace(/\r\n/g, "<br>");

                return `<p>${escaped}</p>`;
              })
              .join("")
          : undefined;

      const mailOptions = {
        from: {
          name: this.extractNameFromEmail(this.pool.connectionConfig.user),
          address: this.pool.connectionConfig.user,
        },
        to: composition.to.map(({ name, address }) => ({ name: name || "", address })),
        cc: composition.cc?.map(({ name, address }) => ({ name: name || "", address })),
        bcc: composition.bcc?.map(({ name, address }) => ({ name: name || "", address })),
        subject: composition.subject,
        text: normalizedText,
        html: composition.html || generatedHtml,
        attachments: composition.attachments?.map(att => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        })),
      };

      // Compile exactly once. Bcc is retained in the SMTP envelope only.
      const compiled = new MailComposer(mailOptions).compile();
      const envelope = compiled.getEnvelope();
      const messageId = compiled.messageId();
      const rawMessage = await compiled.build();
      sendAttempted = true;
      const info = await transporter.sendMail({ envelope, raw: rawMessage });

      const accepted = Array.isArray(info.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected : [];

      if (accepted.length === 0) {
        return {
          success: false,
          delivery: "not-sent",
          message: `SMTP server did not accept any recipients${
            rejected.length > 0
              ? `; rejected: ${rejected.map(String).join(", ")}`
              : ""
          }`,
        };
      }

      if (rejected.length > 0) {
        return {
          success: true,
          delivery: "partial",
          message: `Email was only partially accepted. Rejected recipients: ${rejected
            .map(String)
            .join(", ")}. Do not resend automatically.`,
          messageId,
          rawMessage,
        };
      }

      return {
        success: true,
        delivery: "accepted",
        message: "SMTP server accepted the email",
        messageId,
        rawMessage,
      };
    } catch (error) {
      await this.logger.error(
        "Failed to send email",
        {
          operation: "sendEmail",
          service: "SmtpService",
        },
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );

      return {
        success: false,
        delivery: sendAttempted ? "unknown" : "not-sent",
        message: `${sendAttempted ? "SMTP delivery outcome is unknown. Do not resend automatically." : "Email was not submitted to SMTP."} ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      if (wrapper) {
        try {
          await this.pool.release(wrapper);
        } catch (error) {
          await this.logger.warning("SMTP pool cleanup failed; preserving delivery outcome", {
            operation: "sendEmail", service: "SmtpService",
          }, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  async verifyConnection(): Promise<boolean> {
    let wrapper: SmtpConnectionWrapper | null = null;

    try {
      wrapper = await this.pool.acquire();
      await wrapper.connection.verify();
      return true;
    } catch (error) {
      await this.logger.error(
        "SMTP connection verification failed",
        {
          operation: "verifyConnection",
          service: "SmtpService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    } finally {
      if (wrapper) {
        await this.pool.release(wrapper);
      }
    }
  }

  private extractNameFromEmail(email: string): string {
    const localPart = email.split("@")[0];
    return localPart
      .split(/[._-]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }

  // Pool management methods
  getPoolMetrics() {
    return this.pool.getSmtpMetrics();
  }

  async validatePoolHealth(): Promise<boolean> {
    try {
      const metrics = this.pool.getMetrics();
      return (
        metrics.totalConnections > 0 &&
        metrics.totalErrors < metrics.totalConnections
      );
    } catch (error) {
      await this.logger.error(
        "Error checking SMTP pool health",
        {
          operation: "isHealthy",
          service: "SmtpService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
  }

  async verifyAllPoolConnections(): Promise<{
    verified: number;
    failed: number;
  }> {
    return await this.pool.verifyAllConnections();
  }
}
