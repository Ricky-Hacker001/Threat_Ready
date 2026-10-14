import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/** Validation pipe from a shared contract schema (ADD L5: contracts in packages/contracts). */
export function ZodBody<T>(schema: ZodType<T>): PipeTransform<unknown, T> {
  return {
    transform(value: unknown): T {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: parsed.error.issues[0]?.message ?? "Invalid request",
        });
      }
      return parsed.data;
    },
  };
}
