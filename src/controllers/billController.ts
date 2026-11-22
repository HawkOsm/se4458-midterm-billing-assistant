// Bill endpoints (like the teacher's Controllers/TodoItemsController.cs).
// HTTP concerns only: validate input, call the service, map the result to a status code.
import type { Db } from "../db/db";
import { BillDetailsDto, PageQuery, toBillDetailsDto } from "../dto/billDetailsDto";
import { BillDto, BillPeriodParams, toBillDto } from "../dto/billDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { requireAuth, requireOwnAccountOrAdmin } from "../middleware/auth";
import { formatPeriod, futurePeriodMessage } from "../domain/period";
import { BillService } from "../services/billService";
import { BEARER_AUTH, json, type ApiVersion } from "./apiVersion";

function noBill(subscriberNo: string, year: number, month: number): DtoError {
  return new DtoError(`No bill for ${subscriberNo} in ${formatPeriod(year, month)}`, 404);
}

export function billController(api: ApiVersion, db: Db): void {
  const service = new BillService(db);

  api.route(
    "get",
    "/subscribers/{subscriberNo}/bills/{year}/{month}",
    {
      tags: ["Bills"],
      summary: "Query Bill",
      description: "Bill total, paid amount, remaining balance and status. No authentication (per spec).",
      request: { params: BillPeriodParams },
      responses: {
        200: { description: "The stored bill", content: json(BillDto) },
        400: { description: "Invalid subscriber number, year or month", content: json(ErrorDto) },
        404: { description: "No bill has been calculated for this period", content: json(ErrorDto) },
      },
    },
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const bill = await service.get(subscriberNo, year, month);
      if (!bill) throw noBill(subscriberNo, year, month);
      res.json(toBillDto(bill, subscriberNo));
    },
  );

  api.route(
    "get",
    "/subscribers/{subscriberNo}/bills/{year}/{month}/details",
    {
      tags: ["Bills"],
      summary: "Query Bill Detailed",
      description:
        "The stored bill with usage, charge breakdown, and a page of the usage events it was " +
        "calculated from (newest first). Requires the subscriber's own token, or the provider's admin.",
      security: [{ [BEARER_AUTH]: [] }],
      request: { params: BillPeriodParams, query: PageQuery },
      responses: {
        200: { description: "The bill breakdown and one page of usage events", content: json(BillDetailsDto) },
        400: { description: "Invalid path or paging parameters", content: json(ErrorDto) },
        401: { description: "Missing, invalid or expired token", content: json(ErrorDto) },
        403: { description: "The token belongs to another subscriber (and isn't an admin)", content: json(ErrorDto) },
        404: { description: "No bill has been calculated for this period", content: json(ErrorDto) },
      },
    },
    requireAuth,
    requireOwnAccountOrAdmin,
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const { offset, limit } = parseOrThrow(PageQuery, req.query);
      const details = await service.getDetails(subscriberNo, year, month, offset, limit);
      if (!details) throw noBill(subscriberNo, year, month);
      res.json(toBillDetailsDto(details.bill, subscriberNo, details.events));
    },
  );

  api.route(
    "put",
    "/subscribers/{subscriberNo}/bills/{year}/{month}",
    {
      tags: ["Bills"],
      summary: "Calculate Bill",
      description:
        "Calculates the month's bill from its recorded usage (guide §4.2) and stores it. " +
        "PUT because it is idempotent: repeating it updates the same bill. Allowed until the " +
        "bill's first payment. Requires the subscriber's own token (to see the month so far), or the provider's admin.",
      security: [{ [BEARER_AUTH]: [] }],
      request: { params: BillPeriodParams },
      responses: {
        201: { description: "Bill created", content: json(BillDto) },
        200: { description: "Bill recalculated (unchanged if no new usage)", content: json(BillDto) },
        400: { description: "Invalid path, or a month that hasn't started yet", content: json(ErrorDto) },
        401: { description: "Missing, invalid or expired token", content: json(ErrorDto) },
        403: { description: "The token belongs to another subscriber (and isn't an admin)", content: json(ErrorDto) },
        404: { description: "Unknown subscriber", content: json(ErrorDto) },
        409: { description: "The bill already has payments and is locked", content: json(ErrorDto) },
        422: { description: "The month's usage is too large to bill", content: json(ErrorDto) },
      },
    },
    requireAuth,
    requireOwnAccountOrAdmin,
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const period = formatPeriod(year, month);
      const result = await service.calculate(subscriberNo, year, month);
      switch (result.kind) {
        case "futurePeriod":
          throw new DtoError(futurePeriodMessage(year, month, "bills can be calculated"), 400);
        case "noSubscriber":
          throw new DtoError(`Unknown subscriber ${subscriberNo}`, 404);
        case "locked":
          throw new DtoError(`The ${period} bill already has payments and can no longer be recalculated`, 409);
        case "outOfRange":
          throw new DtoError(`The ${period} usage is too large to bill (the total would exceed 99,999,999.99)`, 422);
        case "created":
          // Where the new bill can be read: the same URL, with GET (Query Bill).
          res.status(201).location(req.originalUrl).json(toBillDto(result.bill, subscriberNo));
          return;
        case "recalculated":
          res.json(toBillDto(result.bill, subscriberNo));
          return;
      }
    },
  );
}
