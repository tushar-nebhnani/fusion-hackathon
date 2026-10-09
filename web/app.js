"use strict";

// Kshetra console. No framework and no build step: index.html holds the
// layout and the forms, this file sends the requests and draws the answers.
// Everything is drawn with DOM nodes, never innerHTML, because answers hold
// text that users typed.

// ── Small helpers ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// localStorage can throw (private windows, file://), so nothing may depend on it
const store = {
  get(key, fallback = "") {
    try { return localStorage.getItem(`kshetra.${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`kshetra.${key}`, value); } catch { /* not kept */ }
  },
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const label = (key) => String(key).replace(/_/g, " ");
const inr = (v) => (typeof v === "number" ? `₹${Math.round(v).toLocaleString("en-IN")}` : "n/a");

function fmt(value) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-IN") : String(+value.toFixed(4));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.map(fmt).join(", ") : "none";
  if (isObject(value)) return JSON.stringify(value);
  return String(value);
}

const tag = (text, tone = "") => h("span", { class: `tag ${tone}` }, text);
const subH = (text) => h("div", { class: "sub-h" }, text);
const note = (kind, ...kids) => h("div", { class: `note ${kind}` }, kids);

function kv(pairs, extra = "") {
  return h("dl", { class: `kv ${extra}` }, pairs.filter(Boolean).map(([k, v]) => h("div", {}, h("dt", {}, label(k)), h("dd", {}, v instanceof Node ? v : fmt(v)))));
}
const kvOf = (obj) => kv(Object.entries(obj ?? {}));

function bar(value, max = 1, tone = "") {
  const share = Math.max(0, Math.min(1, (Number(value) || 0) / max));
  return h("div", { class: `bar ${tone}` }, h("i", { style: `width:${(share * 100).toFixed(1)}%` }));
}
const barRow = (name, value, max, tone) => h("div", { class: "bar-row" }, h("span", {}, label(name)), bar(value, max, tone), h("span", {}, fmt(value)));

function table(head, rows) {
  return h("div", { class: "tbl-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, head.map((c) => h("th", { class: c.startsWith("#") ? "num" : null }, c.replace(/^#/, ""))))),
    h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell, i) => h("td", { class: head[i]?.startsWith("#") ? "num" : null }, cell instanceof Node || Array.isArray(cell) ? cell : fmt(cell))))))));
}

const GRADE_NAMES = { A: "Stable", B: "Watch", C: "Exposed", D: "High", E: "Critical" };
const TONES = {
  primary: "am", secondary: "cy", agent_raised: "am", severe: "er", warning: "am", watch: "cy",
  sent: "ok", failed: "er", dead: "er", suppressed: "am", pending: "", sending: "cy",
  low_risk: "ok", moderate: "cy", high: "am", critical: "er", unfavourable: "am", favourable: "ok",
  ok: "ok", fallback: "am", overridden: "cy", authorised: "cy", active: "ok", rejected: "er", applied: "",
  accepted: "ok", pending_bank: "am", bank: "am", owner: "cy",
};
const toned = (value) => tag(label(value ?? "n/a"), TONES[value] ?? "");

function scoreStrip(cells) {
  return h("div", { class: "score" }, cells.filter(Boolean).map(([name, value, small]) =>
    h("div", {}, h("div", { class: "lbl" }, name), h("div", { class: "val" }, value, small ? h("small", {}, small) : null))));
}

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  // Served by the API itself (/demo style) it calls its own origin; otherwise the dev default
  base: store.get("base") || (location.port === "4000" ? location.origin : "http://localhost:4000"),
  mode: "live", // "live" calls the API; "sample" answers reads from SAMPLES and sends nothing
  reachable: null,
  health: null,
  user: null,
  wire: [],
};

// Values several forms share: the business being worked on, its loan, and so on
const ctx = {
  set(key, value) {
    if (value === null || value === undefined || value === "") return;
    store.set(`ctx.${key}`, String(value));
    for (const input of document.querySelectorAll(`[data-bind="${key}"]`)) input.value = String(value);
    if (key === "advBiz" || key === "advLoan") $("chat-who").textContent = [$("chat-biz").value, $("chat-loan").value].filter(Boolean).join(" · ");
  },
};

// ── Sample answers ───────────────────────────────────────────────────────────
// Shown only in sample mode, and always labelled. The climate profile is a real
// answer captured from the API; the rest are written by hand from the documented
// shapes so that the layout can be seen before the API is running.

const HAND = "Illustrative: written by hand from the documented response shape, not computed.";

const SAMPLE_CLIMATE = {
  location: { lat: 26.1445, lon: 91.7362, cells: { historical: "0.1:26.1:91.7", climate: "0.1:26.1:91.7", flood: "0.05:26.15:91.75", forecast: "0.1:26.1:91.7" } },
  overall_climate_risk: 0.459, grade: "C", confidence: "med",
  hazards: [
    { hazard: "river_flood", relevance: "secondary", relevance_method: "static", score: 0.322, components: { structural: 1, historical: 0.022, forecast: 0.055 }, reason: "99th-percentile river discharge of 45 m³/s" },
    { hazard: "flash_flood", relevance: "primary", relevance_method: "static", score: 0.824, components: { structural: 1, historical: 1, forecast: 0 }, reason: "Rain of 50 mm or more on 11.6 days per year" },
    { hazard: "heat", relevance: "dormant", relevance_method: "static", score: 0, components: { historical: 0, forecast: 0 }, reason: "Max temperature above 40°C on 0.0 days per year" },
    { hazard: "drought", relevance: "dormant", relevance_method: "static", score: 0.1, components: { historical: 0.125, forecast: 0 }, reason: "Weak monsoon (below 75% of normal) in about 1 in 16 years" },
    { hazard: "storm", relevance: "secondary", relevance_method: "static", score: 0.12, components: { historical: 0.113, forecast: 0.148 }, reason: "Gusts above 60 km/h on 1.1 days per year" },
    { hazard: "cold_wave", relevance: "dormant", relevance_method: "static", score: 0, components: { historical: 0, forecast: 0 }, reason: "Min temperature below 4°C on 0.0 days per year" },
  ],
  active_events: [],
  data_freshness: { forecast_issued_at: "2026-10-09T11:58:01+05:30", history_until: "2026-10-03" },
  cache: "complete_hit",
  warnings: ["flood_exposure_unavailable: World Bank exposure raster is not loaded"],
};

const SAMPLE_IMPACT = {
  business_id: "sample-business", version: 1, status: "ok", category: "food_beverage", overall_confidence: 0.8,
  conditions: {
    river_flood: { physical: 0.8, demand: -0.3, mechanism: "operational_downtime", confidence: 0.7, reason: "Ground-floor premises close during floods", source: "llm" },
    flash_flood: { physical: 0.5, demand: -0.5, mechanism: "foot_traffic", confidence: 0.8, reason: "Walk-in shop; heavy rain keeps customers home", source: "llm" },
    heat: { physical: 0.2, demand: 0.1, mechanism: "demand_mix", confidence: 0.6, reason: "Ovens run hotter; cold items sell a little more", source: "llm" },
    drought: { physical: 0.1, demand: 0, mechanism: "none", confidence: 0.3, reason: "Sector default", source: "sector_default" },
    storm: { physical: 0.5, demand: -0.4, mechanism: "foot_traffic", confidence: 0.7, reason: "Shop shuts in high wind; few walk-ins", source: "llm" },
    cold_wave: { physical: 0, demand: 0.1, mechanism: "demand_timing", confidence: 0.5, reason: "Warm baked goods sell slightly more", source: "llm" },
  },
  model: "sample", prompt_version: "sample", note: null, overridden_by: null, override_reason: null,
};

const SAMPLE_SNAPSHOT = {
  version: 1, as_of: "2026-09-30", verified_by_bank: false, derivation_version: "derive-1",
  raw: { monthly_revenue: [410000, 395000, 420000, 450000, 470000, 430000, 405000, 415000], monthly_opex: 310000, existing_emi_total: 28000, outstanding_debt: 650000, cash_balance: 240000, payment_delays_12m: 1 },
  derived: { avg_revenue: 424375, revenue_volatility: 0.054, operating_margin: 0.2695, dscr: 4.0848, debt_to_revenue: 0.1276, cash_buffer_days: 23.2, years_in_operation: 11, num_locations: 1 },
};

const SAMPLE_BUSINESS = {
  id: "sample-business", source: "user",
  profile: { name: "Sri Lakshmi Bakery", sector: "food_beverage", sub_sector: "bakery", year_started: 2015, sales_channel: "both", indoor_outdoor: "indoor", employees: 6 },
  locations: { primary: { lat: 13.0827, lon: 80.2707, address: "12 NSC Bose Road, George Town, Chennai", pincode: "600001", premises: "rented", floor: "ground" }, additional_locations: [] },
  operations: { power_outage_hrs_month: 12, has_backup_power: false, water_dependency: "medium", has_insurance: true, insurance_covers: ["flood", "stock"], seasonal_months: [10, 11, 12] },
  suppliers: [{ name: "Annai Flour Mills", lat: 13.05, lon: 80.21, share: 0.6, critical: false }, { name: "Madurai Dairy Co-op", lat: 9.9252, lon: 78.1198, share: 0.4, critical: false }],
  consent: { data_processing: true, share_with_bank: true, alerts: true, version: "consent-1" },
  latest_snapshot: SAMPLE_SNAPSHOT,
  loans: [{ id: "sample-loan", business_id: "sample-business", amount: 800000, emi: 21500, tenure_months: 48, interest_rate: 13, purpose: "equipment", status: "applied" }],
  impact_profile: SAMPLE_IMPACT,
  scoring: "pending",
};

const stressRow = (severity, shock, gross, insurance, revenue, dscr, breach) => ({
  severity, direction: shock < 0 ? "unfavourable" : "neutral", shock_pct: shock, gross_shock_pct: gross, insurance_applied: insurance, duration_months: 2,
  stressed_metrics: { monthly_revenue: revenue, net_monthly_cashflow: revenue - 60000, dscr, surplus_after_debt: revenue - 70000, cash_runway: "positive_cashflow", cash_runway_months: null, cash_after_shock: 90000 },
  breach, breach_reasons: breach ? ["dscr_below_1"] : [],
});

const SAMPLE_FINANCE = {
  business_id: "sample-business", generated_at: "2026-10-09T11:30:00+05:30", model_version: "finance-1",
  inputs: { snapshot_version: 1, snapshot_as_of: "2026-09-30", snapshot_verified: false, proposed_loan_ids: [], impact_profile_version: 1 },
  baseline: { score: 89, band: "low_risk", sub_scores: { dscr: 100, runway: 85, leverage: 85, volatility: 80, repayment: 75, business_age: 100 }, source: "rules" },
  metrics: { avg_monthly_revenue: 100000, avg_monthly_expenses: 60000, net_monthly_cashflow: 40000, total_emi: 10000, dscr: 4, surplus_after_debt: 30000, cash_runway: "positive_cashflow", revenue_volatility: 0.12, leverage: 0.2 },
  climate: { profile_ref: "0.1:19.1:72.9@2026-10-09T11:30:00+05:30", cell_id: "0.1:19.1:72.9", fetched_at: "2026-10-09T11:30:00+05:30", overall_climate_risk: 0.4, grade: "C", confidence: "med" },
  sensitivity: { source: "fallback", hazards: {
    river_flood: { direction: "unfavourable", magnitude: 0.6, channels: ["operations", "revenue"], reason: "Sector default for food_beverage", physical: 0.6, demand: 0 },
    flash_flood: { direction: "unfavourable", magnitude: 0.4, channels: ["foot_traffic"], reason: "Sector default for food_beverage", physical: 0.4, demand: 0 },
    heat: { direction: "neutral", magnitude: 0, channels: [], reason: "Sector default for food_beverage", physical: 0, demand: 0 },
  } },
  stress: {
    river_flood: stressRow(0.8, -24, -48, ["flood", "stock"], 76000, 1.6, false),
    flash_flood: stressRow(0.5, -10, -20, ["flood", "stock"], 90000, 3, false),
    heat: stressRow(0.1, 0, 0, [], 100000, 4, false),
  },
  adjusted: { score: 80, band: "low_risk", drivers: [
    { hazard: "river_flood", points_change: -7.2, reason: "River flood stress (severity 0.8, revenue down 24% after flood and stock insurance) drops DSCR from 4 to 1.6" },
    { hazard: "flash_flood", points_change: -1.8, reason: "Flash flood stress (severity 0.5, revenue down 10% after flood and stock insurance) drops DSCR from 4 to 3" },
  ] },
  summary: "Baseline 89 (low_risk); climate-adjusted 80 (low_risk). Biggest driver: River flood stress.",
  warnings: ["snapshot_unverified: the bank has not verified the financials", "short_revenue_history: fewer than 12 months of revenue"],
};

const SAMPLE_ALERTS = { alerts: [
  { id: 2, business_id: "SME-0142", business_name: "Sri Ganesh Bakery", audience: "owner", channel: "email", hazard: "flash_flood", severity: "warning", status: "sent", attempts: 1, window_start: "2026-10-10", window_end: "2026-10-12", evidence: "Sample evidence line from the monitor", note: null, created_at: "2026-10-09T12:05:00+05:30",
    deliveries: [{ provider: "dry_run", result: "sent", error: null, subject: "Sample subject: heavy rain warning", body: "Sample body. Live, this is the message exactly as the template rendered it.", sent_at: "2026-10-09T12:05:04+05:30" }] },
  { id: 1, business_id: "SME-0142", business_name: "Sri Ganesh Bakery", audience: "bank", channel: "email", hazard: "flash_flood", severity: "warning", status: "suppressed", attempts: 0, window_start: "2026-10-10", window_end: "2026-10-12", evidence: "Sample evidence line from the monitor", note: "Sample reason: inside the cooldown window", created_at: "2026-10-09T12:05:00+05:30", deliveries: [] },
] };

// The four businesses in api/data/smes.json, which the advisor reads
const SAMPLE_ADVISOR_BUSINESSES = { businesses: [
  { id: "SME-0101", name: "Maa Tarini Kirana Store", sector: "kirana", city: "Puri", loans: ["LN-0101"] },
  { id: "SME-0142", name: "Sri Ganesh Bakery", sector: "food", city: "Chennai", loans: ["LN-0142"] },
  { id: "SME-0203", name: "Patil Agro Inputs", sector: "agri-inputs", city: "Latur", loans: ["LN-0203"] },
  { id: "SME-0307", name: "Rathore Tailoring & Alterations", sector: "tailoring", city: "Jaipur", loans: ["LN-0307"] },
] };

const SAMPLE_TURN = {
  conversationId: "00000000-0000-4000-8000-000000000000", mode: "sample", loanId: "LN-0142", loanState: null,
  reply: "This is a placeholder shown in sample mode. Live, the advisor answers from tool results (finance scenarios, the climate profile, hazard seasons) and cites each one.",
  structured: null, citations: [], warnings: [], toolCalls: [],
};

const SAMPLES = [
  [/^POST \/climate\/profile$/, SAMPLE_CLIMATE, "A real answer for Guwahati, captured from the API on 9 Oct 2026. Other coordinates show the same answer."],
  [/^GET \/climate\/events/, { location: SAMPLE_CLIMATE.location, active_events: [], data_freshness: SAMPLE_CLIMATE.data_freshness, cache: "complete_hit", warnings: SAMPLE_CLIMATE.warnings }, "From the Guwahati answer captured on 9 Oct 2026."],
  [/^(GET|POST) \/businesses(\/[^/]+)?$/, SAMPLE_BUSINESS, HAND],
  [/^GET \/businesses\/[^/]+\/impact-profile$/, SAMPLE_IMPACT, HAND],
  [/^GET \/businesses\/[^/]+\/snapshots$/, { snapshots: [SAMPLE_SNAPSHOT] }, HAND],
  [/^GET \/finance\/(demo|business\/[^/]+\/profile)$/, SAMPLE_FINANCE, HAND],
  [/^POST \/businesses\/[^/]+\/snapshots$/, { snapshot: SAMPLE_SNAPSHOT, scoring: "pending" }, HAND],
  [/^POST \/businesses\/[^/]+\/loans$/, { loan: SAMPLE_BUSINESS.loans[0], scoring: "pending" }, HAND],
  [/^PATCH \/loans\/[^/]+\/status$/, { loan: { ...SAMPLE_BUSINESS.loans[0], status: "authorised" }, scoring: "pending" }, HAND],
  [/^POST \/advisor\/dev\/fake-alert$/, { event: { alertId: "fake-sample", cellId: "demo-cell", hazard: "heavy_rain", severity: "warning", windowStart: "2026-10-10T06:00:00.000Z", windowEnd: "2026-10-11T06:00:00.000Z", loanIds: ["LN-0142"] } }, HAND],
  [/^GET \/alerts/, SAMPLE_ALERTS, HAND],
  [/^GET \/advisor\/businesses$/, SAMPLE_ADVISOR_BUSINESSES, "The four demo businesses in api/data/smes.json. Live, the list also has the input service's businesses you may see."],
  [/^POST \/advisor\/chat$/, SAMPLE_TURN, HAND],
];

// ── API client ───────────────────────────────────────────────────────────────

function newKey() {
  // randomUUID needs a secure context; file:// is not one
  return crypto.randomUUID?.() ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// Every call ends as one result object and one row in the wire log; it never throws.
// options: key (reuse an Idempotency-Key), noKey (leave it out), live (ignore sample mode)
async function api(method, path, body, options = {}) {
  const write = method !== "GET";
  const key = write && !options.noKey ? (options.key ?? newKey()) : null;
  const started = performance.now();
  const result = { method, path, body, key, ok: false, status: 0, data: null, headers: {}, source: "live", ms: 0 };

  if (state.mode === "sample" && !options.live) {
    result.source = "sample";
    // noSample: a request made to show a refusal must not be answered with a sample
    const hit = options.noSample ? null : SAMPLES.find(([pattern]) => pattern.test(`${method} ${path}`));
    if (hit) Object.assign(result, { ok: true, status: 200, data: hit[1], sampleNote: hit[2] });
    else result.notSent = true;
  } else {
    try {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (key) headers["Idempotency-Key"] = key;
      const response = await fetch(state.base + path, {
        method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      Object.assign(result, {
        ok: response.ok, status: response.status, data,
        headers: {
          requestId: response.headers.get("X-Request-Id"),
          rateLimit: response.headers.get("RateLimit"),
          ratePolicy: response.headers.get("RateLimit-Policy"),
          replayed: response.headers.get("Idempotency-Replayed") === "true",
          retryAfter: response.headers.get("Retry-After"),
        },
      });
    } catch {
      // fetch rejects without detail when the API is down or refuses this origin
      result.network = true;
    }
  }
  result.ms = Math.round(performance.now() - started);
  logWire(result);
  return result;
}

// ── Wire log ─────────────────────────────────────────────────────────────────

function logWire(r) {
  state.wire.unshift({ ...r, at: new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }) });
  state.wire.length = Math.min(state.wire.length, 200);
  const status = r.notSent ? "not sent" : r.network ? "no answer" : String(r.status);
  $("wire-count").textContent = `${state.wire.length} request${state.wire.length === 1 ? "" : "s"}`;
  $("wire-last").textContent = `${r.method} ${r.path} → ${status} · ${r.ms} ms${r.source === "sample" ? " · sample" : ""}`;
  $("wire-rows").replaceChildren(...state.wire.map((w) => h("tr", {},
    h("td", {}, w.at),
    h("td", {}, w.source === "sample" ? tag("sample", "am") : tag("live", "cy")),
    h("td", {}, w.method),
    h("td", {}, w.path),
    h("td", { class: `s${String(w.status)[0]}` }, w.notSent ? "not sent" : w.network ? "no answer" : w.status),
    h("td", { class: "num" }, w.ms),
    h("td", {}, w.headers.rateLimit ?? ""),
    h("td", {}, w.headers.replayed ? tag("replayed", "am") : ""),
    h("td", {}, w.key ?? ""),
    h("td", {}, w.headers.requestId ?? ""))));
  if (r.headers.rateLimit || r.headers.requestId) {
    $("rate-last").replaceChildren(...kv([
      ["last request", `${r.method} ${r.path}`],
      ["RateLimit", r.headers.rateLimit ?? "not sent"],
      ["RateLimit-Policy", r.headers.ratePolicy ?? "not sent"],
      ["X-Request-Id", r.headers.requestId ?? "not sent"],
    ]).children);
  }
}

// ── Drawing an answer ────────────────────────────────────────────────────────

const HINTS = {
  UNAUTHORIZED: "This route needs a session. Sign in at step 01.",
  FORBIDDEN: "This route is for bank officers. Your email must be in AUTH_BANK_EMAILS or AUTH_BANK_DOMAINS.",
  ORIGIN_NOT_ALLOWED: "Serve this page from an origin listed in AUTH_ALLOWED_ORIGINS (http://localhost:3000 by default).",
  UPSTREAM_UNAVAILABLE: "Usually Open-Meteo's per-minute limit on a first lookup. Wait a minute and try again.",
  NO_FINANCIALS: "Save a financial snapshot for this business under Business intake first.",
  AUTH_NOT_CONFIGURED: "GOOGLE_CLIENT_ID is blank in api/.env.",
};

function errorNote(r) {
  if (r.notSent) {
    return note("sample", h("b", {}, "NOT SENT "), "Sample mode sends nothing and has no stored answer for this request. Switch to the live API to run it.");
  }
  if (r.network) {
    return note("err", h("b", {}, "NO ANSWER "), `Nothing came back from ${state.base}. The API may be stopped, or it does not accept this page's origin (${location.origin}).`);
  }
  const error = isObject(r.data) && isObject(r.data.error) ? r.data.error : {};
  const fields = isObject(error.details?.fields) ? Object.entries(error.details.fields) : [];
  return note("err",
    h("b", {}, `${r.status} ${error.code ?? "ERROR"} `), error.message ?? "The request failed.",
    error.step ? h("div", { class: "mono muted", style: "font-size:12px;margin-top:4px" }, `step: ${error.step}`) : null,
    fields.length ? h("ul", { class: "plain", style: "margin-top:6px" }, fields.map(([field, problem]) => h("li", {}, h("code", {}, field), " ", fmt(problem)))) : null,
    !fields.length && isObject(error.details) ? h("div", { class: "mono", style: "font-size:12px;margin-top:4px" }, JSON.stringify(error.details)) : null,
    HINTS[error.code] ? h("div", { style: "margin-top:6px" }, HINTS[error.code]) : null);
}

function show(out, r, renderer = "generic") {
  const body = h("div", { class: "out-b" });
  if (r.source === "sample" && r.ok) body.append(note("sample", h("b", {}, "SAMPLE "), r.sampleNote ?? HAND), h("div", { style: "height:12px" }));
  if (!r.ok) body.append(errorNote(r));
  else if (r.status === 204 || r.data === null) body.append(note("", `${r.status} with no body.`));
  else {
    try {
      body.append((RENDER[renderer] ?? RENDER.generic)(r.data, r));
    } catch (error) {
      // An answer in a shape the renderer did not expect is still shown in full
      body.append(note("", "This answer has a shape the view does not know yet; it is shown as plain fields."), RENDER.generic(r.data));
      console.warn(error);
    }
  }
  const meta = h("div", { class: "panel-h" },
    h("span", { class: "ep" }, h("span", { class: `verb ${r.method === "GET" ? "" : "w"}` }, r.method), r.path),
    h("span", {}, r.notSent ? "not sent" : r.network ? "no answer" : `${r.status} · ${r.ms} ms`,
      r.headers.replayed ? [" ", tag("replayed", "am")] : null, r.source === "sample" ? [" ", tag("sample", "am")] : null));
  const raw = h("details", { class: "raw" }, h("summary", {}, "Raw request and response"),
    h("pre", {}, `${r.method} ${r.path}${r.key ? `\nIdempotency-Key: ${r.key}` : ""}${r.body === undefined ? "" : `\n\n${JSON.stringify(r.body, null, 2)}`}\n\n── ${r.notSent ? "not sent" : r.network ? "no answer" : r.status}${r.headers.requestId ? ` · X-Request-Id ${r.headers.requestId}` : ""} ──\n${r.data === null ? "" : typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2)}`));
  out.replaceChildren(meta, body, raw);
}

// Any JSON, drawn as fields and tables. Used where no bespoke view exists.
function generic(data, depth = 0) {
  if (!isObject(data) && !Array.isArray(data)) return h("p", {}, fmt(data));
  if (Array.isArray(data)) {
    if (!data.length) return h("p", { class: "muted" }, "Empty list.");
    if (!data.every(isObject)) return h("p", { class: "mono" }, fmt(data));
    const cols = [...new Set(data.flatMap((row) => Object.keys(row)))].slice(0, 9);
    return table(cols.map(label), data.map((row) => cols.map((c) => fmt(row[c]))));
  }
  const frag = document.createDocumentFragment();
  if (typeof data.summary === "string") frag.append(h("p", { style: "margin-bottom:12px" }, data.summary));
  const flat = Object.entries(data).filter(([k, v]) => k !== "summary" && !isObject(v) && !(Array.isArray(v) && v.some(isObject)));
  const nested = Object.entries(data).filter(([, v]) => isObject(v) || (Array.isArray(v) && v.some(isObject)));
  if (flat.length) frag.append(kv(flat));
  for (const [key, value] of nested) {
    frag.append(subH(label(key)), depth >= 3 ? h("pre", {}, JSON.stringify(value, null, 2)) : generic(value, depth + 1));
  }
  return frag;
}

const warnings = (list) => (list?.length ? [subH("Warnings"), list.map((w) => note("", w))] : null);

function gradeCell(grade) {
  return [h("span", { class: `sw g-${grade}` }), grade ?? "n/a"];
}

function eventsBlock(events) {
  if (!events?.length) return [subH("Active events"), h("p", { class: "muted" }, "None: the 7-day forecast crosses no danger threshold.")];
  return [subH("Active events"), table(["Hazard", "Severity", "Window", "#Confidence"],
    events.map((e) => [h("b", {}, label(e.hazard)), toned(e.severity), `${e.window_start} → ${e.window_end}`, e.confidence]))];
}

const RENDER = {
  generic: (d) => generic(d),

  climate(d) {
    ctx.set("cell", d.location?.cells?.forecast);
    return h("div", {},
      scoreStrip([
        ["Grade", gradeCell(d.grade), GRADE_NAMES[d.grade]],
        ["Overall climate risk", fmt(d.overall_climate_risk), "0 to 1"],
        ["Confidence", d.confidence],
        ["Cache", h("span", { style: "font-size:16px" }, label(d.cache))],
      ]),
      h("div", { style: "padding-top:16px" },
        subH("Six hazards"),
        table(["Hazard", "Relevance", "Score", "Structural · historical · forecast", "Why"], (d.hazards ?? []).map((z) => [
          h("b", {}, label(z.hazard)),
          [toned(z.relevance), z.relevance_method === "agent_raised" ? [" ", tag("agent raised", "am")] : null, z.tripwire_promoted ? [" ", tag("tripwire", "er")] : null],
          h("div", { style: "min-width:120px" }, h("div", { class: "mono" }, fmt(z.score)), bar(z.score, 1, z.relevance === "primary" ? "am" : "")),
          h("span", { class: "mono" }, ["structural", "historical", "forecast"].map((c) => (z.components?.[c] === undefined ? "–" : fmt(z.components[c]))).join(" · "), z.forecast_source ? [" ", tag(`forecast: ${z.forecast_source}`, "cy")] : null),
          [z.reason, z.forecast_note ? h("span", { class: "sub" }, z.forecast_note) : null],
        ])),
        eventsBlock(d.active_events),
        subH("Grid cells"),
        h("div", { class: "presets" }, Object.entries(d.location?.cells ?? {}).map(([layer, id]) =>
          h("button", { class: "btn sm quiet", type: "button", title: "Put this id in the cell form below", onclick: () => ctx.set("cell", id) }, `${layer} ${id}`))),
        subH("Data freshness"), kvOf(d.data_freshness),
        warnings(d.warnings)));
  },

  events: (d) => h("div", {}, eventsBlock(d.active_events), subH("Data freshness"), kv([...Object.entries(d.data_freshness ?? {}), ["cache", d.cache]]), warnings(d.warnings)),

  business(d) {
    ctx.set("biz", d.id);
    ctx.set("loan", d.loans?.at(-1)?.id);
    // The advisor reads the same business and loan from the input service
    ctx.set("advBiz", d.id);
    ctx.set("advLoan", d.loans?.at(-1)?.id);
    const p = d.profile ?? {}, loc = d.locations?.primary ?? {};
    // The next step scores this business's own location
    if (typeof loc.lat === "number" && typeof loc.lon === "number") {
      $("f-climate").elements.lat.value = loc.lat;
      $("f-climate").elements.lon.value = loc.lon;
    }
    return h("div", {},
      scoreStrip([
        ["Business", h("span", { style: "font:600 20px var(--sans)" }, p.name ?? "n/a"), label(p.sector ?? "")],
        ["Snapshot", d.latest_snapshot ? `v${d.latest_snapshot.version}` : "none", d.latest_snapshot ? (d.latest_snapshot.verified_by_bank ? "verified" : "unverified") : "add one below"],
        ["Loans", d.loans?.length ?? 0],
        ["Weather profile", h("span", { style: "font-size:16px" }, label(d.impact_profile?.status ?? "none"))],
      ]),
      h("div", { style: "padding-top:16px" },
        kv([["id", d.id], ["source", d.source], ["scoring", isObject(d.scoring) ? JSON.stringify(d.scoring) : d.scoring],
          ["primary location", `${fmt(loc.lat)}, ${fmt(loc.lon)} · ${loc.pincode ?? ""}`], ["consent", fmt(d.consent)]]),
        d.loans?.length ? [subH("Loans"), table(["Loan id", "#Amount", "#EMI", "#Months", "Status", ""], d.loans.map((l) => [
          h("code", {}, l.id), inr(l.amount), inr(l.emi), l.tenure_months, toned(l.status),
          h("button", { class: "btn sm quiet", type: "button", onclick: () => ctx.set("loan", l.id) }, "Use")]))] : null,
        d.latest_snapshot ? [subH("Latest snapshot · derived"), kvOf(d.latest_snapshot.derived)] : null,
        d.impact_profile ? [subH("Weather-impact profile"), RENDER.impact(d.impact_profile)] : null,
        subH("Suppliers"), generic(d.suppliers ?? []),
        subH("Operations"), kvOf(d.operations)));
  },

  snapshot(d) {
    const s = d.snapshot ?? d;
    return h("div", {},
      h("div", { class: "presets" }, tag(`version ${s.version}`, "cy"), tag(s.verified_by_bank ? "verified by bank" : "unverified", s.verified_by_bank ? "ok" : "am"),
        d.scoring !== undefined ? tag(`scoring: ${isObject(d.scoring) ? JSON.stringify(d.scoring) : d.scoring}`) : null),
      subH("Derived by the service"), kvOf(s.derived), subH("As entered"), kvOf({ as_of: s.as_of, ...s.raw }));
  },

  snapshots: (d) => table(["#Version", "As of", "Verified", "#Avg revenue", "#DSCR", "#Volatility", "#Cash buffer days"], (d.snapshots ?? []).map((s) => [
    s.version, s.as_of, s.verified_by_bank ? tag("verified", "ok") : tag("unverified", "am"), inr(s.derived?.avg_revenue), s.derived?.dscr, s.derived?.revenue_volatility, s.derived?.cash_buffer_days])),

  loan(d) {
    const l = d.loan ?? d;
    ctx.set("loan", l.id);
    ctx.set("advBiz", l.business_id);
    ctx.set("advLoan", l.id);
    return h("div", {}, h("div", { class: "presets" }, toned(l.status), d.scoring !== undefined ? tag(`scoring: ${isObject(d.scoring) ? JSON.stringify(d.scoring) : d.scoring}`) : null), kvOf(l));
  },

  impact(d) {
    const head = h("div", { class: "presets" }, toned(d.status), tag(`version ${d.version}`, "cy"), d.category ? tag(label(d.category)) : null,
      d.overall_confidence !== null && d.overall_confidence !== undefined ? tag(`confidence ${d.overall_confidence}`) : null);
    if (!d.conditions) return h("div", {}, head, note("", "The classifier is still running. Finance uses the sector defaults until it finishes."));
    return h("div", {}, head,
      table(["Hazard", "Physical · 0 to 1", "#Demand", "Mechanism", "#Confidence", "Source", "Reason"], Object.entries(d.conditions).map(([hazard, c]) => [
        h("b", {}, label(hazard)),
        h("div", { style: "min-width:110px" }, h("div", { class: "mono" }, fmt(c.physical)), bar(c.physical, 1, "am")),
        h("span", { class: c.demand > 0 ? "cyan" : c.demand < 0 ? "amber" : "" }, `${c.demand > 0 ? "+" : ""}${fmt(c.demand)}`),
        label(c.mechanism), c.confidence, toned(c.source), c.reason])),
      d.override_reason ? note("", `Overridden: ${d.override_reason}`) : null, d.note ? note("", d.note) : null);
  },

  finance(d) {
    if (!isObject(d.baseline)) return generic(d);
    const m = d.metrics ?? {};
    return h("div", {},
      scoreStrip([
        ["Baseline score", fmt(d.baseline.score), [toned(d.baseline.band), ` ${d.baseline.source ?? ""}`]],
        ["Climate-adjusted", d.adjusted ? fmt(d.adjusted.score) : "n/a", d.adjusted ? toned(d.adjusted.band) : "climate unavailable"],
        ["Climate grade", d.climate ? gradeCell(d.climate.grade) : "n/a", d.climate ? `risk ${fmt(d.climate.overall_climate_risk)}` : null],
        ["DSCR", fmt(m.dscr), "cash flow ÷ repayments"],
      ]),
      h("div", { style: "padding-top:16px" },
        d.summary ? h("p", { style: "margin-bottom:6px" }, d.summary) : null,
        h("div", { class: "grid2", style: "margin-top:10px" },
          h("div", {}, subH("Baseline sub-scores · 0 to 100"), Object.entries(d.baseline.sub_scores ?? {}).map(([k, v]) => barRow(k, v, 100))),
          h("div", {}, subH("What moved the score"), d.adjusted?.drivers?.length
            ? h("ul", { class: "plain" }, d.adjusted.drivers.map((x) => h("li", {}, h("b", { class: x.points_change < 0 ? "amber mono" : "cyan mono" }, `${x.points_change > 0 ? "+" : ""}${x.points_change} `), x.reason)))
            : h("p", { class: "muted" }, "No hazard moved the score."))),
        Object.keys(d.stress ?? {}).length ? [subH("Stress test · one row per hazard"),
          table(["Hazard", "#Severity", "#Shock", "#Before insurance", "Insurance", "#Stressed revenue", "#Stressed DSCR", "Breach"], Object.entries(d.stress).map(([hazard, s]) => [
            h("b", {}, label(hazard)), s.severity, `${s.shock_pct}%`, `${s.gross_shock_pct}%`, s.insurance_applied?.length ? s.insurance_applied.join(", ") : "none",
            inr(s.stressed_metrics?.monthly_revenue), s.stressed_metrics?.dscr,
            s.breach ? [tag("breach", "er"), h("span", { class: "sub" }, fmt(s.breach_reasons))] : tag("holds", "ok")]))] : null,
        isObject(d.sensitivity?.hazards) ? [subH(`Weather sensitivity · source: ${d.sensitivity.source}`),
          table(["Hazard", "Direction", "#Magnitude", "#Physical", "#Demand", "Channels", "Reason"], Object.entries(d.sensitivity.hazards).map(([hazard, s]) => [
            h("b", {}, label(hazard)), toned(s.direction), s.magnitude, s.physical, s.demand, fmt(s.channels), s.reason]))] : null,
        h("div", { class: "grid2", style: "margin-top:4px" },
          h("div", {}, subH("Metrics"), kvOf(m)),
          h("div", {}, subH("Computed from"), kvOf(d.inputs), kv([["model version", d.model_version], ["generated at", d.generated_at], d.climate ? ["climate profile", d.climate.profile_ref] : null]))),
        warnings(d.warnings)));
  },

  history(d) {
    const rows = Array.isArray(d) ? d : Object.values(d).find(Array.isArray) ?? [];
    return rows.length ? generic(rows) : h("p", { class: "muted" }, "No stored profiles yet. Compute one first.");
  },

  alerts(d) {
    if (!d.alerts?.length) return h("p", { class: "muted" }, "The outbox is empty. Run the monitor, the simulation or npm run alerts:test to queue one.");
    return h("div", {}, d.alerts.map((a) => h("div", { class: "note", style: "padding:0" },
      h("div", { class: "panel-h", style: "border-bottom:1px solid var(--rule)" },
        h("span", { class: "ep" }, `#${a.id} · ${a.business_name ?? a.business_id}`),
        h("span", {}, toned(a.severity), " ", tag(label(a.hazard)), " ", toned(a.status))),
      h("div", { style: "padding:12px 14px" },
        kv([["created", a.created_at], ["audience · channel", `${a.audience} · ${a.channel}`], ["window", a.window_start ? `${a.window_start} → ${a.window_end}` : null],
          ["attempts", a.attempts], ["evidence", a.evidence], a.note ? ["note", a.note] : null]),
        a.deliveries?.length ? a.deliveries.map((x) => h("details", { class: "raw", style: "margin-top:8px;border:1px solid var(--rule)" },
          h("summary", {}, `${x.result} · ${x.provider} · ${x.sent_at}${x.subject ? ` · ${x.subject}` : ""}`),
          h("pre", {}, x.error ? `error: ${x.error}\n\n` : "", x.body ?? "No body stored."))) : h("p", { class: "muted", style: "font-size:13px;margin-top:8px" }, "No send attempts.")))));
  },

  advBusinesses: (d) => table(["Id", "Name", "Sector", "City", "Loans", ""], (d.businesses ?? []).map((b) => [
    h("code", {}, b.id), h("b", {}, b.name), b.sector, b.city, h("code", {}, fmt(b.loans)),
    h("button", { class: "btn sm quiet", type: "button", onclick: () => { ctx.set("advBiz", b.id); ctx.set("advLoan", b.loans?.[0]); } }, "Use")])),

  turn(d) {
    ctx.set("conv", d.conversationId);
    ctx.set("proposal", d.proposal?.id);
    return h("div", {},
      h("div", { class: "presets" }, d.mode ? tag(`mode: ${d.mode}`, "cy") : null, d.loanState ? tag(`loan: ${d.loanState}`) : null,
        tag(`${d.toolCalls?.length ?? 0} tool calls`), tag(`${d.citations?.length ?? 0} citations`)),
      d.reply ? h("div", { class: "msg", style: "max-width:none" }, d.reply) : null,
      d.proposal ? [subH("Proposal for the bank"), kvOf(d.proposal)] : null,
      d.toolCalls?.length ? [subH("Tool calls"), generic(d.toolCalls)] : null,
      d.structured ? [subH("Structured answer"), generic(d.structured)] : null,
      warnings(d.warnings));
  },

  // Under the chat, where the reply itself is already in the log
  chatMeta: (d) => h("div", {},
    d.proposal ? [subH("Proposal for the bank"), kvOf(d.proposal)] : null,
    d.toolCalls?.length ? [subH("Tool calls"), generic(d.toolCalls)] : h("p", { class: "muted", style: "font-size:13px" }, "No tool calls in this turn."),
    warnings(d.warnings)),

  conversations(d) {
    if (!d.conversations?.length) return h("p", { class: "muted" }, "No conversations stored for this business.");
    return h("div", {}, d.conversations.map((c) => h("div", { style: "margin-bottom:16px" },
      subH(`${c.id} · ${c.createdAt ?? ""} · ${c.toolCalls?.length ?? 0} tool calls`),
      h("div", { class: "chat", style: "padding:0;max-height:none" }, (c.messages ?? []).map((m) => bubble(m.role === "user" ? "me" : "", m.role, m.content,
        m.citations?.length ? [tag(`${m.citations.length} citations`, "cy")] : null))))));
  },
};

// ── Forms ────────────────────────────────────────────────────────────────────

function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value;
    else node = node[key] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
  });
}

