// Add Usage request/response shapes.
import { MAX_QUANTITY, USAGE_TYPES, type RecordedUsage } from "../domain/usageEvent";
import { SubscriberNo } from "./billDto";
import { z } from "./zod";

export const UsagePathParams = z.object({ subscriberNo: SubscriberNo });

export const AddUsageRequest = z
  .object({
    year: z.number().int().min(2000).max(2100).openapi({ example: 2025 }),
    month: z.number().int().min(1).max(12).openapi({ example: 4 }),
    usageType: z.enum(USAGE_TYPES).openapi({ example: "INTERNET" }),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUANTITY)
      .default(1)
      .openapi({
        description: "Units to record: each PHONE unit is 10 minutes, each INTERNET unit is 1 MB. Default 1 (the spec's one unit per call).",
        example: 50,
      }),
  })
  .openapi("AddUsageRequest");
export type AddUsageRequest = z.infer<typeof AddUsageRequest>;

// Required on every call (decision 4). A retry with the same key and the same body gets
// the original response and records nothing new; a different body is refused (409).
// Matches the column, billing.usage_events.idempotency_key VARCHAR(100).
export const IdempotencyHeaders = z.object({
  "idempotency-key": z
    .string({ error: "required header (a unique value per usage report, e.g. a UUID)" })
    .min(1)
    .max(100)
    .openapi({ description: "Unique per usage report; retries reuse it", example: "3f6c1e2a-8b1d-4c3e-9a7f-1b2c3d4e5f60" }),
});

export const UsageRecordDto = z
  .object({
    status: z.literal("RECORDED"),
    subscriberNo: z.string().openapi({ example: "5551234" }),
    year: z.number().int().openapi({ example: 2025 }),
    month: z.number().int().openapi({ example: 4 }),
    usageType: z.enum(USAGE_TYPES).openapi({ example: "INTERNET" }),
    quantity: z.number().int().openapi({ example: 50 }),
    amount: z.number().int().openapi({ description: "Minutes for PHONE, MB for INTERNET", example: 50 }),
    unit: z.enum(["minutes", "MB"]).openapi({ example: "MB" }),
    recordedAt: z.string().openapi({ example: "2025-04-12T09:30:00.000Z" }),
  })
  .openapi("UsageRecord");
export type UsageRecordDto = z.infer<typeof UsageRecordDto>;

export function toUsageRecordDto(record: RecordedUsage, subscriberNo: string): UsageRecordDto {
  return {
    status: "RECORDED",
    subscriberNo,
    year: record.year,
    month: record.month,
    usageType: record.event.type,
    quantity: record.quantity,
    amount: record.event.amount,
    unit: record.event.unit,
    recordedAt: record.event.recordedAt.toISOString(),
  };
}
