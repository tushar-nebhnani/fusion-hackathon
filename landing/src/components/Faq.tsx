import { FAQ } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function Faq() {
  return (
    <section id="faq">
      <div className="wrap">
        <SectionHeader mark="?" eyebrow="Questions" title="Fair" accent="questions." />
        <Reveal>
          {FAQ.map((item) => (
            <details className="q" key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
