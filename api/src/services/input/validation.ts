import type { z } from "zod";
import { AppError } from "../../errors/app-error.js";
import { parseCoordinates } from "../climate/coordinates.js";
import { INPUT } from "./config.js";
import { validationFailed, type FieldErrors } from "./errors.js";
import type {
  Contacts,
  Financials,
  LoanInput,
  Locations,
  Operations,
  Profile,
  Suppliers,
} from "./schemas/index.js";

// Flow step 1: the body against its schema. Every problem is reported
// under the path of its field.
export function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
    fields[key] ??= issue.message;
  }
  throw validationFailed(fields, "schema_validation");
}

// Flow step 3: the checks below look across fields. Each adds what it
// finds to `errors`; `assertValid` then reports them all at once.
export function assertValid(errors: FieldErrors): void {
  if (Object.keys(errors).length > 0) throw validationFailed(errors, "cross_field_validation");
}

const at = (path: string, key: string | number) => (path ? `${path}.${String(key)}` : String(key));

// YYYY-MM-DD in India, whatever zone the server runs in
export function today(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INPUT.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function currentYear(now: Date): number {
  return Number(today(now).slice(0, 4));
}

// The climate unit's own validator decides what a valid point is, so the two
// services cannot disagree. It also rounds to the precision climate stores.
function checkPoint<Point extends { lat: number; lon: number }>(
  point: Point,
  path: string,
  errors: FieldErrors,
): Point {
  try {
    return { ...point, ...parseCoordinates(point.lat, point.lon) };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    errors[path] = error.message;
    return point;
  }
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

export function checkProfile(
  profile: Pick<Profile, "year_started">,
  now: Date,
  errors: FieldErrors,
  path = "profile",
): void {
  const year = currentYear(now);
  if (profile.year_started > year) {
    errors[at(path, "year_started")] = `year_started cannot be after ${String(year)}`;
  }
}

export function checkLocations(locations: Locations, errors: FieldErrors, path = "locations"): Locations {
  return {
    primary: checkPoint(locations.primary, at(path, "primary"), errors),
    additional_locations: locations.additional_locations.map((location, index) =>
      checkPoint(location, at(at(path, "additional_locations"), index), errors),
    ),
  };
}

export function checkOperations(operations: Operations, errors: FieldErrors, path = "operations"): void {
  const covers = operations.insurance_covers ?? [];
  if (!operations.has_insurance && covers.length > 0) {
    errors[at(path, "insurance_covers")] = "insurance_covers needs has_insurance to be true";
  } else if (hasDuplicates(covers)) {
    errors[at(path, "insurance_covers")] = "insurance_covers lists a cover twice";
  }
  if (hasDuplicates(operations.seasonal_months ?? [])) {
    errors[at(path, "seasonal_months")] = "seasonal_months lists a month twice";
  }
}

export function checkSuppliers(suppliers: Suppliers, errors: FieldErrors, path = "suppliers"): Suppliers {
  const checked = suppliers.map((supplier, index) => checkPoint(supplier, at(path, index), errors));
  const sum = suppliers.reduce((total, supplier) => total + supplier.share, 0);
  if (Math.abs(sum - 1) > INPUT.supplierShareTolerance + 1e-9) {
    errors[path] = `shares sum to ${sum.toFixed(2)}, must be 1.0`;
  }
  return checked;
}

export function checkContacts(contacts: Contacts, errors: FieldErrors, path = "contacts"): void {
  if (hasDuplicates(contacts.alerts.channels)) {
    errors[at(path, "alerts.channels")] = "channels lists a channel twice";
  }
}

export function checkFinancials(financials: Financials, now: Date, errors: FieldErrors): void {
  if (financials.as_of > today(now)) errors.as_of = "as_of cannot be in the future";
}

export function checkLoan(loan: LoanInput, errors: FieldErrors): void {
  if (loan.emi > loan.amount) errors.emi = "emi cannot be more than the loan amount";
}
