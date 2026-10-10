import { follow } from "../shared/router";
import { FACTS } from "../content";
import { Film } from "./Film";
import { Reveal } from "./Reveal";

export function Hero() {
  return (
    <section className="hero">
      <div className="ruled hero-grid" aria-hidden="true" />
      <div className="hero-glow" aria-hidden="true" />
      <div className="wrap hero-in">
        <div className="eyebrow">Climate-adjusted credit risk · India</div>
        <h1>Lend with the<br /><em>weather in view.</em></h1>
        <p className="lede">
          Kshetra scores a small business's loan against six climate hazards at its exact location, stress-tests its
          cash flow against each one, watches the forecast after the money goes out, and helps the owner recover when
          the weather hits.
        </p>
        <div className="cta">
          <a className="btn" href="/playground" onClick={follow}>Watch it work →</a>
          <a className="btn ghost" href="/analysis" onClick={follow}>Check your business</a>
        </div>
        <div className="facts">{FACTS.map((fact) => <span key={fact}>{fact}</span>)}</div>
        <Reveal className="film-wrap"><Film /></Reveal>
      </div>
    </section>
  );
}