// Reads a form into { params, body }. Blank optional fields are left out,
// because the API rejects empty strings where it expects a value or nothing.
function readForm(form) {
  const params = {}, body = {};
  let whole;
  for (const el of form.elements) {
    if (!el.name || el.tagName === "BUTTON" || el.hasAttribute("data-skip")) continue;
    const raw = el.value.trim();
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (raw === "") continue;
    else if (el.dataset.t === "num") value = Number(raw);
    else if (el.dataset.t === "csv") value = raw.split(",").map((s) => s.trim()).filter(Boolean);
    else if (el.dataset.t === "csvnum") value = raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    else if (el.dataset.t === "json") {
      try { value = JSON.parse(raw); } catch (error) { throw new Error(`${el.closest("label")?.querySelector("span")?.firstChild?.textContent?.trim() ?? el.name} is not valid JSON: ${error.message}`); }
    } else value = raw;

    if (el.name.startsWith(":")) params[el.name.slice(1)] = value;
    else if (el.name === "$body") whole = value;
    else setPath(body, el.name, value);
  }
  // A supplier row left blank leaves a hole in its list
  for (const [key, value] of Object.entries(body)) if (Array.isArray(value)) body[key] = value.filter((item) => item !== undefined);
  return { params, body, whole };
}

async function submitForm(form, button) {
  const out = form.closest(".panel")?.querySelector(".out");
  const call = button?.dataset.call ?? form.dataset.call ?? form.elements[form.dataset.callFrom]?.value;
  const renderer = button?.dataset.call ? button.dataset.render : (button?.dataset.render ?? form.dataset.render);
  const [method, template] = call.split(" ");
  let input;
  try {
    input = readForm(form);
  } catch (error) {
    out.replaceChildren(h("div", { class: "out-b" }, note("err", h("b", {}, "NOT SENT "), error.message)));
    return null;
  }
  const missing = [];
  let path = template.replace(/:(\w+)/g, (_, name) => {
    if (input.params[name] === undefined) missing.push(name);
    return encodeURIComponent(input.params[name] ?? "");
  });
  if (missing.length) {
    out.replaceChildren(h("div", { class: "out-b" }, note("err", h("b", {}, "NOT SENT "), `Fill in: ${missing.join(", ")}.`)));
    return null;
  }
  let body;
  const bare = button?.hasAttribute("data-nobody");
  if (method === "GET") {
    const query = bare ? "" : new URLSearchParams(Object.entries(input.body).filter(([, v]) => !isObject(v))).toString();
    if (query) path += `?${query}`;
  } else if (!bare) {
    body = input.whole ?? input.body;
  }
  if (button) button.disabled = true;
  out.replaceChildren(h("div", { class: "out-b muted mono", style: "font-size:13px" }, `${method} ${path} …`));
  const result = await api(method, path, body);
  if (button) button.disabled = false;
  show(out, result, renderer);
  // Ids the next form needs
  if (result.ok && isObject(result.data)) {
    ctx.set("alertId", result.data.event?.alertId);
    ctx.set("proposal", result.data.proposal?.id);
  }
  if (template.startsWith("/auth/")) loadAccount();
  if (result.ok) markDone(form.closest(".step")?.id);
  return result;
}

