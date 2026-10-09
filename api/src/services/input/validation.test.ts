import { describe, expect, it } from "vitest";
import { AppError } from "../../errors/app-error.js";
import type { FieldErrors } from "./errors.js";
import { placeFromPincode } from "./pincode.js";
import {
  contactsSchema,
  createBusinessSchema,
  financialsSchema,
  loanSchema,
  patchBusinessSchema,
  profileSchema,
  type Locations,
  type Suppliers,
} from "./schemas/index.js";
import { businessBody, financialsBody, loanBody } from "./testing/fixtures.js";
import {
  assertValid,
  checkFinancials,
  checkLocations,
  checkOperations,
  checkProfile,
  checkSuppliers,
  currentYear,
  parseBody,
  today,
} from "./validation.js";

const NOW = new Date("2026-10-09T06:00:00Z");

// The per-field errors a body is refused with
function fieldsOf(run: () => unknown): FieldErrors {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      return (error.details as { fields: FieldErrors }).fields;
    }
    throw error;
  }
  throw new Error("expected a validation error");
}

const profile = (overrides: object) => ({
  ...(businessBody().profile as object),
  ...overrides,
});

describe("parseBody", () => {
  it("accepts the full business body and fills the defaults", () => {
    const parsed = parseBody(createBusinessSchema, businessBody());

    expect(parsed.contacts.owner.language).toBe("en");
    expect(parsed.locations.additional_locations).toEqual([]);
  });

  it("reports every invalid field under its path with a 422", () => {
    const body = businessBody({
      profile: profile({ name: "A", description: "too short", sector: "banking" }),
    });

    let thrown: unknown;
    try {
      parseBody(createBusinessSchema, body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED", step: "schema_validation" });
    const fields = fieldsOf(() => parseBody(createBusinessSchema, body));
    expect(Object.keys(fields).sort()).toEqual(["profile.description", "profile.name", "profile.sector"]);
  });

  it("reports a missing body and a missing group", () => {
    expect(fieldsOf(() => parseBody(createBusinessSchema, undefined))).toHaveProperty("body");
    const { suppliers: _suppliers, ...rest } = businessBody();
    expect(fieldsOf(() => parseBody(createBusinessSchema, rest))).toHaveProperty("suppliers");
  });

  it("refuses fields the server sets itself", () => {
    const consent = { data_processing: true, share_with_bank: true, alerts: true, timestamp: "2020-01-01" };
    expect(fieldsOf(() => parseBody(createBusinessSchema, businessBody({ consent })))).toHaveProperty("consent");
    expect(
      fieldsOf(() => parseBody(financialsSchema, financialsBody({ verified_by_bank: true }))),
    ).toHaveProperty("body");
  });
});

describe("field formats", () => {
  it.each([
    ["udyam_number", "UDYAM-MH-12-0012345", true],
    ["udyam_number", "UDYAM-MH-12-12345", false],
    ["udyam_number", "udyam-mh-12-0012345", false],
    ["gstin", "27ABCDE1234F1Z5", true],
    ["gstin", "27ABCDE1234F1Z", false],
    ["gstin", "27abcde1234f1z5", false],
    ["year_started", 1950, true],
    ["year_started", 1949, false],
    ["year_started", 2015.5, false],
    ["employees", 0, true],
    ["employees", -1, false],
    ["description", "x".repeat(30), true],
    ["description", "x".repeat(29), false],
    ["description", "x".repeat(501), false],
    ["products", Array.from({ length: 10 }, () => "item"), true],
    ["products", Array.from({ length: 11 }, () => "item"), false],
    ["products", ["x".repeat(41)], false],
    ["sales_channel", "b2b", true],
    ["sales_channel", "online", false],
  ])("profile.%s = %j is valid: %s", (field, value, valid) => {
    expect(profileSchema.safeParse(profile({ [field]: value })).success).toBe(valid);
  });

  it.each([
    ["+919876543210", true],
    ["9876543210", false],
    ["+91987654321", false],
    ["+14155550123", false],
  ])("owner phone %s is valid: %s", (phone, valid) => {
    const contacts = businessBody().contacts as { owner: object };
    const result = contactsSchema.safeParse({ ...contacts, owner: { ...contacts.owner, phone } });
    expect(result.success).toBe(valid);
  });

  it("needs at least one alert channel and refuses WhatsApp", () => {
    const contacts = businessBody().contacts as object;
    const withChannels = (channels: string[]) =>
      contactsSchema.safeParse({ ...contacts, alerts: { channels } }).success;

    expect(withChannels(["sms"])).toBe(true);
    expect(withChannels([])).toBe(false);
    expect(withChannels(["whatsapp"])).toBe(false);
  });

  it.each([
    ["400014", true],
    ["40001", false],
    ["4000145", false],
    ["012345", false],
    ["4000a4", false],
  ])("pincode %s is valid: %s", (pincode, valid) => {
    const body = businessBody();
    const locations = body.locations as { primary: object };
    const result = createBusinessSchema.safeParse({
      ...body,
      locations: { primary: { ...locations.primary, pincode } },
    });
    expect(result.success).toBe(valid);
  });

  it("limits suppliers to 1-10 and additional locations to 5", () => {
    const supplier = { name: "S", lat: 19, lon: 73, share: 0.1 };
    const place = { lat: 19, lon: 73, address: "Somewhere" };
    const body = businessBody();
    const parse = (overrides: object) => createBusinessSchema.safeParse({ ...body, ...overrides }).success;

    expect(parse({ suppliers: [] })).toBe(false);
    expect(parse({ suppliers: Array.from({ length: 11 }, () => supplier) })).toBe(false);
    expect(parse({ suppliers: [{ ...supplier, share: 0 }] })).toBe(false);
    expect(parse({ suppliers: [{ ...supplier, share: 1.1 }] })).toBe(false);
    const primary = (body.locations as { primary: object }).primary;
    expect(parse({ locations: { primary, additional_locations: Array.from({ length: 5 }, () => place) } })).toBe(true);
    expect(parse({ locations: { primary, additional_locations: Array.from({ length: 6 }, () => place) } })).toBe(false);
  });

  it.each([
    [{ monthly_revenue: [1, 2, 3, 4, 5] }, false],
    [{ monthly_revenue: Array.from({ length: 12 }, () => 1) }, true],
    [{ monthly_revenue: Array.from({ length: 13 }, () => 1) }, false],
    [{ monthly_revenue: [1, 2, 3, 4, 5, -6] }, false],
    [{ monthly_revenue: [1, 2, 3, 4, 5, 6.5] }, false],
    [{ payment_delays_12m: 24 }, true],
    [{ payment_delays_12m: 25 }, false],
    [{ receivables_days: 366 }, false],
    [{ as_of: "30-09-2026" }, false],
    [{ as_of: "2026-02-30" }, false],
    [{ cash_balance: -1 }, false],
  ])("financials %j are valid: %s", (overrides, valid) => {
    expect(financialsSchema.safeParse(financialsBody(overrides)).success).toBe(valid);
  });

  it.each([
    [{ amount: 0 }, false],
    [{ emi: 0 }, false],
    [{ tenure_months: 0 }, false],
    [{ tenure_months: 361 }, false],
    [{ interest_rate: 40 }, true],
    [{ interest_rate: 40.1 }, false],
    [{ purpose: "holiday" }, false],
    [{ status: "active" }, false],
  ])("loan %j is valid: %s", (overrides, valid) => {
    expect(loanSchema.safeParse(loanBody(overrides)).success).toBe(valid);
  });

  it("needs at least one group in a patch", () => {
    expect(patchBusinessSchema.safeParse({}).success).toBe(false);
    expect(patchBusinessSchema.safeParse({ profile: { name: "New Name" } }).success).toBe(true);
    expect(patchBusinessSchema.safeParse({ consent: { alerts: false } }).success).toBe(false);
  });
});

describe("today", () => {
  it("is the date in India, not on the server", () => {
    // 19:00 UTC on 31 December is already 00:30 on 1 January in India
    const lateEvening = new Date("2026-12-31T19:00:00Z");

    expect(today(lateEvening)).toBe("2027-01-01");
    expect(currentYear(lateEvening)).toBe(2027);
    expect(today(new Date("2026-12-31T18:00:00Z"))).toBe("2026-12-31");
  });
});

describe("cross-field checks", () => {
  const supplier = (share: number, lat = 19, lon = 73) => ({ name: "S", lat, lon, share });

  it("accepts supplier shares within 0.02 of 1.0", () => {
    for (const shares of [[1], [0.5, 0.5], [0.6, 0.38], [0.6, 0.42], [0.33, 0.33, 0.34]]) {
      const errors: FieldErrors = {};
      checkSuppliers(shares.map((share) => supplier(share)), errors);
      expect(errors).toEqual({});
    }
  });

  it("refuses supplier shares that do not sum to 1.0", () => {
    const errors: FieldErrors = {};
    checkSuppliers([supplier(0.5), supplier(0.35)] as Suppliers, errors);
    expect(errors).toEqual({ suppliers: "shares sum to 0.85, must be 1.0" });

    const over: FieldErrors = {};
    checkSuppliers([supplier(0.7), supplier(0.4)] as Suppliers, over);
    expect(over.suppliers).toBe("shares sum to 1.10, must be 1.0");
  });

  it("checks coordinates with the climate unit's validator", () => {
    const errors: FieldErrors = {};
    const locations: Locations = {
      primary: { lat: 51.5, lon: -0.12, address: "London", pincode: "400014" },
      additional_locations: [
        { lat: 19.07604, lon: 72.87771, address: "Mumbai" },
        { lat: 95, lon: 72, address: "Nowhere" },
      ],
    };

    const checked = checkLocations(locations, errors);

    expect(errors).toEqual({
      "locations.primary": "Location is outside the supported coverage area (India)",
      "locations.additional_locations.1": "Latitude must be between -90 and 90",
    });
    // Valid points come back rounded the way the climate unit stores them
    expect(checked.additional_locations[0]).toMatchObject({ lat: 19.076, lon: 72.8777 });
  });

  it("catches swapped lat and lon", () => {
    const errors: FieldErrors = {};
    checkSuppliers([supplier(1, 72.8777, 19.076)] as Suppliers, errors);
    expect(errors).toHaveProperty(["suppliers.0"]);
  });

  it("ties insurance_covers to has_insurance", () => {
    const base = { power_outage_hrs_month: 0, has_insurance: false };
    const errors: FieldErrors = {};
    checkOperations({ ...base, insurance_covers: ["flood"] }, errors);
    expect(errors).toEqual({
      "operations.insurance_covers": "insurance_covers needs has_insurance to be true",
    });

    const fine: FieldErrors = {};
    checkOperations({ ...base, insurance_covers: [] }, fine);
    checkOperations({ ...base, has_insurance: true, insurance_covers: ["flood"] }, fine);
    expect(fine).toEqual({});
  });

  it("refuses repeated months", () => {
    const errors: FieldErrors = {};
    checkOperations({ power_outage_hrs_month: 0, has_insurance: false, seasonal_months: [6, 7, 6] }, errors);
    expect(errors).toHaveProperty(["operations.seasonal_months"]);
  });

  it("refuses a start year or an as_of date in the future", () => {
    const errors: FieldErrors = {};
    checkProfile({ year_started: 2027 }, NOW, errors);
    checkFinancials(parseBody(financialsSchema, financialsBody({ as_of: "2026-10-10" })), NOW, errors);
    expect(Object.keys(errors)).toEqual(["profile.year_started", "as_of"]);

    const fine: FieldErrors = {};
    checkProfile({ year_started: 2026 }, NOW, fine);
    checkFinancials(parseBody(financialsSchema, financialsBody({ as_of: "2026-10-09" })), NOW, fine);
    expect(fine).toEqual({});
  });

  it("assertValid throws only when something was found", () => {
    expect(() => assertValid({})).not.toThrow();
    expect(fieldsOf(() => assertValid({ suppliers: "bad" }))).toEqual({ suppliers: "bad" });
  });
});

describe("placeFromPincode", () => {
  it.each([
    ["400014", { city: "Mumbai", state: "Maharashtra" }],
    ["110001", { city: "Delhi", state: "Delhi" }],
    ["781001", { city: "Guwahati", state: "Assam" }],
    ["403001", { city: null, state: "Goa" }],
    ["416001", { city: null, state: "Maharashtra" }],
    ["999999", { city: null, state: null }],
    ["abc", { city: null, state: null }],
  ])("%s -> %j", (pincode, place) => {
    expect(placeFromPincode(pincode)).toEqual(place);
  });
});
