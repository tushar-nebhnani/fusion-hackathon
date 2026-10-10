import { useEffect, useState } from "react";
import { NAV_LINKS } from "../content";
import { useActiveSection } from "../hooks/useActiveSection";
import { follow } from "../shared/router";
import { Logo } from "./Logo";

const IDS = NAV_LINKS.map((link) => link.id);

export function Nav() {
  const active = useActiveSection(IDS);
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The menu closes on Escape and when the layout grows past the phone breakpoint
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const wide = window.matchMedia("(min-width: 961px)");
    const onWide = () => { if (wide.matches) setOpen(false); };
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => { window.removeEventListener("keydown", onKey); wide.removeEventListener("change", onWide); };
  }, [open]);

  return (
    <header className={`nav ${scrolled ? "scrolled" : ""} ${open ? "open" : ""}`}>
      <div className="wrap nav-bar">
        <a className="brand" href="#top" onClick={() => setOpen(false)}>
          <Logo />
          <b>Kshetra</b>
        </a>

        <nav className="nav-links" aria-label="Sections">
          {NAV_LINKS.map((link) => (
            <a key={link.id} href={`#${link.id}`} aria-current={active === link.id ? "true" : undefined}>{link.label}</a>
          ))}
        </nav>

        <div className="nav-end">
          <a className="btn sm" href="/analysis" onClick={follow}>Check your business</a>
          <button className="menu-btn" type="button" aria-expanded={open} aria-controls="nav-menu" onClick={() => setOpen((v) => !v)}>
            <span className="sr">{open ? "Close menu" : "Open menu"}</span>
            <i aria-hidden="true" /><i aria-hidden="true" />
          </button>
        </div>
      </div>

      <div id="nav-menu" className="nav-menu" hidden={!open}>
        <div className="wrap">
          {NAV_LINKS.map((link, i) => (
            <a key={link.id} href={`#${link.id}`} onClick={() => setOpen(false)}>
              <span>0{i + 1}</span>{link.label}
            </a>
          ))}
          <a className="btn ghost" href="/playground" onClick={follow}>Watch it work</a>
          <a className="btn" href="/analysis" onClick={follow}>Check your business →</a>
        </div>
      </div>
    </header>
  );
}
