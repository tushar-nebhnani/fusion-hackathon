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

export function App() {
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