function markDone(stepId) {
  if (stepId) document.querySelector(`#rail a[href="#${stepId}"]`)?.classList.add("done");
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("form[data-call], form[data-call-from]")) return;
  event.preventDefault();
  submitForm(form, event.submitter);
});

// ── Chat ─────────────────────────────────────────────────────────────────────

function bubble(kind, by, text, extras) {
  return h("div", { class: `msg ${kind}` }, h("span", { class: "by" }, by), text, extras ? h("div", { class: "extras" }, extras) : null);
}

async function sendChat(message) {
  const log = $("chat-log");
  log.append(bubble("me", "you", message));
  log.scrollTop = log.scrollHeight;
  $("chat-who").textContent = [$("chat-biz").value.trim(), $("chat-loan").value.trim()].filter(Boolean).join(" · ");
  const body = { businessId: $("chat-biz").value.trim(), message };
  if ($("chat-loan").value.trim()) body.loanId = $("chat-loan").value.trim();
  if ($("chat-conv").value.trim()) body.conversationId = $("chat-conv").value.trim();
  const r = await api("POST", "/advisor/chat", body);
  if (r.ok && isObject(r.data)) {
    const d = r.data;
    ctx.set("conv", d.conversationId);
    ctx.set("proposal", d.proposal?.id);
    log.append(bubble("", `advisor${r.source === "sample" ? " · sample" : ""}`, d.reply, [
      d.mode ? tag(`mode: ${d.mode}`, "cy") : null, d.loanState ? tag(`loan: ${d.loanState}`) : null,
      tag(`${d.toolCalls?.length ?? 0} tool calls`), tag(`${d.citations?.length ?? 0} citations`),
      d.warnings?.length ? tag(`${d.warnings.length} warnings`, "am") : null,
      d.proposal ? tag("proposal sent to bank", "am") : null]));
    log.scrollTop = log.scrollHeight;
  }
  if (r.ok) markDone("s-event");
  show($("chat-out"), r, "chatMeta");
}

