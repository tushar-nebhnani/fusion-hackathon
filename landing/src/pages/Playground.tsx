import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppNav } from "../components/app/AppNav";
import { openSignin } from "../components/app/SignIn";
import { Bubble, Field, Kv, Note, Problem, SubHead, Tag } from "../components/app/ui";
import { AdvisorAnswer, AlertsView, ClimateView, FinanceView, ImpactView } from "../components/app/views";
import { api, type ApiResult, type Json, type Source } from "../shared/api";
import { daysAhead, fmt, hazardName, inr, nice, pct, sectorName } from "../shared/format";
import { getSession, useSession } from "../shared/session";

// One loan told as eight chapters. On opening, the whole story plays by itself
// on example data: nothing is stored and no email can go out. "Run it live"
// plays it again against the real API, which needs a signed-in bank officer.

const enc = encodeURIComponent;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const PAUSE = 1800;

// What the chapters pass along: the business, its loan and the repayment proposal
// answer is the advisor's recovery answer, kept so the page can redraw it once the bank decides
interface Story { biz: string | null; loan: string | null; lat: number; lon: number; proposal: Json; answer: Json }
const fresh = (): Story => ({ biz: null, loan: null, lat: 13.0827, lon: 80.2707, proposal: null, answer: null });

interface Ran { view: ReactNode; calls: ApiResult[] }
type Values = Record<string, string>;
type Call = (method: string, path: string, body?: unknown) => Promise<Json>;

class StepError extends Error {
  constructor(public r: ApiResult) { super(r.data?.error?.code ?? "request failed"); }
}

interface Chapter {
  id: string; title: string; who: string; service: string; what: string; why: string; action: string;
  needs: ("biz" | "loan")[];
  // What the chapter sends, in plain words, for "Behind the scenes"
  sends: [string, string, string][];
  // Editable inputs: [name, label, default, kind]
  fields?: [string, string, string, ("text" | "number" | "date" | "area" | string[])?][];
  run(v: Values, st: Story, call: Call, ctx: { source: Source; bank: boolean }): Promise<ReactNode>;
}

// ── Pictures of the answers ──────────────────────────────────────────────────

const Tiles = ({ items }: { items: ([string, ReactNode, ReactNode?] | null)[] }) => (
  <div className="k-tiles">{items.filter((x): x is [string, ReactNode, ReactNode?] => Boolean(x)).map(([k, val, sub]) => <div key={k}><span>{k}</span><b>{val}</b>{sub ? <small>{sub}</small> : null}</div>)}</div>
);

function Timeline({ reached }: { reached: number }) {
  return <ol className="k-timeline">{["Applied", "Authorised by the bank", "Money paid out"].map((t, i) => <li key={t} className={i < reached ? "on" : ""}>{t}</li>)}</ol>;
}

// Ask the advisor a follow-up, in whatever mode the loan is in now
function Ask({ st, source, bank, prompts }: { st: Story; source: Source; bank: boolean; prompts: string[] }) {
  const [log, setLog] = useState<ReactNode[]>([]);
  const [text, setText] = useState("");
  async function send(message: string) {
    if (!message || !st.biz) return;
    setLog((l) => [...l, <Bubble key={l.length} me by="You">{message}</Bubble>]);
    const body: Json = { businessId: st.biz, message };
    if (st.loan) body.loanId = st.loan;
    const r = await api("POST", "/advisor/chat", body, { source });
    setLog((l) => [...l, r.ok ? <AdvisorAnswer key={l.length} d={r.data} bank={bank} source={source} /> : <Problem key={l.length} r={r} />]);
  }
  return (
    <div className="k-ask">
      <SubHead>Ask the advisor</SubHead>
      {log.length ? <div className="k-log">{log}</div> : null}
      <div className="k-prompts">{prompts.map((p) => <button key={p} type="button" onClick={() => void send(p)}>{p}</button>)}</div>
      <form className="k-chat-form" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); setText(""); void send(t); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the advisor" aria-label="Message to the advisor" maxLength={2000} />
        <button className="btn sm">Send</button>
      </form>
    </div>
  );
}

function Recovery({ st, d, source, bank }: { st: Story; d: Json; source: Source; bank: boolean }) {
  return <div><AdvisorAnswer d={d} bank={bank} source={source} /><Ask st={st} source={source} bank={bank} prompts={["Which option is safest for me?", "When do I start paying again?"]} /></div>;
}

