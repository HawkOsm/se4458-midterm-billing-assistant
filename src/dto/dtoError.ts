// An error that already knows its HTTP status (like the teacher's dto/DtoValidationError.js
// and ts-api's DtoError). The error handler in app.ts turns it into { "error": message }.
import type { ZodType } from "zod";
import { z } from "./zod";

export class DtoError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DtoError";
  }
}

export const ErrorDto = z
  .object({ error: z.string().openapi({ example: "No bill for 5551234 in 2025-04" }) })
  .openapi("Error");

// Validate untrusted input with a zod schema, or throw a 400 naming the first bad field.
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".") || "request";
  throw new DtoError(`${field}: ${issue?.message ?? "invalid value"}`, 400);
}
