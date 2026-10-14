import { AsyncLocalStorage } from 'node:async_hooks';
import { SENSITIVE_KEYS } from '@threatready/shared';
import pino from 'pino';

export interface RequestContext {
  requestId: string;
  userId?: string;
  route?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * JSON logs to stdout for CloudWatch. Logs carry ids and the request_id only; document text,
 * answers, prompts and model output are redacted by key (ADD §9).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'threatready-api', role: process.env.APP_ROLE },
  redact: {
    paths: [...SENSITIVE_KEYS.map((k) => `*.${k}`), ...SENSITIVE_KEYS.map((k) => k), 'req.headers.cookie', 'req.headers.authorization'],
    censor: '[redacted]',
  },
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { request_id: ctx.requestId, user_id: ctx.userId } : {};
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/**
 * CloudWatch Embedded Metric Format: one JSON line becomes a metric without an agent or API call.
 * Namespace ThreatReady/InterviewPrep; dimensions kept low-cardinality (feature, tier).
 */
export function emitMetric(
  name: string,
  value: number,
  unit: 'Milliseconds' | 'Count' | 'None',
  dimensions: Record<string, string> = {},
): void {
  if (process.env.NODE_ENV === 'test') return;
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'ThreatReady/InterviewPrep', Dimensions: [Object.keys(dimensions)], Metrics: [{ Name: name, Unit: unit }] },
      ],
    },
    ...dimensions,
    [name]: value,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
