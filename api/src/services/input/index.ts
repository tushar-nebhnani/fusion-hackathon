import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { NotFoundError } from "../../errors/app-error.js";
import { auditNote } from "../../middleware/audit.js";
import { requireAuth, requireBank, requireUser } from "../../middleware/auth.js";
import { requireIdempotencyKey } from "../../middleware/idempotency.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { INPUT } from "./config.js";
import { loadSeedFile, seedSmes } from "./seed.js";
import type { Actor, InputService } from "./service.js";
import { parseBody } from "./validation.js";

export interface InputRouterOptions {
  // Requests per minute per client on these routes
  rateLimit?: number;
  // POST /seed/smes exists only when enabled (never in production)
  seed?: { enabled: boolean; file: string };
}

// The signed-in user, as the service knows callers
function actorOf(res: Response): Actor {
  const user = requireUser(res);
  return { role: user.role, id: user.id };
}

const PATHS = ["/businesses", "/loans", "/seed"];
const seedRequestSchema = z.strictObject({ classify: z.enum(["defaults", "llm"]).default("defaults") });

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

// Route handlers of the input service. Paths are absolute, so the router is
// mounted at the root of the app.
export function inputRouter(service: InputService, options: InputRouterOptions = {}): Router {
  const router = Router();

  // Flow step 7
  const requestLog: RequestHandler = (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      const businessId: unknown = res.locals.businessId;
      service.logRequest({
        method: req.method,
        route: typeof route === "string" ? route : "(unmatched)",
        status: res.statusCode,
        latencyMs: Date.now() - started,
        businessId: typeof businessId === "string" ? businessId.slice(0, 64) : null,
        actorRole: actorOf(res).role,
      });
    });
    next();
  };

  // Rate limiting on top of the API-wide limit, a signed-in user, and every
  // write must carry an Idempotency-Key; the app's idempotency middleware
  // does the replaying.
  router.use(
    PATHS,
    rateLimiter(options.rateLimit ?? INPUT.rateLimit),
    requireAuth,
    requireIdempotencyKey,
    requestLog,
  );
  // One check for every route under a business: an owner reaches only the
  // businesses they created, a bank officer those shared with the bank
  router.use("/businesses/:id", async (req, res, next) => {
    res.locals.businessId = param(req, "id");
    auditNote(res, { target: { type: "business", id: param(req, "id") } });
    await service.assertAccess(param(req, "id"), actorOf(res));
    next();
  });

  router.post("/businesses", async (req, res) => {
    const actor = actorOf(res);
    const business = await service.createBusiness(req.body, {
      ownerUserId: actor.role === "owner" ? actor.id : null,
    });
    res.locals.businessId = business.id;
    auditNote(res, { target: { type: "business", id: business.id } });
    res.status(201).json(business);
  });

  router.get("/businesses/:id", async (req, res) => {
    res.json(await service.getBusiness(param(req, "id")));
  });

  router.patch("/businesses/:id", async (req, res) => {
    res.json(await service.patchBusiness(param(req, "id"), req.body, actorOf(res)));
  });

  router.put("/businesses/:id/locations", async (req, res) => {
    res.json(await service.replaceLocations(param(req, "id"), req.body, actorOf(res)));
  });

  router.put("/businesses/:id/suppliers", async (req, res) => {
    res.json(await service.replaceSuppliers(param(req, "id"), req.body, actorOf(res)));
  });

  router.post("/businesses/:id/snapshots", async (req, res) => {
    res.status(201).json(await service.createSnapshot(param(req, "id"), req.body));
  });

  router.get("/businesses/:id/snapshots", async (req, res) => {
    res.json({ snapshots: await service.listSnapshots(param(req, "id")) });
  });

  router.post("/businesses/:id/snapshots/:v/verify", async (req, res) => {
    auditNote(res, { target: { type: "snapshot", id: `${param(req, "id")}/${param(req, "v")}` } });
    res.json(await service.verifySnapshot(param(req, "id"), param(req, "v"), actorOf(res)));
  });

  router.post("/businesses/:id/loans", async (req, res) => {
    res.status(201).json(await service.createLoan(param(req, "id"), req.body, actorOf(res)));
  });

  router.patch("/loans/:id/status", async (req, res) => {
    auditNote(res, { target: { type: "loan", id: param(req, "id") } });
    const result = await service.changeLoanStatus(param(req, "id"), req.body, actorOf(res));
    res.locals.businessId = result.loan.business_id;
    res.json(result);
  });

  router.get("/businesses/:id/impact-profile", async (req, res) => {
    res.json(await service.getImpactProfile(param(req, "id")));
  });

  router.post("/businesses/:id/impact-profile/reclassify", async (req, res) => {
    res.status(202).json(await service.reclassify(param(req, "id"), actorOf(res)));
  });

  router.put("/businesses/:id/impact-profile", async (req, res) => {
    res.json(await service.overrideImpactProfile(param(req, "id"), req.body, actorOf(res)));
  });

  router.post("/seed/smes", requireBank, async (req, res) => {
    const { seed } = options;
    if (!seed?.enabled) throw new NotFoundError("Route POST /seed/smes not found");
    const { classify } = parseBody(seedRequestSchema, (req.body as unknown) ?? {});
    res.json(await seedSmes(service, await loadSeedFile(seed.file), { classify }));
  });

  return router;
}
