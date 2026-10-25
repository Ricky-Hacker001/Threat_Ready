import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { PortError } from '@threatready/shared';
import { logger } from '../logging/logger.js';
import type { CachePort } from '../ports/cache.port.js';
import type { EmailPort, EmailTemplate } from '../ports/email.port.js';

/**
 * S1 CachePort: per-task counters until Valkey arrives (L11/L12). Keys can come from anonymous
 * clients (per-IP limits), so the map is bounded: past `sweepAt` entries a write sweeps expired ones
 * (at most once a second), and beyond `maxEntries` the oldest are evicted (Map order is insertion order).
 */
export class InMemoryCacheAdapter implements CachePort {
  private readonly store = new Map<string, { value: unknown; exp: number }>();
  private lastSweep = 0;

  constructor(
    private readonly sweepAt = 50_000,
    private readonly maxEntries = 100_000,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e || e.exp < Date.now()) return null;
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    this.store.delete(key);
    this.store.set(key, { value, exp: Date.now() + ttlSec * 1000 });
    this.bound();
  }

  async incr(key: string, windowSec: number): Promise<number> {
    const e = this.store.get(key);
    if (!e || e.exp < Date.now()) {
      this.store.delete(key);
      this.store.set(key, { value: 1, exp: Date.now() + windowSec * 1000 });
      this.bound();
      return 1;
    }
    e.value = (e.value as number) + 1;
    return e.value as number;
  }

  async ttl(key: string): Promise<number | null> {
    const e = this.store.get(key);
    if (!e || e.exp < Date.now()) return null;
    return Math.max(1, Math.ceil((e.exp - Date.now()) / 1000));
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  private bound(): void {
    if (this.store.size <= this.sweepAt) return;
    const now = Date.now();
    if (now - this.lastSweep >= 1000) {
      this.lastSweep = now;
      for (const [k, v] of this.store) if (v.exp < now) this.store.delete(k);
    }
    for (const k of this.store.keys()) {
      if (this.store.size <= this.maxEntries) break;
      this.store.delete(k);
    }
  }
}

const SUBJECTS: Record<EmailTemplate, string> = {
  'interview-report-ready': 'Your ThreatReady interview report is ready',
};

function renderText(template: EmailTemplate, data: Record<string, unknown>): string {
  switch (template) {
    case 'interview-report-ready':
      return [
        `Hi ${String(data.name ?? 'there')},`,
        '',
        `Your InterviewPrep report for ${String(data.roleTitle ?? 'your interview')} is ready.`,
        `Open it here: ${String(data.url)}`,
        '',
        'This is a simulated interview assessment for practice, not a prediction of hiring outcomes.',
        '— ThreatReady',
      ].join('\n');
  }
}

export class SesEmailAdapter implements EmailPort {
  private readonly ses: SESv2Client;
  constructor(region: string, private readonly from: string) {
    this.ses = new SESv2Client({ region });
  }

  async send(template: EmailTemplate, to: string, data: Record<string, unknown>, key: string): Promise<void> {
    try {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [to] },
          Content: { Simple: { Subject: { Data: SUBJECTS[template] }, Body: { Text: { Data: renderText(template, data) } } } },
          EmailTags: [{ Name: 'message_key', Value: key.replace(/[^\w-]/g, '_').slice(0, 250) }],
        }),
      );
    } catch (cause) {
      throw new PortError('unavailable', 'ses send failed', { cause });
    }
  }
}

/** Development EmailPort: records that a message would be sent, without the address or body. */
export class LogEmailAdapter implements EmailPort {
  readonly sent: { template: EmailTemplate; key: string }[] = [];
  async send(template: EmailTemplate, _to: string, _data: Record<string, unknown>, key: string): Promise<void> {
    this.sent.push({ template, key });
    logger.info({ template, message_key: key }, 'email (log driver)');
  }
}
