import { DRIVERS, EXAMPLE_FACTS, GRADES } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Example() {
  return (
    <section id="example">
      <div className="wrap">
        <SectionHeader mark="e.g." eyebrow="Worked example" title="A Chennai bakery," accent="in numbers.">
          The business from the video. Open the console with the API stopped and every step answers from this sample,
          so you can run it yourself.
        </SectionHeader>
        <Reveal className="ex">
          <div className="ex-l">
            <div>
              <div className="k quiet">Sri Lakshmi Bakery · food and beverage · ground floor</div>
              <h3 className="mt8">₹8,00,000 equipment loan over 48 months</h3>
            </div>
            <div className="scorebox">
              <span className="big">85</span><span className="arr">→</span><span className="big am">68</span>
              <span className="bands"><span className="tag ok">Low risk</span><span className="tag cy">Moderate</span></span>
            </div>
            <p className="muted small">The baseline score, then the climate-adjusted score once every hazard in the cell is applied.</p>
            <div>
              {DRIVERS.map((d) => (
                <div className="drv" key={d.hazard}>
                  <span className="p">{d.points}</span>
                  <span>{d.hazard}<small>{d.detail}</small></span>
                  <span className={`tag ${d.breach ? "er" : "ok"}`}>{d.breach ? "Breach" : "Holds"}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="ex-r">
            <div className="k quiet">Climate grade · cell 0.1:13.1:80.3</div>
            <div className="scale" role="img" aria-label="Grade scale from A to E; this cell is D, risk 0.56">
              {GRADES.map((g) => (
                <div key={g.grade} className={g.grade === "D" ? "here" : undefined}>
                  <i className={`g-${g.grade}`} /><b>{g.grade}</b><span>{g.name}</span>
                </div>
              ))}
            </div>
            <dl className="kv">
              {EXAMPLE_FACTS.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
            </dl>
            <div className="note"><b>SYNTHETIC</b>A made-up business. These figures come from the console's sample mode, which imitates the services' rules. Against the live API they are computed from real weather.</div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
