import { SAFEGUARDS } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Safeguards() {
  return (
    <section id="safeguards">
      <div className="wrap">
        <SectionHeader mark="✓" eyebrow="Safeguards" title="Models inform." accent="Rules and people decide.">
          Each limit below is fixed in code and covered by tests. None of them can be loosened to make a number look better.
        </SectionHeader>
        <div className="grid3">
          {SAFEGUARDS.map((s, i) => (
            <Reveal className="box" key={s.title} delay={(i % 3) * 70}>
              <div className="k">{s.area}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
