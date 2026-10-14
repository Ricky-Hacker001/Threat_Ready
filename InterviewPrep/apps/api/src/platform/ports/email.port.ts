export type EmailTemplate = 'interview-report-ready';

/** ADD §6 EmailPort. `key` makes a send idempotent across job retries. */
export interface EmailPort {
  send(template: EmailTemplate, to: string, data: Record<string, unknown>, key: string): Promise<void>;
}

export const EMAIL_PORT = Symbol('EmailPort');
