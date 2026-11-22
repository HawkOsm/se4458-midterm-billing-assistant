// Bill endpoints (like the teacher's Controllers/TodoItemsController.cs).
// HTTP concerns only: validate input, call the service, map the result to a status code.
import type { Db } from "../db/db";
import { BillDto, BillPeriodParams, toBillDto } from "../dto/billDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { BillService } from "../services/billService";
import type { ApiVersion } from "./apiVersion";

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
        200: { description: "The stored bill", content: { "application/json": { schema: BillDto } } },
        400: { description: "Invalid subscriber number, year or month", content: { "application/json": { schema: ErrorDto } } },
        404: { description: "No bill has been calculated for this period", content: { "application/json": { schema: ErrorDto } } },
      },
    },
    async (req, res) => {
      const { subscriberNo, year, month } = parseOrThrow(BillPeriodParams, req.params);
      const bill = await service.get(subscriberNo, year, month);
      if (!bill) {
        const period = `${year}-${String(month).padStart(2, "0")}`;
        throw new DtoError(`No bill for ${subscriberNo} in ${period}`, 404);
      }
      res.json(toBillDto(bill, subscriberNo));
    },
  );
}
