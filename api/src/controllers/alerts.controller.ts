import type { RequestHandler } from "express";
import { z } from "zod";
import { BadRequestError } from "../errors/app-error.js";
import { ALERT_STATUSES, type AlertReader } from "../services/alerts/reader.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  business_id: z.string().min(1).max(64).optional(),
  status: z.enum(ALERT_STATUSES).optional(),
});

export function alertsController(reader: AlertReader) {
  const list: RequestHandler = async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      const issue = query.error.issues[0];
      throw new BadRequestError(`Invalid ${issue?.path.join(".") ?? "query"}: ${issue?.message ?? ""}`);
    }
    const { limit, business_id: businessId, status } = query.data;
    res.json(await reader.list({ limit, businessId, status }));
  };

  return { list };
}
