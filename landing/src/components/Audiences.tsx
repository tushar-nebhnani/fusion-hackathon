import { AUDIENCES } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Audiences() {
  return (
    <section id="who">
      <div className="wrap">
        <SectionHeader mark="⇄" eyebrow="Who it is for" title="Two sides of" accent="the same loan." />
        <div className="grid2">
          {AUDIENCES.map((a, i) => (
            <Reveal className="box" key={a.who} delay={i * 70}>
              <div className="k">{a.who}</div>
              <h3>{a.title}</h3>
              <ul>{a.points.map((point) => <li key={point}>{point}</li>)}</ul>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
