import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { AppNav } from "../components/app/AppNav";
import { MapPicker } from "../components/app/MapPicker";
import { openSignin } from "../components/app/SignIn";
import { Bubble, Check, Field, Grade, Note, Problem, Strip, Tag } from "../components/app/ui";
import {
  AdvisorAnswer, AlertsView, CapacityView, CashflowView, ClimateView, FinanceView, ImpactView, LoanStageView, RatingReasons,
} from "../components/app/views";
import { api, type ApiResult, type Json } from "../shared/api";
import { fmt, HAZARDS, HAZARD_NAMES, inr, LOAN_STATUS, nice, RATINGS, SECTORS, sectorName, today } from "../shared/format";
import { num, nums, opt, str, ticked } from "../shared/form";
import { getSession, isBank, needsSignin, useSession } from "../shared/session";

// The owner enters their details once, gets one analysis worked out by the
// scoring rules, and asks the advisor about it alongside. Signed out, the
// first touch of anything opens the sign-in pop-up. It never shows how the
// answers were made: no routes, raw answers or settings.

const enc = encodeURIComponent;
const hazardOptions: [string, string][] = HAZARDS.map((k) => [k, HAZARD_NAMES[k] ?? k]);

interface Current { id: string; name: string; loan: string | null }
interface Results {
  biz: Json; climate: ApiResult; finance: ApiResult; rating: ApiResult; capacity: ApiResult; impact: ApiResult; outlook: ApiResult | null;
}

// The classifier works in the background after a save; wait a little for it
async function impactWhenReady(id: string) {
  let r = await api("GET", `/businesses/${enc(id)}/impact-profile`);
  for (let i = 0; i < 4 && r.ok && !r.data?.conditions; i += 1) {
    await new Promise((done) => setTimeout(done, 2000));
    r = await api("GET", `/businesses/${enc(id)}/impact-profile`);
  }
  return r;
}

async function analyse(id: string): Promise<Results | ApiResult> {
  const b = await api("GET", `/businesses/${enc(id)}`);
  if (!b.ok) return b;
  const biz = b.data, loc = biz.locations?.primary ?? {}, raw = biz.latest_snapshot?.raw ?? {}, revenue = biz.latest_snapshot?.derived?.avg_revenue;
  // The climate lookup first: the other answers reuse what it stores
  const climate = await api("POST", "/climate/profile", { lat: loc.lat, lon: loc.lon });
  const [finance, rating, capacity, impact, outlook] = await Promise.all([
    api("GET", `/finance/business/${enc(id)}/profile`),
    api("GET", `/evaluate/business/${enc(id)}`),
    api("POST", `/finance/business/${enc(id)}/repayment-capacity`, { revenue_drop_pct: 30, months: 3 }),
    impactWhenReady(id),
    // Running costs are taken to rise and fall with sales
    typeof revenue === "number" && revenue > 0 ? api("POST", "/ml/climate-cashflow", {
      lat: loc.lat, lon: loc.lon, sector: biz.profile?.sector, monthly_revenue: revenue,
      variable_cost_share: Math.min(0.95, Math.max(0, (raw.monthly_opex ?? 0) / revenue)), fixed_costs: 0,
      emi: raw.existing_emi_total ?? 0, starting_cash: raw.cash_balance ?? 0,
    }) : Promise.resolve(null),
  ]);
  return { biz, climate, finance, rating, capacity, impact, outlook };
}

const Card = ({ title, help, children }: { title: string; help?: string; children: ReactNode }) => (
  <section className="k-card"><h3>{title}</h3>{help ? <p className="k-help">{help}</p> : null}{children}</section>
);
const Answer = ({ r, view }: { r: ApiResult; view: (d: Json) => ReactNode }) => (r.ok ? <>{view(r.data)}</> : <Problem r={r} />);

// A small form whose answer appears under it
function Task({ title, help, button = "Show", children, run }: { title: string; help?: string; button?: string; children?: ReactNode; run: (form: HTMLFormElement) => Promise<ReactNode> }) {
  const [out, setOut] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setOut(<p className="muted">Working…</p>);
    try { setOut(await run(e.currentTarget)); } finally { setBusy(false); }
  }
  return (
    <Card title={title} help={help}>
      <form onSubmit={submit}>{children ? <div className="k-fields">{children}</div> : null}<div className="k-actions"><button className="btn sm" disabled={busy}>{button}</button></div></form>
      {out ? <div className="k-out">{out}</div> : null}
    </Card>
  );
}