// ── Session ──────────────────────────────────────────────────────────────────

function drawAccount() {
  const user = state.user;
  $("account").replaceChildren(...(user
    ? [h("span", {}, user.email), h("span", { class: `role ${user.role === "bank" ? "bank" : ""}` }, user.role)]
    : [h("a", { href: "#s-signin", class: "chip", style: "text-decoration:none" }, state.mode === "sample" ? "Sample viewer" : "Sign in")]));
  drawStatus();
}

function drawStatus() {
  const hl = state.health;
  const dot = (cls, text) => h("span", { style: "display:inline-flex;align-items:center;gap:8px" }, h("span", { class: `dot ${cls}` }), text);
  $("status").replaceChildren(...kv([
    ["API", state.reachable === null ? dot("", "checking") : !state.reachable ? dot("bad", "not reachable") : dot(hl?.status === "ok" ? "ok" : "warn", hl?.status ?? "answered")],
    ["Database", hl?.db ?? "n/a"],
    ["Open-Meteo", hl?.upstream?.open_meteo?.state ?? "n/a"],
    ["Session", state.user ? `${state.user.role} · ${state.user.email}` : "not signed in"],
    ["Answers from", state.mode === "sample" ? h("span", { class: "amber" }, "built-in samples") : state.base],
  ]).children);
}

