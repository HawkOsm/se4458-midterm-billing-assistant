// The billing tools Claude can call. None of them takes a subscriber number: every call is
// made for the logged-in subscriber with their own token, so a prompt that names another
// subscriber ("show 5559999's bill") has no way to reach that data (assignment line 113).
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiResponse, BillingApiClient } from "./billingApiClient";

export interface Session {
  subscriberNo: string;
  token: string;
}

const period = {
  year: { type: "integer", description: "Billing year, 2000-2100, e.g. 2026" },
  month: { type: "integer", description: "Billing month, 1-12" },
} as const;

// strict: true makes Claude's arguments match the schema exactly. Strict schemas can't hold
// number ranges (minimum/maximum: the API refuses them), so ranges are in the descriptions
// and checked by the zod schemas below.
export const BILLING_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_bill",
    description:
      "The logged-in subscriber's stored bill for one month: total, paid amount, remaining balance, " +
      "status, and `estimate` (true = the month is still running, so it is only the amount so far).",
    input_schema: { type: "object", properties: { ...period }, required: ["year", "month"], additionalProperties: false },
    strict: true,
  },
  {
    name: "query_bill_detailed",
    description:
      "The logged-in subscriber's bill for one month with usage (phone minutes, internet MB/GB) and the " +
      "charge breakdown (included allowance, extra blocks, prices), plus a page of usage events. Use it " +
      "to explain why a bill is what it is.",
    input_schema: {
      type: "object",
      properties: {
        ...period,
        offset: { type: "integer", description: "Usage events to skip (paging), 0 or more, default 0" },
        limit: { type: "integer", description: "Usage events per page, 1-100, default 5" },
      },
      required: ["year", "month"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "calculate_bill",
    description:
      "Calculate (or recalculate) the logged-in subscriber's bill for one month from its recorded usage. " +
      "A write action: the user is asked to confirm before it runs. Needed when a payment is refused " +
      "because usage was added after the bill was calculated.",
    input_schema: { type: "object", properties: { ...period }, required: ["year", "month"], additionalProperties: false },
    strict: true,
  },
  {
    name: "pay_bill",
    description:
      "Pay (a simulated payment, no real money) part or all of the logged-in subscriber's bill for one " +
      "finished month. A write action: the user is asked to confirm the exact amount before it runs. " +
      "Only call it when the user asked to pay; never more than the remaining balance.",
    input_schema: {
      type: "object",
      properties: {
        ...period,
        amount: { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$", description: 'Amount in dollars, e.g. "25.00"' },
      },
      required: ["year", "month", "amount"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// The same rules checked again in code: tool inputs are never trusted blindly.
const Period = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
const Detailed = Period.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(5),
});
const Pay = Period.extend({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/) });

const two = (n: number): string => String(n).padStart(2, "0");

// Tools that change data: the agent pauses and asks the user before running them.
export const WRITE_TOOLS = new Set(["calculate_bill", "pay_bill"]);

// What the user is asked to confirm, written by the code from the actual input, so the
// model can't describe a write differently from what will really happen.
export function confirmationText(name: string, input: unknown, session: Session): string {
  if (name === "pay_bill") {
    const p = Pay.parse(input);
    return `Pay $${p.amount} on the ${p.year}-${two(p.month)} bill of subscriber ${session.subscriberNo}? (simulated payment)`;
  }
  const p = Period.parse(input);
  return `Calculate the ${p.year}-${two(p.month)} bill of subscriber ${session.subscriberNo}?`;
}

function result(res: ApiResponse): { text: string; isError: boolean } {
  const isError = res.status >= 400;
  const prefix = res.status === 401 ? "The login has expired; ask the user to log in again. " : "";
  return { text: prefix + JSON.stringify({ httpStatus: res.status, ...(typeof res.body === "object" ? res.body : { body: res.body }) }), isError };
}

// Runs one billing tool for the session. Unknown fields in the input are ignored, and the
// subscriber always comes from the session, never from the input.
export async function runBillingTool(
  api: BillingApiClient,
  session: Session,
  name: string,
  input: unknown,
): Promise<{ text: string; isError: boolean }> {
  const base = `/subscribers/${encodeURIComponent(session.subscriberNo)}/bills`;
  switch (name) {
    case "query_bill": {
      const p = Period.parse(input);
      return result(await api.call("GET", `${base}/${p.year}/${p.month}`, session.token));
    }
    case "query_bill_detailed": {
      const p = Detailed.parse(input);
      return result(await api.call("GET", `${base}/${p.year}/${p.month}/details?offset=${p.offset}&limit=${p.limit}`, session.token));
    }
    case "calculate_bill": {
      const p = Period.parse(input);
      return result(await api.call("PUT", `${base}/${p.year}/${p.month}`, session.token));
    }
    case "pay_bill": {
      const p = Pay.parse(input);
      // One transactionId per confirmed payment, kept for the client's retry: the API's
      // idempotency key, so a retried request can't pay twice.
      const body = { transactionId: `agent-${randomUUID()}`, amount: p.amount };
      try {
        return result(await api.call("POST", `${base}/${p.year}/${p.month}/payments`, session.token, body));
      } catch {
        // Both attempts got no answer: the payment may or may not have been made.
        return {
          text: "The payment result is unknown: the billing service did not answer. Do not pay again. Tell the user, and check the bill with query_bill (its paidAmount) before anything else.",
          isError: true,
        };
      }
    }
    default:
      return { text: `Unknown tool ${name}`, isError: true };
  }
}
