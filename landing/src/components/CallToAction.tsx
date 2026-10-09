import { CONSOLE_URL } from "../config";
import { Logo } from "./Logo";
import { Reveal } from "./Reveal";

export function CallToAction() {
  return (
    <section className="end">
      <Reveal className="wrap end-in">
        <Logo size={56} />
        <h2>See one loan go from<br />application <em>to recovery.</em></h2>
        <p className="lede">The console runs the whole workflow in one click, against the live API or on sample data.</p>
        <div className="cta">
          <a className="btn" href={CONSOLE_URL}>Run the whole workflow →</a>
          <a className="btn ghost" href="#top">Watch the demo again</a>
        </div>
      </Reveal>
    </section>
  );
}
