import { Audiences } from "./components/Audiences";
import { CallToAction } from "./components/CallToAction";
import { Example } from "./components/Example";
import { Faq } from "./components/Faq";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { Issues } from "./components/Issues";
import { Nav } from "./components/Nav";
import { Safeguards } from "./components/Safeguards";
import { Status } from "./components/Status";
import { SignInDialog } from "./components/app/SignIn";
import { Analysis } from "./pages/Analysis";
import { Playground } from "./pages/Playground";
import { usePage } from "./shared/router";

// The landing page, plus the two pages that use the API. The path picks one.
export function App() {
  const page = usePage();
  if (page === "playground" || page === "analysis") {
    return (
      <div className="k-app">
        {page === "playground" ? <Playground /> : <Analysis />}
        <SignInDialog />
      </div>
    );
  }
  return (
    <>
      <Nav />
      <main id="top">
        <Hero />
        <Issues />
        <HowItWorks />
        <Example />
        <Safeguards />
        <Audiences />
        <Status />
        <Faq />
        <CallToAction />
      </main>
      <Footer />
    </>
  );
}
