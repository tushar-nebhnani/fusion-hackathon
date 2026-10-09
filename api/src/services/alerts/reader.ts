import type { PrismaClient } from "../../generated/prisma/client.js";
import { businessNames } from "./businesses.js";
import { alertEventSchema } from "./types.js";

export const ALERT_STATUSES = ["pending", "sending", "sent", "failed", "dead", "suppressed"] as const;

export interface AlertListQuery {
  limit: number;
  businessId?: string;
  status?: (typeof ALERT_STATUSES)[number];
}

export interface AlertReader {
  list(query: AlertListQuery): Promise<{ alerts: AlertView[] }>;
}

export interface AlertView {
  id: number;
  business_id: string;
  business_name: string | null;
  audience: string;
  channel: string;
  hazard: string;
  severity: string;
  status: string;
  attempts: number;
  window_start: string | null;
  window_end: string | null;
  evidence: string | null;
  // Why it was suppressed, or the last send error
  note: string | null;
  created_at: string;
  deliveries: {
    provider: string;
    result: string;
    error: string | null;
    subject: string | null;
    body: string | null;
    sent_at: string;
  }[];
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const ist = (date: Date) =>
  `${new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

// Read side for the dashboard's Alerts tab. It returns each message as it
// was rendered, but never who it was sent to.
export function createAlertReader(prisma: PrismaClient): AlertReader {
  return {
    async list({ limit, businessId, status }) {
      const rows = await prisma.alertOutbox.findMany({
        where: { businessId, status },
        orderBy: { id: "desc" },
        take: limit,
        include: { deliveries: { orderBy: { id: "asc" } } },
      });
      const names = await businessNames(prisma, rows.map((row) => row.businessId));

      const alerts = rows.map((row): AlertView => {
        const event = alertEventSchema.safeParse(row.payload);
        return {
          id: row.id,
          business_id: row.businessId,
          business_name: names.get(row.businessId) ?? null,
          audience: row.audience,
          channel: row.channel,
          hazard: row.hazard,
          severity: row.severity,
          status: row.status,
          attempts: row.attempts,
          window_start: event.success ? event.data.windowStart : null,
          window_end: event.success ? event.data.windowEnd : null,
          evidence: event.success ? event.data.evidence : null,
          note: row.lastError,
          created_at: ist(row.createdAt),
          deliveries: row.deliveries.map((delivery) => ({
            provider: delivery.provider,
            result: delivery.result,
            error: delivery.error,
            subject: delivery.subject,
            body: delivery.body,
            sent_at: ist(delivery.sentAt),
          })),
        };
      });
      return { alerts };
    },
  };
}
