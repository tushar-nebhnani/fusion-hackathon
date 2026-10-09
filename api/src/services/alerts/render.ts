import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OutboundMessage } from "./senders/Sender.js";
import type { AlertEvent, Audience, Hazard, Language, Severity } from "./types.js";

const byLanguage = z.record(z.string(), z.string());

const guidelinesSchema = z.object({
  labels: z.record(z.string(), byLanguage),
  // One short sentence of steps per hazard, for languages without a full list
  steps: z.record(z.string(), byLanguage),
  hazards: z.record(
    z.string(),
    z.record(z.string(), z.object({ owner: z.array(z.string()), bank: z.array(z.string()) })),
  ),
  sectors: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
});

interface Template {
  subject: string;
  body: string;
  html: boolean;
}

export interface Content {
  guidelines: z.infer<typeof guidelinesSchema>;
  // Keyed by file name without extension, e.g. "email_owner_hi"
  templates: Map<string, Template>;
}

export interface AlertBusinessInfo {
  id: string;
  name: string;
  city: string;
  sector?: string | null;
}

export type RenderedMessage = Omit<OutboundMessage, "to">;

// Both flood hazards share one set of guidelines and one label
const GROUP: Record<Hazard, string> = {
  flood: "flood",
  river_flood: "flood",
  flash_flood: "flood",
  heat: "heat",
  drought: "drought",
  storm: "storm",
  cold_wave: "cold_wave",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// tsc does not copy the content files to dist/, so a compiled build reads
// them from src/
function contentDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  if (existsSync(path.join(here, "guidelines.json"))) return here;
  return here.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`);
}

function parseTemplate(text: string, html: boolean): Template {
  const match = /^Subject: (.*)\r?\n/.exec(text);
  return match
    ? { subject: (match[1] ?? "").trim(), body: text.slice(match[0].length).trim(), html }
    : { subject: "", body: text.trim(), html };
}

// Guidelines and templates are content, not code: they are read from disk
// when the worker starts, so they can be edited without touching it.
export function loadContent(dir = contentDir()): Content {
  const guidelines = guidelinesSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "guidelines.json"), "utf8")),
  );
  const templates = new Map<string, Template>();
  const templateDir = path.join(dir, "templates");
  for (const file of readdirSync(templateDir)) {
    const { name, ext } = path.parse(file);
    if (ext !== ".txt" && ext !== ".html") continue;
    const text = readFileSync(path.join(templateDir, file), "utf8");
    templates.set(name, parseTemplate(text, ext === ".html"));
  }
  return { guidelines, templates };
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

// Replaces {placeholder} fields. `raw` values are markup built here and go
// in as they are; everything else is escaped in an HTML template.
function fill(
  text: string,
  values: Record<string, string>,
  raw: Record<string, string>,
  html: boolean,
): string {
  return text.replace(/\{(\w+)\}/g, (field, key: string) => {
    if (key in raw) return raw[key] ?? "";
    const value = values[key];
    if (value === undefined) return field;
    return html ? escapeHtml(value) : value;
  });
}

function dateParts(isoDate: string): { day: number; month: number } {
  const [, month, day] = isoDate.split("-").map(Number);
  return { day: day ?? 1, month: month ?? 1 };
}

// "12–14 Oct", "12 Oct" or "30 Sep – 2 Oct"
export function formatWindow(start: string, end: string): string {
  const from = dateParts(start);
  const to = dateParts(end);
  const name = (part: { day: number; month: number }) =>
    `${part.day} ${MONTHS[part.month - 1] ?? ""}`;
  if (start === end) return name(from);
  if (from.month === to.month) return `${from.day}–${name(to)}`;
  return `${name(from)} – ${name(to)}`;
}

// Falls back to English, and says so, so that labels and steps are filled in
// the language of the template that was actually found
function template(
  content: Content,
  name: string,
  wanted: Language,
): { chosen: Template; language: Language } {
  const exact = content.templates.get(`${name}_${wanted}`);
  if (exact) return { chosen: exact, language: wanted };
  const english = content.templates.get(`${name}_en`);
  if (!english) throw new Error(`No template named ${name}_${wanted} or ${name}_en`);
  return { chosen: english, language: "en" };
}

function localized(table: Record<string, Record<string, string>>, group: string, language: Language) {
  return table[group]?.[language] ?? table[group]?.en ?? "";
}

function guidelineList(
  content: Content,
  hazard: Hazard,
  severity: Severity,
  audience: Audience,
  sector?: string | null,
): string[] {
  const group = GROUP[hazard];
  const base = content.guidelines.hazards[group]?.[severity]?.[audience] ?? [];
  const extras =
    audience === "owner" && sector
      ? (content.guidelines.sectors[sector.toLowerCase()]?.[group] ?? [])
      : [];
  return [...base, ...extras];
}

const borrowerUrl = (dashboardUrl: string, businessId: string) =>
  `${dashboardUrl}/borrowers/${encodeURIComponent(businessId)}`;

const htmlList = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");

export interface RenderInput {
  audience: Audience;
  language: Language;
  event: AlertEvent;
  business: AlertBusinessInfo;
  dashboardUrl: string;
}

// Messages carry no scores, loan amounts or account details: the bank email
// links to the dashboard instead.
export function renderAlert(content: Content, input: RenderInput): RenderedMessage {
  const { audience, event, business } = input;
  const { chosen, language } = template(content, `email_${audience}`, input.language);
  const group = GROUP[event.hazard];
  const list = guidelineList(content, event.hazard, event.severity, audience, business.sector);

  const values = {
    hazardLabel: localized(content.guidelines.labels, group, language) || group,
    businessName: business.name,
    businessId: business.id,
    city: business.city,
    window: formatWindow(event.windowStart, event.windowEnd),
    severity: event.severity,
    evidence: event.evidence,
    steps: localized(content.guidelines.steps, group, language),
    dashboardUrl: borrowerUrl(input.dashboardUrl, business.id),
  };
  const raw = {
    guidelines: chosen.html ? htmlList(list) : list.map((item) => `- ${item}`).join("\n"),
  };

  return {
    subject: fill(chosen.subject, values, {}, false),
    body: fill(chosen.body, values, raw, chosen.html),
    html: chosen.html,
  };
}

// One email for all of the bank's WATCH alerts of the day
export function renderDigest(
  content: Content,
  alerts: readonly { event: AlertEvent; business: AlertBusinessInfo }[],
  context: { dashboardUrl: string; date: string },
): RenderedMessage {
  const { chosen } = template(content, "email_bank_digest", "en");
  const items = alerts
    .map(({ event, business }) => {
      const label = localized(content.guidelines.labels, GROUP[event.hazard], "en");
      const window = formatWindow(event.windowStart, event.windowEnd);
      const list = guidelineList(content, event.hazard, event.severity, "bank");
      return [
        `<li><strong>${escapeHtml(`${business.id} ${business.name}, ${business.city}`)}</strong>: `,
        `${escapeHtml(`${label}, ${window}. ${event.evidence}`)} `,
        `<a href="${escapeHtml(borrowerUrl(context.dashboardUrl, business.id))}">Open borrower page</a>`,
        `<ul>\n${htmlList(list)}\n</ul></li>`,
      ].join("");
    })
    .join("\n");

  const values = {
    count: alerts.length === 1 ? "1 alert" : `${alerts.length} alerts`,
    date: context.date,
  };
  return {
    subject: fill(chosen.subject, values, {}, false),
    body: fill(chosen.body, values, { items }, chosen.html),
    html: chosen.html,
  };
}
