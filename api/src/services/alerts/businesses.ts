import type { PrismaClient } from "../../generated/prisma/client.js";
import { placeFromPincode } from "../input/pincode.js";
import type { AlertBusinessInfo } from "./render.js";
import { LANGUAGES, type Language } from "./types.js";

// Businesses and owner contacts come from two places: the alert system's own
// alert_businesses / alert_contacts (the demo CLI fills them) and the input
// service's businesses table. The alert tables are asked first, so a row
// there, an opt-out included, always wins over the input service's answer.

type Db = Pick<PrismaClient, "alertBusiness" | "alertContact" | "business">;

interface InputContacts {
  owner?: { email?: string; language?: string };
  alerts?: { channels?: string[] };
}

interface InputConsent {
  alerts?: boolean;
}

const isLanguage = (value: unknown): value is Language =>
  (LANGUAGES as readonly unknown[]).includes(value);

export async function findAlertBusiness(db: Db, id: string): Promise<AlertBusinessInfo | null> {
  const own = await db.alertBusiness.findUnique({ where: { id } });
  if (own) return own;
  const business = await db.business.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      sector: true,
      locations: { where: { isPrimary: true }, select: { pincode: true, address: true }, take: 1 },
    },
  });
  if (!business) return null;
  const location = business.locations[0];
  const place = placeFromPincode(location?.pincode);
  return {
    id: business.id,
    name: business.name,
    city: place.city ?? place.state ?? location?.address ?? "",
    sector: business.sector,
  };
}

export async function businessNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const [own, input] = await Promise.all([
    db.alertBusiness.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }),
    db.business.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }),
  ]);
  // The alert system's own name wins, as in findAlertBusiness
  return new Map([...input, ...own].map((business) => [business.id, business.name]));
}

// The owner of an input-service business, only when they agreed to alerts
// (consent.alerts), chose email as a channel and gave an address. Null when
// alert_contacts already has an owner row for the business: that row decides.
export async function inputOwnerRecipient(
  db: Db,
  businessId: string,
): Promise<{ to: string; language: Language } | null> {
  const listed = await db.alertContact.findFirst({
    where: { audience: "owner", businessId },
    select: { id: true },
  });
  if (listed) return null;
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { contacts: true, consent: true },
  });
  if (!business) return null;
  const consent = business.consent as InputConsent | null;
  const contacts = business.contacts as InputContacts | null;
  const email = contacts?.owner?.email;
  if (consent?.alerts !== true || !contacts?.alerts?.channels?.includes("email") || !email) {
    return null;
  }
  const language = contacts.owner?.language;
  return { to: email, language: isLanguage(language) ? language : "en" };
}
