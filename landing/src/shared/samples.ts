// @ts-nocheck -- copied from web/sample-data.js, which is plain JavaScript.
// Keep the two in step: change the console's file, then copy it here again.

// [pattern, answer or (body, path) => answer, note]
export type Sample = [RegExp, unknown, string?];

// Synthetic answers for the console's sample mode, loaded before app.js.
//
// One made-up business, Sri Lakshmi Bakery in Chennai, is followed through
// every step. Writes are not sent anywhere: they move a small state kept in
// this page (loan status, advisor state, alert outbox, repayment proposal), so
// each step answers with what the step before it left behind. A reload starts
// again. Nothing here is computed by the API, and app.js labels every answer.
//
// SAMPLES is a list of [pattern, answer, note]. An answer is the body, or a
// function of (body, path) that returns it; refuse() makes it an error.

export const { SAMPLES, HAND } = ((): { SAMPLES: Sample[]; HAND: string } => {
  const HAND = "Synthetic: made up for this walk-through from the documented response shape, not computed by the API. Most values typed into the form do not change it.";

  const BIZ = "demo-sri-lakshmi-bakery", LOAN = "demo-loan-0001", NAME = "Sri Lakshmi Bakery";
  const CELL = "0.1:13.1:80.3";
  const OFFICER = "priya.raman@example-bank.in";
  const PROPOSAL = "7d3f2a10-5c1e-4b7a-9e44-2b6f0c8d1a35";
  const CONVERSATION = {
    preLoan: "3b1c9e52-0a4d-4f6b-8c21-5e7d9a0b1c01",
    alert: "3b1c9e52-0a4d-4f6b-8c21-5e7d9a0b1c02",
    recovery: "3b1c9e52-0a4d-4f6b-8c21-5e7d9a0b1c03",
  };
  const HAZARDS = ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"];
  const HAZARD_LABEL = { river_flood: "River flood", flash_flood: "Flash flood", heat: "Heat", drought: "Drought", storm: "Storm", cold_wave: "Cold wave" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const r = (value, digits = 2) => +value.toFixed(digits);
  const rupees = (value) => `₹${Math.round(value).toLocaleString("en-IN")}`;
  const HOUR = 3_600_000, DAY = 24 * HOUR, IST = 330 * 60_000;
  const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
  const ist = (ms = 0) => `${new Date(Date.now() + ms + IST).toISOString().slice(0, 19)}+05:30`;
  const day = (n = 0) => ist(n * DAY).slice(0, 10);
  // "Nov 2026": the month n months after this one
  const monthAt = (n) => {
    const date = new Date(Date.now() + IST);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + n);
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  };

  const refuse = (sampleStatus, code, message, sampleNote) => ({ sampleStatus, sampleNote, error: { code, message } });

  // ── What the walk-through has done so far ──────────────────────────────────
  // The page opens with the application already made, so any button answers.
  // "Create business" starts again from an empty application.

  const applied = () => ({
    snapshots: 1, verified: false, loan: "applied", overridden: false,
    advisor: "PRE_LOAN", history: [], alertId: null, damage: null, proposal: null,
    outbox: [], turns: [], profiles: [], evaluations: [], seeded: false,
  });
  let demo = applied();

  const MODE = { ALERT: "alert", IMPACTED: "recovery", RECOVERY: "recovery" };
  const modeNow = () => MODE[demo.advisor] ?? "preLoan";

  function move(event, to, reason) {
    demo.history.push({ from: demo.advisor, to, event, reason, at: iso() });
    demo.advisor = to;
  }
  const notAllowed = (event, hint) =>
    refuse(409, "CONFLICT", `Loan ${LOAN} is ${demo.advisor}; "${event}" is not allowed`, hint);

  // ── Step 02 and 05: the business, its financials and its loan ──────────────

  const RAW = {
    monthly_revenue: [410000, 395000, 420000, 450000, 470000, 430000, 405000, 415000],
    monthly_opex: 310000, existing_emi_total: 28000, outstanding_debt: 650000, cash_balance: 240000,
    payment_delays_12m: 1, receivables_days: 20,
  };
  const AVG = 424375, NET = AVG - RAW.monthly_opex;
  const DERIVED = { avg_revenue: AVG, revenue_volatility: 0.0548, operating_margin: 0.2695, dscr: 4.0848, debt_to_revenue: 0.1276, cash_buffer_days: 23.2, years_in_operation: 11, num_locations: 1 };
  const NEW_LOAN = { amount: 800000, emi: 21500, tenure_months: 48, interest_rate: 13, purpose: "equipment" };

  const snapshot = (version = demo.snapshots) => ({
    version, as_of: "2026-09-30", verified_by_bank: demo.verified && version === demo.snapshots,
    derivation_version: "derive-1", raw: RAW, derived: DERIVED,
  });
  const loan = () => ({ id: LOAN, business_id: BIZ, ...NEW_LOAN, status: demo.loan });
  const scoring = () => (demo.snapshots ? "pending" : "skipped: no financial snapshot yet");

  // ── Step 03: how weather moves this business ───────────────────────────────

  const CONDITIONS = {
    river_flood: { physical: 0.8, demand: -0.3, mechanism: "operational_downtime", confidence: 0.7, reason: "Ground-floor premises; ovens and stock sit at street level", source: "llm" },
    flash_flood: { physical: 0.5, demand: -0.5, mechanism: "foot_traffic", confidence: 0.8, reason: "Walk-in shop; waterlogged roads keep customers and delivery riders away", source: "llm" },
    heat: { physical: 0.2, demand: 0.1, mechanism: "demand_mix", confidence: 0.6, reason: "Ovens run hotter and cream spoils faster; cold items sell a little more", source: "llm" },
    drought: { physical: 0.1, demand: 0, mechanism: "none", confidence: 0.3, reason: "Sector default for food_beverage", source: "sector_default" },
    storm: { physical: 0.5, demand: -0.4, mechanism: "foot_traffic", confidence: 0.7, reason: "Cyclone warnings shut the market and cut power to the ovens", source: "llm" },
    cold_wave: { physical: 0, demand: 0.1, mechanism: "demand_timing", confidence: 0.5, reason: "Warm baked goods sell slightly more", source: "llm" },
  };
  const CHANNELS = { river_flood: ["operations", "inventory"], flash_flood: ["revenue", "operations"], heat: ["revenue"], drought: [], storm: ["revenue", "operations"], cold_wave: ["revenue"] };

  function conditions() {
    if (!demo.overridden) return CONDITIONS;
    return { ...CONDITIONS, river_flood: { ...CONDITIONS.river_flood, physical: 0.1, source: "override" } };
  }

  const impact = () => ({
    business_id: BIZ, version: demo.overridden ? 2 : 1, status: demo.overridden ? "overridden" : "ok",
    category: "food_beverage", overall_confidence: 0.8, conditions: conditions(),
    model: "synthetic", prompt_version: "classifier-synthetic", note: null,
    overridden_by: demo.overridden ? OFFICER : null,
    override_reason: demo.overridden ? "Shop is on a raised plinth" : null,
  });

  const business = () => ({
    id: BIZ, source: "user",
    profile: { name: NAME, sector: "food_beverage", sub_sector: "bakery", year_started: 2015, description: "Neighbourhood bakery selling bread, cakes and snacks to walk-in customers from a ground-floor shop, with some delivery orders.", products: ["bread", "cakes", "snacks"], sales_channel: "both", indoor_outdoor: "indoor", employees: 6 },
    locations: { primary: { lat: 13.0827, lon: 80.2707, address: "12 NSC Bose Road, George Town, Chennai", pincode: "600001", premises: "rented", floor: "ground" }, additional_locations: [] },
    operations: { power_outage_hrs_month: 12, has_backup_power: false, water_dependency: "medium", has_insurance: true, insurance_covers: ["flood", "stock"], seasonal_months: [10, 11, 12] },
    suppliers: [{ name: "Annai Flour Mills", lat: 13.05, lon: 80.21, share: 0.6, critical: false }, { name: "Madurai Dairy Co-op", lat: 9.9252, lon: 78.1198, share: 0.4, critical: false }],
    consent: { data_processing: true, share_with_bank: true, alerts: true, version: "consent-1" },
    latest_snapshot: demo.snapshots ? snapshot() : null,
    loans: demo.loan ? [loan()] : [],
    impact_profile: impact(),
    scoring: scoring(),
  });

  // ── Step 04: climate risk at the shop's cell ───────────────────────────────

  // Hazard scores, which the stress test below uses as its severities
  const SEVERITY = { river_flood: 0.36, flash_flood: 0.71, heat: 0.31, drought: 0.12, storm: 0.58, cold_wave: 0 };
  const CLIMATE_NOTE = "Synthetic profile for the bakery's cell in Chennai, with one event in the forecast so that the monitor has something to act on. Other coordinates show the same answer.";

  const climate = () => ({
    location: { lat: 13.0827, lon: 80.2707, cells: { historical: CELL, climate: CELL, flood: "0.05:13.1:80.25", forecast: CELL } },
    overall_climate_risk: 0.56, grade: "D", confidence: "med",
    hazards: [
      { hazard: "river_flood", relevance: "secondary", relevance_method: "static", score: 0.36, components: { structural: 1, historical: 0.11, forecast: 0.18 }, reason: "99th-percentile river discharge of 61 m³/s" },
      { hazard: "flash_flood", relevance: "primary", relevance_method: "static", score: 0.71, components: { structural: 1, historical: 0.64, forecast: 0.62 }, reason: "Rain of 50 mm or more on 7.4 days per year" },
      { hazard: "heat", relevance: "secondary", relevance_method: "static", score: 0.31, components: { historical: 0.38, forecast: 0.04 }, reason: "Max temperature above 40°C on 6.2 days per year" },
      { hazard: "drought", relevance: "dormant", relevance_method: "static", score: 0.12, components: { historical: 0.15, forecast: 0 }, reason: "Weak monsoon (below 75% of normal) in about 1 in 9 years" },
      { hazard: "storm", relevance: "primary", relevance_method: "static", score: 0.58, components: { historical: 0.61, forecast: 0.47 }, reason: "Gusts above 60 km/h on 4.3 days per year" },
      { hazard: "cold_wave", relevance: "dormant", relevance_method: "static", score: 0, components: { historical: 0, forecast: 0 }, reason: "Min temperature below 4°C on 0.0 days per year" },
    ],
    active_events: [{ hazard: "flash_flood", severity: "warning", window_start: day(2), window_end: day(4), confidence: 0.74 }],
    data_freshness: { forecast_issued_at: ist(-2 * HOUR), history_until: day(-6) },
    cache: "complete_hit",
    warnings: ["flood_exposure_unavailable: World Bank exposure raster is not loaded"],
  });

  function events() {
    const { location, active_events, data_freshness, cache, warnings } = climate();
    return { location, active_events, data_freshness, cache, warnings };
  }

  const cellStore = () => ({
    cell: { id: CELL, gridSize: 0.1, lat: 13.1, lon: 80.3, createdAt: iso(-9 * DAY), lastRequestedAt: iso(-2 * HOUR) },
    relevance: climate().hazards.map((z) => ({ cellId: CELL, hazard: z.hazard, relevance: z.relevance, method: z.relevance_method, reason: z.reason, updatedAt: iso(-9 * DAY) })),
    responses: [
      { id: 41, api: "archive", variablesRequested: ["precipitation_sum", "temperature_2m_max", "temperature_2m_min", "wind_gusts_10m_max"], fetchedAt: iso(-9 * DAY), staleAfter: iso(21 * DAY), status: "ok" },
      { id: 42, api: "climate", variablesRequested: ["precipitation_sum", "temperature_2m_max"], fetchedAt: iso(-9 * DAY), staleAfter: iso(81 * DAY), status: "ok" },
      { id: 44, api: "flood", variablesRequested: ["river_discharge"], fetchedAt: iso(-20 * HOUR), staleAfter: iso(4 * HOUR), status: "ok" },
      { id: 47, api: "forecast", variablesRequested: ["precipitation_sum", "temperature_2m_max", "wind_gusts_10m_max"], fetchedAt: iso(-2 * HOUR), staleAfter: iso(4 * HOUR), status: "ok" },
    ],
    events: [{ id: 12, cellId: CELL, hazard: "flash_flood", severity: "warning", status: "open", windowStart: day(2), windowEnd: day(4), confidence: 0.74, openedAt: iso(-2 * HOUR) }],
    metricCount: 10957,
  });

  // ── Step 06: the finance profile ───────────────────────────────────────────
  // Small enough to work out here, so that recording the loan and overriding
  // the weather profile visibly change the score. The API's own formulas are
  // in api/src/services/finance; these only imitate them.

  function money() {
    const proposed = demo.loan && demo.loan !== "rejected" && demo.loan !== "closed" ? NEW_LOAN.emi : 0;
    const emi = RAW.existing_emi_total + proposed;
    const debt = RAW.outstanding_debt + (proposed ? NEW_LOAN.amount : 0);
    return { proposed, emi, dscr: r(NET / emi), surplus: NET - emi, leverage: r(debt / (AVG * 12), 4), buffer: r(RAW.cash_balance / (RAW.monthly_opex + emi)) };
  }

  const bandOf = (score) => (score >= 70 ? "low_risk" : score >= 50 ? "moderate" : score >= 30 ? "high" : "critical");

  function baseline() {
    const m = money();
    const sub = {
      dscr: m.dscr >= 2 ? 100 : m.dscr >= 1.5 ? 85 : 70,
      runway: m.buffer >= 3 ? 100 : m.buffer >= 1 ? 85 : 70,
      leverage: m.leverage <= 0.1 ? 100 : m.leverage <= 0.25 ? 85 : 65,
      volatility: 100, repayment: 75, business_age: 100,
    };
    const score = Math.round(0.3 * sub.dscr + 0.2 * sub.runway + 0.15 * sub.leverage + 0.1 * sub.volatility + 0.15 * sub.repayment + 0.1 * sub.business_age);
    return { score, band: bandOf(score), sub_scores: sub, source: "rules" };
  }

  // Revenue lost at severity 1: [before insurance, after insurance, covers that paid]
  const LOSS = {
    river_flood: [0.39, 0.28, ["flood", "stock"]], flash_flood: [0.34, 0.255, ["flood", "stock"]], storm: [0.29, 0.22, ["stock"]],
    heat: [0.06, 0.06, []], drought: [0, 0, []], cold_wave: [0, 0, []],
  };

  function stressRow(hazard, severity, months = 2) {
    const m = money();
    const [gross, net, covers] = LOSS[hazard];
    // The override in step 03 says the shop floor stays dry in a river flood
    const share = hazard === "river_flood" && demo.overridden ? 0.125 : 1;
    const shock = r(net * share * severity * 100, 1), before = r(gross * share * severity * 100, 1);
    const revenue = Math.round(AVG * (1 - shock / 100));
    const cashflow = revenue - RAW.monthly_opex, surplus = cashflow - m.emi, dscr = r(cashflow / m.emi);
    return {
      severity, direction: shock >= 2 ? "unfavourable" : "neutral", shock_pct: shock ? -shock : 0, gross_shock_pct: before ? -before : 0,
      insurance_applied: shock ? covers : [], duration_months: months,
      stressed_metrics: { monthly_revenue: revenue, net_monthly_cashflow: cashflow, dscr, surplus_after_debt: surplus, cash_runway: surplus < 0 ? "burning" : "positive_cashflow", cash_runway_months: surplus < 0 ? r(RAW.cash_balance / -surplus, 1) : null, cash_after_shock: RAW.cash_balance + surplus * months },
      breach: dscr < 1, breach_reasons: dscr < 1 ? ["dscr_below_1"] : [],
    };
  }

  // The worst hazard counts in full, each next one at half the one before
  function adjust(base, stress) {
    const m = money();
    const hit = Object.entries(stress).filter(([, row]) => row.direction === "unfavourable").sort((a, b) => a[1].shock_pct - b[1].shock_pct);
    const drivers = hit.map(([hazard, row], i) => ({
      hazard, points_change: -r(-row.shock_pct * 0.62 * 0.5 ** i, 1),
      reason: `${HAZARD_LABEL[hazard]} stress (severity ${row.severity}, revenue down ${-row.shock_pct}%${row.insurance_applied.length ? ` after ${row.insurance_applied.join(" and ")} insurance` : ""}) drops DSCR from ${m.dscr} to ${row.stressed_metrics.dscr}`,
    }));
    const score = Math.max(0, Math.round(base.score + drivers.reduce((sum, d) => sum + d.points_change, 0)));
    return { score, band: bandOf(score), drivers };
  }

  function sensitivity(source = demo.overridden ? "override" : "llm") {
    return { source, hazards: Object.fromEntries(Object.entries(conditions()).map(([hazard, c]) => {
      const magnitude = Math.max(c.physical, Math.abs(c.demand));
      return [hazard, { direction: magnitude < 0.15 ? "neutral" : c.demand > c.physical ? "favourable" : "unfavourable", magnitude, channels: magnitude < 0.15 ? [] : CHANNELS[hazard], reason: c.reason, physical: c.physical, demand: c.demand }];
    })) };
  }

  function assessment() {
    const m = money(), base = baseline();
    const stress = Object.fromEntries(HAZARDS.map((hazard) => [hazard, stressRow(hazard, SEVERITY[hazard])]));
    const adjusted = adjust(base, stress);
    const worst = adjusted.drivers[0];
    return {
      baseline: base,
      metrics: {
        months_of_history: RAW.monthly_revenue.length, avg_monthly_revenue: AVG, avg_monthly_expenses: RAW.monthly_opex, net_monthly_cashflow: NET,
        existing_emi: RAW.existing_emi_total, proposed_emi: m.proposed, total_emi: m.emi, dscr: m.dscr, surplus_after_debt: m.surplus,
        cash_reserves: RAW.cash_balance, cash_runway: "positive_cashflow", cash_runway_months: null, cash_buffer_months: m.buffer,
        revenue_volatility: DERIVED.revenue_volatility, seasonality_index: 1.11, leverage: m.leverage,
        repayment_record: { missed_payments_12m: 1, rating: "minor" }, years_in_operation: 11,
      },
      climate: { profile_ref: `${CELL}@${ist(-2 * HOUR)}`, cell_id: CELL, fetched_at: ist(-2 * HOUR), overall_climate_risk: 0.56, grade: "D", confidence: "med" },
      sensitivity: sensitivity(), stress, adjusted,
      summary: `Baseline ${base.score} (${base.band}); climate-adjusted ${adjusted.score} (${adjusted.band}).${worst ? ` Biggest driver: ${HAZARD_LABEL[worst.hazard]} stress.` : ""}`,
    };
  }

  const financeWarnings = () => [
    ...(demo.verified ? [] : ["snapshot_unverified: the bank has not verified the financials"]),
    "short_revenue_history: fewer than 12 months of revenue",
  ];
  const noFinancials = () => refuse(409, "NO_FINANCIALS", `Business ${BIZ} has no financial snapshot yet; submit one before asking for a finance profile`);

  function storeProfile(trigger, a = assessment()) {
    demo.profiles.unshift({ id: demo.profiles.length + 1, created_at: iso(), trigger, snapshot_version: demo.snapshots, baseline_score: a.baseline.score, adjusted_score: a.adjusted.score, scorer_source: "rules", model_version: "finance-1" });
    return demo.profiles[0].id;
  }

  function financeProfile() {
    if (!demo.snapshots) return noFinancials();
    const a = assessment();
    storeProfile("request", a);
    return {
      business_id: BIZ, generated_at: ist(), model_version: "finance-1",
      inputs: { snapshot_version: demo.snapshots, snapshot_as_of: "2026-09-30", snapshot_verified: demo.verified, proposed_loan_ids: money().proposed ? [LOAN] : [], impact_profile_version: demo.overridden ? 2 : 1 },
      ...a, warnings: financeWarnings(),
    };
  }

  function scenario(body) {
    if (!demo.snapshots) return noFinancials();
    const hazard = HAZARDS.includes(body.hazard) ? body.hazard : "river_flood";
    const severity = Math.max(0, Math.min(1, Number(body.severity) || 0)), months = Number(body.duration_months) || 2;
    const base = baseline(), stress = stressRow(hazard, severity, months);
    const adjusted = adjust(base, { [hazard]: stress });
    const effect = adjusted.drivers[0]?.reason ?? `${HAZARD_LABEL[hazard]} at severity ${severity} has no material effect on this business's revenue`;
    return {
      business_id: BIZ, generated_at: ist(), scenario: { hazard, severity, duration_months: months },
      baseline: base, sensitivity: sensitivity().hazards[hazard], stress, adjusted,
      summary: `${effect}, over ${months} months. Score ${base.score} (${base.band}) becomes ${adjusted.score} (${adjusted.band}).${stress.breach ? ` Breaches: ${stress.breach_reasons.join(", ")}.` : " No threshold is breached."}`,
      warnings: financeWarnings(),
    };
  }

  function repaymentCapacity(body) {
    if (!demo.snapshots) return noFinancials();
    const m = money();
    const drop = Math.max(0, Math.min(100, Number(body.revenue_drop_pct) || 0)), months = Number(body.months) || 1;
    const revenue = AVG * (1 - drop / 100), cashflow = revenue - RAW.monthly_opex;
    const maxEmi = Math.max(0, Math.floor(cashflow / 1.25));
    const shortfall = Math.max(0, r(m.emi - cashflow)), total = r(shortfall * months);
    const uncovered = Math.max(0, r(total - RAW.cash_balance)), cover = shortfall > 0 ? r(RAW.cash_balance / shortfall, 1) : null;
    const outcome = shortfall === 0
      ? `the business still meets its EMIs of ${rupees(m.emi)}`
      : `it falls ${rupees(shortfall)} short each month (${rupees(total)} in all); reserves cover ${cover} months, leaving ${rupees(uncovered)} uncovered`;
    return {
      business_id: BIZ, generated_at: ist(), scenario: { revenue_drop_pct: drop, months },
      stressed: { monthly_revenue: r(revenue), net_monthly_cashflow: r(cashflow), dscr: r(cashflow / m.emi) },
      current_total_emi: m.emi, target_dscr: 1.25, max_affordable_emi: maxEmi, shortfall_per_month: shortfall, total_shortfall: total,
      cash_reserves: RAW.cash_balance, reserves_cover_months: cover, uncovered_after_reserves: uncovered,
      summary: `With revenue down ${drop}% for ${months} months, ${outcome}. The largest EMI it can carry at a DSCR of 1.25 is ${rupees(maxEmi)}.`,
      warnings: financeWarnings(),
    };
  }

  // An unsaved business is scored on its sector's defaults
  function evaluateLocation(body) {
    const a = assessment();
    return {
      location: { lat: Number(body.lat) || 13.0827, lon: Number(body.lon) || 80.2707 }, generated_at: ist(), model_version: "finance-1",
      loan_request: { amount: 800000, tenure_months: 48, interest_rate: 13, emi: 21462 },
      ...a, sensitivity: sensitivity("fallback"),
      warnings: ["sensitivity_sector_defaults: an unsaved business is scored on its sector's defaults"],
    };
  }

  function evaluation() {
    if (!demo.snapshots) return noFinancials();
    const a = assessment(), m = money();
    const breached = HAZARDS.filter((hazard) => a.stress[hazard].breach);
    const pass = (id, detail) => ({ id, status: "pass", detail });
    const id = demo.evaluations.length + 1, profileId = storeProfile("evaluation", a);
    const result = {
      evaluation_id: id, business_id: BIZ, generated_at: ist(), evaluator_version: "evaluator-1",
      rating: breached.length ? "caution" : "acceptable", reliable: true,
      reasons: [
        `Climate grade D (risk 0.56) at cell ${CELL}`,
        `Finance score ${a.baseline.score} (${a.baseline.band}) becomes ${a.adjusted.score} (${a.adjusted.band}) after climate stress`,
        breached.length ? `Stress test breaches DSCR 1 under: ${breached.join(", ")}` : "No hazard breaches a threshold in the stress test",
        ...(demo.verified ? [] : ["The bank has not verified the financial snapshot"]),
      ],
      checks: [
        pass("climate_available", "Climate profile returned"),
        pass("climate_schema", "Climate profile matches its schema"),
        { id: "climate_confidence", status: "warn", detail: "Climate confidence is med" },
        pass("forecast_fresh", "Forecast issued 2 hours ago"),
        pass("finance_available", "Finance profile computed"),
        pass("finance_schema", "Finance profile matches its schema"),
        pass("finance_current", `Computed from snapshot v${demo.snapshots}, the latest`),
        demo.verified ? pass("snapshot_verified", "Snapshot verified by the bank") : { id: "snapshot_verified", status: "warn", detail: "Snapshot is not verified by the bank" },
        pass("same_location", "Both answers are for the business's primary location"),
        pass("same_climate_run", "Finance used the same forecast run"),
        pass("stress_coverage", "All 6 hazards were stress-tested"),
        pass("adjustment_cap", "Adjusted score is within the uplift cap above the baseline"),
      ],
      climate: climate(),
      finance: {
        profile_id: profileId, generated_at: ist(), origin: "computed", snapshot_version: demo.snapshots,
        baseline_score: a.baseline.score, baseline_band: a.baseline.band, adjusted_score: a.adjusted.score, adjusted_band: a.adjusted.band,
        dscr: m.dscr, cash_runway_months: null, breached_hazards: breached, drivers: a.adjusted.drivers, summary: a.summary,
      },
    };
    demo.evaluations.unshift({ evaluation_id: id, created_at: iso(), evaluator_version: "evaluator-1", rating: result.rating, reliable: true, finance_profile_id: profileId, climate_ref: a.climate.profile_ref });
    return result;
  }

  // ── Step 07: authorising, and the alert outbox ─────────────────────────────

  function queue(row, delivery) {
    demo.outbox.unshift({
      id: demo.outbox.length + 1, business_id: BIZ, business_name: NAME, channel: "email", attempts: delivery ? 1 : 0, note: null,
      created_at: ist(), ...row,
      deliveries: delivery ? [{ provider: "dry_run", result: "sent", error: null, sent_at: ist(4000), ...delivery }] : [],
    });
  }

  // What the monitor and the alert worker would have left once the cell is watched
  function monitorAlert() {
    const window = { hazard: "flash_flood", severity: "WARNING", window_start: day(2), window_end: day(4), evidence: `Forecast rain of 118 mm in 24 hours on ${day(2)} for cell ${CELL}; the flash flood event is at warning level with confidence 0.74` };
    queue({ ...window, audience: "bank", status: "sent" }, {
      subject: `[Kshetra] ${NAME}: flash flood WARNING`,
      body: `${NAME} (${BIZ}), loan ${LOAN}\nFlash flood WARNING: ${day(2)} to ${day(4)}\n\n${window.evidence}.\n\nThe owner has been sent preventive steps. No action is needed from the bank unless damage is reported.`,
    });
    queue({ ...window, audience: "owner", status: "sent" }, {
      subject: `Heavy rain warning for ${NAME}: ${day(2)} to ${day(4)}`,
      body: `Dear Lakshmi Narayanan,\n\nHeavy rain is forecast for your area from ${day(2)} to ${day(4)}.\n\nBefore it starts:\n1. Move flour, sugar and packed stock off the floor onto raised shelves.\n2. Switch off and raise the mixer and the display fridge before you close.\n3. Keep your insurance policy number and photos of your stock ready.\n\nOpen the chat to ask what else you can do.`,
    });
  }

  function setStatus(body) {
    if (!demo.loan) return refuse(404, "NOT_FOUND", `Loan ${LOAN} not found`, "Record the loan in step 06 first.");
    const from = demo.loan, to = body.status ?? "authorised";
    demo.loan = to;
    let sampleNote;
    if (to === "authorised" && from !== "authorised") {
      storeProfile("loan_authorised");
      if (!demo.outbox.length) monitorAlert();
      sampleNote = "Synthetic. Authorising stored a finance profile and put the cell on the watch list; the outbox below now holds the monitor's alert. The advisor still sees the loan as PRE_LOAN until it is disbursed (set it to active here, or press Disburse in step 08).";
    }
    if (to === "active" && demo.advisor === "PRE_LOAN") move("disbursed", "ACTIVE", "loan marked active");
    return { loan: loan(), scoring: "pending", sampleNote };
  }

  function alerts(_body, path) {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const status = query.get("status");
    return { alerts: demo.outbox.filter((a) => !status || a.status === status).slice(0, Number(query.get("limit")) || 50) };
  }

  // ── Step 08: the advisor ───────────────────────────────────────────────────

  const calls = (...tools) => tools.map((tool, i) => ({ callId: `c${i + 1}`, tool, ok: true }));

  function turn(mode, input, { reply, structured = null, toolCalls = [], proposal }, body = {}) {
    const result = {
      conversationId: CONVERSATION[mode], mode, loanId: body.loanId ?? LOAN, loanState: demo.advisor, reply, structured,
      citations: toolCalls.map((c) => c.callId), warnings: [], toolCalls, ...(proposal ? { proposal } : {}),
    };
    demo.turns.push({ mode, input, result, at: iso() });
    return result;
  }

  function preLoanAdvice() {
    const a = assessment(), m = money(), flash = a.stress.flash_flood, storm = a.stress.storm;
    if (demo.advisor !== "PRE_LOAN") {
      return {
        reply: `Your loan ${LOAN} is active and no alert is open for your area right now. In a normal month the bakery keeps ${rupees(m.surplus)} after all EMIs (DSCR ${m.dscr}). The forecast for your cell shows a flash flood event at warning level from ${day(2)}; if the bank raises an alert I will send you steps to take before it starts. If the shop is damaged, submit a damage report and I will work out repayment options.`,
        structured: { questions: [], assessment: null, citations: ["c1"] }, toolCalls: calls("getEvaluation"),
      };
    }
    const summary = `Baseline score ${a.baseline.score} (${a.baseline.band}); ${a.adjusted.score} (${a.adjusted.band}) after climate stress. DSCR is ${m.dscr} in a normal month and ${flash.stressed_metrics.dscr} under a flash flood.`;
    return {
      reply: `The ${rupees(NEW_LOAN.amount)} equipment loan is workable for ${NAME}, with conditions. In a normal month the bakery keeps ${rupees(m.surplus)} after all EMIs (DSCR ${m.dscr}). The main risk is flash flooding in the northeast monsoon: a spell at severity ${flash.severity} cuts revenue by ${-flash.shock_pct}% even after insurance, and DSCR falls to ${flash.stressed_metrics.dscr}${flash.breach ? ", below what the EMIs need" : ""}. A storm takes DSCR to ${storm.stressed_metrics.dscr}, which still holds. I would ask the bank for a repayment holiday clause for flood months, and build the cash balance of ${rupees(RAW.cash_balance)} before October.`,
      structured: {
        questions: [],
        assessment: {
          verdict: "viable_with_conditions", summary,
          risks: [
            { hazard: "flash_flood", months: ["Oct", "Nov", "Dec"], impact: `Revenue down ${-flash.shock_pct}% for 2 months; DSCR ${flash.stressed_metrics.dscr}${flash.breach ? ", a breach" : ""}`, citations: ["c2"] },
            { hazard: "storm", months: ["Nov", "Dec"], impact: `Revenue down ${-storm.shock_pct}% for 2 months; DSCR ${storm.stressed_metrics.dscr}, which holds`, citations: ["c3"] },
          ],
          loanStructureSuggestions: ["Agree a moratorium clause for a verified flood event", "Schedule the first EMI after the northeast monsoon", "Keep flood and stock insurance in force for the life of the loan"],
          bankSummary: `${NAME} (${BIZ}): viable with conditions. ${summary}`,
        },
        citations: ["c1", "c2", "c3", "c4"],
      },
      toolCalls: calls("getEvaluation", "simulateScenario", "simulateScenario", "getHazardSeasons"),
    };
  }

  function alertAdvice(event) {
    const flash = assessment().stress.flash_flood, by = event?.windowStart ?? iso(18 * HOUR);
    const why = `A flash flood at severity ${flash.severity} is modelled to cut revenue by ${-flash.shock_pct}% and take DSCR to ${flash.stressed_metrics.dscr}`;
    const actions = [
      { rank: 1, action: "Move flour, sugar and packed stock off the floor onto raised shelves.", deadline: by, why: `The shop is on the ground floor and stock is the first loss. ${why}.`, citations: ["c1", "c3"] },
      { rank: 2, action: "Switch off and raise the mixer and the display fridge before you close.", deadline: by, why: "Equipment damage is not covered by your flood and stock insurance.", citations: ["c2"] },
      { rank: 3, action: "Bake and deliver confirmed orders early, and pause new perishable purchases.", deadline: by, why: "Walk-in customers and delivery riders stay away while roads are waterlogged.", citations: ["c2"] },
      { rank: 4, action: "Photograph stock and equipment, and keep your insurance policy number at hand.", deadline: by, why: "A claim for flood and stock needs proof of what was in the shop.", citations: ["c2"] },
    ];
    const bankSummary = `${NAME} (${LOAN}): the owner has ${actions.length} preventive steps. ${why}.`;
    return {
      reply: `Heavy rain is expected at your shop. Do these in order before it starts:\n${actions.map((a) => `${a.rank}. ${a.action}`).join("\n")}\n\nIf water does get in, tell me what was lost and I will work out repayment options with you.`,
      actions, bankSummary, structured: { actions, bankSummary, citations: ["c1", "c2", "c3"] },
      toolCalls: calls("getAlertContext", "getWeatherImpact", "simulateScenario"),
    };
  }

  // The month after the damage: normal takings less the restocking and repairs
  const cashflowAfter = (d) => NET - (d.stockLossInr ?? 0) - (d.equipmentDamageInr ?? 0);

  function repaymentOptions() {
    const d = demo.damage ?? {}, claim = d.insuranceClaim?.expectedAmountInr ?? 0;
    const cashflow = cashflowAfter(d), start = monthAt(1);
    const option = (kind, title, terms, o) => {
      const due = RAW.existing_emi_total + o.reliefEmi;
      return { kind, title, terms, prepayment: 0, ...o, totalInterest: o.totalPaid - NEW_LOAN.amount, extraCostVsOriginal: o.totalPaid - 1032000, minMonthlyDSCR: r(cashflow / due), minMonthlyDSCRMonth: start, cashShortfall: Math.max(0, due - cashflow) };
    };
    return [
      option("moratorium", "3-month moratorium", "No EMI for 3 months; the interest is added to the loan, then 48 EMIs", { reliefMonths: 3, reliefEmi: 0, newEmi: 22168, months: 51, endMonth: monthAt(51), totalPaid: 1064064 }),
      option("tenure_extension", "Extend by 12 months", "A lower EMI over 60 months instead of 48", { reliefMonths: 0, reliefEmi: 18203, newEmi: 18203, months: 60, endMonth: monthAt(60), totalPaid: 1092180 }),
      option("step_down_up", "Half EMI for 3 months", "Half the EMI for 3 months, then a higher EMI to finish on time", { reliefMonths: 3, reliefEmi: 10750, newEmi: 22378, months: 48, endMonth: monthAt(48), totalPaid: 1039260 }),
      option("insurance_bridge", "Bridge to the insurance payout", `No EMI for 2 months; half of the ${rupees(claim)} payout then goes to the loan`, { reliefMonths: 2, reliefEmi: 0, newEmi: 21125, prepayment: claim / 2, months: 50, endMonth: monthAt(50), totalPaid: 1014000 + claim / 2 }),
    ];
  }

  const QUESTIONS = {
    expectedReopenDate: "On what date do you expect to reopen (YYYY-MM-DD)?",
    insuranceClaim: "Have you filed an insurance claim? If yes, how much do you expect and by what date?",
  };

  function recoveryAdvice() {
    const d = demo.damage ?? {};
    const lost = `${d.daysClosed ?? 0} days closed, ${rupees(d.stockLossInr ?? 0)} of stock and ${rupees(d.equipmentDamageInr ?? 0)} of equipment`;
    if (demo.proposal) {
      const p = demo.proposal, chosen = p.options[p.recommendedIndex];
      const where = p.status === "pending_bank" ? "is with the bank officer, who decides" : `was ${p.status} by the bank`;
      return {
        reply: `Your repayment plan ${where}. The recommended option is "${chosen.title}": ${chosen.terms}. ${p.status === "accepted" ? `Your EMI after the relief period is ${rupees(chosen.newEmi)}.` : "Nothing changes on the loan unless the bank accepts it."}`,
        structured: { questions: [], recommendation: { optionIndex: p.recommendedIndex, why: p.explanation }, citations: ["c1"] },
        toolCalls: calls("getDamageReport"), proposal: p,
      };
    }
    const missing = Object.keys(QUESTIONS).filter((key) => d[key] === undefined);
    if (missing.length) {
      return {
        reply: `I am sorry about the damage. I have recorded ${lost}. To work out repayment options I need ${missing.length === 1 ? "one more detail" : "two more details"}:\n${missing.map((key, i) => `${i + 1}. ${QUESTIONS[key]}`).join("\n")}`,
        structured: { questions: missing.map((key) => QUESTIONS[key]), recommendation: null, citations: ["c1"] },
        toolCalls: calls("getDamageReport"),
      };
    }
    const options = repaymentOptions(), best = options[0];
    const current = r(cashflowAfter(d) / (RAW.existing_emi_total + NEW_LOAN.emi));
    const why = `Next month's cash flow covers ${best.minMonthlyDSCR} times the EMIs still due under "${best.title}", against ${current} on the current schedule. It leaves no shortfall and does not depend on the insurance payout arriving on time. It costs ${rupees(best.extraCostVsOriginal)} more in interest over the loan.`;
    demo.proposal = { id: PROPOSAL, loanId: LOAN, status: "pending_bank", recommendedIndex: 0, explanation: why, options, decidedBy: null, decidedAt: null, note: null };
    return {
      reply: `I have recomputed your cash flow with ${lost}, reopening on ${d.expectedReopenDate}. There are ${options.length} ways to change the repayments:\n${options.map((o, i) => `${i + 1}. ${o.title}: ${o.terms}.`).join("\n")}\n\nI recommend the first. ${why}\n\nI have sent it to the bank as a proposal. Only a bank officer can accept it.`,
      structured: { questions: [], recommendation: { optionIndex: 0, why }, citations: ["c1", "c2", "c3", "c4"] },
      toolCalls: calls("getDamageReport", "saveDamageDetails", "recomputeCashflow", "generateRepaymentOptions"), proposal: demo.proposal,
    };
  }

  function chat(body) {
    const mode = modeNow();
    if (mode === "alert") return turn(mode, body.message, alertAdvice(), body);
    if (mode === "recovery") {
      // The owner's reply to the advisor's questions; any message stands in for it here
      if (!demo.proposal) {
        demo.damage = {
          daysClosed: 9, stockLossInr: 60000, equipmentDamageInr: 25000, reportedOn: day(),
          expectedReopenDate: day(12), insuranceClaim: { status: "filed", expectedAmountInr: 60000, expectedDate: day(40) },
          ...demo.damage,
        };
      }
      return turn(mode, body.message, recoveryAdvice(), body);
    }
    return turn(mode, body.message, preLoanAdvice(), body);
  }

  function fakeAlert(body) {
    const hazard = body.hazard ?? "heavy_rain", severity = body.severity ?? "warning";
    const starts = (body.startsInHours ?? 18) * HOUR;
    const event = { alertId: `fake-${Date.now().toString(36)}`, cellId: "demo-cell", hazard, severity, windowStart: iso(starts), windowEnd: iso(starts + (body.durationHours ?? 24) * HOUR), loanIds: body.loanIds ?? [LOAN] };
    if (demo.advisor === "PRE_LOAN") {
      return {
        event, alertId: event.alertId, hazard: "flash_flood", results: event.loanIds.map((loanId) => ({ loanId, status: "skipped", reason: "loan not disbursed" })), emailsQueued: 0,
        sampleNote: "Synthetic. The advisor only alerts a disbursed loan, and this one is still PRE_LOAN: authorising it is not enough. Press Disburse under Loan state below (or set the loan to active in step 07), then raise the alert again.",
      };
    }
    if (demo.advisor === "ACTIVE" || demo.advisor === "ALERT") {
      move("alert", "ALERT", `${hazard} ${severity} alert ${event.alertId}`);
      demo.alertId = event.alertId;
    }
    const advice = alertAdvice(event), loanState = demo.advisor;
    // IMPACTED and RECOVERY loans keep their state but still get the advice
    const advised = turn("alert", `A ${severity} ${hazard} alert (id ${event.alertId}) was raised for this business.`, advice, body);
    const window = { hazard: "flood", severity: { watch: "WATCH", warning: "WARNING", severe: "CRITICAL" }[severity] ?? "WARNING", window_start: day(1), window_end: day(2), evidence: `Test alert raised from the demo (${hazard}, ${severity})` };
    queue({ ...window, audience: "bank", status: "suppressed", note: "cooldown: this audience was alerted about this business in the last 24 hours" });
    queue({ ...window, audience: "owner", status: "pending" });
    return {
      event, alertId: event.alertId, hazard: "flash_flood",
      results: [{
        loanId: LOAN, status: "advised", loanState, conversationId: advised.conversationId, reply: advice.reply, actions: advice.actions,
        smsText: `ClimaCredit ${severity.toUpperCase()}: heavy rain soon. ${advice.actions[0].action} Reply or open chat.`,
        emailBody: `Dear Lakshmi Narayanan,\n\n${advice.reply}`, bankSummary: advice.bankSummary,
        deliveries: [{ channel: "email", to: null, status: "sent", provider: "dry_run" }], citations: advised.citations, warnings: [],
      }],
      emailsQueued: 1,
      sampleNote: "Synthetic. The loan is now in ALERT, so the chat answers with preventive steps, and the outbox in step 07 has the test alert.",
    };
  }

  function damageReport(body) {
    if (!["ACTIVE", "ALERT", "IMPACTED"].includes(demo.advisor)) {
      return notAllowed("damageReported", demo.advisor === "PRE_LOAN" ? "This loan was never disbursed. Press Disburse under Loan state below, then submit the report again." : undefined);
    }
    const { loanId: _loanId, message, ...damage } = body;
    demo.damage = { ...demo.damage, ...damage, reportedOn: day() };
    demo.alertId = null;
    move("damageReported", "IMPACTED", "damage report submitted");
    return turn("recovery", message ?? "Damage report submitted. Please help me with a repayment plan.", recoveryAdvice(), body);
  }

  function decide(body, path) {
    const id = path.split("/")[3], p = demo.proposal;
    if (!p || id !== p.id) return refuse(404, "NOT_FOUND", `Proposal ${id} not found`, "The advisor makes a proposal after a damage report; its id then fills this form.");
    if (p.status !== "pending_bank") return refuse(409, "CONFLICT", `Proposal ${id} is already ${p.status}`);
    const accept = body.decision !== "reject";
    Object.assign(p, { status: accept ? "accepted" : "rejected", decidedBy: OFFICER, decidedAt: iso(), note: body.note ?? null });
    if (accept) move("proposalAccepted", "RECOVERY", `proposal ${id} accepted by ${OFFICER}`);
    return { proposal: p, loanState: { loanId: LOAN, state: demo.advisor } };
  }

  const loanState = () => ({ loanId: LOAN, businessId: BIZ, state: demo.advisor, mode: modeNow(), alertId: demo.alertId, damage: demo.damage, history: demo.history });

  function disburse(body) {
    if (demo.advisor !== "PRE_LOAN") return notAllowed("disbursed");
    move("disbursed", "ACTIVE", body.note ?? "bank: disbursed");
    if (demo.loan) demo.loan = "active";
    return loanState();
  }

  function closeRecovery(body) {
    if (demo.advisor !== "RECOVERY") return notAllowed("recoveryClosed", "Only a loan in RECOVERY can be closed out: accept a proposal first.");
    move("recoveryClosed", "ACTIVE", body.note ?? "bank: recoveryClosed");
    demo.damage = null;
    demo.proposal = null;
    return loanState();
  }

  function leaveAlert(event, to, reason) {
    if (demo.advisor !== "ALERT") return [];
    move(event, to, reason);
    demo.alertId = null;
    return [LOAN];
  }

  function conversations() {
    const modes = [...new Set(demo.turns.map((t) => t.mode))];
    return { businessId: BIZ, conversations: modes.map((mode) => {
      const turns = demo.turns.filter((t) => t.mode === mode);
      return {
        id: CONVERSATION[mode], businessId: BIZ, loanId: LOAN, mode, createdAt: turns[0].at,
        messages: turns.flatMap((t, i) => [
          { id: i * 2 + 1, role: "user", content: t.input, structuredOutput: null, citations: [], createdAt: t.at },
          { id: i * 2 + 2, role: "assistant", content: t.result.reply, structuredOutput: t.result.structured, citations: t.result.citations, createdAt: t.at },
        ]),
        toolCalls: turns.flatMap((t) => t.result.toolCalls.map((c) => ({ conversationId: CONVERSATION[mode], callId: c.callId, tool: c.tool, input: null, output: null, error: null, durationMs: 12 }))),
      };
    }) };
  }

  // ── The routes ─────────────────────────────────────────────────────────────

  // "GET /a/:id" matches that call with any id and any query string
  const on = (spec) => {
    const [method, path] = spec.split(" ");
    return new RegExp(`^(${method}) ${path.replace(/:\w+/g, "[^/?]+")}(\\?.*)?$`);
  };

  const SAMPLES = [
    [on("GET /auth/me"), { user: { id: "demo-bank-officer", email: OFFICER, name: "Priya Raman", role: "bank" } }, "Synthetic bank officer. Sample mode has no session; it answers as if a bank officer were signed in, so every step is open."],
    [on("GET /auth/config"), { google_client_id: null }, HAND],
    [on("POST /auth/logout"), { sampleStatus: 204 }, "Synthetic. Live, this ends the session and clears the cookie."],

    [on("POST /businesses"), () => { demo = { ...applied(), snapshots: 0, loan: null }; return { ...business(), sampleStatus: 201 }; }, "Synthetic. A new application: it has no financials and no loan yet, so the steps below add them. Values typed into the form do not change the answer."],
    [on("GET|PATCH /businesses/:id"), business, HAND],
    [on("PUT /businesses/:id/(locations|suppliers)"), business, HAND],
    [on("POST /seed/smes"), () => { const first = !demo.seeded; demo.seeded = true; return { total: 4, created: first ? 4 : 0, skipped: first ? 0 : 4, failed: [] }; }, "Synthetic. The seed file holds four businesses; loading it twice skips them all."],

    [on("GET /businesses/:id/impact-profile"), impact, HAND],
    [on("POST /businesses/:id/impact-profile/reclassify"), () => { demo.overridden = false; return { ...impact(), sampleStatus: 202 }; }, "Synthetic. Reclassifying drops the bank's override and reads the description again."],
    [on("PUT /businesses/:id/impact-profile"), () => { demo.overridden = true; return impact(); }, "Synthetic. The override lowers the river flood physical value to 0.1, whatever the body says; compute the finance profile again to see the stress test change."],

    [on("POST /climate/profile"), climate, CLIMATE_NOTE],
    [on("GET /climate/events"), events, CLIMATE_NOTE],
    [on("GET /climate/cell/:id"), cellStore, "Synthetic. What the cell store would hold for the bakery's cell after one lookup; other cell ids show the same answer."],

    [on("POST /businesses/:id/snapshots"), () => { demo.snapshots += 1; demo.verified = false; return { snapshot: snapshot(), scoring: "pending", sampleStatus: 201 }; }, "Synthetic. Each save is a new, unverified version; the figures are the form's defaults."],
    [on("GET /businesses/:id/snapshots"), () => ({ snapshots: Array.from({ length: demo.snapshots }, (_, i) => snapshot(demo.snapshots - i)) }), HAND],
    [on("POST /businesses/:id/snapshots/:v/verify"), (_body, path) => {
      const version = path.split("/")[4];
      if (Number(version) !== demo.snapshots || !demo.snapshots) return refuse(404, "NOT_FOUND", `Business ${BIZ} has no snapshot version ${version}`, demo.snapshots ? `Only the latest version, ${demo.snapshots}, can be verified in sample mode.` : "Save a snapshot in step 05 first.");
      demo.verified = true;
      return snapshot();
    }, "Synthetic. A verified snapshot removes the snapshot_unverified warning from the finance profile and the evaluation."],

    [on("POST /businesses/:id/loans"), () => { demo.loan = "applied"; return { loan: loan(), scoring: scoring(), sampleStatus: 201 }; }, "Synthetic. The loan's EMI now counts in the finance profile: compute it to see DSCR and the score move."],
    [on("PATCH /loans/:id/status"), setStatus, HAND],
    [on("GET /finance/business/:id/profile"), financeProfile, "Synthetic. Worked out in the page from the snapshot, the loan and the weather profile above, imitating the finance service's rules."],
    [on("GET /finance/business/:id/profiles"), () => ({ profiles: demo.profiles }), "Synthetic. One row for each profile this walk-through has computed or stored."],
    [on("POST /finance/business/:id/scenario"), scenario, "Synthetic. Uses the hazard, severity and duration from the form."],
    [on("POST /finance/business/:id/repayment-capacity"), repaymentCapacity, "Synthetic. Uses the revenue drop and months from the form."],
    [on("POST /finance/evaluate-location"), evaluateLocation, "Synthetic. The bakery's figures on its sector's default weather sensitivity; the draft in the form does not change it."],
    [on("GET /finance/demo"), () => ({ sample: { lat: 13.0827, lon: 80.2707, business: { sector: "food_beverage", years_in_operation: 11, insurance_covers: ["flood", "stock"] } }, result: evaluateLocation({}) }), HAND],
    [on("GET /evaluate/business/:id"), evaluation, "Synthetic. The climate and finance answers above, checked together and rated."],
    [on("GET /evaluate/business/:id/history"), () => ({ evaluations: demo.evaluations }), "Synthetic. One row for each evaluation run in this walk-through."],

    [on("GET /alerts"), alerts, "Synthetic. Empty until the loan is authorised: only then does the monitor watch the cell. The messages are examples, not the alert templates."],

    [on("POST /advisor/chat"), chat, HAND],
    [on("GET /advisor/businesses"), { businesses: [
      { id: BIZ, name: NAME, sector: "food_beverage", city: "Chennai", loans: [LOAN] },
      { id: "SME-0101", name: "Maa Tarini Kirana Store", sector: "kirana", city: "Puri", loans: ["LN-0101"] },
      { id: "SME-0142", name: "Sri Ganesh Bakery", sector: "food", city: "Chennai", loans: ["LN-0142"] },
      { id: "SME-0203", name: "Patil Agro Inputs", sector: "agri-inputs", city: "Latur", loans: ["LN-0203"] },
      { id: "SME-0307", name: "Rathore Tailoring & Alterations", sector: "tailoring", city: "Jaipur", loans: ["LN-0307"] },
    ] }, "The walk-through's business, then the four demo businesses in api/data/smes.json. In sample mode the advisor answers about the first, whichever is chosen."],
    [on("GET /advisor/conversations/:id"), conversations, "Synthetic. The chat turns made in this walk-through, grouped by the advisor's mode."],
    [on("POST /advisor/dev/fake-alert"), fakeAlert, HAND],
    [on("POST /advisor/dev/sweep-alerts"), () => ({ movedToActive: leaveAlert("alertEnded", "ACTIVE", "alert window ended") }), "Synthetic. Live, only alerts whose window has ended are swept; here an open alert is treated as ended."],
    [on("POST /advisor/dev/verify-alert"), (body) => ({ alertId: body.alertId, moved: body.label === "miss" ? [] : leaveAlert("verifiedHit", "IMPACTED", `alert ${body.alertId} verified as a hit`) }), HAND],
    [on("POST /advisor/damage-report"), damageReport, "Synthetic. The loan is now IMPACTED and the advisor is in recovery mode. If it asked for missing details, send any message in the chat to answer them and get the repayment options."],
    [on("POST /advisor/proposals/:id/decision"), decide, "Synthetic. Accepting moves the loan to RECOVERY; Close recovery under Loan state returns it to ACTIVE."],
    [on("GET /advisor/loans/:id/state"), loanState, HAND],
    [on("POST /advisor/loans/:id/disburse"), disburse, HAND],
    [on("POST /advisor/loans/:id/close-recovery"), closeRecovery, HAND],

    [on("GET /health"), { status: "ok", db: "up", upstream: { open_meteo: { state: "ok", checked_at: ist(-2 * HOUR) } } }, HAND],
    [on("GET /ml/status"), { status: "ok", models: { alert_calibration_flood: true, alert_calibration_storm: true, cashflow_anomaly: true }, hazard_params: true }, HAND],
    [on("POST /ml/alerts/calibrate"), (body) => ({ p_event: body.hazard === "storm" ? 0.21 : 0.41, band: body.hazard === "storm" ? "medium" : "high", model_version: "alert-cal-synthetic", cell: "Chennai", distance_km: 2.4, reason: null }), "Synthetic. The band follows the hazard in the form; live, the model reads the rain series."],
    [on("POST /ml/anomaly"), { anomaly_score: 0.63, flagged: true, type: "systemic", months_flagged: 2, model_version: "cashflow-anomaly-synthetic", reason: null }, HAND],
    [on("POST /ml/climate-cashflow"), {
      scored: true, cell: "Chennai", distance_km: 2.4,
      pd_without_climate: 0.0011, pd_with_climate: 0.0482, delta_pd_climate: 0.0471, climate_adjusted_pd: 0.0612, climate_premium_bps: 212.4,
      expected_annual_climate_loss: 61200, climate_cfar95: 214500, cash_reserve_target: 184000,
      p_cash_short_30d: 0.03, p_cash_short_30d_without_climate: 0.0,
      loss_by_hazard: { flash_flood: 38400, storm: 16900, river_flood: 5900 },
      what_if: [{ condition: "insure 50% of climate losses", pd_with_climate: 0.0213, pd_change: -0.0269 }, { condition: "backup power", pd_with_climate: 0.0431, pd_change: -0.0051 }],
      paths: 20000, hazards: { flash_flood: { events_per_year: 2.1, mean_duration: 3.4 }, storm: { events_per_year: 0.9, mean_duration: 2.2 } },
      assumptions: ["Synthetic sample: the costs per event are made up for this walk-through"],
    }, "Synthetic. Live, the simulation runs 20,000 paths from the hazard history of the nearest measured cell."],
  ];

  return { SAMPLES, HAND };
})();
