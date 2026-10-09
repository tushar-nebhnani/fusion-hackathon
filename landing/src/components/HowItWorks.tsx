import { STEPS } from "../content";
import { Reveal } from "./Reveal";
import { SectionHeader } from "./SectionHeader";

export function HowItWorks() {
  return (
    <section id="how">
      <div className="wrap">
        <SectionHeader mark="→" eyebrow="How it works" title="One loan, from application" accent="to recovery.">
          Five services, each with one job, follow the same business. The console walks through all of them on one page.
        </SectionHeader>
        <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.title} data-n={String(i + 1).padStart(2, "0")}>
              <Reveal className="st">
                <div>
                  <div className="k">{step.service}</div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                <ul>{step.points.map((point) => <li key={point}>{point}</li>)}</ul>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
