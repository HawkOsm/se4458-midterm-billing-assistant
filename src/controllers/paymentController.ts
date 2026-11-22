// Pay Bill endpoint.
import type { Db } from "../db/db";
import { formatCents } from "../domain/money";
import { formatPeriod } from "../domain/period";
import { BillPeriodParams } from "../dto/billDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { PayBillRequest, PaymentDto, parseAmountCents, toPaymentDto } from "../dto/paymentDto";
import { requireAuth, requireOwnAccount } from "../middleware/auth";
import { PaymentService } from "../services/paymentService";
import { BEARER_AUTH, json, type ApiVersion } from "./apiVersion";

export function paymentController(api: ApiVersion, db: Db): void {
  const service = new PaymentService(db);

  api.route(
    "post",
    "/subscribers/{subscriberNo}/bills/{year}/{month}/payments",
    {
      tags: ["Payments"],
      summary: "Pay Bill",
      description:
        "Records a simulated full or partial payment (no real money). transactionId is the " +
        "idempotency key: a retry with the same transactionId and details returns the original " +
        "result (header Idempotent-Replayed: true) and pays nothing again. The AI agent must get " +
        "the user's explicit confirmation before calling this (guide §5.2). Requires the " +
        "subscriber's own token.",
      security: [{ [BEARER_AUTH]: [] }],
      request: { params: BillPeriodParams, body: { content: json(PayBillRequest) } },
      responses: {
        201: { description: "Payment accepted (or the replay of an earlier identical call)", content: json(PaymentDto) },
        400: { description: "Invalid path or body (amount must be positive, at most 2 decimals)", content: json(ErrorDto) },
        401: { description: "Missing, invalid or expired token", content: json(ErrorDto) },
        403: { description: "Not the subscriber's own token (admins can't pay for a subscriber)", content: json(ErrorDto) },
        404: { description: "Unknown subscriber, or no bill calculated for the month", content: json(ErrorDto) },
        409: {
          description:
            "transactionId already used for a different payment, the month isn't over yet, or usage was added after the bill was calculated",
          content: json(ErrorDto),
        },
        422: { description: "Amount exceeds the remaining balance, or the bill is already fully paid", content: json(ErrorDto) },
      },
    },
    requireAuth,
    requireOwnAccount,
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const body = parseOrThrow(PayBillRequest, req.body);
      const amountCents = parseAmountCents(body.amount);
      const period = formatPeriod(year, month);

      const result = await service.pay({ subscriberNo, year, month, transactionId: body.transactionId, amountCents });
      switch (result.kind) {
        case "noSubscriber":
          throw new DtoError(`Unknown subscriber ${subscriberNo}`, 404);
        case "noBill":
          throw new DtoError(`No bill for ${subscriberNo} in ${period}; calculate the bill first`, 404);
        case "monthNotOver":
          throw new DtoError(`${period} is not over yet; a bill can be paid once its month has ended`, 409);
        case "transactionConflict":
          throw new DtoError("This transactionId was already used for a different payment", 409);
        case "unbilledUsage":
          throw new DtoError(
            `Usage was added to ${period} after its bill was calculated; recalculate the bill (PUT) before paying`,
            409,
          );
        case "alreadyPaid":
          throw new DtoError(`The ${period} bill is already fully paid`, 422);
        case "exceedsBalance":
          throw new DtoError(
            `Amount ${formatCents(amountCents)} exceeds the remaining balance ${formatCents(result.remainingCents)}`,
            422,
          );
        case "paid":
          if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
          res.status(201).json(toPaymentDto(result.payment));
          return;
      }
    },
  );
}
