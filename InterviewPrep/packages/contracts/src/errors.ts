import { z } from './zod.js';

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      request_id: z.string(),
      retryable: z.boolean(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorEnvelope');
