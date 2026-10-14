import { Logger } from "@nestjs/common";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Category for logs/metrics; never log the body. */
  kind: string;
}

/** EmailPort (ADD HLD-3): the only place that knows about the email vendor. */
export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PORT = Symbol("EMAIL_PORT");

/** AWS SES v2 in ap-south-1. Credentials come from the ECS task role; no keys in config. */
export class SesEmailAdapter implements EmailPort {
  private readonly client: SESv2Client;
  private readonly logger = new Logger("SesEmail");

  constructor(
    region: string,
    private readonly from: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(m: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [m.to] },
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: "UTF-8" },
            Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
          },
        },
        EmailTags: [{ Name: "kind", Value: m.kind }],
      }),
    );
    this.logger.log(`sent kind=${m.kind}`);
  }
}

export interface CapturedEmail extends EmailMessage {
  at: string;
}

/**
 * Development driver: prints to stdout and keeps the last 50 messages in memory
 * for the dev mailbox route. Config validation refuses it in production.
 */
export class LogEmailAdapter implements EmailPort {
  private readonly logger = new Logger("DevEmail");
  readonly outbox: CapturedEmail[] = [];

  async send(m: EmailMessage): Promise<void> {
    this.outbox.unshift({ ...m, at: new Date().toISOString() });
    this.outbox.length = Math.min(this.outbox.length, 50);
    this.logger.log(`\n  to: ${m.to}\n  subject: ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}`);
  }
}

/**
 * Fire-and-forget send. Auth flows must answer in the same time whether or not
 * an account exists, so they never await delivery (Better Auth's own guidance).
 */
export function dispatch(port: EmailPort, message: EmailMessage, logger: Logger): void {
  void port.send(message).catch((err: unknown) => {
    logger.error(`email send failed kind=${message.kind}: ${err instanceof Error ? err.message : String(err)}`);
  });
}
