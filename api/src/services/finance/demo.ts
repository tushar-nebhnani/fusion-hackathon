// The sample business behind GET /finance/demo: a Chennai bakery asking
// for an equipment loan. The location is one the monitor already watches
// (data/monitor-locations.json, L1), so its climate history is usually cached.
export const DEMO = {
  label: "Chennai bakery (coastal, flood-prone)",
  lat: 13.0827,
  lon: 80.2707,
  business: {
    sector: "food_beverage",
    years_in_operation: 6,
    insurance_covers: ["flood", "stock"],
    financials: {
      monthly_revenue: [
        410_000, 395_000, 380_000, 360_000, 340_000, 355_000, 390_000, 430_000, 470_000, 520_000,
        480_000, 450_000,
      ],
      monthly_opex: 310_000,
      existing_emi_total: 28_000,
      outstanding_debt: 650_000,
      cash_balance: 240_000,
      payment_delays_12m: 1,
    },
    loan_request: { amount: 800_000, tenure_months: 48, interest_rate: 13 },
  },
} as const;