const show = async (r: Promise<ApiResult>, view: (d: Json) => ReactNode) => { const res = await r; return res.ok ? view(res.data) : <Problem r={res} />; };

// ── Step 1: your details ─────────────────────────────────────────────────────

// The API's own rules, checked before anything is sent so the owner hears
// about all of them at once, in plain words: [field name, what is wrong]
type Bad = [string, string][];

function checkBusiness(f: HTMLFormElement): Bad {
  const bad: Bad = [];
  const year = num(f, "year_started"), thisYear = new Date().getFullYear(), about = str(f, "description").length;
  if (str(f, "name").length < 2) bad.push(["name", "Business name: enter your business's name."]);
  if (year === undefined || !Number.isInteger(year) || year < 1950 || year > thisYear) bad.push(["year_started", `Year started: enter a year between 1950 and ${thisYear}.`]);
  if (about < 30) bad.push(["description", `What you do: write a little more, at least 30 characters (you have ${about}).`]);
  if (about > 500) bad.push(["description", `What you do: keep it under 500 characters (you have ${about}).`]);
  if (num(f, "lat") === undefined || num(f, "lon") === undefined) bad.push(["lat", "Where you work: search for your shop or click the map to place it."]);
  if (!str(f, "address")) bad.push(["address", "Shop address: enter your shop's address."]);
  if (!/^[1-9]\d{5}$/.test(str(f, "pincode"))) bad.push(["pincode", "Pincode: enter the 6-digit pincode."]);
  return bad;
}

function checkMoney(f: HTMLFormElement): Bad {
  const bad: Bad = [];
  const sales = str(f, "monthly_revenue").split(",");
  if (sales.some((v) => v.trim() === "" || Number.isNaN(Number(v)) || Number(v) < 0)) bad.push(["sales-0", "Monthly sales: fill in every month shown (0 for a month with no sales)."]);
  else if (!sales.some((v) => Number(v) > 0)) bad.push(["sales-0", "Monthly sales: at least one month must be above zero."]);
  if (num(f, "monthly_opex") === undefined) bad.push(["monthly_opex", "Monthly running costs: enter an amount (0 if none)."]);
  if (num(f, "cash_balance") === undefined) bad.push(["cash_balance", "Cash and bank balance: enter an amount (0 if none)."]);
  if (!str(f, "owner_name")) bad.push(["owner_name", "Your name: enter your name."]);
  if (!/^\+91\d{10}$/.test(str(f, "owner_phone").replace(/[\s-]/g, ""))) bad.push(["owner_phone", "Mobile: enter +91 followed by your 10-digit number."]);
  if (!/^\S+@\S+\.\S+$/.test(str(f, "bank_email"))) bad.push(["bank_email", "Your bank's email: enter your branch's or loan officer's email address."]);
  if (!ticked(f, "consent_data")) bad.push(["consent_data", "Consent: tick \"I agree to Kshetra using these details\" so we can save them."]);
  return bad;
}

const Problems = ({ bad }: { bad: Bad }) => (
  <Note err>Please fix {bad.length === 1 ? "this" : `these ${bad.length} things`} first:<ul className="k-list">{bad.map(([name, message]) => <li key={name + message}>{message}</li>)}</ul></Note>
);

// What the insurance covers, picked from a menu. The form reads the two hidden
// inputs: has_insurance ("yes" or "") and insurance_covers (comma separated).
const COVERS: [string, string][] = [["flood", "Flood"], ["fire", "Fire"], ["storm", "Storm"], ["crop", "Crop"], ["stock", "Stock"]];

