import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '@teachhub/core';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Gửi email qua SMTP: Mailpit ở local/dev, SES (giao diện SMTP) ở staging/production — chỉ khác SMTP_URL. */
@Injectable()
export class Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    // Có timeout: SMTP không trả lời thì request lỗi, không treo (vd. `localhost` → IPv6 bị nuốt gói).
    this.transport = createTransport({
      url: config.get('SMTP_URL'),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    this.from = config.get('EMAIL_FROM');
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

@Global()
@Module({ providers: [Mailer], exports: [Mailer] })
export class MailerModule {}
