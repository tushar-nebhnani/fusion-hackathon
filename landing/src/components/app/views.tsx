import { useState } from "react";
import { api, type Json, type Source } from "../../shared/api";
import {
  ALERT_STATUS, cap, day, fmt, hazardName, inr, LOAN_STAGE, level, nice, pct, plainWarning, ratio, SEVERITIES, tidy,
} from "../../shared/format";
import { Bar, Bubble, DataTable, Grade, Kv, Note, Problem, Strip, SubHead, Tag } from "./ui";

// Answers drawn in plain words. Both pages use them.

export function ClimateView({ d }: { d: Json }) {
  const hazards = [...(d.hazards ?? [])].sort((a: Json, b: Json) => (b.score ?? 0) - (a.score ?? 0));
  const events: Json[] = d.active_events ?? [];
  return (
    <div>
      <Strip cells={[
        ["Climate grade", <Grade grade={d.grade} />],
        ["Overall risk", pct(d.overall_climate_risk)],
        ["How sure we are", ({ low: "Low", med: "Medium", high: "High" } as Record<string, string>)[d.confidence] ?? "n/a"],
      ]} />
      <SubHead>Next 7 days</SubHead>
      {events.length
        ? <ul className="k-list">{events.map((e, i) => <li key={i}><b>{hazardName(e.hazard)}</b> <Tag tone={e.severity === "watch" ? "cy" : "er"}>{SEVERITIES[e.severity] ?? nice(e.severity)}</Tag> from {day(e.window_start)} to {day(e.window_end)}</li>)}</ul>
        : <p className="muted">No weather warnings for the coming week.</p>}
      <SubHead>Risks at this place</SubHead>
      <div className="k-risks">
        {hazards.map((z: Json) => {
          const [word, tone] = level(z.score);
          return (
            <div className="k-risk" key={z.hazard}>
              <b>{hazardName(z.hazard)}</b>
              {z.relevance === "dormant" ? <Tag>Not a concern here</Tag> : <Tag tone={tone}>{word}</Tag>}
              <Bar value={z.score ?? 0} tone={(z.score ?? 0) >= 0.5 ? "am" : ""} />
              {z.reason ? <p>{tidy(z.reason)}</p> : null}
            </div>
          );
        })}
      </div>
      {d.warnings?.length ? <Note>Some weather data was missing, so this result is less certain than usual.</Note> : null}
    </div>
  );
}