async function onCredential(response) {
  const r = await api("POST", "/auth/google", { credential: response.credential });
  // The token is in the body the wire log kept; drop it
  r.body = { credential: "(Google ID token)" };
  if (!r.ok) show($("gsi").closest(".panel").querySelector(".out"), r);
  await loadAccount();
}

async function loadAccount() {
  if (state.mode === "sample") { state.user = null; drawAccount(); return; }
  const me = await api("GET", "/auth/me");
  state.user = me.ok ? (me.data?.user ?? me.data) : null;
  drawAccount();
  const gsi = $("gsi");
  if (state.user) { gsi.replaceChildren(note("", `Signed in as ${state.user.email}, role ${state.user.role}.`)); return; }
  const config = await api("GET", "/auth/config");
  const clientId = config.data?.google_client_id;
  if (!clientId) {
    gsi.replaceChildren(note("", config.ok ? "Sign-in is not configured: GOOGLE_CLIENT_ID is blank in api/.env, so every protected route answers 401." : "The sign-in settings could not be read from the API."));
    return;
  }
  const draw = () => {
    gsi.replaceChildren();
    google.accounts.id.initialize({ client_id: clientId, callback: onCredential });
    google.accounts.id.renderButton(gsi, { theme: "outline", size: "large", shape: "rectangular" });
  };
  if (window.google?.accounts) draw();
  else document.head.append(h("script", { src: "https://accounts.google.com/gsi/client", async: true, onload: draw,
    onerror: () => gsi.replaceChildren(note("err", "Google's sign-in script could not be loaded.")) }));
}