function InsuranceMenu() {
  const [covers, setCovers] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const insured = covers.length > 0 || other;
  const picked = [...COVERS.filter(([k]) => covers.includes(k)).map(([, text]) => text), ...(other ? ["Other cover"] : [])];

  // Like any dropdown, it closes on a click elsewhere or Escape
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) menu.current?.removeAttribute("open");
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); };
  }, []);

  const toggle = (key: string) => setCovers((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  return (
    <div className="k-field">
      <span>Insurance</span>
      <details className="k-dropdown" ref={menu}>
        <summary>{insured ? picked.join(", ") : "No insurance"}</summary>
        <div className="k-menu">
          <label className="k-check"><input type="radio" checked={!insured} onChange={() => { setCovers([]); setOther(false); }} />No insurance</label>
          {COVERS.map(([key, text]) => <label className="k-check" key={key}><input type="checkbox" checked={covers.includes(key)} onChange={() => toggle(key)} />{text}</label>)}
          <label className="k-check"><input type="checkbox" checked={other} onChange={() => setOther((v) => !v)} />Other cover</label>
        </div>
      </details>
      <input type="hidden" name="has_insurance" value={insured ? "yes" : ""} />
      <input type="hidden" name="insurance_covers" value={covers.join(",")} />
    </div>
  );
}

// Monthly sales, one box per month, oldest first. The newest box is the last
// month that has ended, so the figures are for whole months. The form reads
// two hidden inputs: monthly_revenue (comma separated) and as_of.
const MIN_MONTHS = 6, MAX_MONTHS = 12;

function lastMonths(count: number): { label: string; asOf: string }[] {
  const [year, month] = today().split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    // Day 0 of a month is the last day of the month before it
    const end = new Date(Date.UTC(year, month - 1 - (count - 1 - i), 0));
    return { label: end.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), asOf: end.toISOString().slice(0, 10) };
  });
}

function MonthlySales() {
  // Newest last; an earlier month is added at the front
  const [values, setValues] = useState<string[]>(Array(MIN_MONTHS).fill(""));
  const months = lastMonths(values.length);
  const set = (i: number, v: string) => setValues((all) => all.map((x, j) => (j === i ? v : x)));
  return (
    <div className="k-field wide">
      <span>Monthly sales<em>₹ for each month, {MIN_MONTHS} to {MAX_MONTHS} months</em></span>
      <div className="k-months">
        {months.map((m, i) => (
          <label key={m.asOf}><small>{m.label}</small><input id={`sales-${i}`} name={`sales-${i}`} type="number" min="0" step="any" inputMode="numeric" placeholder="₹" value={values[i]} onChange={(e) => set(i, e.target.value)} /></label>
        ))}
      </div>
      <div className="k-actions k-months-actions">
        <button className="btn sm ghost" type="button" disabled={values.length >= MAX_MONTHS} onClick={() => setValues((all) => ["", ...all])}>Add an earlier month</button>
        <button className="btn sm ghost" type="button" disabled={values.length <= MIN_MONTHS} onClick={() => setValues((all) => all.slice(1))}>Remove the earliest</button>
        <button className="btn sm ghost" type="button" disabled={!values.some(Boolean)} title="Copies the first amount you entered into the empty months"
          onClick={() => setValues((all) => { const first = all.find(Boolean) ?? ""; return all.map((v) => v || first); })}>Fill the empty months</button>
      </div>
      <input type="hidden" name="monthly_revenue" value={values.join(",")} />
      <input type="hidden" name="as_of" value={months.at(-1)?.asOf ?? today()} />
    </div>
  );
}

