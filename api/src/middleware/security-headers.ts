import type { RequestHandler } from "express";

const YEAR_SECONDS = 31_536_000;

// Headers every response carries. Answers hold business and financial data,
// so nothing is cached, framed or type-sniffed. `hsts` is for deployments
// served over HTTPS only.
export function securityHeaders(options: { hsts?: boolean } = {}): RequestHandler {
  return (_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      // express.static sets its own, so /demo stays cacheable
      "Cache-Control": "no-store",
    });
    if (options.hsts) {
      res.set("Strict-Transport-Security", `max-age=${String(YEAR_SECONDS)}; includeSubDomains`);
    }
    next();
  };
}
