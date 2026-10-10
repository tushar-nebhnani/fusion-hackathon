import { LIMITS, STATUS } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Status() {
  return (
    <section id="status">
      <div className="wrap">
        <SectionHeader mark="≡" eyebrow="Where it stands" title="Built in 24 hours." accent="Here is what works.">
          Kshetra is a hackathon project for Fusion 2026. Every part below is working. What limits it today is scale.
        </SectionHeader>
        <Reveal className="tbl">
          <table className="status">
            <thead><tr><th>Part</th><th>State</th><th>Notes</th></tr></thead>
            <tbody>
              {STATUS.map((row) => (
                <tr key={row.part}>
                  <td>{row.part}</td>
                  <td><span className="tag ok">Working</span></td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
        <div className="grid3 limits">
          {LIMITS.map((l, i) => (
            <Reveal className="box" key={l.title} delay={i * 70}>
              <div className="k">{l.area}</div>
              <h3>{l.title}</h3>
              <p>{l.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
