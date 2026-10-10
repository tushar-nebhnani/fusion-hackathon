import { AppError } from "../../errors/app-error.js";

// Field path ("suppliers.0.share") to what is wrong with it
export type FieldErrors = Record<string, string>;

// All of these go through the API's one error handler, so they come out in
// the same envelope as the climate unit's errors.

export function validationFailed(fields: FieldErrors, step = "validation"): AppError {
  return new AppError("Some fields are invalid", 422, "VALIDATION_FAILED", { fields }, step);
}

export function invalidFinancials(message: string): AppError {
  return new AppError(message, 422, "INVALID_FINANCIALS", undefined, "derive");
}

export function consentRequired(message: string): AppError {
  return new AppError(message, 403, "CONSENT_REQUIRED", undefined, "consent");
}

export function invalidStatusTransition(from: string, to: string, allowed: readonly string[]): AppError {
  return new AppError(
    `A loan cannot go from ${from} to ${to}`,
    409,
    "INVALID_STATUS_TRANSITION",
    { from, to, allowed },
  );
}

export function businessNotFound(id: string): AppError {
  return new AppError(`Business ${id} not found`, 404, "BUSINESS_NOT_FOUND");
}

export function loanNotFound(id: string): AppError {
  return new AppError(`Loan ${id} not found`, 404, "LOAN_NOT_FOUND");
}

export function snapshotNotFound(businessId: string, version: string): AppError {
  return new AppError(
    `Business ${businessId} has no snapshot version ${version}`,
    404,
    "SNAPSHOT_NOT_FOUND",
  );
}

// The bank relies on these details once it has authorised a loan
export function lockedByLoan(what: string): AppError {
  return new AppError(
    `This business has an authorised or active loan, so only a bank officer can change its ${what}`,
    403,
    "LOCKED_BY_LOAN",
  );
}

export function bankOnly(): AppError {
  return new AppError("Only a bank officer can do this", 403, "FORBIDDEN");
}

export function ownerOnly(): AppError {
  return new AppError("Only the business's owner can change its consent", 403, "FORBIDDEN");
}

// The bank needs the business's details to service a live loan
export function sharingLockedByLoan(): AppError {
  return new AppError(
    "Sharing with the bank cannot be withdrawn while a loan is authorised or active; ask the bank to close the loan first",
    409,
    "CONSENT_LOCKED_BY_LOAN",
    undefined,
    "consent",
  );
}
