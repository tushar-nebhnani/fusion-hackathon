import type { ReactNode } from "react";
import { useInView } from "../hooks/useInView";

// Rises into place the first time it scrolls into view
export function Reveal({ children, className = "", delay = 0, as: Tag = "div" }: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "article" | "figure";
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <Tag ref={ref} className={`rv ${inView ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}
