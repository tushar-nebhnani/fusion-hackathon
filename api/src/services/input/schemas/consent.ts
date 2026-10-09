import { z } from "zod";

// H. Consent. `timestamp` and `version` are set by the server, so the
// client cannot send them.

export const consentSchema = z.strictObject({
  data_processing: z.boolean(),
  share_with_bank: z.boolean(),
  alerts: z.boolean(),
});
export type ConsentInput = z.infer<typeof consentSchema>;

export interface Consent extends ConsentInput {
  timestamp: string;
  version: string;
}
