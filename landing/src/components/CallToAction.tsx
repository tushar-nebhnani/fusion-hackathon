import { follow } from "../shared/router";
import { Logo } from "./Logo";
import { Reveal } from "./Reveal";

export function CallToAction() {
  return (
    <section className="end">
      <Reveal className="wrap end-in">
        <Logo size={56} />
        <h2>See one loan go from<br />application <em>to recovery.</em></h2>
        <p className="lede">The Playground plays the whole story by itself on example data. Then check your own business on the Analysis page.</p>
        <div className="cta">
          <a className="btn" href="/playground" onClick={follow}>Watch the whole story →</a>
          <a className="btn ghost" href="/analysis" onClick={follow}>Check your business</a>
        </div>
      </Reveal>
    </section>
  );
}
