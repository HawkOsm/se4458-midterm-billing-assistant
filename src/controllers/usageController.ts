// Add Usage endpoint.
import * as apiKeyDbContext from "../db/apiKeyDbContext";
import type { Db } from "../db/db";
import { formatPeriod, futurePeriodMessage } from "../domain/period";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { AddUsageRequest, IdempotencyHeaders, UsagePathParams, UsageRecordDto, toUsageRecordDto } from "../dto/usageDto";
import { authenticate, requireProvider } from "../middleware/auth";
import { UsageService } from "../services/usageService";
import { API_KEY_AUTH, json, type ApiVersion } from "./apiVersion";

export function usageController(api: ApiVersion, db: Db): void {
  const service = new UsageService(db);
  // Subscribers log in (JWT); the provider's systems send an API key.
  const auth = authenticate((keyHash) => apiKeyDbContext.findActiveKeyName(db, keyHash));

  api.route(
    "post",
    "/subscribers/{subscriberNo}/usage",
    {
      tags: ["Usage"],
      summary: "Add Usage",
      description:
        "Records usage for a month: each PHONE unit is 10 minutes, each INTERNET unit is 1 MB " +
        "(guide §2.3, §3.3). Requires an Idempotency-Key header: a retry with the same key and " +
        "body returns the original response (header Idempotent-Replayed: true) and records nothing. " +
        "Provider side: requires a provider API key (usage comes from the network, not from the customer).",
      security: [{ [API_KEY_AUTH]: [] }],
      request: {
        params: UsagePathParams,
        headers: IdempotencyHeaders,
        body: { content: json(AddUsageRequest) },
      },
      responses: {
        201: { description: "Recorded (or the replay of an earlier identical call)", content: json(UsageRecordDto) },
        400: { description: "Invalid body, missing Idempotency-Key, or a month that hasn't started", content: json(ErrorDto) },
        401: { description: "Missing, invalid or expired token", content: json(ErrorDto) },
        403: { description: "A subscriber token (only the provider records usage)", content: json(ErrorDto) },
        404: { description: "Unknown subscriber", content: json(ErrorDto) },
        409: { description: "Key reused with a different body, or the month's bill already has payments", content: json(ErrorDto) },
      },
    },
    auth,
    requireProvider,
    async (req, res) => {
      const { subscriberNo } = parseOrThrow(UsagePathParams, req.params);
      const { "idempotency-key": key } = parseOrThrow(IdempotencyHeaders, req.headers);
      const report = parseOrThrow(AddUsageRequest, req.body);
      const period = formatPeriod(report.year, report.month);

      const result = await service.add(subscriberNo, report, key);
      switch (result.kind) {
        case "futurePeriod":
          throw new DtoError(futurePeriodMessage(report.year, report.month, "usage can be added"), 400);
        case "noSubscriber":
          throw new DtoError(`Unknown subscriber ${subscriberNo}`, 404);
        case "keyConflict":
          throw new DtoError("This Idempotency-Key was already used for a different usage report", 409);
        case "locked":
          throw new DtoError(`The ${period} bill already has payments; usage can no longer be added to it`, 409);
        case "recorded":
          if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
          res.status(201).json(toUsageRecordDto(result.record, subscriberNo));
          return;
      }
    },
  );
}
