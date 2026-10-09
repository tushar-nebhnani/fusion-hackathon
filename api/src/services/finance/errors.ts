import { z } from "zod";
import { AppError } from "../../errors/app-error.js";

// All of these go through the API's one error handler, so they come out in
// the same envelope as the climate unit's errors.

export function noFinancials(businessId: string): AppError {
  return new AppError(
    `Business ${businessId} has no financial snapshot yet; submit one before asking for a finance profile`,
    409,
    "NO_FINANCIALS",
    undefined,
    "load_business",
  );
}

export function invalidOutput(issues: unknown): AppError {
  return new AppError(
    "The finance profile failed output validation",
    500,
    "INVALID_OUTPUT",
    issues,
    "output_validation",
  );
}

// Parses a request body or tool argument; a failure is a 422 naming each field
export function parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fields[issue.path.join(".") || "body"] ??= issue.message;
  }
  throw new AppError("Some fields are invalid", 422, "VALIDATION_FAILED", { fields }, "input_validation");
}
