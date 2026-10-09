import { ISSUES } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Issues() {
  return (
    <section id="issues">
      <div className="wrap">
        <SectionHeader mark="!" eyebrow="The problem" title="Small-business credit is" accent="blind to weather.">
          A loan to a bakery, a kirana store or an agri-input dealer is underwritten on its books. Where it stands, and
          what the weather there does to its takings, rarely enters the file. These are the gaps Kshetra is built to close.
        </SectionHeader>
        <div className="issues">
          {ISSUES.map((issue, i) => (
            <Reveal as="article" className="issue" key={issue.title} delay={(i % 3) * 70}>
              <span className="n">ISSUE {String(i + 1).padStart(2, "0")}</span>
              <h3>{issue.title}</h3>
              <p>{issue.problem}</p>
              <div className="fix"><b>KSHETRA</b>{issue.answer}</div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
