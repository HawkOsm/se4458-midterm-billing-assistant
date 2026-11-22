// Bill endpoints (like the teacher's Controllers/TodoItemsController.cs).
// HTTP concerns only: validate input, call the service, map the result to a status code.
import type { Db } from "../db/db";
import { BillDetailsDto, PageQuery, toBillDetailsDto } from "../dto/billDetailsDto";
import { BillDto, BillPeriodParams, toBillDto } from "../dto/billDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { requireAuth, requireOwnAccount } from "../middleware/auth";
import { BillService } from "../services/billService";
import { BEARER_AUTH, json, type ApiVersion } from "./apiVersion";

function noBill(subscriberNo: string, year: number, month: number): DtoError {
  const period = `${year}-${String(month).padStart(2, "0")}`;
  return new DtoError(`No bill for ${subscriberNo} in ${period}`, 404);
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
        "calculated from (newest first). Requires the subscriber's own token.",
      security: [{ [BEARER_AUTH]: [] }],
      request: { params: BillPeriodParams, query: PageQuery },
      responses: {
        200: { description: "The bill breakdown and one page of usage events", content: json(BillDetailsDto) },
        400: { description: "Invalid path or paging parameters", content: json(ErrorDto) },
        401: { description: "Missing, invalid or expired token", content: json(ErrorDto) },
        403: { description: "The token belongs to another subscriber", content: json(ErrorDto) },
        404: { description: "No bill has been calculated for this period", content: json(ErrorDto) },
      },
    },
    requireAuth,
    requireOwnAccount,
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const { offset, limit } = parseOrThrow(PageQuery, req.query);
      const details = await service.getDetails(subscriberNo, year, month, offset, limit);
      if (!details) throw noBill(subscriberNo, year, month);
      res.json(toBillDetailsDto(details.bill, subscriberNo, details.events));
    },
  );
}
