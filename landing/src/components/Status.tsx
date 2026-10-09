import { STATUS } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Status() {
  return (
    <section id="status">
      <div className="wrap">
        <SectionHeader mark="≡" eyebrow="Where it stands" title="Built in 24 hours." accent="Here is what works.">
          Kshetra is a hackathon project for Fusion 2026. This is the honest state of each part.
        </SectionHeader>
        <Reveal className="tbl">
          <table className="status">
            <thead><tr><th>Part</th><th>State</th><th>Notes</th></tr></thead>
            <tbody>
              {STATUS.map((row) => (
                <tr key={row.part}>
                  <td>{row.part}</td>
                  <td><span className={`tag ${row.built ? "ok" : "am"}`}>{row.built ? "Built" : "Partial"}</span></td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}
