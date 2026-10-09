import type { PrismaClient } from "../../../generated/prisma/client.js";
import { mask } from "../../alerts/senders/dryRun.js";
import type { Sender } from "../../alerts/senders/Sender.js";
import type { BusinessRecord } from "../types.js";

export type Channel = "sms" | "email";

export interface DeliveryStatus {
  channel: Channel;
  // Masked, like the alert system's logs
  to: string | null;
  status: "sent" | "dry_run" | "unavailable" | "failed" | "no_recipient";
  provider: string | null;
  providerRef?: string;
  error?: string;
}

export interface Contacts {
  ownerEmail: string | null;
  ownerPhone: string | null;
  bankEmails: string[];
}

export interface ContactBook {
  forBusiness(business: BusinessRecord): Promise<Contacts>;
}

// The alert system's contacts come first, with its rule: no consent, or an
// opt-out, means no message. Without a row there, the demo contacts in
// smes.json are used when they carry consent.
export function createContactBook(prisma?: PrismaClient): ContactBook {
  return {
    async forBusiness(business) {
      const fallback: Contacts = business.contacts.consent
        ? {
            ownerEmail: business.contacts.ownerEmail,
            ownerPhone: business.contacts.ownerPhone,
            bankEmails: business.contacts.bankEmail ? [business.contacts.bankEmail] : [],
          }
        : { ownerEmail: null, ownerPhone: null, bankEmails: [] };
      if (!prisma) return fallback;

      const rows = await prisma.alertContact.findMany({
        where: {
          OR: [{ audience: "owner", businessId: business.id }, { audience: "bank" }],
          consentAt: { not: null },
          optedOutAt: null,
        },
      });
      const owner = rows.find((row) => row.audience === "owner");
      const banks = rows.flatMap((row) => (row.audience === "bank" && row.email ? [row.email] : []));
      return {
        ownerEmail: owner?.email ?? fallback.ownerEmail,
        ownerPhone: owner?.phoneE164 ?? fallback.ownerPhone,
        bankEmails: banks.length > 0 ? banks : fallback.bankEmails,
      };
    },
  };
}

export interface OutgoingMessage {
  channel: Channel;
  to: string | null;
  subject?: string;
  body: string;
}

export interface Messenger {
  send(message: OutgoingMessage): Promise<DeliveryStatus>;
}

// Wraps the alert system's sender (dry run or SMTP). SMS was removed from
// the alert system (RESOLVE_LATER.md item 5), so an SMS is composed and
// stored but reported as unavailable instead of being sent.
export function createMessenger(sender: Sender): Messenger {
  return {
    async send({ channel, to, subject, body }) {
      if (!to) return { channel, to: null, status: "no_recipient", provider: null };
      if (channel === "sms") {
        return {
          channel,
          to: mask(to),
          status: "unavailable",
          provider: null,
          error: "No SMS channel: SMS was removed from the alert system (RESOLVE_LATER.md item 5)",
        };
      }
      try {
        const result = await sender.send({ to, subject: subject ?? "ClimaCredit advisor", body, html: false });
        return {
          channel,
          to: mask(to),
          status: sender.provider === "dry_run" ? "dry_run" : "sent",
          provider: sender.provider,
          providerRef: result.providerRef,
        };
      } catch (error) {
        return {
          channel,
          to: mask(to),
          status: "failed",
          provider: sender.provider,
          error: error instanceof Error ? error.message : "send failed",
        };
      }
    },
  };
}