// ── Mode: live API or built-in samples ───────────────────────────────────────

function drawMode() {
  const sample = state.mode === "sample";
  $("mode-dot").className = `dot ${sample ? "warn" : "ok"}`;
  $("mode-label").textContent = sample ? "Sample data" : "Live API";
  const banner = $("banner");
  banner.hidden = !sample;
  if (sample) {
    banner.replaceChildren(h("b", {}, "SAMPLE DATA"),
      state.reachable === false ? `The API at ${state.base} did not answer. ` : "",
      "Reads show built-in sample answers and writes are not sent. ",
      location.protocol === "file:" ? "This page was opened from disk; serve it on http://localhost:3000 so the API accepts its requests. " : "",
      "Start the API with npm run dev inside api/, then click the mode button.");
  }
}

async function goLive() {
  state.mode = "live";
  const health = await api("GET", "/health", undefined, { live: true });
  state.reachable = !health.network;
  state.health = isObject(health.data) ? health.data : null;
  if (!state.reachable) state.mode = "sample";
  drawMode();
  await loadAccount();
}

// ── Static pieces drawn once ─────────────────────────────────────────────────

// The same outline of India as the design, one square per illustrative cell
function drawIndia() {
  const SHAPE = ["........XXX", ".......XXXX", "......XXXXXX", ".....XXXXXXX", ".....XXXXXXXX", "....XXXXXXXXXX.....XXXX", "...XXXXXXXXXXXXX.XXXXXXX", "..XXXXXXXXXXXXXXXXXXXXX", ".XXXXXXXXXXXXXXXXX.XXX", "XXXXXXXXXXXXXXXXXX..X", ".XXXXXXXXXXXXXXXXX", "..XXXXXXXXXXXXXXX", "..XXXXXXXXXXXXXX", "...XXXXXXXXXXXX", "....XXXXXXXXXX", "....XXXXXXXXXX", ".....XXXXXXXX", ".....XXXXXXXX", "......XXXXXX", "......XXXXXX", ".......XXXX", ".......XXXX", "........XX", "........X"];
  $("india").replaceChildren(...SHAPE.map((line, r) => h("div", {}, [...line.padEnd(24, ".")].map((ch, c) => {
    if (ch !== "X") return h("i", {});
    let heat = (r * 31 + c * 17 + ((r * c) % 7)) % 9;
    if (c >= 17) heat += 4;
    if (r >= 12 && (c <= 6 || c >= 12)) heat += 2;
    if (r >= 7 && r <= 11 && c <= 5) heat += 2;
    return h("i", { class: `g-${"ABCDE"[Math.min(4, Math.floor(heat / 3))]}` });
  }))));
}

