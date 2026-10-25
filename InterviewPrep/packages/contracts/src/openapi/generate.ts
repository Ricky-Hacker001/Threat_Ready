import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ErrorEnvelopeSchema } from '../errors.js';
import { TurnStreamEvent } from '../interviews.js';
import { ReasoningStateEvent } from '../reasoning.js';
import { z } from '../zod.js';
import { ROUTES } from './routes.js';

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.register('ErrorEnvelope', ErrorEnvelopeSchema);
  registry.register('TurnStreamEvent', TurnStreamEvent);
  registry.register('ReasoningStateEvent', ReasoningStateEvent);
  registry.registerComponent('securitySchemes', 'session', { type: 'apiKey', in: 'cookie', name: 'tr.session_token' });

  for (const r of ROUTES) {
    const pathParams = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const ok = r.status ?? 200;
    registry.registerPath({
      method: r.method,
      path: r.path,
      operationId: r.id,
      summary: r.summary,
      tags: [r.path.startsWith('/v1/documents') ? 'documents' : r.path.startsWith('/v1/skills') ? 'skills' : r.path.startsWith('/v1/assets') ? 'assets' : r.path.startsWith('/v1/reasoning') ? 'reasoning' : 'interviews'],
      security: [{ session: [] }],
      'x-permission': r.permission,
      'x-rate-class': r.rateClass,
      request: {
        params: pathParams.length ? z.object(Object.fromEntries(pathParams.map((p) => [p, z.uuid()]))) : undefined,
        query: r.id === 'listInterviews' || r.id === 'listReasoningAttempts' ? z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }) : undefined,
        body: r.body ? { content: { 'application/json': { schema: r.body } } } : undefined,
      },
      responses: {
        [ok]: r.stream
          ? { description: 'Server-Sent Events; each data line is a TurnStreamEvent', content: { 'text/event-stream': { schema: z.string() } } }
          : r.binary
            ? { description: 'Encrypted binary', content: { 'application/octet-stream': { schema: z.string() } } }
            : r.response
            ? { description: 'OK', content: { 'application/json': { schema: r.response } } }
            : { description: 'No content' },
        default: { description: 'Error envelope (ADD §10)', content: { 'application/json': { schema: ErrorEnvelopeSchema } } },
      },
    } as Parameters<typeof registry.registerPath>[0]);
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ThreatReady InterviewPrep API',
      version: '1.0.0',
      description: 'Generated from Zod schemas in packages/contracts. Do not edit openapi.json by hand.',
    },
    servers: [{ url: '/' }],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
}
