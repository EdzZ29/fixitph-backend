import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outbound email.
 *
 * With SMTP_HOST set, mail goes out over SMTP. Without it, messages are
 * written to the log instead, so the reset flow is fully usable on a machine
 * with no mail server. Production refuses to start in that state: silently
 * dropping a password reset code is worse than failing loudly.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>(
      'MAIL_FROM',
      'FixItPH <no-reply@fixitph.example>',
    );
  }

  onModuleInit(): void {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const isProduction = this.config.get('NODE_ENV') === 'production';

    if (!host) {
      if (isProduction) {
        throw new Error(
          'SMTP_HOST is not set. Refusing to start in production without a mail ' +
            'transport, because password reset codes would be silently discarded.',
        );
      }
      this.logger.warn(
        'SMTP_HOST is not set. Emails will be written to this log instead of sent.',
      );
      return;
    }

    const port = this.config.get<number>('SMTP_PORT', 587);
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASSWORD');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      // Implicit TLS on 465, STARTTLS everywhere else.
      secure: port === 465,
      ...(user && pass ? { auth: { user, pass } } : {}),
    });

    this.logger.log(`SMTP transport ready at ${host}:${port}`);
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.log(
        `\n--- email (no SMTP transport configured) ---\n` +
          `To:      ${message.to}\n` +
          `Subject: ${message.subject}\n\n` +
          `${message.text}\n` +
          `--- end email ---`,
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (e) {
      // The caller must not be able to tell a delivery failure from an unknown
      // address, so this is logged and swallowed rather than thrown.
      this.logger.error(
        `Failed to send "${message.subject}" to ${message.to}: ${(e as Error).message}`,
      );
    }
  }

  /** The password reset code email. */
  async sendPasswordResetCode(
    to: string,
    code: string,
    minutesValid: number,
  ): Promise<void> {
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    await this.send({
      to,
      subject: `${code} is your FixItPH password reset code`,
      text: [
        'Someone asked to reset the password on your FixItPH account.',
        '',
        `Your code is ${spaced}`,
        '',
        `It expires in ${minutesValid} minutes and can be used once.`,
        '',
        'If this was not you, ignore this email. Your password has not changed.',
        'Nobody from FixItPH will ever ask you for this code.',
      ].join('\n'),
      html: `
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#101010">
          <p style="font-size:20px;font-weight:700;margin:0 0 24px">FixItPH</p>
          <p style="margin:0 0 16px">Someone asked to reset the password on your FixItPH account.</p>
          <p style="margin:0 0 8px;color:#737373;font-size:14px">Your code</p>
          <p style="font-size:34px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${spaced}</p>
          <p style="margin:0 0 24px;color:#737373;font-size:14px">
            It expires in ${minutesValid} minutes and can be used once.
          </p>
          <p style="margin:0;font-size:14px;color:#737373">
            If this was not you, ignore this email and your password stays as it is.
            Nobody from FixItPH will ever ask you for this code.
          </p>
        </div>
      `,
    });
  }

  /** Sent after a successful reset, so an unexpected change is noticed. */
  async sendPasswordChangedNotice(to: string): Promise<void> {
    await this.send({
      to,
      subject: 'Your FixItPH password was changed',
      text: [
        'The password on your FixItPH account was just changed.',
        '',
        'Every other device has been signed out.',
        '',
        'If this was not you, reset your password again straight away and',
        'contact support@fixitph.example.',
      ].join('\n'),
      html: `
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#101010">
          <p style="font-size:20px;font-weight:700;margin:0 0 24px">FixItPH</p>
          <p style="margin:0 0 16px">The password on your FixItPH account was just changed.</p>
          <p style="margin:0 0 16px">Every other device has been signed out.</p>
          <p style="margin:0;font-size:14px;color:#737373">
            If this was not you, reset your password again straight away and contact
            <a href="mailto:support@fixitph.example">support@fixitph.example</a>.
          </p>
        </div>
      `,
    });
  }
}