const CITIES = [["Guwahati", 26.1445, 91.7362], ["Mumbai", 19.076, 72.8777], ["Delhi", 28.6139, 77.209], ["Chennai", 13.0827, 80.2707],
  ["Jaisalmer", 26.9157, 70.9083], ["Srinagar", 34.0837, 74.7973], ["Puri", 19.8135, 85.8312], ["Bengaluru", 12.9716, 77.5946]];

const EDIT_EXAMPLES = {
  "PATCH /businesses/:id": { profile: { employees: 8 }, operations: { has_backup_power: true } },
  "PUT /businesses/:id/locations": { primary: { lat: 13.0827, lon: 80.2707, address: "12 NSC Bose Road, George Town, Chennai", pincode: "600001", floor: "upper" }, additional_locations: [] },
  "PUT /businesses/:id/suppliers": { suppliers: [{ name: "Annai Flour Mills", lat: 13.05, lon: 80.21, share: 1 }] },
};

// Requests that are meant to fail, to show the one error shape
const ERROR_TRIES = [
  ["Latitude 120", "POST", "/climate/profile", { lat: 120, lon: 77 }],
  ["Longitude missing", "POST", "/climate/profile", { lat: 20 }],
  ["Outside India", "POST", "/climate/profile", { lat: 51.5, lon: -0.12 }],
  ["Malformed cell id", "GET", "/climate/cell/not-a-cell"],
  ["Unknown route", "GET", "/nope"],
  ["Bank-only route", "GET", "/alerts"],
  ["Write without a key", "POST", "/businesses", {}, { noKey: true }],
];

