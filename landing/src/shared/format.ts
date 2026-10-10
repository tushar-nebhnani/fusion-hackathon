// Turning the API's values into plain words for people

export const HAZARDS = ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"] as const;
export const HAZARD_NAMES: Record<string, string> = {
  river_flood: "River flooding", flash_flood: "Flash floods", heat: "Heatwaves",
  drought: "Drought", storm: "Storms and cyclones", cold_wave: "Cold waves",
};
export const SECTORS = ["retail", "apparel_footwear", "food_beverage", "food_processing", "delivery_ecommerce", "agriculture", "construction", "manufacturing",
  "hospitality_tourism", "logistics", "entertainment_leisure", "healthcare_pharmacy", "home_improvement", "automotive", "other"];
const SECTOR_NAMES: Record<string, string> = {
  food_beverage: "Food and drink", apparel_footwear: "Clothes and footwear", delivery_ecommerce: "Delivery and online selling",
  hospitality_tourism: "Hotels and tourism", entertainment_leisure: "Entertainment and leisure", healthcare_pharmacy: "Healthcare and pharmacy",
};
export const GRADE_NAMES: Record<string, string> = { A: "Stable", B: "Watch", C: "Exposed", D: "High", E: "Critical" };
export const SEVERITIES: Record<string, string> = { watch: "Watch", warning: "Warning", severe: "Severe" };
export const LOAN_STATUS: Record<string, string> = { applied: "Applied", authorised: "Approved", active: "Active", closed: "Closed", rejected: "Rejected" };
export const LOAN_STAGE: Record<string, string> = { PRE_LOAN: "Not paid out yet", ACTIVE: "Active", ALERT: "Weather alert in force", IMPACTED: "Hit by bad weather", RECOVERY: "On a recovery plan" };
export const RATINGS: Record<string, [string, string]> = { acceptable: ["Good", "ok"], caution: ["Needs care", "am"], high_risk: ["High risk", "er"], decline: ["Not recommended", "er"] };
export const ALERT_STATUS: Record<string, string> = { sent: "Sent", pending: "Waiting to send", sending: "Sending", suppressed: "Not sent: already alerted recently", failed: "Could not be sent", dead: "Could not be sent" };

export const label = (key: unknown) => String(key ?? "").replace(/_/g, " ");
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const nice = (key: unknown) => cap(label(key));
export const hazardName = (key: string) => HAZARD_NAMES[key] ?? nice(key);
export const sectorName = (key: string) => SECTOR_NAMES[key] ?? nice(key);

export function fmt(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-IN") : String(+value.toFixed(4));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.map(fmt).join(", ") : "none";
  return String(value);
}
export const ratio = (v: unknown) => fmt(typeof v === "number" ? +v.toFixed(1) : v);
export const inr = (v: unknown) => (typeof v === "number" ? `₹${Math.round(v).toLocaleString("en-IN")}` : "n/a");
export const pct = (v: unknown) => (typeof v === "number" ? `${+(v * 100).toFixed(1)}%` : "n/a");
export const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "n/a");
export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export const daysAhead = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

// Sentences the services write can carry internal words: grid cell ids and
// snake_case values such as low_risk. People get them as plain words.
export const tidy = (t: unknown) => String(t ?? "").replace(/\s*at cell \S+/g, "").replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => w.replace(/_/g, " "));
// A warning reads "code: explanation"; only the explanation is for people
export const plainWarning = (w: unknown) => cap(tidy(String(w).replace(/^[a-z_]+:\s*/, "")));

// A 0 to 1 hazard score in words, with its tag tone
export function level(score: unknown): [string, string] {
  if (typeof score !== "number") return ["Unknown", ""];
  if (score < 0.25) return ["Low", "ok"];
  if (score < 0.5) return ["Moderate", "cy"];
  if (score < 0.75) return ["High", "am"];
  return ["Very high", "er"];
}