// ── The chapters ─────────────────────────────────────────────────────────────

const n = (v: Values, k: string) => Number(v[k]);

const CHAPTERS: Chapter[] = [
  {
    id: "apply", title: "A business applies", who: "Owner", service: "Input service", action: "Submit the application", needs: [],
    what: "Sri Lakshmi Bakery fills in one form: what it sells, where the shop is, how it runs, who supplies it and how to reach the owner. Every field is checked, and nothing is stored unless the owner consents.",
    why: "Everything after this reads from this one record, so the location and the description have to be right.",
    sends: [["POST", "/businesses", "Creates the business with its profile, location, operations, suppliers, contacts and consent."]],
    fields: [["name", "Business name", "Sri Lakshmi Bakery"], ["lat", "Latitude", "13.0827", "number"], ["lon", "Longitude", "80.2707", "number"],
      ["description", "What the business does", "Neighbourhood bakery selling bread, cakes and snacks to walk-in customers from a ground-floor shop, with some delivery orders.", "area"]],
    async run(v, st, call) {
      const d = await call("POST", "/businesses", {
        profile: { name: v.name, sector: "food_beverage", sub_sector: "bakery", description: v.description, year_started: 2015, products: ["bread", "cakes", "snacks"], sales_channel: "both", indoor_outdoor: "indoor", employees: 6 },
        locations: { primary: { lat: n(v, "lat"), lon: n(v, "lon"), address: "12 NSC Bose Road, George Town, Chennai", pincode: "600001", premises: "rented", floor: "ground" } },
        operations: { power_outage_hrs_month: 12, water_dependency: "medium", has_insurance: true, insurance_covers: ["flood", "stock"], seasonal_months: [10, 11, 12], has_backup_power: false },
        suppliers: [{ name: "Annai Flour Mills", lat: 13.05, lon: 80.21, share: 0.6 }, { name: "Madurai Dairy Co-op", lat: 9.9252, lon: 78.1198, share: 0.4 }],
        contacts: { owner: { name: "Lakshmi Narayanan", phone: "+919876543210", email: "owner@example.com", language: "en" }, bank_officer: { name: "MSME Desk", email: "msme-desk@example-bank.in" }, alerts: { channels: ["email"] } },
        consent: { data_processing: true, share_with_bank: true, alerts: true },
      });
      Object.assign(st, fresh(), { biz: d.id, lat: d.locations?.primary?.lat ?? n(v, "lat"), lon: d.locations?.primary?.lon ?? n(v, "lon") });
      const p = d.profile ?? {}, loc = d.locations?.primary ?? {};
      return (
        <div>
          <div className="k-res-title"><div><h3>{p.name}</h3><p className="muted">{sectorName(p.sector ?? "")} · {loc.address}</p></div><Tag tone="ok">Application saved</Tag></div>
          <Tiles items={[["Where", `${fmt(loc.lat)}, ${fmt(loc.lon)}`, loc.floor ? `${nice(loc.floor)} floor, ${loc.premises ?? ""}` : null],
            ["Shared with the bank", d.consent?.share_with_bank ? "Yes" : "No"], ["Weather alerts", d.consent?.alerts ? "On" : "Off"]]} />
        </div>
      );
    },
  },
  {
    id: "impact", title: "How weather moves this business", who: "Automatic", service: "Weather-impact classifier", action: "Read the weather profile", needs: ["biz"],
    what: "A model reads the description and decides, for each of six kinds of bad weather, how much of the business physically stops and how customers react. Rules keep it honest: a floor under the physical value, sector defaults when it is unsure, and a full fallback if it fails.",
    why: "A flooded street shuts a ground-floor bakery but barely touches a pharmacy upstairs. This is what makes the score about this business, not its postcode.",
    sends: [["GET", "/businesses/:id/impact-profile", "Reads the classifier's answer for the business."]],
    async run(_v, st, call) {
      return <ImpactView d={await call("GET", `/businesses/${enc(st.biz!)}/impact-profile`)} />;
    },
  },
  {
    id: "climate", title: "Climate risk at the shop", who: "Automatic", service: "Climate pipeline", action: "Score this location", needs: ["biz"],
    what: "The shop's location is checked against about 30 years of weather history for river floods, flash floods, heat, drought, storms and cold waves, and against the 7-day forecast. The result is graded from A (stable) to E (critical).",
    why: "The grade and the hazard scores become the shocks the loan is tested against.",
    sends: [["POST", "/climate/profile", "Scores a point for six hazards and returns the grade, the reasons and any forecast warnings."]],
    async run(_v, st, call) {
      return <ClimateView d={await call("POST", "/climate/profile", { lat: st.lat, lon: st.lon })} />;
    },
  },
  {
    id: "financials", title: "The owner shares the books", who: "Owner", service: "Input service", action: "Save the financials", needs: ["biz"],
    what: "The owner enters eight months of sales, monthly costs, existing repayments, debt and cash. The ratios a credit officer reads are worked out: margin, repayment cover, cash buffer and how much sales swing.",
    why: "These are the numbers the weather will stress. Each save is a new version, never an overwrite, and the bank can mark one as checked.",
    sends: [["POST", "/businesses/:id/snapshots", "Stores a financial snapshot and works out its ratios."]],
    fields: [["revenue", "Monthly sales, oldest first", "410000, 395000, 420000, 450000, 470000, 430000, 405000, 415000"], ["opex", "Monthly costs", "310000", "number"],
      ["emi", "Existing EMIs", "28000", "number"], ["debt", "Loans still owed", "650000", "number"], ["cash", "Cash in hand", "240000", "number"]],
    async run(v, st, call) {
      const d = await call("POST", `/businesses/${enc(st.biz!)}/snapshots`, {
        as_of: "2026-09-30", monthly_revenue: (v.revenue ?? "").split(",").map((x) => Number(x.trim())), monthly_opex: n(v, "opex"), existing_emi_total: n(v, "emi"),
        outstanding_debt: n(v, "debt"), cash_balance: n(v, "cash"), payment_delays_12m: 1, receivables_days: 20,
      });
      const s = d.snapshot ?? d, x = s.derived ?? {};
      return (
        <div>
          <div className="k-res-title"><h3>Financials saved, version {s.version}</h3><Tag tone={s.verified_by_bank ? "ok" : "am"}>{s.verified_by_bank ? "Checked by the bank" : "Not yet checked by the bank"}</Tag></div>
          <Tiles items={[["Average monthly sales", inr(x.avg_revenue)], ["Operating margin", x.operating_margin === undefined ? "n/a" : pct(x.operating_margin)],
            ["Repayment cover", `${fmt(x.dscr)}×`, "money in vs repayments, before the new loan"], ["Cash buffer", `${Math.round(x.cash_buffer_days ?? 0)} days`]]} />
        </div>
      );
    },
  },
  {
    id: "score", title: "The bank records the loan and scores it", who: "Bank", service: "Finance service", action: "Record the loan and score it", needs: ["biz"],
    what: "A bank officer records the loan. The business is scored on six rules (repayment cover, runway, debt, how sales swing, repayment record, age), then its cash flow is hit with each kind of bad weather where it works, insurance is netted off, and a climate-adjusted score names the reason behind every point.",
    why: "Rules decide; nothing here is a black box. Good weather can add at most 3 points, so it never rescues a weak business.",
    sends: [["POST", "/businesses/:id/loans", "Records the loan request; it starts as applied."], ["GET", "/finance/business/:id/profile", "Works out the score with and without the weather, and the stress test."]],
    fields: [["amount", "Loan amount", "800000", "number"], ["emi", "EMI", "21500", "number"], ["tenure", "Months", "48", "number"], ["rate", "Interest %", "13", "number"]],
    async run(v, st, call, ctx) {
      if (!st.loan) {
        const d = await call("POST", `/businesses/${enc(st.biz!)}/loans`, { amount: n(v, "amount"), emi: n(v, "emi"), tenure_months: n(v, "tenure"), interest_rate: n(v, "rate"), purpose: "equipment" });
        st.loan = d.loan?.id ?? d.id;
      }
      const d = await call("GET", `/finance/business/${enc(st.biz!)}/profile`);
      return <div><FinanceView d={d} /><Ask st={st} source={ctx.source} bank={ctx.bank} prompts={["Should I take this loan?", "What happens in a flood?"]} /></div>;
    },
  },
  {
    id: "watch", title: "The bank approves; Kshetra starts watching", who: "Bank", service: "Monitor and alerts", action: "Approve and pay out", needs: ["loan"],
    what: "The officer approves the loan and the money is paid out. From now on the shop's area is checked every 15 minutes, more often when the forecast worsens, and an alert goes out when it crosses a danger line, after checking consent and that the same warning wasn't just sent.",
    why: "Most lenders stop looking once the money is out. This is where Kshetra keeps watching.",
    sends: [["PATCH", "/loans/:id/status", "Approves the loan; this stores the first finance profile and starts watching the area."],
      ["POST", "/advisor/loans/:id/disburse", "Records that the money was paid out."], ["GET", "/alerts", "Reads the alerts sent so far."]],
    async run(_v, st, call) {
      const status = await call("PATCH", `/loans/${enc(st.loan!)}/status`, { status: "authorised" });
      const state = await call("POST", `/advisor/loans/${enc(st.loan!)}/disburse`, { note: "Paid out from the Playground" });
      const alerts = await call("GET", `/alerts?business_id=${enc(st.biz!)}&limit=10`);
      const loan = status.loan ?? status;
      const reached = loan?.status === "active" || state?.state === "ACTIVE" ? 3 : loan?.status === "authorised" ? 2 : 1;
      return (
        <div>
          <Timeline reached={reached} />
          <SubHead>Alerts so far</SubHead>
          {alerts.alerts?.length ? <AlertsView d={alerts} /> : <Note>Nothing yet. An alert goes out only when the forecast crosses a danger line.</Note>}
        </div>
      );
    },
  },
  {
    id: "alert", title: "Heavy rain is coming", who: "Monitor", service: "Advisor, alert mode", action: "Raise the alert", needs: ["loan"],
    what: "Here a test alert stands in for real bad weather. The loan moves into alert mode and the advisor turns the forecast into a short, ranked list of things the owner can do before the rain, each tied to the numbers behind it.",
    why: "A district bulletin does not tell a baker to lift the flour off the floor tonight. This does, and the bank gets a copy.",
    sends: [["POST", "/advisor/dev/fake-alert", "Raises a test alert for the loan and asks the advisor what to do. Only on a development server."]],
    fields: [["hazard", "Weather", "heavy_rain", ["heavy_rain", "flood", "cyclone", "heatwave"]], ["severity", "How bad", "warning", ["watch", "warning", "severe"]], ["starts", "Starts in (hours)", "18", "number"]],
    async run(v, st, call, ctx) {
      const d = await call("POST", "/advisor/dev/fake-alert", { loanIds: [st.loan], hazard: v.hazard, severity: v.severity, startsInHours: n(v, "starts"), durationHours: 24 });
      const res = d.results?.[0];
      if (!res || res.status !== "advised") return <Note err>The advisor skipped this loan{res?.reason ? `: ${res.reason}` : ""}. It only alerts a loan whose money has been paid out.</Note>;
      return (
        <div>
          <div className="k-alert-band"><Tag tone="am">{nice(d.event?.severity ?? "warning")}</Tag><b>{hazardName(d.hazard ?? d.event?.hazard ?? "")} expected</b></div>
          <SubHead>What the owner is told to do, in order</SubHead>
          <ol className="k-actions-list">{(res.actions ?? []).map((a: Json, i: number) => <li key={i}><b>{a.action}</b><p>{a.why}</p></li>)}</ol>
          {res.bankSummary ? <Note><b>The bank's copy: </b>{res.bankSummary}</Note> : null}
          <Ask st={st} source={ctx.source} bank={ctx.bank} prompts={["What should I do first?", "Will my insurance cover this?"]} />
        </div>
      );
    },
  },
  {
    id: "recover", title: "The shop floods; a plan to recover", who: "Owner, then bank", service: "Advisor, recovery mode", action: "Report the damage", needs: ["loan"],
    what: "Water got in. The owner reports what was lost. The advisor works out the next twelve months of cash flow and proposes ways to change the repayments: a pause, a longer term, half EMIs for a while, or a bridge to the insurance payout. It suggests one and explains why.",
    why: "The advisor can only propose. Nothing changes on the loan until a bank officer accepts.",
    sends: [["POST", "/advisor/damage-report", "Records the damage and asks the advisor for options."], ["POST", "/advisor/proposals/:id/decision", "The bank accepts or turns down the plan."]],
    fields: [["days", "Days closed", "9", "number"], ["stock", "Stock lost (₹)", "60000", "number"], ["equipment", "Equipment damage (₹)", "25000", "number"],
      ["reopen", "Expected to reopen", daysAhead(12), "date"], ["claim", "Insurance claim expected (₹)", "60000", "number"]],
    async run(v, st, call, ctx) {
      const d = await call("POST", "/advisor/damage-report", {
        loanId: st.loan, hazard: "flash_flood", daysClosed: n(v, "days"), stockLossInr: n(v, "stock"), equipmentDamageInr: n(v, "equipment"),
        expectedReopenDate: v.reopen, insuranceClaim: { status: "filed", expectedAmountInr: n(v, "claim"), expectedDate: daysAhead(40) },
        message: "Water came into the shop on Tuesday night.",
      });
      st.proposal = d.proposal ?? null;
      st.answer = d;
      return <Recovery st={st} d={d} source={ctx.source} bank={ctx.bank} />;
    },
  },
];

// ── The page ─────────────────────────────────────────────────────────────────

export function Playground() {
  const s = useSession();
  const [source, setSource] = useState<Source>("sample");
  const [at, setAt] = useState(0);
  const [results, setResults] = useState<Record<string, Ran>>({});
  const [errors, setErrors] = useState<Record<string, ApiResult>>({});
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<ReactNode>(null);
  const story = useRef<Story>(fresh());
  // Each play gets a number; a play whose number is no longer current stops
  const run = useRef(0);

  // Example data answers as a bank officer would; live needs one signed in
  const bankFor = (src: Source) => src === "sample" || getSession().user?.role === "bank";

  async function runChapter(i: number, src: Source, values?: Values): Promise<boolean> {
    const c = CHAPTERS[i]!;
    setAt(i);
    setBusy(true);
    const calls: ApiResult[] = [];
    const call: Call = async (method, path, body) => {
      const r = await api(method, path, body, { source: src });
      calls.push(r);
      if (!r.ok) throw new StepError(r);
      return r.data;
    };
    const v: Values = values ?? Object.fromEntries((c.fields ?? []).map(([k, , def]) => [k, def]));
    try {
      const view = await c.run(v, story.current, call, { source: src, bank: bankFor(src) });
      setResults((r) => ({ ...r, [c.id]: { view, calls } }));
      setErrors((e) => { const { [c.id]: _gone, ...rest } = e; return rest; });
      return true;
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      setResults((r) => ({ ...r, [c.id]: { view: null, calls } }));
      setErrors((e) => ({ ...e, [c.id]: error.r }));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const pause = () => { run.current += 1; setPlaying(false); setStatus(<><Tag>Paused</Tag> Pick any chapter, or play the story again.</>); };

  async function playAll(src: Source) {
    const mine = ++run.current;
    story.current = fresh();
    setSource(src);
    setResults({});
    setErrors({});
    setPlaying(true);
    for (let i = 0; i < CHAPTERS.length; i++) {
      if (run.current !== mine) return;
      setStatus(<><Tag tone="cy">{i + 1} of {CHAPTERS.length}</Tag> {CHAPTERS[i]!.title}…</>);
      const ok = await runChapter(i, src);
      if (run.current !== mine) return;
      if (!ok) {
        setPlaying(false);
        setStatus(<><Tag tone="er">Stopped</Tag> at “{CHAPTERS[i]!.title}”. The reason is shown in the chapter.</>);
        return;
      }
      await wait(PAUSE);
    }
    // The bank's decision closes the story
    const p = story.current.proposal;
    if (p?.status === "pending_bank") {
      const r = await api("POST", `/advisor/proposals/${enc(p.id)}/decision`, { decision: "accept", note: "Approved from the Playground" }, { source: src });
      if (run.current !== mine) return;
      if (r.ok) {
        const st = story.current;
        st.proposal = r.data.proposal;
        // Drawn again from the accepted plan, so it no longer offers to accept it
        const view = <Recovery st={st} d={{ ...st.answer, proposal: st.proposal }} source={src} bank={bankFor(src)} />;
        setResults((all) => (all.recover ? { ...all, recover: { ...all.recover, view } } : all));
      }
    }
    setPlaying(false);
    setStatus(<><Tag tone="ok">Done</Tag> The whole story ran{src === "sample" ? " on example data" : " live"}. Open any chapter to see it again.</>);
  }

  // The story plays by itself as soon as the page opens, on example data
  useEffect(() => {
    void playAll("sample");
    return () => { run.current += 1; };
    // Runs once per visit to the page
  }, []);

  function runLive() {
    if (!s.user) { openSignin(); return; }
    if (s.user.role !== "bank") { setStatus(<><Tag tone="er">Bank only</Tag> Chapters 5 to 8 are a bank officer's work. Sign in with a bank officer's account to run the story live.</>); return; }
    void playAll("live");
  }

  const c = CHAPTERS[at]!;
  const done = results[c.id];
  const missing = c.needs.filter((need) => !story.current[need]);
  const goTo = (i: number) => { if (playing) pause(); setAt(i); };

  return (
    <>
      <AppNav page="playground" />
      <div className="wrap k-pg">
        <header className="k-intro">
          <h1>One loan, start to finish</h1>
          <p>Follow Sri Lakshmi Bakery from its loan application through a flood and its recovery. The story plays by itself on example data; nothing is saved and no email is sent.</p>
          <div className="k-actions">
            {playing
              ? <button className="btn" type="button" onClick={pause}>Pause</button>
              : <button className="btn" type="button" onClick={() => void playAll("sample")}>Play the story again</button>}
            <button className="btn ghost" type="button" disabled={playing} onClick={runLive}>Run it live</button>
            <span className="k-status">{status}</span>
          </div>
        </header>

        <div className="k-pg-body">
          <nav className="k-rail" aria-label="Chapters">
            {CHAPTERS.map((ch, i) => (
              <button key={ch.id} type="button" aria-current={i === at ? "step" : undefined} className={results[ch.id]?.view ? "done" : errors[ch.id] ? "failed" : ""} onClick={() => goTo(i)}>
                <i>{String(i + 1).padStart(2, "0")}</i><span>{ch.title}<small>{ch.who}</small></span>
              </button>
            ))}
          </nav>

          <article className="k-card k-chapter">
            <div className="k-eyebrow">Chapter {at + 1} of {CHAPTERS.length} · {c.service}</div>
            <h2>{c.title} <Tag tone={/bank/i.test(c.who) ? "am" : "cy"}>{c.who}</Tag></h2>
            <div className="k-ch-text">
              <div><SubHead>What happens</SubHead><p>{c.what}</p></div>
              <div className="k-why"><SubHead>Why it matters</SubHead><p>{c.why}</p></div>
            </div>

            <form key={c.id} onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget).entries()) as Values;
              void runChapter(at, source, values);
            }}>
              {c.fields ? (
                <details className="k-more"><summary>Edit the details</summary>
                  <div className="k-fields">{c.fields.map(([name, text, def, kind]) => Array.isArray(kind)
                    ? <Field key={name} name={name} label={text} value={def} options={kind.map((o) => [o, nice(o)])} />
                    : <Field key={name} name={name} label={text} value={def} type={kind === "number" || kind === "date" ? kind : "text"} area={kind === "area"} />)}</div>
                </details>
              ) : null}
              <div className="k-actions">
                <button className="btn sm" disabled={busy || playing || missing.length > 0}>{done?.view ? `${c.action} again` : c.action}</button>
                {missing.length ? <span className="muted small">Needs a {missing.map((m) => (m === "biz" ? "business" : "loan")).join(" and a ")} from an earlier chapter. Play the story to fill it in.</span> : null}
              </div>
            </form>

            <div className="k-out">
              {busy && !done ? <p className="muted">Working…</p> : null}
              {errors[c.id] ? <Problem r={errors[c.id]!} /> : done?.view ?? null}
            </div>

            <details className="k-more k-bts"><summary>Behind the scenes</summary>
              <p className="muted small">Done by the {c.service.toLowerCase()}. This chapter sends:</p>
              <ul className="k-list">{c.sends.map(([m, p, d]) => <li key={m + p}><code>{m} {p}</code><br />{d}</li>)}</ul>
              {done?.calls.length ? <Kv pairs={done.calls.map((r, i) => [`${i + 1}. ${r.method} ${r.path.split("?")[0]}`, r.network ? "no answer" : `${r.status}${r.source === "sample" ? " (example)" : ""}`])} /> : null}
            </details>

            <footer className="k-ch-nav">
              <button className="btn sm ghost" type="button" disabled={at === 0} onClick={() => goTo(at - 1)}>← Back</button>
              <button className="btn sm ghost" type="button" disabled={at === CHAPTERS.length - 1} onClick={() => goTo(at + 1)}>Next →</button>
            </footer>
          </article>
        </div>
      </div>
    </>
  );
}
