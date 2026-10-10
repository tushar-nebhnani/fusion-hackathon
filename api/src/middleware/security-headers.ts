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
      "Cache-Control": "no-store",
      // The API serves JSON only, so a browser that renders an answer as a
      // page may load and run nothing from it
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    if (options.hsts) {
      res.set("Strict-Transport-Security", `max-age=${String(YEAR_SECONDS)}; includeSubDomains`);
    }
    next();
  };
}
