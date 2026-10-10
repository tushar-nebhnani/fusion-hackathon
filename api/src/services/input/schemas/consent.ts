import { z } from "zod";

// H. Consent. `timestamp` and `version` are set by the server, so the
// client cannot send them.

export const consentSchema = z.strictObject({
  data_processing: z.boolean(),
  share_with_bank: z.boolean(),
  alerts: z.boolean(),
});
export type ConsentInput = z.infer<typeof consentSchema>;

// What an owner may change later. Withdrawing data_processing is a request
// to delete the business, which this route does not do.
export const consentChangeSchema = z
  .strictObject({
    share_with_bank: z.boolean().optional(),
    alerts: z.boolean().optional(),
  })
  .refine((body) => body.share_with_bank !== undefined || body.alerts !== undefined, {
    message: "Send share_with_bank, alerts or both",
  });

export interface Consent extends ConsentInput {
  timestamp: string;
  version: string;
}
