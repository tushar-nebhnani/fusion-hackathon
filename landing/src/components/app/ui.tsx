import type { ReactNode } from "react";
import type { ApiResult } from "../../shared/api";
import { fmt, GRADE_NAMES, nice } from "../../shared/format";

// Small building blocks shared by the Playground and Analysis pages

export const Tag = ({ tone = "", children }: { tone?: string; children: ReactNode }) => <span className={`tag ${tone}`}>{children}</span>;

export const Note = ({ err = false, children }: { err?: boolean; children: ReactNode }) => <div className={`k-note ${err ? "err" : ""}`}>{children}</div>;

export const SubHead = ({ children }: { children: ReactNode }) => <div className="k-sub">{children}</div>;

export function Bar({ value, tone = "" }: { value: number; tone?: string }) {
  const width = Math.max(0, Math.min(1, value)) * 100;
  return <div className={`k-bar ${tone}`} role="img" aria-label={`${Math.round(width)} out of 100`}><i style={{ width: `${width}%` }} /></div>;
}

// A row of big figures: [label, value, small print]
export function Strip({ cells }: { cells: [string, ReactNode, ReactNode?][] }) {
  return (
    <div className="k-strip">
      {cells.map(([name, value, small]) => (
        <div key={name}><span className="lbl">{name}</span><span className="val">{value}{small ? <small>{small}</small> : null}</span></div>
      ))}
    </div>
  );
}

export const Grade = ({ grade }: { grade?: string }) => (
  <span className="k-grade"><span className={`sw g-${grade ?? "x"}`} aria-hidden="true" />{grade ?? "n/a"}{grade ? <small>{GRADE_NAMES[grade]}</small> : null}</span>
);

// A column whose name starts with # is a number column, aligned right
export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="k-tbl">
      <table>
        <thead><tr>{head.map((col) => <th key={col} className={col.startsWith("#") ? "num" : ""}>{col.replace(/^#/, "")}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className={head[j]?.startsWith("#") ? "num" : ""}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Kv({ pairs }: { pairs: ([string, ReactNode] | null | false)[] }) {
  return <dl className="k-kv">{pairs.filter((p): p is [string, ReactNode] => Boolean(p)).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === "object" ? v : fmt(v)}</dd></div>)}</dl>;
}

export const Bubble = ({ me = false, by, children }: { me?: boolean; by: string; children: ReactNode }) => (
  <div className={`k-msg ${me ? "me" : ""}`}><span className="by">{by}</span>{children}</div>
);

// One labelled input. options: [value, text] pairs. Uncontrolled: forms are read on submit.
export function Field({ name, label, hint, type = "text", value, options, area, wide, placeholder, inputRef }: {
  name: string; label: string; hint?: string; type?: string; value?: string | number; options?: [string | number, string][];
  area?: boolean; wide?: boolean; placeholder?: string; inputRef?: (el: HTMLInputElement | null) => void;
}) {
  let input: ReactNode;
  if (options) input = <select name={name} defaultValue={value === undefined ? undefined : String(value)}>{options.map(([v, t]) => <option key={String(v)} value={String(v)}>{t}</option>)}</select>;
  else if (area) input = <textarea name={name} rows={3} defaultValue={value} placeholder={placeholder} />;
  else input = <input ref={inputRef} name={name} type={type} defaultValue={value} placeholder={placeholder} step={type === "number" ? "any" : undefined} autoComplete="off" />;
  return <label className={`k-field ${wide || area ? "wide" : ""}`}><span>{label}{hint ? <em>{hint}</em> : null}</span>{input}</label>;
}

export const Check = ({ name, label, on = false }: { name: string; label: string; on?: boolean }) => (
  <label className="k-check"><input type="checkbox" name={name} defaultChecked={on} />{label}</label>
);

// ── Problems in plain words ──────────────────────────────────────────────────

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Please sign in first.",
  FORBIDDEN: "Only bank officers can do this.",
  LOCKED_BY_LOAN: "These details are locked while your loan is approved or active. Ask your bank to change them.",
  CONSENT_REQUIRED: "We need your consent to use your details before we can save them.",
  BUSINESS_NOT_FOUND: "We couldn't find that business on your account.",
  NOT_FOUND: "We couldn't find that.",
  LOAN_NOT_FOUND: "We couldn't find that loan.",
  SNAPSHOT_NOT_FOUND: "There are no financials with that version number.",
  NO_FINANCIALS: "We don't have the monthly figures yet.",
  INVALID_FINANCIALS: "Monthly sales can't be zero for every month.",
  INVALID_STATUS_TRANSITION: "The loan can't move to that status from where it is now.",
  CONFLICT: "That can't be done at this stage of the loan. For example, damage can only be reported once the loan has been paid out.",
  OUTSIDE_COVERAGE: "That place is outside India. We only cover locations in India.",
  OUT_OF_RANGE: "That location doesn't look right.",
  MISSING_COORDINATES: "Place your shop on the map first.",
  INVALID_COORDINATES: "That location doesn't look right.",
  VALIDATION_FAILED: "Some details need fixing:",
  BAD_REQUEST: "Some details aren't right. Please check the form and try again.",
  RATE_LIMITED: "Too many tries in a short time. Please wait a minute and try again.",
  UPSTREAM_UNAVAILABLE: "Weather data is busy right now. Please try again in a minute.",
  ML_UNAVAILABLE: "This outlook isn't available right now. Please try again later.",
};
const BY_STATUS: Record<number, string> = { 401: "Please sign in first.", 403: "Only bank officers can do this.", 404: "We couldn't find that.", 429: "Too many tries in a short time. Please wait a minute and try again." };
// The form's own label for a field the API names by its path
const FIELD_LABELS: Record<string, string> = {
  "profile.name": "Business name", "profile.description": "What you do", "profile.year_started": "Year started", "profile.employees": "Employees",
  "profile.sector": "Type of business", "locations.primary": "Shop location", "locations.primary.address": "Shop address", "locations.primary.pincode": "Pincode",
  "operations.power_outage_hrs_month": "Power cuts a month", "operations.insurance_covers": "Insurance covers", suppliers: "Main supplier",
  "contacts.owner.name": "Your name", "contacts.owner.phone": "Mobile", "contacts.owner.email": "Email", "contacts.bank_officer.email": "Your bank's email",
  "consent.data_processing": "Consent", monthly_revenue: "Monthly sales", monthly_opex: "Monthly running costs", existing_emi_total: "Current EMIs",
  outstanding_debt: "Loans still owed", cash_balance: "Cash and bank balance", payment_delays_12m: "Late payments", as_of: "Date",
};
const fieldName = (path: string) => FIELD_LABELS[path] ?? FIELD_LABELS[path.replace(/\.\d+(\.|$)/g, "$1")] ?? nice(path.split(".").filter((p) => !/^\d+$/.test(p)).at(-1) ?? path);