// Two pages: the business, then its money and contact. Both stay in the form,
// so going back loses nothing and one submit sends everything.
function DetailsForm({ onSaved }: { onSaved: (id: string) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const address = useRef<HTMLInputElement | null>(null);
  const pincode = useRef<HTMLInputElement | null>(null);
  // What the owner typed is theirs; only what the map filled in may be replaced
  const typed = useRef({ address: false, pincode: false });
  const [page, setPage] = useState<1 | 2>(1);
  const [out, setOut] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  const fill = useCallback((addr: string, pin: string | undefined) => {
    if (address.current && !typed.current.address) address.current.value = addr;
    if (pincode.current && pin && !typed.current.pincode) pincode.current.value = pin;
  }, []);

  const go = (to: 1 | 2) => { setPage(to); setOut(null); form.current?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const refuse = (f: HTMLFormElement, bad: Bad) => { setOut(<Problems bad={bad} />); (f.elements.namedItem(bad[0]![0]) as HTMLElement | null)?.focus(); };

  function next() {
    const f = form.current;
    if (!f) return;
    const bad = checkBusiness(f);
    if (bad.length) refuse(f, bad);
    else go(2);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    // Enter on the first page moves on; it does not send half a form
    if (page === 1) { next(); return; }
    const first = checkBusiness(f);
    if (first.length) { setPage(1); refuse(f, first); return; }
    const bad = checkMoney(f);
    if (bad.length) { refuse(f, bad); return; }
    setBusy(true);
    setOut(<p className="muted">Saving your details…</p>);
    try {
      const lat = num(f, "lat"), lon = num(f, "lon");
      const insured = str(f, "has_insurance") === "yes", covers = str(f, "insurance_covers").split(",").filter(Boolean);
      const created = await api("POST", "/businesses", {
        profile: { name: str(f, "name"), sector: str(f, "sector"), description: str(f, "description"), year_started: num(f, "year_started"), employees: num(f, "employees") },
        locations: { primary: { lat, lon, address: str(f, "address"), pincode: str(f, "pincode"), premises: opt(f, "premises"), floor: opt(f, "floor") }, additional_locations: [] },
        operations: { power_outage_hrs_month: num(f, "power_outage_hrs_month") ?? 0, has_backup_power: str(f, "has_backup_power") === "yes", has_insurance: insured, insurance_covers: insured && covers.length ? covers : undefined },
        // One supplier, taken to be near the shop: enough for a first analysis
        suppliers: [{ name: str(f, "supplier") || "Main supplier", lat, lon, share: 1 }],
        contacts: {
          owner: { name: str(f, "owner_name"), phone: str(f, "owner_phone").replace(/[\s-]/g, ""), email: opt(f, "owner_email") },
          bank_officer: { name: "Loan officer", email: str(f, "bank_email") },
          alerts: { channels: opt(f, "owner_email") ? ["email"] : ["sms"] },
        },
        consent: { data_processing: ticked(f, "consent_data"), share_with_bank: ticked(f, "consent_share"), alerts: ticked(f, "consent_alerts") },
      });
      if (!created.ok) { setOut(<Problem r={created} />); return; }
      const id: string = created.data.id;
      const saved = await api("POST", `/businesses/${enc(id)}/snapshots`, {
        as_of: str(f, "as_of"), monthly_revenue: nums(f, "monthly_revenue"), monthly_opex: num(f, "monthly_opex"), existing_emi_total: num(f, "existing_emi_total"),
        outstanding_debt: num(f, "outstanding_debt"), cash_balance: num(f, "cash_balance"), payment_delays_12m: num(f, "payment_delays_12m"),
      });
      if (!saved.ok) { setOut(<><Note><b>Your business is saved, </b>but your monthly figures were not:</Note><Problem r={saved} /></>); return; }
      setOut(<Note><b>Saved. </b>Your analysis is below, and it stays with your account for next time.</Note>);
      onSaved(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="k-card">
      <h2 className="k-step"><span>1</span>Your details</h2>
      <ol className="k-pages" aria-label="Progress">
        <li className={page === 1 ? "on" : "done"}><b>1</b>Your business</li>
        <li className={page === 2 ? "on" : ""}><b>2</b>Your money and contact</li>
      </ol>
      <form ref={form} onSubmit={submit} noValidate>
        <div hidden={page !== 1}>
          <div className="k-sub">About your business</div>
          <div className="k-fields">
            <Field name="name" label="Business name" placeholder="Sri Lakshmi Bakery" />
            <Field name="sector" label="Type of business" options={SECTORS.map((s) => [s, sectorName(s)])} value="food_beverage" />
            <Field name="year_started" label="Year started" type="number" placeholder="2015" />
            <Field name="employees" label="Employees" hint="optional" type="number" />
            <Field name="description" label="What you do" hint="at least 30 characters" area placeholder="What you sell or do, who your customers are, and whether you work indoors or outdoors." />
          </div>
          <div className="k-sub">Where you work</div>
          <div className="k-fields">
            <MapPicker onAddress={fill} />
            <label className="k-field wide"><span>Shop address</span><input ref={address} name="address" onInput={() => { typed.current.address = true; }} autoComplete="off" /></label>
            <label className="k-field"><span>Pincode<em>6 digits</em></span><input ref={pincode} name="pincode" onInput={() => { typed.current.pincode = true; }} autoComplete="off" /></label>
            <Field name="premises" label="Premises" options={[["", "Not saying"], ["owned", "Owned"], ["rented", "Rented"]]} />
            <Field name="floor" label="Floor" options={[["", "Not saying"], ["basement", "Basement"], ["ground", "Ground floor"], ["upper", "Upper floor"]]} />
          </div>
          <div className="k-sub">How you run</div>
          <div className="k-fields">
            <InsuranceMenu />
            <Field name="has_backup_power" label="Backup power" options={[["", "No"], ["yes", "Yes"]]} />
            <Field name="power_outage_hrs_month" label="Power cuts a month" hint="hours" type="number" value={10} />
            <Field name="supplier" label="Main supplier" hint="optional" />
          </div>
          <div className="k-actions"><button className="btn" type="button" onClick={next}>Next: your money →</button></div>
        </div>

        <div hidden={page !== 2}>
          <div className="k-sub">Your money</div>
          <div className="k-fields">
            <MonthlySales />
            <Field name="monthly_opex" label="Monthly running costs" hint="₹, without loan repayments" type="number" />
            <Field name="existing_emi_total" label="Current EMIs" hint="₹ a month" type="number" value={0} />
            <Field name="outstanding_debt" label="Loans still owed" hint="₹" type="number" value={0} />
            <Field name="cash_balance" label="Cash and bank balance" hint="₹" type="number" />
            <Field name="payment_delays_12m" label="Late payments" hint="last 12 months" type="number" value={0} />
          </div>
          <div className="k-sub">Contact</div>
          <div className="k-fields">
            <Field name="owner_name" label="Your name" />
            <Field name="owner_phone" label="Mobile" hint="+91 and 10 digits" placeholder="+919876543210" />
            <Field name="owner_email" label="Email" hint="optional" type="email" />
            <Field name="bank_email" label="Your bank's email" hint="your branch or loan officer" type="email" />
          </div>
          <div className="k-consents">
            <Check name="consent_data" label="I agree to Kshetra using these details" on />
            <Check name="consent_share" label="Share my details with my bank" on />
            <Check name="consent_alerts" label="Send me weather alerts" on />
          </div>
          <div className="k-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => go(1)}>← Back</button>
            <button className="btn" disabled={busy}>Get my analysis</button>
          </div>
        </div>
      </form>
      {out ? <div className="k-out">{out}</div> : null}
    </section>
  );
}

// ── Step 2: your analysis ────────────────────────────────────────────────────

function ResultsView({ r, current }: { r: Results; current: Current }) {
  const s = useSession();
  const [word, tone] = r.rating.ok ? RATINGS[r.rating.data.rating] ?? [nice(r.rating.data.rating ?? "unknown"), ""] : ["Not available", ""];
  return (
    <div className="k-stack">
      <section className="k-card">
        <h2 className="k-step"><span>2</span>Your analysis{current.name ? `: ${current.name}` : ""}</h2>
        {s.source === "sample" ? <Tag tone="am">Example data</Tag> : null}
        <Strip cells={[
          ["Overall rating", <span className={`k-rating ${tone}`}>{word}</span>],
          ["Climate grade", r.climate.ok ? <Grade grade={r.climate.data.grade} /> : "n/a"],
          ["Financial score", r.finance.ok && r.finance.data.adjusted ? fmt(r.finance.data.adjusted.score) : "n/a", "after weather risks"],
        ]} />
      </section>
      <Card title="Why this rating"><Answer r={r.rating} view={(d) => <RatingReasons d={d} />} /></Card>
      <Card title="Weather risk where you work"><Answer r={r.climate} view={(d) => <ClimateView d={d} />} /></Card>
      <Card title="Your financial score" help="Worked out from your monthly figures, then tested against the weather risks where you work."><Answer r={r.finance} view={(d) => <FinanceView d={d} />} /></Card>
      <Card title="How weather affects your business"><Answer r={r.impact} view={(d) => <ImpactView d={d} />} /></Card>
      <Card title="If sales fell 30% for 3 months"><Answer r={r.capacity} view={(d) => <CapacityView d={d} />} /></Card>
      {r.outlook?.ok ? <Card title="Your cash-flow outlook for the next year"><CashflowView d={r.outlook.data} /></Card> : null}
      <details className="k-card k-fold">
        <summary>Had damage from bad weather? Tell your advisor</summary>
        <Task title="Report damage" button="Send report" help="Leave anything blank you don't know yet; the advisor will ask. This works once your loan has been paid out." run={async (f) => {
          const loanId = current.loan ?? (s.source === "sample" ? "LN-0142" : null);
          if (!loanId) return <Note err>You don't have a loan with us yet, so there's nothing to report against.</Note>;
          const claim = opt(f, "insurance");
          return show(api("POST", "/advisor/damage-report", {
            loanId, hazard: opt(f, "hazard"), daysClosed: num(f, "daysClosed"), stockLossInr: num(f, "stockLossInr"), equipmentDamageInr: num(f, "equipmentDamageInr"),
            expectedReopenDate: opt(f, "expectedReopenDate"), insuranceClaim: claim ? { status: claim, expectedAmountInr: num(f, "insuranceAmount") } : undefined, message: opt(f, "message"),
          }), (d) => <AdvisorAnswer d={d} bank={isBank(s)} source={s.source} />);
        }}>
          <Field name="hazard" label="What happened" options={[["", "Not sure"], ...hazardOptions]} value="flash_flood" />
          <Field name="daysClosed" label="Days closed" type="number" />
          <Field name="stockLossInr" label="Stock lost" hint="₹" type="number" />
          <Field name="equipmentDamageInr" label="Equipment damage" hint="₹" type="number" />
          <Field name="expectedReopenDate" label="Expect to reopen" type="date" />
          <Field name="insurance" label="Insurance claim" options={[["", "Not saying"], ["none", "No claim"], ["planned", "Going to claim"], ["filed", "Claim filed"], ["approved", "Claim approved"]]} />
          <Field name="insuranceAmount" label="Expected payout" hint="₹, optional" type="number" />
          <Field name="message" label="Anything else" wide placeholder="Water came into the shop on Tuesday night." />
        </Task>
      </details>
    </div>
  );
}

// ── The advisor, alongside ───────────────────────────────────────────────────

function Chat({ current }: { current: Current | null }) {
  const s = useSession();
  const [log, setLog] = useState<ReactNode[]>([]);
  const [text, setText] = useState("");
  const conversation = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [log]);

  async function send(message: string) {
    if (!message) return;
    if (!current && s.source !== "sample") { setLog((l) => [...l, <Note key={l.length}>Fill in your details first, so the advisor knows your business.</Note>]); return; }
    setLog((l) => [...l, <Bubble key={l.length} me by="You">{message}</Bubble>, <Bubble key={l.length + 1} by="Advisor">Thinking…</Bubble>]);
    const body: Json = { businessId: current?.id ?? "SME-0142", message };
    if (current?.loan) body.loanId = current.loan;
    if (conversation.current) body.conversationId = conversation.current;
    const r = await api("POST", "/advisor/chat", body);
    if (r.ok && r.data?.conversationId) conversation.current = r.data.conversationId;
    setLog((l) => [...l.slice(0, -1), r.ok ? <AdvisorAnswer key={l.length} d={r.data} bank={isBank(s)} source={s.source} /> : <Problem key={l.length} r={r} />]);
  }

  return (
    <div className="k-chat">
      <h3>Your advisor</h3>
      <p className="k-help">{current ? `Ask anything about ${current.name || "your business"}. The advisor uses your figures and the weather where you work.` : "Fill in your details and the advisor will answer about your business: whether a loan makes sense, what to do before bad weather, and how to recover after it."}</p>
      <div className="k-log" aria-live="polite">{log.length ? log : <p className="muted">No messages yet. Ask something below.</p>}<div ref={end} /></div>
      <div className="k-prompts">
        {["Should I take a ₹3 lakh loan?", "Heavy rain is forecast. What should I do?", "How can I lower my weather risk?"].map((p) => <button key={p} type="button" onClick={() => void send(p)}>{p}</button>)}
        <button type="button" onClick={() => { conversation.current = null; setLog([]); }}>Start over</button>
      </div>
      <form className="k-chat-form" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); setText(""); void send(t); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask your advisor" aria-label="Message" maxLength={2000} />
        <button className="btn sm">Send</button>
      </form>
    </div>
  );
}

// ── Bank officers ────────────────────────────────────────────────────────────

function BankTools({ current, onLoan }: { current: Current | null; onLoan: (id: string) => void }) {
  const need = (): string | null => current?.id ?? null;
  const noBiz = <Note err>Choose a business above first.</Note>;
  return (
    <details className="k-card k-fold">
      <summary>Bank tools</summary>
      <div className="k-stack">
        <Task title="Record a loan" button="Record" help="For the business shown above. It starts as applied." run={async (f) => {
          const id = need();
          if (!id) return noBiz;
          return show(api("POST", `/businesses/${enc(id)}/loans`, { amount: num(f, "amount"), emi: num(f, "emi"), tenure_months: num(f, "tenure_months"), interest_rate: num(f, "interest_rate"), purpose: opt(f, "purpose") }), (d) => {
            const l = d.loan ?? d;
            onLoan(l.id);
            return <Note>Loan {l.id} recorded for {inr(l.amount)}. Status: {LOAN_STATUS[l.status] ?? nice(l.status)}.</Note>;
          });
        }}>
          <Field name="amount" label="Amount" hint="₹" type="number" />
          <Field name="emi" label="Monthly EMI" hint="₹" type="number" />
          <Field name="tenure_months" label="Months" type="number" value={48} />
          <Field name="interest_rate" label="Interest" hint="% a year" type="number" value={13} />
          <Field name="purpose" label="Purpose" options={[["", "Not saying"], ["working_capital", "Working capital"], ["equipment", "Equipment"], ["expansion", "Expansion"], ["other", "Other"]]} />
        </Task>
        <Task title="Change a loan's status" button="Update" run={async (f) => show(api("PATCH", `/loans/${enc(str(f, "loan"))}/status`, { status: str(f, "status") }), (d) => {
          const l = d.loan ?? d;
          return <Note>Loan {l.id} is now {LOAN_STATUS[l.status] ?? nice(l.status)}.</Note>;
        })}>
          <Field name="loan" label="Loan ID" value={current?.loan ?? ""} />
          <Field name="status" label="New status" options={[["authorised", "Approve"], ["active", "Activate"], ["closed", "Close"], ["rejected", "Reject"]]} value="authorised" />
        </Task>
        <Task title="Mark financials as checked" button="Mark checked" help="Confirms the figures the owner entered. The figures themselves don't change." run={async (f) => {
          const id = need();
          if (!id) return noBiz;
          return show(api("POST", `/businesses/${enc(id)}/snapshots/${enc(str(f, "version"))}/verify`), (d) => <Note>Financials version {(d.snapshot ?? d).version} marked as checked.</Note>);
        }}>
          <Field name="version" label="Financials version" type="number" value={1} />
        </Task>
        <Task title="Loan stage" help="Before payout, active, under a weather alert, hit by weather or on a recovery plan." run={async (f) => {
          const loan = enc(str(f, "loan")), action = str(f, "action");
          return show(action ? api("POST", `/advisor/loans/${loan}/${action}`, {}) : api("GET", `/advisor/loans/${loan}/state`), (d) => <LoanStageView d={d} />);
        }}>
          <Field name="loan" label="Loan ID" value={current?.loan ?? ""} />
          <Field name="action" label="Do" options={[["", "Just show it"], ["disburse", "Mark as paid out"], ["close-recovery", "End the recovery plan"]]} />
        </Task>
        <Task title="Adjust the weather profile" button="Save change" help="Correct one kind of weather, for example when the shop is on a raised floor. The reason is kept." run={async (f) => {
          const id = need();
          if (!id) return noBiz;
          return show(api("PUT", `/businesses/${enc(id)}/impact-profile`, { reason: str(f, "reason"), conditions: { [str(f, "hazard")]: { physical: num(f, "physical") } } }), (d) => <ImpactView d={d} />);
        }}>
          <Field name="hazard" label="Weather" options={hazardOptions} value="river_flood" />
          <Field name="physical" label="How much it disrupts the business" options={[["0", "Not at all"], ["0.25", "A little"], ["0.5", "Somewhat"], ["0.75", "A lot"], ["1", "Completely"]]} value="0.25" />
          <Field name="reason" label="Reason" wide placeholder="Shop is on a raised plinth" />
        </Task>
        <Task title="Weather alerts" help="Alerts sent to business owners and to the bank, newest first." run={async (f) => {
          const status = str(f, "status");
          return show(api("GET", `/alerts?limit=30${status ? `&status=${enc(status)}` : ""}`), (d) => <AlertsView d={d} />);
        }}>
          <Field name="status" label="Show" options={[["", "All alerts"], ["sent", "Sent"], ["pending", "Waiting to send"], ["suppressed", "Not sent"], ["failed", "Could not be sent"]]} />
        </Task>
      </div>
    </details>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function Analysis() {
  const s = useSession();
  const bank = isBank(s);
  const [current, setCurrent] = useState<Current | null>(null);
  const [results, setResults] = useState<Results | ApiResult | "loading" | null>(null);
  const [registered, setRegistered] = useState(false);
  const [shared, setShared] = useState<Json[] | null>(null);
  const top = useRef<HTMLElement>(null);

  const showAnalysis = useCallback(async (id: string) => {
    setResults("loading");
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const r = await analyse(id);
    if ("biz" in r) setCurrent({ id: r.biz.id, name: r.biz.profile?.name ?? "", loan: r.biz.loans?.at(-1)?.id ?? null });
    setResults(r);
  }, []);

  // Sign-in says who someone is, so nobody types a business ID. The list of
  // businesses a user may see also holds demo ones that only bank officers can
  // open, so an owner's own is the newest one that opens for them.
  const who = s.source === "sample" ? "sample" : s.user?.id ?? null;
  useEffect(() => {
    setCurrent(null);
    setResults(null);
    setRegistered(false);
    setShared(null);
    if (!who) return;
    let alive = true;
    (async () => {
      const r = await api("GET", "/advisor/businesses");
      const list: Json[] = r.ok ? r.data?.businesses ?? [] : [];
      if (!alive) return;
      if (isBank(getSession())) { setShared(list); return; }
      for (const b of [...list].reverse()) {
        if ((await api("GET", `/businesses/${enc(b.id)}`)).ok) {
          if (!alive) return;
          setRegistered(true);
          await showAnalysis(b.id);
          return;
        }
      }
    })();
    return () => { alive = false; };
  }, [who, showAnalysis]);

  // Nothing here works signed out: the first touch of a field, button or the chat asks for sign-in
  const guard = (e: SyntheticEvent) => {
    if (!needsSignin(getSession())) return;
    const target = e.target as Element;
    if (target.closest("dialog")) return;
    if (e.type === "focus" && target.matches("input, textarea, select")) { (target as HTMLElement).blur(); openSignin(); return; }
    if ((e.type === "click" && target.closest("button, input, select, textarea, summary")) || e.type === "submit") {
      e.preventDefault();
      e.stopPropagation();
      openSignin();
    }
  };

  const details = <DetailsForm onSaved={(id) => { setRegistered(true); void showAnalysis(id); }} />;

  return (
    <>
      <AppNav page="analysis" />
      <div className="wrap k-ax" onFocusCapture={guard} onClickCapture={guard} onSubmitCapture={guard}>
        <main className="k-stack" ref={top}>
          <header className="k-intro">
            <h1>Your climate and credit check</h1>
            <p>Tell us about your business once. We check the weather risks where you work, score your finances with and without them, and give you one rating with the reasons. Ask the advisor anything about it on the right.</p>
          </header>

          {bank && shared ? (
            <section className="k-card k-pick">
              <label className="k-field"><span>Business</span>
                <select value={shared.some((b) => b.id === current?.id) ? current!.id : ""} onChange={(e) => { if (e.target.value) void showAnalysis(e.target.value); }}>
                  <option value="">{shared.length ? "Choose a business" : "No businesses shared with you yet"}</option>
                  {shared.map((b) => <option key={b.id} value={b.id}>{[b.name, b.city].filter(Boolean).join(" · ")}</option>)}
                </select>
              </label>
            </section>
          ) : null}

          {registered ? <details className="k-card k-fold"><summary>Register another business</summary>{details}</details> : details}

          {results === "loading" ? <section className="k-card"><p className="muted">Working out your analysis. The first look at a new place can take up to a minute.</p></section> : null}
          {results && results !== "loading" ? ("biz" in results && current ? <ResultsView r={results} current={current} /> : <section className="k-card"><Problem r={results as ApiResult} /></section>) : null}

          {bank ? <BankTools current={current} onLoan={(id) => setCurrent((c) => (c ? { ...c, loan: id } : c))} /> : null}
        </main>
        <aside className="k-aside"><Chat key={current?.id ?? "none"} current={current} /></aside>
      </div>
    </>
  );
}
