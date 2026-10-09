import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

export function SectionHeader({ mark, eyebrow, title, accent, children }: {
  mark: string;
  eyebrow: string;
  title: ReactNode;
  accent: string;
  children?: ReactNode;
}) {
  return (
    <Reveal className="sec-h">
      <div className="eyebrow"><b>{mark}</b>{eyebrow}</div>
      <h2>{title} <em>{accent}</em></h2>
      {children ? <p className="lede">{children}</p> : null}
    </Reveal>
  );
}