// The API's validation messages are written for developers; say them plainly
const PLAIN: [RegExp, string][] = [
  [/^Too small: expected string to have >=(\d+) characters?/, "needs at least $1 characters"],
  [/^Too big: expected string to have <=(\d+) characters?/, "can have at most $1 characters"],
  [/^Too small: expected array to have >=(\d+) items?/, "needs at least $1 entries"],
  [/^Too big: expected array to have <=(\d+) items?/, "can have at most $1 entries"],
  [/^Too small: expected number to be >=?(-?[\d.]+)/, "must be at least $1"],
  [/^Too big: expected number to be <=?(-?[\d.]+)/, "must be at most $1"],
  [/^Invalid input: expected \w+, received undefined/, "is missing"],
  [/^Invalid input: expected number/, "must be a number"],
  [/^Invalid option/, "isn't one of the choices"],
  [/^Invalid (email|string|input)/, "doesn't look right"],
];
export function plainProblem(message: unknown): string {
  const text = fmt(message);
  for (const [pattern, plain] of PLAIN) if (pattern.test(text)) return text.replace(pattern, plain).replace(/[.;].*$/, "");
  return text;
}

export function Problem({ r }: { r: ApiResult }) {
  if (r.notSent) return <Note>This isn't available with example data. Switch to Live at the top to try it.</Note>;
  if (r.network) return <Note err>We couldn't reach Kshetra. Please check your connection and try again.</Note>;
  const e = r.data?.error ?? {};
  const fields = e.details?.fields && typeof e.details.fields === "object" ? Object.entries(e.details.fields as Record<string, unknown>) : [];
  const text = MESSAGES[e.code] ?? BY_STATUS[r.status] ?? (r.status >= 500 ? "Something went wrong on our side. Please try again in a minute." : "That didn't work. Please check what you entered.");
  return (
    <Note err>
      {text}
      {fields.length ? <ul className="k-list">{fields.map(([f, p]) => <li key={f}><b>{fieldName(f)}</b> {plainProblem(p)}</li>)}</ul> : null}
    </Note>
  );
}
