import { describe, expect, it } from "vitest";
import { formatWindow, loadContent, renderAlert, renderDigest } from "./render.js";
import { HAZARDS, SEVERITIES, type AlertEvent } from "./types.js";

const content = loadContent();
const business = { id: "SME-0142", name: "Sri Ganesh Bakery", city: "Chennai", sector: "food" };
const event: AlertEvent = {
  businessId: "SME-0142",
  hazard: "flood",
  severity: "WARNING",
  windowStart: "2026-10-12",
  windowEnd: "2026-10-14",
  evidence: "Heavy-rain tripwire crossed; river discharge rising",
  sourceRunId: "mon-2026-10-09T15:45",
};
const render = (overrides: Partial<Parameters<typeof renderAlert>[1]> = {}) =>
  renderAlert(content, {
    audience: "owner",
    language: "en",
    event,
    business,
    dashboardUrl: "http://localhost:3000",
    ...overrides,
  });

describe("alert rendering", () => {
  it("tells the owner what is coming, when, and what to do", () => {
    const email = render();

    expect(email.subject).toBe("Kshetra alert: Flood risk near Sri Ganesh Bakery, 12–14 Oct");
    expect(email.html).toBe(false);
    expect(email.body).toContain("A Flood risk is forecast near Sri Ganesh Bakery, Chennai, on 12–14 Oct.");
    expect(email.body).toContain("- Move stock, machines and records to a higher shelf or floor");
    expect(email.body).toContain("Your bank may contact you with support.");
    expect(email.body).toContain("Follow instructions from local authorities");
    expect(email.body).toContain("reply to this email with STOP");
    expect(email.body).not.toMatch(/[{}]/);
  });

  it("puts no borrower id, evidence or dashboard link in the owner's email", () => {
    const { subject, body } = render();
    expect(subject + body).not.toContain("SME-0142");
    expect(body).not.toContain(event.evidence);
    expect(body).not.toContain("/borrowers/");
  });

  it("writes to the owner in Hindi or Marathi", () => {
    const hindi = render({ language: "hi" });
    const marathi = render({ language: "mr" });

    expect(hindi.subject).toBe("Kshetra चेतावनी: Sri Ganesh Bakery के पास बाढ़ का खतरा, 12–14 Oct");
    expect(hindi.body).toContain("सामान व कागज़ात ऊँचाई पर रखें।");
    expect(marathi.subject).toContain("पूर धोका");
    expect(marathi.body).toContain("माल व कागदपत्रे उंचावर ठेवा.");
    expect(hindi.body + marathi.body).not.toMatch(/[{}]/);
  });

  it("gives the bank the borrower, evidence, suggestions and a dashboard link", () => {
    const email = render({ audience: "bank" });

    expect(email.subject).toBe(
      "[WARNING] Flood risk — SME-0142 Sri Ganesh Bakery, Chennai — 12–14 Oct",
    );
    expect(email.html).toBe(true);
    expect(email.body).toContain("Heavy-rain tripwire crossed; river discharge rising");
    expect(email.body).toContain("<li>Call the borrower to confirm they received the warning</li>");
    expect(email.body).toContain('href="http://localhost:3000/borrowers/SME-0142"');
    expect(email.body).toContain("not automatic decisions");
    expect(email.body).toContain("reply to this email with STOP");
  });

  it("escapes values placed in an HTML email", () => {
    const email = render({
      audience: "bank",
      business: { ...business, name: "<script>alert(1)</script> & Sons" },
    });
    expect(email.body).not.toContain("<script>");
    expect(email.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons");
  });

  it("adds the sector's extra step to the owner's email, not the bank's", () => {
    const heat = { ...event, hazard: "heat" as const };
    const owner = render({ event: heat });
    const bank = render({ audience: "bank", event: heat });

    expect(owner.subject).toBe("Kshetra alert: Heatwave risk near Sri Ganesh Bakery, 12–14 Oct");
    expect(owner.body).toContain("- Check refrigeration and power backup");
    expect(bank.body).not.toContain("Check refrigeration");
  });

  it("uses the flood guidelines for both flood hazards", () => {
    const river = render({ event: { ...event, hazard: "river_flood" } });
    const flash = render({ event: { ...event, hazard: "flash_flood" } });
    expect(river).toEqual(render());
    expect(flash).toEqual(render());
  });

  it("has owner and bank guidelines for every hazard and severity", () => {
    for (const hazard of HAZARDS) {
      for (const severity of SEVERITIES) {
        for (const audience of ["owner", "bank"] as const) {
          const { body } = render({ audience, event: { ...event, hazard, severity } });
          expect(body.match(audience === "bank" ? /<li>/g : /^- /gm)?.length).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("falls back to English, labels included, when a language has no template", () => {
    expect(render({ audience: "bank", language: "hi" }).subject).toContain("[WARNING] Flood risk");
  });

  it("renders one digest for several WATCH alerts", () => {
    const digest = renderDigest(
      content,
      [
        { event: { ...event, severity: "WATCH" }, business },
        {
          event: { ...event, severity: "WATCH", hazard: "heat", businessId: "SME-0200" },
          business: { id: "SME-0200", name: "Lakshmi Textiles", city: "Surat" },
        },
      ],
      { dashboardUrl: "http://localhost:3000", date: "10 Oct 2026" },
    );

    expect(digest.subject).toBe("[WATCH] Daily digest — 2 alerts on watch — 10 Oct 2026");
    expect(digest.body).toContain("SME-0142 Sri Ganesh Bakery, Chennai");
    expect(digest.body).toContain("SME-0200 Lakshmi Textiles, Surat");
    expect(digest.body).toContain("/borrowers/SME-0200");
  });
});

describe("formatWindow", () => {
  it("shortens a window to days and month names", () => {
    expect(formatWindow("2026-10-12", "2026-10-14")).toBe("12–14 Oct");
    expect(formatWindow("2026-10-12", "2026-10-12")).toBe("12 Oct");
    expect(formatWindow("2026-09-30", "2026-10-02")).toBe("30 Sep – 2 Oct");
  });
});
