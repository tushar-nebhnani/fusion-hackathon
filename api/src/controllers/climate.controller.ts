import type { RequestHandler } from "express";
import { requireUser } from "../middleware/auth.js";
import { parseCoordinates } from "../services/climate/coordinates.js";
import type { ClimateService } from "../services/climate/profile.service.js";

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

export function climateController(service: ClimateService) {
  const profile: RequestHandler = async (req, res) => {
    const body: unknown = req.body;
    const point = parseCoordinates(field(body, "lat"), field(body, "lon"));
    // The requester counts against their allowance of new places
    res.json(await service.getProfile(point, requireUser(res).id));
  };

  const events: RequestHandler = async (req, res) => {
    const point = parseCoordinates(req.query.lat, req.query.lon, { allowStrings: true });
    const result = await service.getProfile(point, requireUser(res).id);
    res.json({
      location: result.location,
      active_events: result.active_events,
      data_freshness: result.data_freshness,
      cache: result.cache,
      warnings: result.warnings,
    });
  };

  const cell: RequestHandler = async (req, res) => {
    const cellId = req.params.cellId;
    res.json(await service.getCell(typeof cellId === "string" ? cellId : ""));
  };

  return { profile, events, cell };
}
