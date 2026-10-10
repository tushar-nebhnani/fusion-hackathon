import { follow, type Page } from "../../shared/router";
import { setSource, signOut, useSession } from "../../shared/session";
import { Logo } from "../Logo";
import { openSignin } from "./SignIn";

// The bar over the Playground and Analysis pages: the pages, where answers
// come from (live or example data), and who is signed in
export function AppNav({ page }: { page: Page }) {
  const s = useSession();
  const sample = s.source === "sample";
  return (
    <>
      <header className="nav scrolled">
        <div className="wrap nav-bar">
          <a className="brand" href="/" onClick={follow}><Logo /><b>Kshetra</b></a>
          <nav className="nav-links" aria-label="Pages">
            <a href="/playground" onClick={follow} aria-current={page === "playground" ? "true" : undefined}>Playground</a>
            <a href="/analysis" onClick={follow} aria-current={page === "analysis" ? "true" : undefined}>Analysis</a>
          </nav>
          <div className="nav-end">
            <button className="k-chip" type="button" title="Switch between real answers and example data" onClick={() => setSource(sample ? "live" : "sample")}>
              <i className={sample ? "am" : "ok"} aria-hidden="true" />{s.reachable === null ? "Checking" : sample ? "Example data" : "Live"}
            </button>
            {s.user
              ? <span className="k-user"><span>{s.user.name ?? s.user.email}</span><span className={`k-role ${s.user.role}`}>{s.user.role === "bank" ? "bank" : "owner"}</span><button className="k-chip" type="button" onClick={signOut}>Sign out</button></span>
              : sample ? null : <button className="btn sm" type="button" onClick={openSignin}>Sign in</button>}
          </div>
        </div>
        {/* Phones: the two pages under the bar, since the centre links hide below 960px */}
        <nav className="k-pages-sm wrap" aria-label="Pages">
          <a href="/playground" onClick={follow} aria-current={page === "playground" ? "true" : undefined}>Playground</a>
          <a href="/analysis" onClick={follow} aria-current={page === "analysis" ? "true" : undefined}>Analysis</a>
        </nav>
      </header>
      {sample ? (
        <div className="k-banner">
          <b>Example data</b>
          {s.reachable === false ? "Kshetra isn't reachable right now, so you're seeing a made-up bakery. " : "You're seeing a made-up bakery. "}
          Nothing you enter is saved.
        </div>
      ) : null}
    </>
  );
}
