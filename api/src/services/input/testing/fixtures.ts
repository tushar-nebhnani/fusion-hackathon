import type { ClassifierLlm } from "../classifier/index.js";
import type { ClassifierOutput } from "../classifier/schema.js";
import type { ClimatePort, FinancePort } from "../triggers.js";

type Json = Record<string, unknown>;

// A valid POST /businesses body. Tests override the group they care about.
export function businessBody(overrides: Json = {}): Json {
  return {
    profile: {
      name: "Sharma Cold Drinks",
      sector: "food_beverage",
      sub_sector: "ice cream parlour",
      description: "Ground-floor ice cream and cold drinks shop for walk-in families and students.",
      products: ["ice cream", "cold drinks"],
      sales_channel: "walk_in",
      indoor_outdoor: "indoor",
      year_started: 2015,
      employees: 4,
      udyam_number: "UDYAM-MH-12-0012345",
      gstin: "27ABCDE1234F1Z5",
    },
    locations: {
      primary: {
        lat: 19.076,
        lon: 72.8777,
        address: "12 Market Road, Dadar, Mumbai",
        pincode: "400014",
        premises: "rented",
        floor: "ground",
      },
      additional_locations: [],
    },
    operations: {
      power_outage_hrs_month: 12,
      has_backup_power: true,
      water_dependency: "medium",
      has_insurance: true,
      insurance_covers: ["flood", "stock"],
      seasonal_months: [3, 4, 5],
    },
    suppliers: [
      { name: "Amul Depot", lat: 19.2, lon: 72.97, share: 0.6, critical: true },
      { name: "Pune Packaging", lat: 18.52, lon: 73.8567, share: 0.4 },
    ],
    contacts: {
      owner: { name: "Ravi Sharma", phone: "+919876543210", email: "ravi@example.com" },
      bank_officer: { name: "Meera Iyer", email: "meera@examplebank.in" },
      alerts: { channels: ["sms", "email"], quiet_hours: { start: "22:00", end: "07:00" } },
    },
    consent: { data_processing: true, share_with_bank: true, alerts: true },
    ...overrides,
  };
}

// A valid POST /businesses/:id/snapshots body: average revenue 100,000
export function financialsBody(overrides: Json = {}): Json {
  return {
    as_of: "2026-09-30",
    monthly_revenue: [80_000, 90_000, 100_000, 110_000, 120_000, 100_000],
    monthly_opex: 60_000,
    existing_emi_total: 10_000,
    outstanding_debt: 240_000,
    cash_balance: 90_000,
    payment_delays_12m: 1,
    receivables_days: 15,
    ...overrides,
  };
}

export function loanBody(overrides: Json = {}): Json {
  return {
    amount: 500_000,
    emi: 10_000,
    tenure_months: 60,
    interest_rate: 11.5,
    purpose: "equipment",
    ...overrides,
  };
}

const condition = (physical: number, demand: number) => ({
  physical,
  demand,
  mechanism: "foot_traffic" as const,
  confidence: 0.8,
  reason: "test reason",
});

// A reply that passes the output schema and every guardrail for food_beverage
export function validReply(overrides: Partial<ClassifierOutput> = {}): ClassifierOutput {
  return {
    category: "food_beverage",
    conditions: {
      river_flood: condition(0.8, -0.3),
      flash_flood: condition(0.5, -0.5),
      heat: condition(0.2, 0.7),
      drought: condition(0.1, 0),
      storm: condition(0.5, -0.4),
      cold_wave: condition(0.1, -0.4),
    },
    overall_confidence: 0.8,
    ...overrides,
  };
}

// Scripted model. It answers with `replies` in order and repeats the last
// one; `hold()` makes it wait, so a test can look at a pending profile.
export function fakeLlm(replies: unknown[] = [validReply()]) {
  const requests: { system: string; user: string }[] = [];
  const queue = [...replies];
  const state = { failing: false, gate: null as Promise<void> | null };

  const llm: ClassifierLlm = {
    model: "fake-model",
    async complete(request) {
      requests.push(request);
      if (state.gate) await state.gate;
      if (state.failing) throw new Error("model down");
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };

  function hold(): () => void {
    let release: () => void = () => undefined;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      state.gate = null;
      release();
    };
  }

  return { llm, requests, state, hold };
}

// Recording stand-ins for the climate unit and the finance service
export function fakePorts() {
  const calls: { port: string; input: unknown }[] = [];
  const state = { failing: false, hanging: false };

  const answer = (port: string, input: unknown): Promise<void> => {
    calls.push({ port, input });
    if (state.hanging) return new Promise<void>(() => undefined);
    return state.failing ? Promise.reject(new Error(`${port} down`)) : Promise.resolve();
  };
  const climate: ClimatePort = { warm: (point) => answer("climate.warm", point) };
  const finance: FinancePort = {
    firstProfile: (input) => answer("finance.firstProfile", input),
    recompute: (input) => answer("finance.recompute", input),
  };
  return { ports: { climate, finance }, calls, state };
}