export function FinanceView({ d }: { d: Json }) {
  if (!d.baseline) return <Note>{d.summary ? tidy(d.summary) : "No score could be worked out yet."}</Note>;
  const stress = Object.entries((d.stress ?? {}) as Record<string, Json>);
  return (
    <div>
      <Strip cells={[
        ["Score today", fmt(d.baseline.score), d.baseline.band ? nice(d.baseline.band) : null],
        ["After weather risks", d.adjusted ? fmt(d.adjusted.score) : "n/a", d.adjusted?.band ? nice(d.adjusted.band) : "weather data unavailable"],
        ["Repayment cover", d.metrics?.dscr !== undefined ? `${ratio(d.metrics.dscr)}×` : "n/a", "money in vs repayments"],
      ]} />
      {d.summary ? <p className="k-p">{tidy(d.summary)}</p> : null}
      <SubHead>What changes the score</SubHead>
      {d.adjusted?.drivers?.length
        ? <ul className="k-list">{d.adjusted.drivers.map((x: Json, i: number) => <li key={i}><b className={x.points_change < 0 ? "amber mono" : "cyan mono"}>{x.points_change > 0 ? "+" : ""}{x.points_change} </b>{tidy(x.reason)}</li>)}</ul>
        : <p className="muted">Weather doesn't change the score.</p>}
      {stress.length ? (
        <>
          <SubHead>If each kind of bad weather hit</SubHead>
          <DataTable head={["Weather", "#Sales after", "Repayments"]} rows={stress.map(([hazard, s]) => [
            <b>{hazardName(hazard)}</b>, inr(s.stressed_metrics?.monthly_revenue), s.breach ? <Tag tone="er">At risk</Tag> : <Tag tone="ok">Still covered</Tag>])} />
        </>
      ) : null}
      {d.warnings?.map((w: string, i: number) => <Note key={i}>{plainWarning(w)}</Note>)}
    </div>
  );
}

export const CapacityView = ({ d }: { d: Json }) => (
  <div>
    <Strip cells={[
      ["Largest EMI it could carry", inr(d.max_affordable_emi)],
      ["Short each month", d.shortfall_per_month ? inr(d.shortfall_per_month) : "Nothing"],
      ["Savings would cover", d.reserves_cover_months === null || d.reserves_cover_months === undefined ? "Not needed" : `${ratio(d.reserves_cover_months)} months`],
    ]} />
    {d.summary ? <p className="k-p">{tidy(d.summary)}</p> : null}
  </div>
);

export const RatingReasons = ({ d }: { d: Json }) => (
  <div>
    {d.reliable === false ? <Note>Some information is missing or out of date, so treat this rating with care.</Note> : null}
    {d.reasons?.length ? <ul className="k-list">{d.reasons.map((r: string, i: number) => <li key={i}>{tidy(r)}</li>)}</ul> : <p className="muted">No reasons given.</p>}
  </div>
);

export function ImpactView({ d }: { d: Json }) {
  if (!d.conditions) return <Note>We're still working out how weather affects this business. Check again in a minute.</Note>;
  return (
    <div>
      <DataTable head={["Weather", "How much it disrupts", "Customer demand", "Why"]} rows={Object.entries(d.conditions as Record<string, Json>)
        .sort((a, b) => (b[1].physical ?? 0) - (a[1].physical ?? 0))
        .map(([hazard, c]) => [
          <b>{hazardName(hazard)}</b>,
          <div style={{ minWidth: 110 }}><Bar value={c.physical ?? 0} tone="am" /></div>,
          c.demand > 0.05 ? <span className="cyan">Goes up</span> : c.demand < -0.05 ? <span className="amber">Goes down</span> : "No change",
          tidy(c.reason),
        ])} />
      {d.override_reason ? <Note>Adjusted by the bank: {d.override_reason}</Note> : null}
    </div>
  );
}

export function CashflowView({ d }: { d: Json }) {
  if (!d.scored) return <Note>We don't have enough weather history near this place to work this out yet.</Note>;
  const losses = Object.entries((d.loss_by_hazard ?? {}) as Record<string, number>);
  return (
    <div>
      <Strip cells={[
        ["Chance of missing payments", pct(d.pd_with_climate), `${pct(d.pd_without_climate)} without bad weather`],
        ["Expected weather losses", inr(d.expected_annual_climate_loss), "a year"],
        ["Cash to keep aside", inr(d.cash_reserve_target)],
      ]} />
      {losses.length ? <><SubHead>Where the losses come from</SubHead><DataTable head={["Weather", "#Expected loss a year"]} rows={losses.map(([hazard, v]) => [hazardName(hazard), inr(v)])} /></> : null}
      {d.what_if?.length ? <><SubHead>What would help</SubHead><ul className="k-list">{d.what_if.map((w: Json, i: number) => <li key={i}>{cap(w.condition)}: chance of missing payments becomes <b>{pct(w.pd_with_climate)}</b></li>)}</ul></> : null}
      <p className="muted small">These are estimates based on typical costs for a business like this.</p>
    </div>
  );
}

export function AlertsView({ d }: { d: Json }) {
  if (!d.alerts?.length) return <p className="muted">No weather alerts yet.</p>;
  return (
    <div className="k-stack">
      {d.alerts.map((a: Json) => {
        const message = a.deliveries?.find((x: Json) => x.body);
        const severity = String(a.severity ?? "").toLowerCase();
        return (
          <div className="k-note" key={a.id}>
            <div className="k-alert-h"><b>{a.business_name ?? a.business_id}</b> <Tag>{hazardName(a.hazard)}</Tag> <Tag tone="am">{SEVERITIES[severity] ?? nice(severity)}</Tag></div>
            <Kv pairs={[["For", a.audience === "bank" ? "Bank" : "Business owner"], a.window_start ? ["When", `${day(a.window_start)} to ${day(a.window_end)}`] : null, ["Status", ALERT_STATUS[a.status] ?? nice(a.status)]]} />
            {message ? <details className="k-more"><summary>Read the message</summary><p className="k-pre">{message.body}</p></details> : null}
          </div>
        );
      })}
    </div>
  );
}

export const LoanStageView = ({ d }: { d: Json }) => (
  <div>
    <Kv pairs={[["Loan", d.loanId], ["Stage", LOAN_STAGE[d.state] ?? nice(String(d.state ?? "unknown").toLowerCase())]]} />
    {d.history?.length ? <><SubHead>What happened</SubHead><ul className="k-list">{d.history.map((x: Json, i: number) => <li key={i}>{day(x.at ?? x.createdAt)} · {tidy(x.note ?? x.reason ?? LOAN_STAGE[x.to] ?? fmt(x.to))}</li>)}</ul></> : null}
  </div>
);

// The advisor's repayment plan. Only a bank officer can accept it.
export function ProposalView({ p, bank, source }: { p: Json; bank: boolean; source: Source }) {
  const [decided, setDecided] = useState<Json>(null);
  const [problem, setProblem] = useState<Json>(null);
  const current = decided ?? p;
  const decide = async (decision: "accept" | "reject") => {
    const r = await api("POST", `/advisor/proposals/${encodeURIComponent(p.id)}/decision`, { decision }, { source });
    if (r.ok) setDecided(r.data.proposal ?? { ...p, status: decision === "accept" ? "accepted" : "rejected" });
    else setProblem(r);
  };
  return (
    <div className="k-proposal">
      <SubHead>Suggested repayment plan</SubHead>
      {current.options?.length ? (
        <div className="k-options">
          {current.options.map((o: Json, i: number) => (
            <div key={i} className={`k-opt ${i === current.recommendedIndex ? "best" : ""}`}>
              {i === current.recommendedIndex ? <span className="k-rec">Suggested</span> : null}
              <b>{o.title ?? nice(o.kind ?? "option")}</b>
              <p>{o.terms}</p>
              <Kv pairs={[["EMI for now", inr(o.reliefEmi)], ["EMI after", inr(o.newEmi)], o.months ? ["For", `${o.months} months`] : null]} />
            </div>
          ))}
        </div>
      ) : null}
      {current.status === "pending_bank"
        ? bank
          ? <div className="k-actions"><button className="btn sm" type="button" data-accept onClick={() => decide("accept")}>Accept plan</button><button className="btn sm ghost" type="button" onClick={() => decide("reject")}>Turn down</button><span className="muted small">Nothing changes on the loan until the bank decides.</span></div>
          : <p className="muted small">Your bank will review this plan and let you know.</p>
        : <Note>{current.status === "accepted" ? "The bank accepted this plan. The new schedule applies until the recovery ends." : current.status === "rejected" ? "The bank turned this plan down. The loan keeps its schedule." : nice(current.status)}</Note>}
      {problem ? <Problem r={problem} /> : null}
    </div>
  );
}

export function AdvisorAnswer({ d, bank, source }: { d: Json; bank: boolean; source: Source }) {
  const questions: string[] = d.structured?.questions ?? d.questions ?? [];
  return (
    <div className="k-stack">
      {d.reply ? <Bubble by="Advisor">{d.reply}</Bubble> : null}
      {questions.length ? <><SubHead>The advisor would like to know</SubHead><ul className="k-list">{questions.map((q, i) => <li key={i}>{q}</li>)}</ul></> : null}
      {d.proposal ? <ProposalView p={d.proposal} bank={bank} source={source} /> : null}
    </div>
  );
}