function drawStatic() {
  drawIndia();
  const climateForm = $("f-climate");
  $("city-presets").replaceChildren(...CITIES.map(([name, lat, lon]) => h("button", { class: "btn sm quiet", type: "button", onclick: () => {
    climateForm.elements.lat.value = lat;
    climateForm.elements.lon.value = lon;
  } }, name)));

  const op = $("edit-op"), editBody = $("edit-body");
  const fill = () => { editBody.value = JSON.stringify(EDIT_EXAMPLES[op.value], null, 2); };
  op.addEventListener("change", fill);
  fill();

  $("chat-prompts").replaceChildren(...["Should I take a ₹3L loan?", "Heavy rain is forecast. What should I do?", "My shop flooded. What are my options?"].map((text) =>
    h("button", { class: "btn sm quiet", type: "button", onclick: () => sendChat(text) }, text)));
  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("chat-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    sendChat(message);
  });

  $("error-tries").replaceChildren(...ERROR_TRIES.map(([name, method, path, body, options]) => h("button", { class: "btn sm quiet", type: "button",
    onclick: async () => show($("error-out"), await api(method, path, body, { ...options, noSample: true })) }, name)));

  $("idem-btn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const key = newKey();
    const guwahati = { lat: 26.1445, lon: 91.7362 }, delhi = { lat: 28.6139, lon: 77.209 };
    const runs = [];
    for (const [what, body] of [["First request", guwahati], ["Same key, same body", guwahati], ["Same key, different body", delhi]]) {
      runs.push([what, await api("POST", "/climate/profile", body, { key })]);
    }
    button.disabled = false;
    $("idem-out").replaceChildren(h("div", { class: "out-b" },
      runs[0][1].source === "sample" ? [note("sample", h("b", {}, "SAMPLE "), "Sample mode cannot replay anything. Run this against the live API."), h("div", { style: "height:12px" })] : null,
      h("p", { class: "mono muted", style: "font-size:12px;margin-bottom:8px" }, `Idempotency-Key: ${key}`),
      table(["Request", "Status", "Replayed", "#ms", "Code"], runs.map(([what, r]) => [
        what, r.network ? "no answer" : r.status, r.headers.replayed ? tag("replayed", "am") : "no", r.ms,
        r.ok ? `grade ${r.data?.grade ?? "n/a"}` : (r.data?.error?.code ?? "n/a")]))));
  });

  $("signout-btn").addEventListener("click", async () => {
    await api("POST", "/auth/logout");
    await loadAccount();
  });

  for (const input of document.querySelectorAll("[data-bind]")) {
    const key = input.dataset.bind;
    const kept = store.get(`ctx.${key}`);
    if (kept) input.value = kept;
    input.addEventListener("input", () => ctx.set(key, input.value.trim()));
  }
  $("chat-who").textContent = [$("chat-biz").value, $("chat-loan").value].filter(Boolean).join(" · ");
}

// ── Shell: views, theme, API address, wire log ───────────────────────────────

// The rail highlights the step on screen
function watchSteps() {
  const links = new Map([...document.querySelectorAll("#rail a")].map((a) => [a.getAttribute("href").slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of links.values()) link.removeAttribute("aria-current");
      links.get(entry.target.id)?.setAttribute("aria-current", "step");
    }
  }, { rootMargin: "-20% 0px -70% 0px" });
  for (const step of document.querySelectorAll(".step")) observer.observe(step);
}

// ── The whole workflow, in order ─────────────────────────────────────────────
// Each entry is a form on the page; running it is the same as pressing its
// first button. The run stops at the first step that fails, so a refusal
// (a missing session, an owner on a bank route) is shown where it happened.

const WORKFLOW = [
  ["f-business", "Business applies"],
  ["f-impact", "Weather-impact profile"],
  ["f-climate", "Climate risk at its location"],
  ["f-snapshot", "Financial snapshot"],
  ["f-loan", "Bank records the loan"],
  ["f-finance", "Finance profile"],
  ["f-status", "Bank authorises"],
  ["f-alerts", "Alert outbox"],
  ["f-fake-alert", "Test alert reaches the advisor"],
];

async function runWorkflow() {
  const button = $("run-btn"), status = $("run-status");
  const say = (...kids) => status.replaceChildren(...kids);
  button.disabled = true;
  $("f-status").elements.status.value = "authorised";
  let n = 0;
  for (const [formId, name] of WORKFLOW) {
    n += 1;
    const form = $(formId);
    say(tag(`${n} of ${WORKFLOW.length + 1}`, "cy"), ` ${name} …`);
    form.closest(".step").scrollIntoView({ behavior: "smooth", block: "start" });
    const result = await submitForm(form, form.querySelector("button:not([type=button])"));
    if (!result?.ok) {
      const code = result?.data?.error?.code ?? (result?.network ? "no answer" : result?.notSent ? "not sent" : "not sent: a field is missing");
      say(tag("stopped", "er"), ` at “${name}”: ${code}. The answer is shown in that step; fix it and run again, or carry on by hand from there.`);
      form.closest(".panel").scrollIntoView({ behavior: "smooth", block: "center" });
      button.disabled = false;
      return;
    }
  }
  say(tag(`${n + 1} of ${WORKFLOW.length + 1}`, "cy"), " Owner asks the advisor …");
  await sendChat("Heavy rain is forecast. What should I do?");
  say(tag("done", "ok"), ` ${WORKFLOW.length + 1} steps ran${state.mode === "sample" ? " on sample answers" : ""}. Continue in step 08: report damage, then decide the proposal as the bank.`);
  button.disabled = false;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-btn").textContent = theme === "light" ? "Dark" : "Light";
  store.set("theme", theme);
}

function start() {
  applyTheme(store.get("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  $("theme-btn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

  const base = $("api-base");
  base.value = state.base;
  base.addEventListener("change", () => {
    state.base = base.value.trim().replace(/\/+$/, "");
    base.value = state.base;
    store.set("base", state.base);
    goLive();
  });

  $("mode-btn").addEventListener("click", () => {
    if (state.mode === "sample") goLive();
    else { state.mode = "sample"; drawMode(); loadAccount(); }
  });

  $("wire-toggle").addEventListener("click", () => {
    const body = $("wire-body");
    body.hidden = !body.hidden;
    $("wire-toggle").setAttribute("aria-expanded", String(!body.hidden));
    $("wire-caret").textContent = body.hidden ? "▲ open" : "▼ close";
  });

  drawStatic();
  drawAccount();
  watchSteps();
  $("run-btn").addEventListener("click", runWorkflow);
  goLive();
}

start();
